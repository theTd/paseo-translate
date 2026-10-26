import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCommand,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderMode,
  type ProviderModel,
  type ProviderPermissionResponse,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderSessionSummary,
  type ProviderSetting,
  type ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { createTranslator, type TranslatorDeps } from "./translate";
import { completeClaudeCatalog } from "./claude-model-catalog";
import { claudeModelSupportsFastMode, findClaudeModel } from "./claude-model-manifest";
import { translateSessionTitlesForDisplay } from "./session-titles";
import { listClaudeTranscriptSummaries, markManagedClaudeFork } from "./claude-sessions";
import { forkSession as sdkForkSession } from "./claude-rewind";
import {
  isSerializedAttachment,
  restorePromptFragment,
  translatePromptFragment,
} from "./prompt-text";
import type { PromptTranslationFragment } from "../shared/prompt-text";
import {
  ASK_USER_QUESTION_TOOL,
  isAskUserQuestionRequest,
  normalizeQuestionRequestInput,
  resolveQuestionAnswers,
  stripQuestionUiMetadata,
  summarizeQuestions,
  translateQuestionsForDisplay,
} from "./question";
import { ClaudeSubagentTracker, flattenSubagentItemForParent } from "./claude-subagents";
import { ClaudeMessageInput } from "./claude-message-input";
import { ClaudeMessageStream } from "./claude-message-stream";
import { ClaudeToolStream } from "./claude-tool-stream";
import { assertClaudeMode, claudeModeCatalog, isClaudeMode } from "./claude-permission-modes";
import { materializeImageOutput, renderImageOutputMarkdown } from "./image-output";
import { describeFinishedTool, describeRunningTool } from "./claude-tool-details";
import { readClaudeReplay, type ReplayUserTextRestore } from "./claude-transcript";
import { ClaudeForkCoordinator, claudeForkConfigurationSchema, claudeForkConfiguration, claudeForkEnvironment } from "./claude-fork-coordinator";
import { findClaudeTranscriptConfigDir, resolveClaudeConfigDir, resolveConfiguredClaudeConfigDir } from "./claude-project-dir";
import { replayTimelineEvent } from "./provider-replay-timestamps";
import {
  TRANSLATE_CLAUDE_PROVIDER_ID,
  TRANSLATE_CLAUDE_PROVIDER_LABEL,
  TRANSLATION_TEXT_LIMIT,
  omitTranslationBridgeEnv,
  resolveTranslationContextKey,
  type TranslateSettingsValues,
} from "../shared/translate";

/** Subset of the SDK's SlashCommand used for the session command list. */
export interface CommandInfoLike {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** Minimal SDK Query surface this provider uses; test fakes implement the same. */
export interface ClaudeQueryHandle {
  interrupt(): Promise<unknown>;
  cancelAsyncMessage?(uuid: string): Promise<boolean>;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  supportedModels?(): Promise<readonly ModelInfoLike[]>;
  supportedCommands?(): Promise<readonly CommandInfoLike[]>;
  setModel?(model?: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  rewindFiles?(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>;
}

/** Subset of the SDK's ModelInfo used for the dynamic catalog. */
export interface ModelInfoLike {
  value: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
  supportsAdaptiveThinking?: boolean;
}

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQueryHandle;

export interface ClaudeProviderDeps extends TranslatorDeps {
  forkCoordinator?: ClaudeForkCoordinator;
  cacheCoordinator?: import("./claude-cache-compaction").ClaudeCacheCompactionCoordinator;
  resolveVersion?: (executable: string | null) => Promise<string | undefined>;
  /** Test seam; defaults to the real claude-agent-sdk query. */
  queryFactory?: ClaudeQueryFactory;
  /** Test seam; defaults to the real SDK forkSession (conversation rewind). */
  forkSession?: (sessionId: string, options: { upToMessageId: string }) => Promise<{ sessionId: string }>;
}

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "permission",
  "permission.tool_policy",
  "session.persistence",
  "session.configure",
  "session.subsession",
  "session.list",
  "session.revert.files",
  "session.revert.conversation",
  "session.revert.both",
] as const;

/** Effort levels the SDK's Settings.effortLevel accepts at query start. */
const START_EFFORT = new Set(["low", "medium", "high", "xhigh"]);

/**
 * Resolves the `claude` executable from PATH so the provider drives the
 * user's own CLI install (and login) by default, exactly like running
 * `claude` in a terminal. The SDK's own resolution anchors at the daemon's
 * bundled copy, which is only the fallback here.
 */
export function scanPathForClaude(pathValue: string, platform: string): string | null {
  const isWindows = platform === "win32";
  const names = isWindows ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"];
  const delimiter = isWindows ? ";" : ":";
  const directories = pathValue.split(delimiter);
  // Name priority wins over PATH order: a native claude.exe later on PATH
  // beats a claude.cmd shim earlier on it.
  for (const name of names) {
    for (const directory of directories) {
      if (directory.length === 0) continue;
      const candidate = path.join(directory, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep scanning; a directory named claude is not an executable.
      }
    }
  }
  return null;
}

let cachedPathClaude: string | null | undefined;

function resolvePathClaude(): string | null {
  if (cachedPathClaude === undefined) {
    cachedPathClaude = scanPathForClaude(process.env.PATH ?? "", process.platform);
  }
  return cachedPathClaude;
}

type PermissionResultLike =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

interface PendingPermission {
  resolve: (response: PermissionResultLike | null) => void;
  cleanup: () => void;
  resolving?: boolean;
  /** True for ExitPlanMode cards: the answer switches the permission mode. */
  plan?: boolean;
  /**
   * Present for AskUserQuestion permissions: the normalized agent-language
   * input plus the translated questions actually emitted, so answers keyed
   * by translated header map back to Claude's question-text keys.
   */
  question?: {
    requestInput: Record<string, unknown>;
    translatedQuestions: unknown[];
  };
}

/** Shape of `ProviderPermissionRequest.actions` on the permission event. */
type ProviderPermissionActions = NonNullable<
  Extract<ProviderEvent, { type: "session.permission" }>["request"]["actions"]
>;

interface ClaudeSession {
  cacheUnregister?: () => void;
  cacheInvalidate?: () => void;
  cacheFinish?: (success: boolean) => void;
  cacheMaintenance: { uuid: string; boundarySeen: boolean; sent: boolean } | null;
  cacheBackgroundTasks: Set<string>;
  forkConfiguration: boolean;
  id: string;
  config: ProviderSessionConfig;
  /**
   * Translation-context scope: the paseo agent id injected into the session
   * env (see TRANSLATE_AGENT_ID_ENV), falling back to the provider session
   * id when the bridge is absent. Keyed by agent id, prompt-path and
   * display-path translations of one conversation share a transcript.
   */
  contextKey: string;
  translatedSystemPrompt: string | null;
  /** Configured overrides applied at query start and live where possible. */
  desiredModel: string | null;
  runtimeModel: string | null;
  desiredMode: string | null;
  desiredThinking: string | null;
  sink: ClaudeMessageInput;
  messages: ClaudeMessageStream;
  toolStream: ClaudeToolStream;
  query: ClaudeQueryHandle | null;
  abort: AbortController;
  pump: Promise<void> | null;
  claudeSessionId: string | null;
  active: { kind: "prompt" | "rewind"; clientMessageId: string; turnId: string; messageUuid: NonNullable<SDKUserMessage["uuid"]>; announced: boolean; sent: boolean } | null;
  mainTurnInFlight: boolean;
  mainTurnOrdinal: number;
  cancellationEpoch: number;
  permissionClearingEpoch: number;
  compacting: boolean;
  queryRestartNeeded: boolean;
  /**
   * Claude's main loop can wake without a user prompt after background
   * work finishes. Its system/init opens this turn; its result or an idle
   * session state closes it. Background children alone never own a root turn.
   */
  autonomous: { turnId: string } | null;
  interrupted: boolean;
  /** Canceled foreground requests whose ordered terminal results are still
   * pending on this query. Keep their ownership across replacement prompts
   * and repeated interrupts, regardless of the result's success/error text. */
  pendingInterruptedResults: number;
  closed: boolean;
  /** Set while the live query is being swapped out (rewind); the pump then settles silently. */
  detached: boolean;
  /** Fast toggle availability: the desired model (or manifest default) allows it. */
  fastModeSupported: boolean;
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
  /**
   * Latest main-loop prompt usage seen on an assistant message, kept across
   * turns. This is the numerator of the app's context ring: each assistant
   * message carries its own API call's usage, and the prompt side
   * (input + cache read + cache write) is exactly the context that call
   * carried — unlike the cumulative `result.modelUsage` totals.
   */
  contextUsage: { usedTokens: number } | null;
  /** Ring denominator: manifest value at open, updated from `modelUsage`. */
  contextWindowMaxTokens: number | null;
  /** Fast-mode toggle; only offered for models whose manifest row allows it. */
  fastMode: boolean;
  /** Deduplicates the loading compaction card the CLI repeats every 30s. */
  compactionMarkerOpen: boolean;
  /** Mode to return to after a plan is approved (mirrors the native provider). */
  planResumeMode: string | null;
  /** Claude-side user message ids already seen, in arrival order (rewind anchors). */
  rewindUserMessageIds: string[];
  /** Submitted prompts awaiting their Claude-side user message uuid (FIFO). */
  pendingUserAnchors: Array<{ uuid: string; clientMessageId: string; text: string }>;
  /** Latest stream-event request prompt size (mid-turn ring numerator). */
  streamInputTokens: number | null;
  streamOutputTokens: number | null;
  /** Tail of the SDK's stderr, surfaced when the runtime dies. */
  recentStderr: string;
  pendingPermissions: Map<string, PendingPermission>;
  /** Live Task-protocol children, surfaced as provider subsessions. */
  subagents: ClaudeSubagentTracker | null;
  /**
   * Whether the negotiated connection caps include `session.subsession`.
   * Without it the daemon kills the whole provider connection on the first
   * child `session.opened` (failProviderConnection), so the tracker and the
   * replay path must degrade to flat parent-timeline rendering instead.
   */
  supportsSubsessions: boolean;
  commandsPublished: boolean;
}

/**
 * A direct Claude Code provider: drives `claude` through the official SDK in
 * streaming-input mode, translating prompts (and the system prompt) into the
 * agent language before Claude sees them. Claude's replies stream back in the
 * agent language; the client renderer translates them after each turn.
 *
 * Surface: message/command/image prompts, active-turn steering, streaming
 * text and thinking, structured tool-call cards, Task subagents as provider
 * subsessions (track rows with read-only timelines, including nesting,
 * backgrounded children, and resume aliases), permission pass-through,
 * interrupt, slash-command listing, usage reporting, session persistence via
 * Claude's session id, history replay from Claude's own transcript files,
 * session listing, and conversation/file rewind. Archive/unarchive stay
 * capability-gated off: the daemon handles their absence gracefully.
 */
export function createTranslateClaudeProvider(deps: ClaudeProviderDeps): ProviderRegistration {
  const translator = createTranslator(deps);
  const queryFactory = deps.queryFactory ?? claudeQuery;
  const forkClaudeSession = deps.forkSession ?? ((id: string, options: { upToMessageId: string }) =>
    sdkForkSession.forkSession(id, options));
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, ClaudeSession>();
  const unregisterForks = new Map<string, () => void>();
  const context: DispatchContext = {
    sessions,
    translator,
    queryFactory,
    resolveVersion: deps.resolveVersion ?? (async (executable) => {
      try {
        return (await execCommand(executable ?? "claude", ["--version"], { shell: false, timeout: 5_000 })).stdout;
      } catch { return undefined; }
    }),
    forkClaudeSession,
    forkCoordinator: deps.forkCoordinator,
    cacheCoordinator: deps.cacheCoordinator,
    unregisterForks,
    loadValues: () => deps.loadConfig(),
    emit(event) {
      if (!connectionClosed) for (const listener of listeners) listener(event);
    },
  };
  let connectionClosed = false;

  return {
    id: TRANSLATE_CLAUDE_PROVIDER_ID,
    label: TRANSLATE_CLAUDE_PROVIDER_LABEL,
    description:
      "Talks to Claude Code directly through the official SDK. Prompts are translated before Claude sees them; replies stream back in Claude's language and are translated in the app after the stream completes.",
    icon: "icons/claude-translate.svg",
    async getCatalogCacheKey(options) {
      const values = await deps.loadConfig();
      // The catalog reflects the CLI build behind this executable; `force` is
      // intentionally ignored, workspace discovery keys on the target cwd.
      const executable =
        values.claudeExecutablePath.length > 0
          ? values.claudeExecutablePath
          : (resolvePathClaude() ?? "bundled");
      // The curated catalog also reflects settings.json under this directory.
      const configDir = resolveConfiguredClaudeConfigDir(values.claudeConfigDir);
      return options.scope === "workspace"
        ? JSON.stringify({ executable, configDir, cwd: options.cwd })
        : JSON.stringify({ executable, configDir });
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Translate Claude provider requires provider protocol version 1");
      }
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      const connection: ProviderConnection = {
        version: 1,
        capabilities,
        async send(input) {
          if (connectionClosed) throw new Error("Translate Claude provider connection is closed");
          const session = "sessionId" in input ? sessions.get(input.sessionId) : undefined;
          if (session && deps.forkCoordinator && input.type !== "session.prompt" && input.type !== "session.interrupt" && input.type !== "session.permission") {
            await deps.forkCoordinator.exclusive(session.contextKey, () => dispatch(input, context, capabilities));
          } else await dispatch(input, context, capabilities);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          if (connectionClosed) return;
          connectionClosed = true;
          for (const session of sessions.values()) session.cacheUnregister?.();
          for (const session of sessions.values()) {
            const close = async () => {
              unregisterForks.get(session.id)?.();
              await teardownSession(session);
            };
            if (deps.forkCoordinator) await deps.forkCoordinator.exclusive(session.contextKey, close);
            else await close();
          }
          sessions.clear();
          listeners.clear();
        },
      };
      return connection;
    },
  };
}

interface DispatchContext {
  cacheCoordinator?: import("./claude-cache-compaction").ClaudeCacheCompactionCoordinator;
  forkCoordinator?: ClaudeForkCoordinator;
  unregisterForks: Map<string, () => void>;
  sessions: Map<string, ClaudeSession>;
  translator: ReturnType<typeof createTranslator>;
  queryFactory: ClaudeQueryFactory;
  resolveVersion(executable: string | null): Promise<string | undefined>;
  forkClaudeSession: (
    sessionId: string,
    options: { upToMessageId: string },
  ) => Promise<{ sessionId: string }>;
  loadValues(): Promise<TranslateSettingsValues>;
  emit(event: ProviderEvent): void;
}

async function dispatch(
  input: ProviderInput,
  context: DispatchContext,
  capabilities: readonly string[],
): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const catalog = await probeCatalog(context);
      context.emit({ type: "catalog", requestId: input.requestId, catalog });
      return;
    }
    case "session.open":
      requireProviderCapabilities(capabilities, input);
      await openSession(input, context, capabilities);
      return;
    case "session.prompt":
      requireProviderCapabilities(capabilities, input);
      await promptSession(input, context);
      return;
    case "session.interrupt": {
      const session = context.sessions.get(input.sessionId);
      if (session) await interruptSession(session, context);
      context.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.permission": {
      await respondToPermission(context.sessions.get(input.sessionId), input.permissionId, input.response, context);
      return;
    }
    case "session.close": {
      const session = context.sessions.get(input.sessionId);
      context.unregisterForks.get(input.sessionId)?.();
      context.unregisterForks.delete(input.sessionId);
      context.sessions.delete(input.sessionId);
      if (session !== undefined) await teardownSession(session);
      context.emit({ type: "session.closed", sessionId: input.sessionId });
      context.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.configure": {
      requireProviderCapabilities(capabilities, input);
      const session = context.sessions.get(input.sessionId);
      if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
      context.cacheCoordinator?.invalidate(session.contextKey);
      try { await applyConfigChanges(session, input.changes); }
      catch (error) {
        context.emit({ type: "session.config", sessionId: session.id, config: configStateFor(session) });
        context.emit({ type: "request.failed", requestId: input.requestId, error: { message: describe(error) } });
        return;
      }
      if (session.forkConfiguration) context.emit({ type: "session.persistence", sessionId: session.id, persistence: claudePersistence(session) });
      context.emit({
        type: "session.config",
        sessionId: input.sessionId,
        config: configStateFor(session),
      });
      context.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.archive":
    case "session.unarchive":
      context.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `${input.type} is not supported by the Translate Claude provider` },
      });
      return;
    case "session.revert":
      requireProviderCapabilities(capabilities, input);
      await revertSession(input, context);
      return;
    case "sessions":
      requireProviderCapabilities(capabilities, input);
      await listSessions(input, context);
      return;
  }
}

/**
 * Session listing (capability `session.list`): this provider's own Claude
 * sessions for a working directory, from Claude's transcript files. Failures
 * read as an empty list — listing is discoverability, never a blocker.
 * Titles are stored agent-language user text, so they are translated for
 * display (fail soft: a failed title keeps its original text).
 */
async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  context: DispatchContext,
): Promise<void> {
  const values = await context.loadValues();
  const sessions = await listClaudeTranscriptSummaries(
    input.cwd ?? process.cwd(),
    Math.max(1, Math.min(input.limit ?? 20, 100)),
    resolveConfiguredClaudeConfigDir(values.claudeConfigDir),
  );
  context.emit({
    type: "sessions",
    requestId: input.requestId,
    sessions: await translateSessionTitlesForDisplay(sessions, context),
  });
  context.emit({ type: "request.completed", requestId: input.requestId });
}

/**
 * Rewind (capability `session.revert.*`). The daemon sends the revertToken
 * carried on a user_message timeline item — the Claude-side user message
 * uuid. File rewinds call the SDK's file checkpointing; conversation rewind
 * forks the Claude session up to that message and rebinds persistence, so
 * the next prompt resumes the fork.
 */
async function revertSession(
  input: Extract<ProviderInput, { type: "session.revert" }>,
  context: DispatchContext,
): Promise<void> {
  const session = context.sessions.get(input.sessionId);
  if (session === undefined) {
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: `Unknown session: ${input.sessionId}` },
    });
    return;
  }
  const messageId = typeof input.token === "string" ? input.token : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: `Invalid rewind target: ${JSON.stringify(input.token)}` },
    });
    return;
  }
  try {
    if (input.scope === "files" || input.scope === "both") {
      await rewindFilesOnce(session, messageId, context);
    }
    if (input.scope === "conversation" || input.scope === "both") {
      await rewindConversationOnce(session, messageId, context);
    }
    context.emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "notification",
        id: `rewind-${randomUUID()}`,
        level: "info",
        message: `Rewound ${input.scope} to message ${messageId}.`,
      },
    });
    context.emit({ type: "request.completed", requestId: input.requestId });
  } catch (error) {
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: `Rewind failed: ${describe(error)}` },
    });
  }
}

async function rewindFilesOnce(
  session: ClaudeSession,
  messageId: string,
  context: DispatchContext,
  localTurn: ClaudeSession["active"] = null,
): Promise<void> {
  // Checkpoints are restored on a fresh, idle process. Old main-loop results
  // cannot own the local command, and failed transports never serve retries.
  if (session.query) await resetQuery(session, context.emit, localTurn);
  if (localTurn && session.active !== localTurn) throw new Error("Rewind canceled");
  await ensureQuery(session, context, localTurn ?? undefined);
  if (localTurn && session.active !== localTurn) throw new Error("Rewind canceled");
  const query = session.query;
  if (!query?.rewindFiles) throw new Error("This Claude build does not expose file rewind");
  try {
    const result = await query.rewindFiles(messageId, { dryRun: false });
    if (!result.canRewind) throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
  } catch (error) {
    if (session.query === query && (!localTurn || session.active === localTurn)) {
      await resetQuery(session, context.emit, localTurn);
    }
    throw error;
  }
}

/**
 * Conversation rewind tears down the live query (it is bound to the old
 * session) and rebinds persistence to the fork, so the next prompt rebuilds
 * the query on the forked transcript.
 */
async function rewindConversationOnce(
  session: ClaudeSession,
  messageId: string,
  context: DispatchContext,
): Promise<void> {
  if (session.claudeSessionId === null) {
    throw new Error("Claude session is not ready for rewind");
  }
  const fork = await context.forkClaudeSession(session.claudeSessionId, { upToMessageId: messageId });
  if (session.forkConfiguration) {
    await markManagedClaudeFork(session.config.cwd, session.config.env["CLAUDE_CONFIG_DIR"], fork.sessionId);
  }
  session.claudeSessionId = fork.sessionId;
  await resetQuery(session, (event) => context.emit(event));
  context.emit({
    type: "session.persistence",
    sessionId: session.id,
    persistence: claudePersistence(session),
  });
}

/**
 * Stops the live SDK query without closing the session: the pump settles
 * silently (detached), pending permissions are denied, and the next prompt
 * rebuilds the query from the latest Claude session id.
 */
async function resetQuery(
  session: ClaudeSession,
  emit: (event: ProviderEvent) => void,
  preserveActive: ClaudeSession["active"] = null,
): Promise<void> {
  if (session.cacheMaintenance) {
    session.cacheMaintenance = null;
    session.cacheFinish?.(false);
  }
  session.cacheInvalidate?.();
  session.cacheBackgroundTasks.clear();
  session.detached = true;
  session.sink.close();
  session.abort.abort();
  session.abort = new AbortController();
  // The rebuilt query belongs to no interrupted request: a stale flag would
  // mute genuine background work and suppress a later real crash.
  session.interrupted = false;
  session.pendingInterruptedResults = 0;
  session.mainTurnInFlight = false;
  session.compacting = false;
  session.pendingUserAnchors = [];
  settleRootTools(session, emit, "canceled", "Superseded by a rewind");
  for (const pending of session.pendingPermissions.values()) {
    pending.cleanup();
    pending.resolve({ behavior: "deny", message: "Superseded by a rewind" });
  }
  session.pendingPermissions.clear();
  const pump = session.pump;
  session.query = null;
  session.pump = null;
  const active = session.active === preserveActive ? null : session.active;
  if (active) session.active = null;
  await pump?.catch(() => undefined);
  session.subagents?.finishProcessTasks();
  session.detached = false;
  if (active?.announced) {
    emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "canceled" });
  }
  // The torn-down query owns the autonomous turn; the rebuilt one cannot
  // close it, so settle it here like the foreground turn above.
  settleAutonomousTurn(session, emit, "canceled");
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  context: DispatchContext,
  capabilities: readonly string[],
): Promise<void> {
  if (context.sessions.has(input.sessionId)) {
    throw new Error(`Session already exists: ${input.sessionId}`);
  }
  const storedConfigDir = readStoredConfigDir(input.persistence);
  const importConfig = readStoredForkConfiguration(input.persistence);
  if (storedConfigDir || importConfig) {
    input = { ...input, config: { ...input.config,
      ...(importConfig ? { model: importConfig.model, mode: importConfig.mode,
        thinkingOption: importConfig.thinkingOption, settings: importConfig.settings,
        providerOptions: importConfig.providerOptions,
        ...(importConfig.systemPrompt !== undefined ? { systemPrompt: importConfig.systemPrompt } : {}) } : {}),
      env: { ...input.config.env, ...claudeForkEnvironment(importConfig?.env ?? {}),
        ...(storedConfigDir ? { CLAUDE_CONFIG_DIR: storedConfigDir } : {}) },
    } };
  }
  // Replay, listing, persistence and the spawned CLI must all agree on the
  // config directory. A stored dir (fork/import) wins; otherwise an explicit
  // setting, then CLAUDE_CONFIG_DIR, then ~/.claude. Persisting the resolved
  // value makes the session self-describing across daemon restarts.
  const values = await context.loadValues();
  const configuredConfigDir = resolveConfiguredClaudeConfigDir(values.claudeConfigDir);
  const declaredConfigDir = (input.config.env["CLAUDE_CONFIG_DIR"] ?? "").trim();
  const storedSessionId = readStoredSessionId(input.persistence);
  let effectiveConfigDir = declaredConfigDir.length > 0 ? declaredConfigDir : configuredConfigDir;
  if (storedSessionId !== null) {
    // The recorded directory is a declaration, not proof: wrappers such as
    // reclaude sync transcripts into their account config, so a session
    // persisted before that move would replay empty and resume from a
    // directory the CLI never reads. Follow the file that exists.
    effectiveConfigDir = await findClaudeTranscriptConfigDir(input.config.cwd, storedSessionId, [
      effectiveConfigDir, configuredConfigDir, resolveClaudeConfigDir(), path.join(homedir(), ".claude"),
    ]) ?? effectiveConfigDir;
  }
  const configDirChanged = effectiveConfigDir !== declaredConfigDir;
  if (configDirChanged) {
    input = { ...input, config: { ...input.config,
      env: { ...input.config.env, CLAUDE_CONFIG_DIR: effectiveConfigDir } } };
  }
  const contextKey = resolveTranslationContextKey(input.config.env, input.sessionId);
  let translatedSystemPrompt: string | null = null;
  if (typeof input.config.systemPrompt === "string" && input.config.systemPrompt.trim().length > 0) {
    if (values.translatePrompts) {
      try {
        translatedSystemPrompt = await context.translator.translate(
          input.config.systemPrompt,
          "user-to-agent",
          { contextKey },
        );
      } catch (error) {
        context.emit({
          type: "request.failed",
          requestId: input.requestId,
          error: {
            message: `Translating the system prompt failed, so the session was not opened: ${describe(error)}`,
          },
        });
        return;
      }
    } else {
      translatedSystemPrompt = input.config.systemPrompt;
    }
  }
  const session: ClaudeSession = {
    cacheMaintenance: null,
    cacheBackgroundTasks: new Set(),
    forkConfiguration: importConfig !== undefined,
    id: input.sessionId,
    config: input.config,
    contextKey,
    translatedSystemPrompt,
    desiredModel: input.config.model === "default" ? null : readConfigured(input.config.model),
    runtimeModel: null,
    desiredMode: readConfigured(input.config.mode) ?? claudeModeCatalog({ ...process.env, ...input.config.env }).defaultMode,
    desiredThinking: readConfigured(input.config.thinkingOption),
    sink: new ClaudeMessageInput(),
    messages: new ClaudeMessageStream(),
    toolStream: new ClaudeToolStream(),
    query: null,
    abort: new AbortController(),
    pump: null,
    claudeSessionId: storedSessionId,
    active: null,
    mainTurnInFlight: false,
    mainTurnOrdinal: 0,
    cancellationEpoch: 0,
    permissionClearingEpoch: 0,
    compacting: false,
    queryRestartNeeded: false,
    autonomous: null,
    interrupted: false,
    pendingInterruptedResults: 0,
    closed: false,
    detached: false,
    fastModeSupported: claudeModelSupportsFastMode(input.config.model),
    toolNames: new Map(),
    toolInputs: new Map(),
    contextUsage: null,
    contextWindowMaxTokens: findClaudeModel(input.config.model)?.contextWindowMaxTokens ?? null,
    fastMode: input.config.settings?.["fast_mode"] === true,
    compactionMarkerOpen: false,
    planResumeMode: readConfigured(input.config.mode),
    rewindUserMessageIds: [],
    pendingUserAnchors: [],
    streamInputTokens: null,
    streamOutputTokens: null,
    recentStderr: "",
    pendingPermissions: new Map(),
    subagents: null,
    supportsSubsessions: capabilities.includes("session.subsession"),
    commandsPublished: false,
  };
  session.subagents = new ClaudeSubagentTracker(
    session.id,
    session.config.cwd,
    (event) => context.emit(event),
    session.supportsSubsessions,
  );
  context.sessions.set(input.sessionId, session);
  session.cacheInvalidate = () => context.cacheCoordinator?.invalidate(contextKey);
  session.cacheFinish = (success) => context.cacheCoordinator?.finish(contextKey, success);
  session.cacheUnregister = context.cacheCoordinator?.register(contextKey,
    input.config.providerOptions?.translateClaudeCache, {
      snapshot: () => ({ contextTokens: session.contextUsage?.usedTokens ?? null,
        idle: session.config.persist && Boolean(session.query) && !session.closed && !session.detached && !session.queryRestartNeeded &&
          !session.active && !session.autonomous && !session.mainTurnInFlight && !session.compacting &&
          !session.cacheMaintenance && !session.pendingPermissions.size && !session.toolNames.size &&
          !session.sink.pendingUuids.length && !session.cacheBackgroundTasks.size && !session.subagents?.hasRunningTasks() }),
      compact: async (guard) => {
        const reserve = async () => {
          if (!guard()) return false;
          const uuid = randomUUID();
          session.cacheMaintenance = { uuid, boundarySeen: false, sent: false };
          startAutonomousTurn(session, context.emit);
          // Host listeners can synchronously submit a prompt or Stop on started.
          if (session.closed || session.cacheMaintenance?.uuid !== uuid || !session.autonomous) return false;
          context.emit({ type: "timeline.item", sessionId: session.id,
            item: { type: "notification", id: `afk-compact-${uuid}`, level: "info",
              message: "Automatically compacting idle context before estimated cache expiry." } });
          if (session.cacheMaintenance?.uuid !== uuid || session.closed) return false;
          try {
            session.cacheMaintenance.sent = true;
            deliverClaudeMessage(session, uuid, [{ type: "text", text: "/compact" }]);
          }
          catch (error) {
            session.cacheMaintenance = null;
            settleAutonomousTurn(session, context.emit, "failed", describe(error));
            throw error;
          }
          return true;
        };
        return context.forkCoordinator ? context.forkCoordinator.exclusive(contextKey, reserve) : reserve();
      },
    });
  if (context.forkCoordinator) {
    context.unregisterForks.set(session.id, context.forkCoordinator.register(session.contextKey, async () => {
      if (session.closed || session.active || session.autonomous ||
        session.cacheMaintenance || session.cacheBackgroundTasks.size || session.pendingPermissions.size ||
        session.subagents?.hasRunningTasks()) {
        throw new Error("Wait for Claude and its background tasks to finish, and resolve pending permissions before forking");
      }
      if (!session.claudeSessionId) throw new Error("Send a message first so Claude has a persisted session to fork");
      if (session.query) await resetQuery(session, context.emit);
      const declared = path.resolve(session.config.env["CLAUDE_CONFIG_DIR"] ?? resolveClaudeConfigDir());
      // The live transcript may have moved with the wrapper's account config
      // since this session opened; clone from the directory that holds it.
      const configDir = await findClaudeTranscriptConfigDir(session.config.cwd, session.claudeSessionId,
        [declared, configuredConfigDir, resolveClaudeConfigDir(), path.join(homedir(), ".claude")]) ?? declared;
      return { claudeSessionId: session.claudeSessionId,
        configDir,
        config: { ...session.config,
          ...(context.cacheCoordinator ? { providerOptions: { ...session.config.providerOptions,
            translateClaudeCache: context.cacheCoordinator.status(contextKey).preferences } } : {}),
          model: session.desiredModel ?? undefined,
          mode: session.desiredMode ?? undefined, thinkingOption: session.desiredThinking ?? undefined,
          settings: { ...session.config.settings, fast_mode: session.fastMode } },
      };
    }));
  }
  context.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities,
    restoration: "core",
    ...(session.claudeSessionId !== null
      ? { persistence: claudePersistence(session) }
      : {}),
    title: input.config.title,
    cwd: input.config.cwd,
  });
  // A resume normally keeps the stored handle as-is; report the corrected
  // directory explicitly so later opens do not depend on the old setting or
  // on the directory a wrapper has already migrated away from.
  if (configDirChanged && session.claudeSessionId !== null) {
    context.emit({ type: "session.persistence", sessionId: session.id, persistence: claudePersistence(session) });
  }
  context.emit({ type: "session.commands", sessionId: session.id, commands: [{ name: "rewind",
    description: "Rewind tracked files to a previous user message", argumentHint: "[user_message_uuid]" }] });
  await replayHistory(session, input.history, context);
  context.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  context.emit({
    type: "session.config",
    sessionId: input.sessionId,
    config: configStateFor(session),
  });
  // The ring denominator is known from the model manifest before any turn:
  // emit it so the app can render a ratio as soon as used tokens arrive.
  if (session.contextWindowMaxTokens !== null) {
    context.emit({
      type: "session.usage",
      sessionId: input.sessionId,
      usage: { contextWindowMaxTokens: session.contextWindowMaxTokens },
    });
  }
}

/**
 * Parents before descendants. Sidecar files are ordered by mtime, which can
 * list a grandchild before its parent; the daemon rejects a child
 * `session.opened` whose parent is not yet registered with session.subsession.
 */
function orderReplayedChildren<T extends { canonicalId: string; parentCanonicalId?: string }>(
  children: readonly T[],
): T[] {
  const byId = new Map(children.map((child) => [child.canonicalId, child]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  const visit = (child: T): void => {
    if (seen.has(child.canonicalId)) return;
    seen.add(child.canonicalId);
    if (child.parentCanonicalId !== undefined) {
      const parent = byId.get(child.parentCanonicalId);
      if (parent !== undefined) visit(parent);
    }
    ordered.push(child);
  };
  for (const child of children) visit(child);
  return ordered;
}

/** Normalizes a configured selection: empty/unknown/"default" means none. */
function readConfigured(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value === "default") return null;
  return value;
}

/**
 * Best-effort history replay from Claude's own transcript files. Failures
 * read as empty replay: the session still opens and stays fully usable live.
 */
async function replayHistory(
  session: ClaudeSession,
  history: "replay" | "skip",
  context: DispatchContext,
): Promise<void> {
  if (history !== "replay" || session.claudeSessionId === null || session.closed) return;
  const restore = await buildReplayRestore(context, session.contextKey);
  const replay = await readClaudeReplay(session.config.cwd, session.claudeSessionId, restore, session.config.env["CLAUDE_CONFIG_DIR"]);
  for (const item of replay.rootItems) {
    if (session.closed) return;
    if (item.type === "user_message" && typeof item.revertToken === "string") session.rewindUserMessageIds.push(item.revertToken);
    context.emit(replayTimelineEvent(session.id, item));
  }
  for (const child of orderReplayedChildren(replay.children)) {
    if (session.closed) return;
    if (!session.supportsSubsessions) {
      // Same degradation as the live tracker: no child sessions, child
      // content flattened into the parent timeline (see
      // flattenSubagentItemForParent).
      for (const item of child.items) {
        context.emit(replayTimelineEvent(session.id, {
          ...flattenSubagentItemForParent(child.title ?? "Subagent", item), timestamp: item.timestamp,
        }));
      }
      continue;
    }
    const providerId = `subagent:${session.id}:${child.canonicalId}`;
    const parentKnown =
      child.parentCanonicalId !== undefined &&
      replay.children.some((candidate) => candidate.canonicalId === child.parentCanonicalId);
    const parentProviderId = parentKnown
      ? `subagent:${session.id}:${child.parentCanonicalId}`
      : session.id;
    const turnId = randomUUID();
    context.emit({
      type: "session.opened",
      sessionId: providerId,
      parentSessionId: parentProviderId,
      toolCallId: child.canonicalId,
      // Nested children check the immediate parent for session.subsession.
      // An empty list here makes the daemon kill the whole connection.
      capabilities: ["session.subsession"],
      restoration: "parent",
      title: child.title ?? "Subagent",
      ...(child.description !== undefined ? { description: child.description } : {}),
      cwd: session.config.cwd,
    });
    context.emit({ type: "session.turn", sessionId: providerId, turnId, state: "started" });
    for (const item of child.items) {
      context.emit(replayTimelineEvent(providerId, item));
    }
    if (child.totalTokens !== undefined) {
      context.emit({
        type: "session.usage",
        sessionId: providerId,
        turnId,
        usage: { contextWindowUsedTokens: child.totalTokens },
      });
    }
    context.emit({ type: "session.turn", sessionId: providerId, turnId, state: "completed" });
  }
}

/**
 * Builds the user-text restoration for history replay.
 *
 * Claude persists the translated (agent-language) prompts this plugin sent
 * it, so replaying them verbatim would show the user's own messages in the
 * wrong language after a reopen. Two layers, both fail-soft (a miss keeps
 * the translated block):
 * - exact reverse lookup of the fragment recorded at prompt time — no
 *   endpoint call, survives settings changes (trimmed-hash key);
 * - a previously cached back-translation for sessions predating the reverse
 *   index. Cache misses keep the persisted text without calling the endpoint.
 * Only the root timeline gets the fallback: Task sidechain prompts are
 * agent-language by design and must never be back-translated.
 *
 * Replay runs before session.ready, including during CLI import. Network
 * translation here can exceed the daemon request deadline on long sessions,
 * so opening history only reads the cache. The fallback uses current
 * translation settings; exact originals remain settings-independent.
 */
async function buildReplayRestore(
  context: DispatchContext,
  contextKey: string,
): Promise<ReplayUserTextRestore> {
  const lookupExact = (fragment: string): string | undefined => {
    try {
      return context.translator.restoreOriginalFragment(fragment);
    } catch {
      return undefined;
    }
  };
  const exactOriginal = (block: string): string | undefined => {
    try {
      const restored = restorePromptFragment(block, lookupExact);
      if (restored !== block) return restored;
      // A recorded original identical to its translation (numbers, code,
      // cognates) still counts as a hit: without this the identity case
      // would fall through to a cached back-translation on every reopen.
      return hasExactEntry(block) ? block : undefined;
    } catch {
      return undefined;
    }
  };
  const hasExactEntry = (block: string): boolean => {
    try {
      if (block.trim().length === 0 || isSerializedAttachment(block)) return false;
      if (!block.startsWith("/")) return lookupExact(block) !== undefined;
      const match = /^(\S+\s*)([\s\S]*)$/.exec(block);
      if (match === null || match[2].trim().length === 0) return false;
      return lookupExact(match[2]) !== undefined;
    } catch {
      return false;
    }
  };
  let restoreCachedBackTranslation: ((block: string) => Promise<string | undefined>) | undefined;
  let rememberRootMessage: ReplayUserTextRestore["rememberRootMessage"];
  try {
    const values = await context.loadValues();
    if (values.translatePrompts) {
      // Replay knows exactly what Claude received for every shown block, so
      // the prompt display is registered from the transcript instead of
      // being re-translated (and possibly translated differently) by the app.
      rememberRootMessage = (fragments) =>
        context.translator.rememberPromptDisplay(fragments, { contextKey });
      restoreCachedBackTranslation = async (block: string) => {
        if (block.trim().length === 0 || isSerializedAttachment(block)) return undefined;
        if (block.length > TRANSLATION_TEXT_LIMIT) return undefined;
        try {
          const back = await translatePromptFragment(block, async (fragment) =>
            (await context.translator.getCachedTranslation(fragment, "agent-to-user")) ?? fragment,
          );
          if (back.trim().length === 0 || back === block) return undefined;
          return back;
        } catch (error) {
          console.warn(
            `[translate] cached history restoration failed (${error instanceof Error ? error.message : String(error)}); keeping the translated text`,
          );
          return undefined;
        }
      };
    }
  } catch {
    restoreCachedBackTranslation = undefined;
  }
  return {
    restoreRootBlock: async (block: string) => {
      const original = exactOriginal(block);
      if (original !== undefined) return original;
      return (await restoreCachedBackTranslation?.(block)) ?? block;
    },
    restoreChildBlock: (block: string) => exactOriginal(block) ?? block,
    ...(rememberRootMessage !== undefined ? { rememberRootMessage } : {}),
  };
}

function configStateFor(session: ClaudeSession): {
  model?: string;
  mode?: string;
  thinkingOption?: string;
  models: ProviderModel[];
  modes: ProviderMode[];
  thinkingOptions: [];
  settings: ProviderSetting[];
} {
  const model = session.runtimeModel ?? session.desiredModel;
  return {
    ...(model !== null ? { model } : {}),
    ...(session.desiredMode !== null ? { mode: session.desiredMode } : {}),
    ...(session.desiredThinking !== null ? { thinkingOption: session.desiredThinking } : {}),
    models: catalogModelsCache ?? [],
    modes: claudeModeCatalog({ ...process.env, ...session.config.env }).modes,
    thinkingOptions: [],
    // The Fast toggle is offered only for models whose manifest row allows it.
    settings: session.fastModeSupported
      ? [
          {
            type: "toggle",
            id: "fast_mode",
            label: "Fast",
            description: "Lower latency Opus responses at higher token cost",
            value: session.fastMode,
          },
        ]
      : [],
  };
}

function readStoredSessionId(persistence: { version: number; data: unknown } | undefined): string | null {
  if (
    persistence === undefined ||
    typeof persistence.data !== "object" ||
    persistence.data === null
  ) {
    return null;
  }
  const stored = (persistence.data as { claudeSessionId?: unknown }).claudeSessionId;
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

function readStoredConfigDir(persistence: { data: unknown } | undefined): string | undefined {
  if (!persistence || typeof persistence.data !== "object" || !persistence.data) return undefined;
  const configDir = (persistence.data as { configDir?: unknown }).configDir;
  return typeof configDir === "string" && configDir.length > 0 ? configDir : undefined;
}

function claudePersistence(session: ClaudeSession) {
  const configDir = session.config.env["CLAUDE_CONFIG_DIR"];
  return { version: 1, data: { claudeSessionId: session.claudeSessionId,
    ...(configDir ? { configDir } : {}),
    ...(session.forkConfiguration ? { forkConfig: claudeForkConfiguration({ ...session.config,
      model: session.desiredModel ?? undefined,
      mode: session.desiredMode ?? undefined,
      thinkingOption: session.desiredThinking ?? undefined,
      settings: { ...session.config.settings, fast_mode: session.fastMode },
    }) } : {}),
  } };
}

function readStoredForkConfiguration(persistence: { data: unknown } | undefined) {
  if (!persistence || typeof persistence.data !== "object" || !persistence.data || !("forkConfig" in persistence.data)) return undefined;
  return claudeForkConfigurationSchema.parse(persistence.data.forkConfig);
}

/** The pre-translation user text, for rewind anchor display. */
function rawPromptText(
  content: ReadonlyArray<{ type?: unknown; text?: unknown } | unknown>,
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : "[attachment]";
}

function localRewindArguments(input: Extract<ProviderInput, { type: "session.prompt" }>["prompt"]["input"]): string | undefined {
  if (input.type === "command") return input.name === "rewind" ? input.arguments : undefined;
  if (!input.content.every((block) => block.type === "text")) return undefined;
  const match = /^\s*\/rewind(?:\s+([\s\S]*))?\s*$/.exec(rawPromptText(input.content));
  return match ? match[1] ?? "" : undefined;
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
): Promise<void> {
  const session = context.sessions.get(input.sessionId);
  if (session === undefined || session.closed) throw new Error(`Unknown session: ${input.sessionId}`);
  // A user prompt takes priority over our own maintenance, never another user turn.
  if (session.cacheMaintenance) await interruptSession(session, context);
  context.cacheCoordinator?.prompt(session.contextKey);
  const command = localRewindArguments(input.prompt.input);
  if (input.prompt.delivery === "steer" && command !== undefined) {
    context.emit({ type: "session.prompt_result", sessionId: session.id,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "Local /rewind commands cannot steer a running turn" } } });
    return;
  }
  if (input.prompt.delivery === "steer") {
    await steerSession(input, context, session);
    return;
  }
  const cancellationEpoch = session.cancellationEpoch;
  const reserve = () => {
    if (session.closed || session.cancellationEpoch !== cancellationEpoch || session.active !== null) {
      context.emit({ type: "session.prompt_result", sessionId: session.id,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: session.closed || session.cancellationEpoch !== cancellationEpoch
          ? "Prompt canceled before delivery" : "A turn is already running on this session" } } });
      return undefined;
    }
    const active: NonNullable<ClaudeSession["active"]> = { kind: command === undefined ? "prompt" : "rewind",
      clientMessageId: input.prompt.clientMessageId, turnId: randomUUID(),
      messageUuid: randomUUID(), announced: false, sent: false };
    session.active = active;
    return active;
  };
  // Reserve under the fork fence, then release it before translation. The
  // reservation blocks a fork while Stop remains able to cancel preparation.
  const active = context.forkCoordinator
    ? await context.forkCoordinator.exclusive(session.contextKey, async () => reserve())
    : reserve();
  if (!active) return;
  try {
    const prompt = input.prompt.input;
    if (command !== undefined) {
      await executeLocalRewind(session, input, active, context, command);
      return;
    }
    let blocks: SdkContentBlock[];
    let original: string;
    if (prompt.type === "command") {
      original = `/${prompt.name}${prompt.arguments.trim() ? ` ${prompt.arguments}` : ""}`;
      const values = await context.loadValues();
      const args = values.translatePrompts && prompt.arguments.trim()
        ? await context.translator.translate(prompt.arguments, "user-to-agent", { contextKey: session.contextKey })
        : prompt.arguments;
      blocks = [{ type: "text", text: `/${prompt.name}${args.trim() ? ` ${args}` : ""}` }];
    } else {
      original = rawPromptText(prompt.content);
      blocks = await buildMessageBlocks(prompt.content, context, session.contextKey);
    }
    if (session.closed || session.active !== active) return;
    await ensureQuery(session, context, active);
    if (session.closed || session.active !== active) return;
    session.interrupted = false;
    settleAutonomousTurn(session, context.emit, "completed");
    active.announced = true;
    context.emit({ type: "session.prompt_result", sessionId: session.id,
      clientMessageId: active.clientMessageId, result: { type: "turn", turnId: active.turnId } });
    context.emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "started" });
    // Event listeners may synchronously request Stop on acknowledgement.
    if (session.closed || session.active !== active) return;
    session.pendingUserAnchors.push({ uuid: active.messageUuid, clientMessageId: active.clientMessageId, text: original });
    active.sent = true;
    deliverClaudeMessage(session, active.messageUuid, blocks);
    await publishCommands(session, context);
  } catch (error) {
    if (session.closed || session.active !== active) return;
    session.active = null;
    if (active.announced) {
      context.emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId,
        state: "failed", error: { message: describe(error) } });
    } else {
      context.emit({ type: "session.prompt_result", sessionId: session.id,
        clientMessageId: active.clientMessageId, result: { type: "failed", error: { message: describe(error) } } });
    }
  }
}

/** Shared command/message delivery; callers own reservation and lifecycle first. */
function deliverClaudeMessage(session: ClaudeSession, uuid: NonNullable<SDKUserMessage["uuid"]>, blocks: SdkContentBlock[]): void {
  session.sink.push({ type: "user", uuid, session_id: session.claudeSessionId ?? "",
    parent_tool_use_id: null, message: { role: "user", content: blocks } });
}

/** /rewind is Paseo's local file-checkpoint command, never an LLM prompt. */
async function executeLocalRewind(
  session: ClaudeSession,
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  active: NonNullable<ClaudeSession["active"]>,
  context: DispatchContext,
  args: string,
): Promise<void> {
  const requested = args.trim();
  let error = "No prior user message available to rewind. Use /rewind <user_message_uuid>.";
  let target: string | undefined;
  if (requested && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requested)) {
    throw new Error("Invalid message UUID. Usage: /rewind <user_message_uuid> or /rewind");
  }
  if (!requested && session.claudeSessionId && session.rewindUserMessageIds.length === 0) {
    const history = await readClaudeReplay(session.config.cwd, session.claudeSessionId, undefined, session.config.env.CLAUDE_CONFIG_DIR);
    session.rewindUserMessageIds = history.rootItems.flatMap((item) =>
      item.type === "user_message" && typeof item.revertToken === "string" ? [item.revertToken] : []);
  }
  const candidates = requested ? [requested] : [...new Set(session.rewindUserMessageIds)].reverse();
  if (session.closed || session.active !== active) return;
  if (candidates.length === 0) throw new Error(error);
  if (session.query) await resetQuery(session, context.emit, active);
  if (session.closed || session.active !== active) return;
  active.announced = true;
  context.emit({ type: "session.prompt_result", sessionId: session.id,
    clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId: active.turnId } });
  context.emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "started" });
  for (const candidate of candidates) {
    if (session.closed || session.active !== active) return;
    try { await rewindFilesOnce(session, candidate, context, active); target = candidate; break; }
    catch (failure) { error = describe(failure); }
  }
  if (session.closed || session.active !== active) return;
  if (!target) throw new Error(error);
  context.emit({ type: "timeline.item", sessionId: session.id,
    item: { type: "assistant_message", id: `rewind-${active.turnId}`, text: `Rewound tracked files to message ${target}.` } });
  session.active = null;
  context.emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "completed" });
}

async function interruptSession(session: ClaudeSession, context: DispatchContext): Promise<void> {
  const maintenance = session.cacheMaintenance;
  if (session.cacheMaintenance) {
    session.cacheMaintenance = null;
    context.cacheCoordinator?.finish(session.contextKey, false);
  }
  context.cacheCoordinator?.invalidate(session.contextKey);
  session.cancellationEpoch += 1;
  const active = session.active;
  const query = session.query;
  const sink = session.sink;
  const mainTurnOrdinal = session.mainTurnOrdinal;
  const hadMainTurn = session.mainTurnInFlight || Boolean(active?.sent && !sink.hasUnstarted(active.messageUuid)) ||
    Boolean(maintenance?.sent && !sink.hasUnstarted(maintenance.uuid));
  if (active?.kind === "rewind") {
    // A checkpoint control request cannot steer or share a process with its
    // replacement. Abort before publishing cancellation so a reentrant prompt
    // must obtain a fresh query; late control failures retain no ownership.
    session.active = null;
    session.queryRestartNeeded = true;
    session.interrupted = true;
    session.abort.abort();
    if (!query) session.abort = new AbortController();
    settleAutonomousTurn(session, context.emit, "canceled");
    denyPendingPermissions(session, context.emit, "Interrupted");
    settleRootTools(session, context.emit, "canceled", "Interrupted");
    if (active.announced) context.emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "canceled" });
    else context.emit({ type: "session.prompt_result", sessionId: session.id,
      clientMessageId: active.clientMessageId, result: { type: "failed", error: { message: "Prompt canceled before delivery" } } });
    return;
  }
  session.active = null;
  settleAutonomousTurn(session, context.emit, "completed");
  if (active) {
    if (active.announced) context.emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "canceled" });
    else context.emit({ type: "session.prompt_result", sessionId: session.id,
      clientMessageId: active.clientMessageId, result: { type: "failed", error: { message: "Prompt canceled before delivery" } } });
  }
  denyPendingPermissions(session, context.emit, "Interrupted");
  settleRootTools(session, context.emit, "canceled", "Interrupted");
  // Terminalize the children owned by this Stop before control I/O yields.
  // A newer turn may have declared different children by the time it returns.
  if (hadMainTurn || active?.sent) session.subagents?.cancelRunningForegroundTasks();
  if (!query) return;
  // Establish result ownership before an asynchronous control request can yield.
  const ownsResult = Boolean((active?.sent || maintenance?.sent) && hadMainTurn);
  if (ownsResult) session.pendingInterruptedResults += 1;
  session.interrupted = hadMainTurn;
  const withdrawing = new Set(sink.pendingUuids);
  const notWithdrawn = await sink.withdraw(async (uuid) => {
    if (!query.cancelAsyncMessage) return false;
    try { return await withTimeout(query.cancelAsyncMessage(uuid), 10_000, "Claude message withdrawal timed out"); }
    catch (error) { console.warn(`[translate-claude] Could not withdraw message: ${describe(error)}`); return false; }
  });
  const retained = new Set(notWithdrawn);
  session.pendingUserAnchors = session.pendingUserAnchors.filter((anchor) => !withdrawing.has(anchor.uuid) || retained.has(anchor.uuid));
  if (session.query !== query || session.mainTurnOrdinal !== mainTurnOrdinal) return;
  if (!hadMainTurn && notWithdrawn.length === 0) return;
  if (!ownsResult && (active?.sent || maintenance?.sent)) session.pendingInterruptedResults += 1;
  session.interrupted = true;
  // The captured query owns this stop; never interrupt a replacement process.
  try { await withTimeout(query.interrupt(), 10_000, "Claude interrupt timed out"); }
  catch (error) { console.warn(`[translate-claude] Interrupt failed: ${describe(error)}`); }
}

/**
 * Active-turn steering (`prompt.steer`), including autonomous background
 * work. The message joins the live query with SDK `next` priority; the
 * daemon falls back to interrupt-and-replace when this reports failure.
 */
async function steerSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
  session: ClaudeSession,
): Promise<void> {
  const active = session.active ?? session.autonomous;
  const query = session.query;
  const sink = session.sink;
  if (active === null || query === null || session.compacting || (session.active !== null && !session.active.sent)) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "There is no active turn to steer" } },
    });
    return;
  }
  if (input.prompt.input.type !== "message") {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "Cannot steer with a slash command" } },
    });
    return;
  }
  let blocks: SdkContentBlock[];
  try {
    blocks = await buildMessageBlocks(input.prompt.input.content, context, session.contextKey);
  } catch (error) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
  // Translation yields to the SDK pump. Never send an old turn's follow-up
  // into a later turn or a rebuilt query after that work settles or stops.
  if (
    session.closed ||
    (session.active ?? session.autonomous) !== active ||
    session.query !== query ||
    session.sink !== sink
  ) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "Active turn changed while translating the follow-up" } },
    });
    return;
  }
  const uuid = randomUUID();
  if (input.prompt.clearPendingPermissions === true) session.permissionClearingEpoch += 1;
  session.pendingUserAnchors.push({
    uuid,
    clientMessageId: input.prompt.clientMessageId,
    text: rawPromptText(input.prompt.input.content),
  });
  sink.push({
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
    priority: "next",
    uuid,
    session_id: session.claudeSessionId ?? "",
  }, input.prompt.clearPendingPermissions === true);
  if (input.prompt.clearPendingPermissions === true) {
    denyPendingPermissions(session, context.emit, "Superseded by a follow-up prompt");
  }
  context.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "steer", turnId: active.turnId },
  });
}

/**
 * Permissions a steer supersedes are denied immediately: leaving them open
 * would block the steered turn on a card the user already moved past.
 */
function denyPendingPermissions(
  session: ClaudeSession,
  emit: (event: ProviderEvent) => void,
  message: string,
): void {
  for (const permissionId of session.pendingPermissions.keys()) {
    const pending = session.pendingPermissions.get(permissionId);
    if (pending === undefined) continue;
    session.pendingPermissions.delete(permissionId);
    pending.cleanup();
    pending.resolve({ behavior: "deny", message });
    emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
  }
}

type SdkContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } };

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isImageMimeType(
  mimeType: string,
): mimeType is "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  return IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Translates text blocks and flattens the rest. Image blocks with a Claude
 * supported mime type travel natively; every other structured attachment
 * passes through serialized (exactly like the ACP provider flattens them),
 * so its JSON is never machine-translated.
 */
async function buildMessageBlocks(
  content: ReadonlyArray<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown } | unknown>,
  context: DispatchContext,
  contextKey: string,
): Promise<SdkContentBlock[]> {
  const values = await context.loadValues();
  const translate = values.translatePrompts
    ? (text: string) =>
        context.translator.translate(text, "user-to-agent", { contextKey })
    : async (text: string) => text;
  const blocks: SdkContentBlock[] = [];
  const displayFragments: PromptTranslationFragment[] = [];
  let hasContent = false;
  let slashCommandIndex = -1;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const translated = await translatePromptFragment((block as { text: string }).text, translate);
      if (!("mimeType" in block) && /^\/[\w:-]+(?:\s|$)/.test((block as { text: string }).text)) slashCommandIndex = blocks.length;
      displayFragments.push({ original: (block as { text: string }).text, translated });
      if (translated.trim().length > 0) hasContent = true;
      blocks.push({ type: "text", text: translated });
    } else if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string" &&
      typeof (block as { mimeType?: unknown }).mimeType === "string" &&
      isImageMimeType((block as { mimeType: string }).mimeType)
    ) {
      hasContent = true;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: (block as { mimeType: "image/jpeg" }).mimeType,
          data: (block as { data: string }).data,
        },
      });
    } else {
      // Structured attachments pass through serialized; their JSON must not
      // be machine-translated.
      blocks.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  if (!hasContent) {
    throw new Error("Refusing to send an empty prompt");
  }
  if (slashCommandIndex >= 0 && slashCommandIndex < blocks.length - 1) {
    const [command] = blocks.splice(slashCommandIndex, 1);
    blocks.push(command);
  }
  if (values.translatePrompts) await context.translator.rememberPromptDisplay(displayFragments, { contextKey });
  return blocks;
}

async function ensureQuery(session: ClaudeSession, context: DispatchContext, preparing?: NonNullable<ClaudeSession["active"]>): Promise<void> {
  if (session.queryRestartNeeded) {
    session.queryRestartNeeded = false;
    if (session.query !== null) await resetQuery(session, context.emit, preparing ?? null);
  }
  if (session.query !== null) return;
  if (session.closed) throw new Error("Claude session is closed");
  session.subagents?.resetProcessTasks();
  const values = await context.loadValues();
  if (session.closed || (preparing && session.active !== preparing)) throw new Error("Claude prompt was canceled during startup");
  if (session.query !== null) return;
  // Prefer the settings override, then the user's PATH claude (their own
  // install and login); the daemon-bundled CLI is only the last resort.
  const executable =
    values.claudeExecutablePath.length > 0 ? values.claudeExecutablePath : resolvePathClaude();
  const permissionMode = session.desiredMode ?? "default";
  assertClaudeMode(permissionMode, { ...process.env, ...session.config.env });
  const providerOptions = resolveProviderOptions(session);
  validateThinking(session.desiredThinking, session.desiredModel);
  const thinking = thinkingStartOptions(session.desiredThinking);
  const settings: Record<string, unknown> = {
    ...providerOptions.settings,
    ...(typeof thinking.settings === "object" ? thinking.settings : {}),

    ...(session.fastMode ? { fastMode: true } : {}),
  };
  if (thinking.effort !== undefined) delete settings.effortLevel;
  const observeEffort = async (input: unknown): Promise<Record<string, never>> => {
    try { session.subagents?.observeHook(input); }
    catch (error) { console.warn(`[translate-claude] Could not observe child effort: ${describe(error)}`); }
    return {};
  };
  const options: Options = {
    cwd: session.config.cwd,
    env: {
      ...process.env,
      ...omitTranslationBridgeEnv(session.config.env),
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    },
    abortController: session.abort,
    // Token-level stream events drive the mid-turn context ring (the timeline
    // itself still renders complete messages).
    includePartialMessages: true,
    forwardSubagentText: true,
    perTaskStopAffordance: true,
    persistSession: session.config.persist,
    hooks: {
      PreToolUse: [{ hooks: [observeEffort] }],
      PostToolUse: [{ hooks: [observeEffort] }],
      SubagentStop: [{ hooks: [observeEffort] }],
    },
    // Mirror the native provider: load the user's settings/CLAUDE.md layers.
    settingSources: ["user", "project", "local"],
    // Required for provider-level file rewind.
    enableFileCheckpointing: true,
    stderr: (data: string) => captureStderr(session, data),
    ...(session.claudeSessionId !== null ? { resume: session.claudeSessionId } : {}),
    ...(session.desiredModel !== null ? { model: session.desiredModel } : {}),
    ...(session.translatedSystemPrompt !== null
      ? {
          // Preset + append keeps Claude Code's built-in system prompt (only
          // the agent-specific instructions are translated), matching the
          // native provider.
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: session.translatedSystemPrompt,
          },
        }
      : {}),
    // Keep the bypass launch capability available so a later
    // setPermissionMode("bypassPermissions") does not fail after a restart
    // (native provider parity).
    allowDangerouslySkipPermissions: true,
    // Like native Paseo, Stop aborts the main turn. Claude can stop a helper
    // explicitly through TaskStop without killing unrelated background work.
    ...(permissionMode !== undefined
      ? { permissionMode: permissionMode as Options["permissionMode"] }
      : {}),
    ...(executable !== null ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(thinking.thinking !== undefined ? { thinking: thinking.thinking } : {}),
    ...(thinking.effort !== undefined ? { effort: thinking.effort } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...providerOptions.spread,
    canUseTool: ((toolName: string, input: Record<string, unknown>, toolOptions: unknown) =>
      requestPermission(
        session,
        toolName,
        input,
        toolOptions as CanUseToolOptions,
        context,
      )) as unknown as NonNullable<Options["canUseTool"]>,
  };
  const servers = normalizeMcpServers(session.config.mcpServers);
  if (servers !== undefined) options.mcpServers = servers;
  session.sink.close();
  session.messages.clear();
  session.toolStream.clear();
  session.sink = new ClaudeMessageInput();
  session.mainTurnInFlight = false;
  session.compacting = false;
  session.commandsPublished = false;
  const query = context.queryFactory({ prompt: session.sink.iterable, options });
  session.query = query;
  session.pump = pumpQuery(session, query, context);
}

/**
 * Passes daemon-configured MCP servers through to the SDK after normalizing
 * the plugin's shape (stdio/http/sse) into the SDK's record shape. Unknown
 * entries are skipped rather than failing the session.
 */
function normalizeMcpServers(
  servers: ProviderSessionConfig["mcpServers"],
): NonNullable<Options["mcpServers"]> {
  const result: NonNullable<Options["mcpServers"]> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (server.type === "stdio") {
      result[name] = {
        type: "stdio",
        command: server.command,
        ...(server.args !== undefined ? { args: [...server.args] } : {}),
        ...(server.env !== undefined ? { env: { ...server.env } } : {}),
        ...(server.alwaysLoad === true ? { alwaysLoad: true } : {}),
      };
    } else if (server.type === "http" || server.type === "sse") {
      result[name] = {
        type: server.type,
        url: server.url,
        ...(server.headers !== undefined ? { headers: { ...server.headers } } : {}),
        ...(server.alwaysLoad === true ? { alwaysLoad: true } : {}),
      };
    }
  }
  return result;
}

/** MCP tool grants from the daemon's tool policy become allowedTools entries. */
function toolPolicyAllowedTools(toolPolicy: ProviderSessionConfig["toolPolicy"]): string[] {
  if (toolPolicy === undefined || !Array.isArray(toolPolicy.preapproved)) return [];
  const grants: string[] = [];
  for (const grant of toolPolicy.preapproved) {
    if (
      typeof grant === "object" &&
      grant !== null &&
      (grant as { kind?: unknown }).kind === "mcp" &&
      typeof (grant as { server?: unknown }).server === "string" &&
      typeof (grant as { tool?: unknown }).tool === "string"
    ) {
      grants.push(`mcp__${(grant as { server: string }).server}__${(grant as { tool: string }).tool}`);
    }
  }
  return grants;
}

/**
 * Applies daemon provider options (allowedTools/disallowedTools/sandbox/
 * settings) and the daemon tool policy (MCP preapprovals → allowedTools) to
 * SDK option fragments. Fail-soft on every malformed field: a bad option
 * degrades to "not applied" instead of breaking the session.
 */
function resolveProviderOptions(session: ClaudeSession): {
  spread: Pick<Options, "allowedTools" | "disallowedTools" | "sandbox" | "additionalDirectories" | "extraArgs">;
  settings: Record<string, unknown>;
} {
  const allowedTools = toolPolicyAllowedTools(session.config.toolPolicy);
  const disallowedTools: string[] = [];
  const additionalDirectories: string[] = [];
  const settings: Record<string, unknown> = {};
  let sandbox: unknown;
  const extraArgs: Record<string, string | null> = {};
  const raw = session.config.providerOptions;
  if (typeof raw === "object" && raw !== null) {
    for (const key of ["allowedTools", "disallowedTools", "additionalDirectories"] as const) {
      const list = (raw as Record<string, unknown>)[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry !== "string" || entry.length === 0) continue;
        if (key === "allowedTools") allowedTools.push(entry);
        else if (key === "disallowedTools") disallowedTools.push(entry);
        else additionalDirectories.push(entry);
      }
    }
    const rawArgs = (raw as Record<string, unknown>)["extraArgs"];
    if (typeof rawArgs === "object" && rawArgs !== null) {
      for (const [flag, value] of Object.entries(rawArgs)) {
        if (typeof value === "string" || value === null) extraArgs[flag] = value;
      }
    }
    const rawSettings = (raw as Record<string, unknown>)["settings"];
    if (typeof rawSettings === "object" && rawSettings !== null) {
      Object.assign(settings, rawSettings as Record<string, unknown>);
    }
    const rawSandbox = (raw as Record<string, unknown>)["sandbox"];
    if (typeof rawSandbox === "object" && rawSandbox !== null) {
      sandbox = rawSandbox;
    }
  }
  return {
    spread: {
      ...(Object.keys(extraArgs).length ? { extraArgs } : {}),
      ...(allowedTools.length > 0 ? { allowedTools: [...new Set(allowedTools)] } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools: [...new Set(disallowedTools)] } : {}),
      ...(additionalDirectories.length > 0
        ? { additionalDirectories: [...new Set(additionalDirectories)] }
        : {}),
      ...(sandbox !== undefined ? { sandbox: sandbox as NonNullable<Options["sandbox"]> } : {}),
    },
    settings,
  };
}

function captureStderr(session: ClaudeSession, data: string): void {
  const line = data.trim();
  if (line.length === 0) return;
  console.error(`[translate-claude] ${line}`);
  session.recentStderr = `${session.recentStderr}\n${line}`.slice(-4000);
}

/**
 * Publishes the CLI's slash-command list once the query exists. Failures are
 * silent and retried on the next turn or init frame: commands are
 * discoverability, never a turn blocker.
 */
async function publishCommands(session: ClaudeSession, context: DispatchContext): Promise<void> {
  if (session.commandsPublished || session.query?.supportedCommands === undefined || session.closed) {
    return;
  }
  try {
    const commands = await withTimeout(
      session.query.supportedCommands(),
      10_000,
      "command probe timed out",
    );
    if (session.closed) return;
    session.commandsPublished = true;
    const seen = new Map<string, ProviderCommand>([["rewind", { name: "rewind", description: "Rewind tracked files to a previous user message", argumentHint: "[user_message_uuid]" }]]);
    for (const command of commands) {
      if (command === null || typeof command !== "object") continue;
      const info = command as { name?: unknown; description?: unknown; argumentHint?: unknown };
      if (typeof info.name !== "string" || info.name.length === 0 || seen.has(info.name)) continue;
      seen.set(info.name, {
        name: info.name,
        description: typeof info.description === "string" ? info.description : "",
        ...(typeof info.argumentHint === "string" && info.argumentHint.length > 0
          ? { argumentHint: info.argumentHint }
          : {}),
      });
    }
    context.emit({
      type: "session.commands",
      sessionId: session.id,
      commands: [...seen.values()],
    });
  } catch {
    // Retry on the next turn or init frame.
  }
}

/** Thinking selection → query-start options (none for "default"). */
function thinkingStartOptions(thinking: string | null): Pick<Options, "thinking" | "effort" | "settings"> {
  if (thinking === null || thinking === "default") return {};
  if (thinking === "adaptive") return { thinking: { type: "adaptive" } };
  if (thinking === "off") return { thinking: { type: "disabled" } };
  if (thinking === "ultracode") return { thinking: { type: "adaptive" }, effort: "xhigh", settings: { ultracode: true } };
  if (START_EFFORT.has(thinking) || thinking === "max") {
    return { thinking: { type: "adaptive" }, effort: thinking as NonNullable<Options["effort"]> };
  }
  throw new Error(`Unknown Claude thinking option: ${thinking}`);
}

function observePermissionMode(session: ClaudeSession, mode: string): void {
  const previous = session.desiredMode ?? "default";
  session.desiredMode = mode;
  if (mode === "plan") {
    if (previous !== "plan") session.planResumeMode = previous;
  } else session.planResumeMode = mode;
}

function validateThinking(thinking: string | null, model: string | null): void {
  thinkingStartOptions(thinking);
  if (thinking === "off" && findClaudeModel(model)?.supportsThinkingDisabled !== true) {
    throw new Error(`Thinking cannot be disabled for model ${model ?? "default"}`);
  }
}

/** Commit each live setting only after the corresponding SDK call succeeds. */
async function applyConfigChanges(
  session: ClaudeSession,
  changes: { model?: string | null; mode?: string | null; thinkingOption?: string | null; settings?: Readonly<Record<string, unknown>> },
): Promise<void> {
  const model = Object.hasOwn(changes, "model") ? readConfigured(changes.model ?? undefined) : session.desiredModel;
  const nextModel = model === "default" ? null : model ?? null;
  const thinking = Object.hasOwn(changes, "thinkingOption") ? readConfigured(changes.thinkingOption ?? undefined) : session.desiredThinking;
  const nextThinking = thinking === "default" ? null : thinking ?? null;
  if (Object.hasOwn(changes, "thinkingOption")) validateThinking(nextThinking, nextModel);
  if (Object.hasOwn(changes, "mode")) assertClaudeMode(changes.mode ?? "default", { ...process.env, ...session.config.env });
  if (Object.hasOwn(changes, "model")) {
    if (session.query) {
      if (!session.query.setModel) throw new Error("Claude does not support live model changes");
      await session.query.setModel(nextModel ?? undefined);
    }
    session.desiredModel = nextModel;
    session.runtimeModel = null;
    session.fastModeSupported = claudeModelSupportsFastMode(nextModel);
    session.contextWindowMaxTokens = findClaudeModel(nextModel)?.contextWindowMaxTokens ?? null;
    if (session.desiredThinking === "off" && findClaudeModel(nextModel)?.supportsThinkingDisabled !== true) {
      session.desiredThinking = findClaudeModel(nextModel)?.defaultThinkingOption ?? null;
      session.queryRestartNeeded = true;
    }
    if (session.fastMode && !session.fastModeSupported) {
      if (session.query) {
        if (!session.query.applyFlagSettings) throw new Error("Claude does not support live fast-mode changes");
        await session.query.applyFlagSettings({ fastMode: false });
      }
      session.fastMode = false;
    }
  }
  if (Object.hasOwn(changes, "mode")) {
    const mode = changes.mode ?? "default";
    if (session.query) {
      if (!session.query.setPermissionMode) throw new Error("Claude does not support live permission-mode changes");
      await session.query.setPermissionMode(mode);
    }
    observePermissionMode(session, mode);
  }
  if (Object.hasOwn(changes, "thinkingOption") && session.desiredThinking !== nextThinking) {
    session.desiredThinking = nextThinking;
    // Constructor-level thinking options must be rebuilt at the next turn;
    // flag settings cannot override a query launched with thinking disabled.
    session.queryRestartNeeded = session.query !== null;
  }
  if (changes.settings && Object.hasOwn(changes.settings, "fast_mode")) {
    const enabled = changes.settings.fast_mode === true;
    if (enabled && !session.fastModeSupported) throw new Error("Fast mode is unavailable for the selected Claude model");
    if (session.query) {
      if (!session.query.applyFlagSettings) throw new Error("Claude does not support live fast-mode changes");
      await session.query.applyFlagSettings({ fastMode: enabled });
    }
    session.fastMode = enabled;
  }
}

/** Last catalog mapped from the CLI; reused for session.config states. */
let catalogModelsCache: ProviderModel[] | null = null;

/**
 * Probes the CLI for its real model list (same data the native provider
 * surface shows) through a throwaway query, then discards the process.
 */
async function probeCatalog(context: DispatchContext): Promise<{
  models: ProviderModel[];
  modes: ProviderMode[];
  defaultMode: string;
}> {
  const models = await probeModels(context);
  return { models, ...claudeModeCatalog(process.env) };
}

async function probeModels(context: DispatchContext): Promise<ProviderModel[]> {
  const values = await context.loadValues();
  const executable =
    values.claudeExecutablePath.length > 0 ? values.claudeExecutablePath : resolvePathClaude();
  const abort = new AbortController();
  const version = context.resolveVersion(executable).catch(() => undefined);
  const configDir = resolveConfiguredClaudeConfigDir(values.claudeConfigDir);
  const sink = new ClaudeMessageInput();
  let models: ProviderModel[] = [];
  try {
    const query = context.queryFactory({ prompt: sink.iterable, options: {
      cwd: process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, abortController: abort,
      persistSession: false, tools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: ["user"], settings: { disableAllHooks: true },
      ...(executable !== null ? { pathToClaudeCodeExecutable: executable } : {}),
    } });
    if (query.supportedModels) {
      const infos = await withTimeout(query.supportedModels(), 5_000, "model probe timed out");
      models = infos.map(modelInfoToProviderModel);
    }
  } catch {
    // A failed probe does not remove curated or configured model choices.
  } finally {
    sink.close();
    abort.abort();
  }
  const catalog = await completeClaudeCatalog(models, configDir, await version);
  catalogModelsCache = catalog;
  return catalog;
}

function modelInfoToProviderModel(info: ModelInfoLike): ProviderModel {
  const thinkingOptions = thinkingOptionsForModel(info);
  const manifest = findClaudeModel(info.value);
  return {
    id: info.value,
    label: info.displayName ?? info.value,
    ...(info.description !== undefined ? { description: info.description } : {}),
    ...(manifest?.contextWindowMaxTokens !== undefined
      ? { contextWindowMaxTokens: manifest.contextWindowMaxTokens }
      : {}),
    thinkingOptions,
    defaultThinkingOptionId: thinkingOptions.find((option) => option.isDefault)?.id,
  };
}

function thinkingOptionsForModel(
  info: ModelInfoLike,
): NonNullable<ProviderModel["thinkingOptions"]> {
  const options: NonNullable<ProviderModel["thinkingOptions"]> = [
    { id: "default", label: "Default", isDefault: true },
  ];
  if (findClaudeModel(info.value)?.supportsThinkingDisabled === true) options.push({ id: "off", label: "Off" });
  if (info.supportsAdaptiveThinking === true) {
    options.push({ id: "adaptive", label: "Adaptive" });
  }
  if (info.supportsEffort === true && Array.isArray(info.supportedEffortLevels)) {
    for (const level of info.supportedEffortLevels) {
      options.push({ id: level, label: labelForEffort(level) });
    }
  }
  if (info.supportedEffortLevels?.includes("xhigh")) options.push({ id: "ultracode", label: "Ultra Code" });
  return options;
}

function labelForEffort(level: string): string {
  return level === "xhigh" ? "Extra high" : level === "max" ? "Max" : level[0].toUpperCase() + level.slice(1);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs) as unknown as NodeJS.Timeout;
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface CanUseToolOptions {
  signal: AbortSignal;
  title?: string;
  displayName?: string;
  description?: string;
  /** SDK permission suggestions (e.g. always-allow rules) for the card. */
  suggestions?: unknown;
  requestId: string;
  toolUseID?: string;
}

function requestPermission(
  session: ClaudeSession,
  toolName: string,
  input: Record<string, unknown>,
  toolOptions: CanUseToolOptions,
  context: DispatchContext,
): Promise<PermissionResultLike | null> {
  if (isAskUserQuestionRequest(toolName, input)) {
    return requestQuestionPermission(session, input, toolOptions, context);
  }
  return requestToolPermission(session, toolName, input, toolOptions, context);
}

function waitForPermissionResponse(
  session: ClaudeSession,
  permissionId: string,
  request: Extract<ProviderEvent, { type: "session.permission" }>["request"],
  toolOptions: CanUseToolOptions,
  emit: (event: ProviderEvent) => void,
  question?: PendingPermission["question"],
  plan = false,
): Promise<PermissionResultLike | null> {
  if (session.closed || toolOptions.signal.aborted) {
    return Promise.resolve({ behavior: "deny", message: "Permission request expired" });
  }
  if (session.sink.clearsPermissions) {
    return Promise.resolve({ behavior: "deny", message: "Superseded by a follow-up prompt" });
  }
  return new Promise((resolve) => {
    const abort = () => {
      const pending = session.pendingPermissions.get(permissionId);
      if (!pending) return;
      session.pendingPermissions.delete(permissionId);
      pending.cleanup();
      pending.resolve({ behavior: "deny", message: "Permission request expired" });
      emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
    };
    session.pendingPermissions.set(permissionId, {
      resolve, cleanup: () => toolOptions.signal.removeEventListener("abort", abort),
      ...(question !== undefined ? { question } : {}),
      ...(plan ? { plan: true } : {}),
    });
    toolOptions.signal.addEventListener("abort", abort, { once: true });
    emit({ type: "session.permission", sessionId: session.id, request });
  });
}

function requestToolPermission(
  session: ClaudeSession,
  toolName: string,
  input: Record<string, unknown>,
  toolOptions: CanUseToolOptions,
  context: DispatchContext,
): Promise<PermissionResultLike | null> {
  const emit = (event: ProviderEvent) => context.emit(event);
  const permissionId = toolOptions.requestId;
  const kind = resolvePermissionKind(toolName, input);
  return waitForPermissionResponse(
    session,
    permissionId,
    {
      id: permissionId,
      name: toolName,
      kind,
      ...(toolOptions.title !== undefined ? { title: toolOptions.title } : {}),
      ...(toolOptions.description !== undefined
        ? { description: toolOptions.description }
        : toolOptions.displayName !== undefined
          ? { description: toolOptions.displayName }
          : {}),
      // The SDK hands a plain JSON object; round-trip keeps the wire shape
      // the daemon's JsonValue contract expects.
      input: JSON.parse(JSON.stringify(input)),
      // The SDK's permission suggestions (e.g. "always allow") ride along so
      // the app can offer them with the card.
      ...(toolOptions.suggestions !== undefined
        ? { suggestions: JSON.parse(JSON.stringify(toolOptions.suggestions)) }
        : {}),
      ...(kind === "plan"
        ? {
            metadata: {
              ...(toolOptions.toolUseID ? { toolUseId: toolOptions.toolUseID } : {}),
              ...(typeof input.plan === "string" && input.plan.length > 0
                ? { planText: input.plan }
                : {}),
            },
            actions: buildPlanPermissionActions(session.planResumeMode),
          }
        : {}),
      ...(kind !== "plan" && toolOptions.toolUseID ? { metadata: { toolUseId: toolOptions.toolUseID } } : {}),
      ...(kind === "tool"
        ? {
            detail: describeRunningTool(toolName, input),
            actions: [
              { id: "allow", label: "Allow", behavior: "allow" },
              { id: "deny", label: "Deny", behavior: "deny" },
            ],
          }
        : {}),
    },
    toolOptions,
    emit,
    undefined,
    kind === "plan",
  );
}

/** Mirrors the native provider's kind resolution: plan / question / tool. */
function resolvePermissionKind(
  toolName: string,
  input: Record<string, unknown>,
): "tool" | "plan" | "question" {
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) return "question";
  return "tool";
}

/** Plan cards offer Reject / Implement (+ resume-bypass when applicable). */
function buildPlanPermissionActions(resumeMode: string | null): ProviderPermissionActions {
  const actions: ProviderPermissionActions = [
    { id: "reject", label: "Reject", behavior: "deny", variant: "danger", intent: "dismiss" },
    { id: "implement", label: "Implement", behavior: "allow", variant: "primary", intent: "implement" },
  ];
  if (resumeMode === "bypassPermissions") {
    actions.push({
      id: "implement_resume",
      label: "Implement with Bypass",
      behavior: "allow",
      variant: "secondary",
      intent: "implement_resume",
    });
  }
  return actions;
}

/**
 * AskUserQuestion surfaces as a `question` permission (the app's
 * QuestionFormCard) instead of a generic Allow/Deny tool card. Question
 * strings are translated into the user language before emitting; a failed
 * display translation degrades to the original text so the turn survives.
 */
async function requestQuestionPermission(
  session: ClaudeSession,
  input: Record<string, unknown>,
  toolOptions: CanUseToolOptions,
  context: DispatchContext,
): Promise<PermissionResultLike | null> {
  const emit = (event: ProviderEvent) => context.emit(event);
  const cancellationEpoch = session.cancellationEpoch;
  const query = session.query;
  const permissionClearingEpoch = session.permissionClearingEpoch;
  if (session.sink.clearsPermissions) {
    return { behavior: "deny", message: "Superseded by a follow-up prompt" };
  }
  const permissionId = toolOptions.requestId;
  const requestInput = normalizeQuestionRequestInput(
    JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
  );
  const originalQuestions = Array.isArray(requestInput.questions)
    ? (requestInput.questions as unknown[])
    : [];
  let translatedQuestions = originalQuestions;
  try {
    const values = await context.loadValues();
    if (values.translateResponses) {
      translatedQuestions = await translateQuestionsForDisplay(originalQuestions, (text) =>
        context.translator.translate(text, "agent-to-user", { contextKey: session.contextKey }),
      );
    }
  } catch {
    // Display-only: keep the original text rather than breaking the turn.
    translatedQuestions = originalQuestions;
  }
  if (toolOptions.signal.aborted || session.closed ||
      session.cancellationEpoch !== cancellationEpoch || session.query !== query ||
      session.permissionClearingEpoch !== permissionClearingEpoch) {
    // The turn went away while the display translation was in flight
    // (close, teardown, or SDK abort): deny without emitting or registering,
    // so no ghost card appears and no pending is left for teardown to wait on.
    return { behavior: "deny", message: "Permission request expired" };
  }
  const summary = summarizeQuestions({ questions: translatedQuestions });
  return waitForPermissionResponse(
    session,
    permissionId,
    {
      id: permissionId,
      name: ASK_USER_QUESTION_TOOL,
      kind: "question",
      ...summary,
      input: JSON.parse(JSON.stringify({ ...requestInput, questions: translatedQuestions })),
    },
    toolOptions,
    emit,
    { requestInput, translatedQuestions },
  );
}

async function respondToPermission(
  session: ClaudeSession | undefined,
  permissionId: string,
  response: ProviderPermissionResponse,
  context: DispatchContext,
): Promise<void> {
  const emit = (event: ProviderEvent) => context.emit(event);
  if (session === undefined) return;
  const pending = session.pendingPermissions.get(permissionId);
  if (!pending || pending.resolving) return;
  pending.resolving = true;
  let result: PermissionResultLike | null;
  if (response.behavior === "deny") {
    result = { behavior: "deny", message: response.message ?? "Denied", interrupt: response.interrupt };
  } else if (pending.question) {
    const question = pending.question;
    result = await new Promise<PermissionResultLike | null>((resolve) => {
      void resolveQuestionAllow(question, response, resolve, context, session.contextKey);
    });
  } else {
    result = { behavior: "allow", updatedInput: response.updatedInput, updatedPermissions: response.updatedPermissions };
    if (pending.plan) {
      const targetMode = response.selectedActionId === "implement_resume" && session.planResumeMode === "bypassPermissions"
        ? "bypassPermissions" : "acceptEdits";
      try {
        await applyConfigChanges(session, { mode: targetMode });
        if (session.forkConfiguration) emit({ type: "session.persistence", sessionId: session.id, persistence: claudePersistence(session) });
        emit({ type: "session.config", sessionId: session.id, config: configStateFor(session) });
      } catch (error) {
        result = { behavior: "deny", message: `Could not apply plan permission mode: ${describe(error)}` };
      }
    }
  }
  // A Stop or SDK abort can settle a request while its answer is translating
  // or its plan mode is being applied. Never approve it after cancellation.
  if (session.pendingPermissions.get(permissionId) !== pending) return;
  session.pendingPermissions.delete(permissionId);
  pending.cleanup();
  pending.resolve(result);
  emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
}

/**
 * Fail closed: answers are translated into the agent language before Claude
 * sees them. A failed translation denies the request instead of leaking
 * user-language text to the agent. Keys map back from the translated headers
 * the UI answered with to Claude's question-text keys.
 */
async function resolveQuestionAllow(
  question: NonNullable<PendingPermission["question"]>,
  response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
  resolve: (response: PermissionResultLike | null) => void,
  context: DispatchContext,
  contextKey: string,
): Promise<void> {
  try {
    const values = await context.loadValues();
    const translate = values.translatePrompts
      ? (text: string) =>
          context.translator.translate(text, "user-to-agent", { contextKey })
      : async (text: string) => text;
    const answers = await resolveQuestionAnswers(
      question.translatedQuestions,
      Array.isArray(question.requestInput.questions)
        ? (question.requestInput.questions as unknown[])
        : [],
      response.updatedInput,
      translate,
    );
    resolve({
      behavior: "allow",
      updatedInput: { ...stripQuestionUiMetadata(question.requestInput), answers },
      updatedPermissions: response.updatedPermissions,
    });
  } catch (error) {
    resolve({
      behavior: "deny",
      message: `Translating the answers failed, so the question was declined: ${describe(error)}`,
    });
  }
}

/**
 * The long-lived query's message pump.
 *
 * A `session.interrupt` never ends this iteration: the SDK's `query()` is a
 * one-shot generator over the CLI's output stream, and `query.interrupt()` is
 * a control request that the CLI answers with a terminal *result* frame (the
 * "aborted" result the result handler suppresses), not an iterator failure.
 * Keep reading task termination notifications and subsequent prompts; only
 * the stream erroring or closing ends this pump.
 */
async function pumpQuery(
  session: ClaudeSession,
  query: ClaudeQueryHandle,
  context: DispatchContext,
): Promise<void> {
  const emit = (event: ProviderEvent) => context.emit(event);
  try {
    for await (const message of query) {
      if (session.closed || session.detached || session.query !== query) return;
      const maintenance = session.cacheMaintenance !== null;
      observeCacheBackgroundTask(session, message);
      if (!(message.type === "result" && session.pendingInterruptedResults > 0)) {
        context.cacheCoordinator?.observe(session.contextKey, message, cacheTtlOverride(session), maintenance);
      }
      handleSdkMessage(session, message, context);
      if (message.type !== "stream_event") context.cacheCoordinator?.refresh();
    }
  } catch (error) {
    if (session.closed) return;
    if (session.detached) {
      session.detached = false;
      return;
    }
    context.cacheCoordinator?.finish(session.contextKey, false);
    context.cacheCoordinator?.invalidate(session.contextKey);
    session.cacheMaintenance = null;
    finishDeadQuery(session, describe(error), emit);
    return;
  }
  if (session.closed) return;
  if (session.detached) {
    session.detached = false;
    return;
  }
  context.cacheCoordinator?.finish(session.contextKey, false);
  context.cacheCoordinator?.invalidate(session.contextKey);
  session.cacheMaintenance = null;
  finishDeadQuery(session, "Claude exited unexpectedly", emit);
}

function cacheTtlOverride(session: ClaudeSession): "5m" | "1h" | undefined {
  const env = session.config.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  if (env === "5m" || env === "1h") return env;
  const settings = session.config.providerOptions?.settings;
  if (typeof settings === "object" && settings !== null) {
    const ttl = (settings as Record<string, unknown>).promptCacheTtl;
    if (ttl === "5m" || ttl === "1h") return ttl;
  }
  return undefined;
}

/** Include background shells, which deliberately do not appear as subagent panes. */
function observeCacheBackgroundTask(session: ClaudeSession, message: SDKMessage): void {
  const task = message as unknown as { type: string; subtype?: string; task_id?: string;
    task_type?: string; tasks?: Array<{ task_id?: string; id?: string }>;
    parent_tool_use_id?: unknown; status?: string; patch?: { status?: string } };
  if (task.type !== "system" || typeof task.parent_tool_use_id === "string") return;
  if (task.subtype === "background_tasks_changed" && Array.isArray(task.tasks)) {
    const live = new Set(task.tasks.map((entry) => entry.task_id ?? entry.id));
    for (const id of session.cacheBackgroundTasks) if (!live.has(id)) session.cacheBackgroundTasks.delete(id);
  }
  if (typeof task.task_id !== "string") return;
  // Agent/workflow completion levels are already tracked by ClaudeSubagentTracker.
  if (task.subtype === "task_started" && task.task_type === "local_bash") session.cacheBackgroundTasks.add(task.task_id);
  if (task.subtype === "task_notification" || task.subtype === "task_updated") {
    const status = task.patch?.status ?? task.status;
    if (status === "completed" || status === "failed" || status === "killed" || status === "canceled") {
      session.cacheBackgroundTasks.delete(task.task_id);
    }
  }
}

/**
 * The long-lived query is gone (the CLI process died). Reset it so the next
 * prompt rebuilds the process from the latest Claude session id, settle the
 * active turn (canceled when the user interrupted, failed otherwise), and
 * only surface a runtime failure when the exit was not interrupt-driven.
 */

function settleRootTools(
  session: ClaudeSession,
  emit: (event: ProviderEvent) => void,
  status: "canceled" | "failed",
  message: string,
): void {
  for (const [id, name] of session.toolNames) {
    emit({ type: "timeline.item", sessionId: session.id,
      item: { type: "tool_call", id, callId: id, name,
        detail: describeFinishedTool(name, session.toolInputs.get(id), message),
        ...(status === "failed" ? { status, error: message } : { status, error: null }) } });
  }
  session.toolNames.clear();
  session.toolInputs.clear();
}

function finishDeadQuery(
  session: ClaudeSession,
  message: string,
  emit: (event: ProviderEvent) => void,
): void {
  session.query = null;
  session.pump = null;
  session.abort.abort();
  session.abort = new AbortController();
  session.sink.close();
  session.messages.clear();
  session.toolStream.clear();
  session.pendingUserAnchors = [];
  session.mainTurnInFlight = false;
  session.compacting = false;
  const wasInterrupted = session.interrupted;
  session.interrupted = false;
  session.pendingInterruptedResults = 0;
  const active = session.active;
  if (active !== null && (active.announced || !wasInterrupted)) {
    session.active = null;
    if (!active.announced) {
      emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: active.clientMessageId,
        result: { type: "failed", error: { message } } });
    } else if (wasInterrupted) {
      emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "canceled" });
    } else {
      emit({
        type: "session.turn",
        sessionId: session.id,
        turnId: active.turnId,
        state: "failed",
        error: { message },
      });
    }
  }
  settleRootTools(session, emit, wasInterrupted ? "canceled" : "failed", message);
  // A dead process ends backgrounded work too: its autonomous turn settles
  // alongside the foreground one (canceled when the user interrupted).
  if (session.autonomous !== null) {
    settleAutonomousTurn(session, emit, wasInterrupted ? "canceled" : "failed", wasInterrupted ? undefined : message);
  }
  // An interrupt ends foreground children; a dead process fails everything
  // still running, including backgrounded work that outlived its turn.
  if (wasInterrupted) session.subagents?.cancelRunningForegroundTasks();
  session.subagents?.failRunningTasks();
  for (const pending of session.pendingPermissions.values()) {
    pending.cleanup();
    pending.resolve({ behavior: "deny", message: "Claude session ended" });
  }
  session.pendingPermissions.clear();
  if (!wasInterrupted) {
    emit({
      type: "session.runtime_failed",
      sessionId: session.id,
      error: {
        message,
        ...(session.recentStderr.length > 0 ? { diagnostic: session.recentStderr } : {}),
      },
    });
  }
}

/**
 * Mirrors the native provider's main-session wake-up turn. Child output
 * continues on its own timeline without opening a root turn.
 */
function startAutonomousTurn(session: ClaudeSession, emit: (event: ProviderEvent) => void): void {
  if (session.autonomous !== null) return;
  const turnId = randomUUID();
  session.autonomous = { turnId };
  emit({ type: "session.turn", sessionId: session.id, turnId, state: "started" });
}

/** Ends the open autonomous turn, if any, with the given terminal state. */
function settleAutonomousTurn(
  session: ClaudeSession,
  emit: (event: ProviderEvent) => void,
  state: "completed" | "failed" | "canceled",
  error?: string,
): void {
  const autonomous = session.autonomous;
  if (autonomous === null) return;
  session.autonomous = null;
  emit({
    type: "session.turn",
    sessionId: session.id,
    turnId: autonomous.turnId,
    state,
    ...(error !== undefined ? { error: { message: error } } : {}),
  });
}

function handleSdkMessage(
  session: ClaudeSession,
  message: SDKMessage,
  context: DispatchContext,
): void {
  const emit = (event: ProviderEvent) => context.emit(event);
  const lifecycle = message as unknown as { type?: unknown; state?: unknown; command_uuid?: unknown };
  if (lifecycle.type === "command_lifecycle" && typeof lifecycle.command_uuid === "string" &&
      typeof lifecycle.state === "string" && lifecycle.state !== "queued") {
    session.sink.started(lifecycle.command_uuid);
    if (lifecycle.state === "started") session.mainTurnInFlight = true;
    else session.pendingUserAnchors = session.pendingUserAnchors.filter((anchor) => anchor.uuid !== lifecycle.command_uuid);
    return;
  }
  if (message.type === "system" && message.subtype === "init") {
    // A fresh main-loop bracket proves an older interrupted request is over,
    // including an idle interrupt that never produced a result at all.
    session.mainTurnInFlight = true;
    session.mainTurnOrdinal += 1;
    session.interrupted = false;
    session.pendingInterruptedResults = 0;
    if (message.session_id) {
      session.claudeSessionId = message.session_id;
      emit({ type: "session.persistence", sessionId: session.id, persistence: claudePersistence(session) });
    }
    if (message.model) {
      if (session.runtimeModel !== null && session.runtimeModel !== message.model) session.cacheInvalidate?.();
      session.runtimeModel = message.model;
      session.contextWindowMaxTokens = findClaudeModel(message.model)?.contextWindowMaxTokens ?? session.contextWindowMaxTokens;
    }
    if (isClaudeMode(message.permissionMode)) observePermissionMode(session, message.permissionMode);
    emit({ type: "session.config", sessionId: session.id, config: configStateFor(session) });
  }
  // Session state includes background children: "running" never opens a
  // root turn. "idle" closes a wake-up turn, but may trail an earlier
  // request, so it must never close a newly submitted foreground turn.
  if (message.type === "system" && message.subtype === "session_state_changed") {
    if (message.state === "idle") {
      session.mainTurnInFlight = false;
      settleAutonomousTurn(session, emit, "completed");
    }
    return;
  }
  // Only Claude's own turn bracket starts autonomous root work. Background
  // task frames, child text and tool heartbeats have no root result to close
  // a turn, and must not make the daemon replace an imaginary active run.
  if (
    session.active === null &&
    !session.interrupted &&
    session.pendingInterruptedResults === 0 &&
    message.type === "system" && message.subtype === "init"
  ) {
    startAutonomousTurn(session, emit);
  }
  // The Task protocol owns subagent identity and status; sidechain frames
  // only feed the timelines of children it declared.
  if (session.subagents?.observeSystemMessage(message) === true) return;
  if (message.type === "system") {
    if (message.subtype === "init") void publishCommands(session, context);
    if (message.subtype === "status") {
      if (message.permissionMode && isClaudeMode(message.permissionMode)) {
        observePermissionMode(session, message.permissionMode);
        emit({ type: "session.config", sessionId: session.id, config: configStateFor(session) });
      }
      session.compacting = message.status === "compacting";
      noteCompactionStatus(session, message, emit);
      return;
    }
    if (message.subtype === "compact_boundary") {
      session.compacting = false;
      if (session.cacheMaintenance) session.cacheMaintenance.boundarySeen = true;
      noteCompactionBoundary(session, message, emit);
      return;
    }
    return;
  }
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (typeof parentToolUseId === "string" && parentToolUseId.length > 0) {
    session.subagents?.handleSidechainMessage(message, parentToolUseId);
    return;
  }
  if (message.type === "stream_event") {
    // Partial deltas power the mid-turn context ring; the timeline keeps
    // rendering complete messages. Sidechain frames already returned above
    // so they never move the parent ring.
    noteStreamEventUsage(session, message, emit);
    if (session.cacheMaintenance) return;
    for (const item of session.toolStream.observe(message, session.toolNames, session.toolInputs)) {
      if (item.type === "tool_call") session.subagents?.noteRootToolUse(item.callId, item.name, session.toolInputs.get(item.callId));
      emit({ type: "timeline.item", sessionId: session.id, item });
    }
    for (const item of session.messages.observe(message)) emit({ type: "timeline.item", sessionId: session.id, item });
    return;
  }
  if (message.type === "assistant" && message.parent_tool_use_id === null) {
    noteAssistantContextUsage(session, message.message);
    if (session.cacheMaintenance) return;
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const item of session.messages.observe(message)) emit({ type: "timeline.item", sessionId: session.id, item });
    for (const block of content) {
      if (typeof block === "object" && block !== null &&
          (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use")) {
        const use = block as { id: string; name: string; input?: unknown };
        if (typeof use.id !== "string" || typeof use.name !== "string") continue;
        session.toolNames.set(use.id, use.name);
        session.toolInputs.set(use.id, use.input);
        session.subagents?.noteRootToolUse(use.id, use.name, use.input);
        emit({
          type: "timeline.item",
          sessionId: session.id,
          item: {
            type: "tool_call",
            id: use.id,
            callId: use.id,
            name: use.name,
            status: "running",
            error: null,
            detail: describeRunningTool(use.name, use.input),
          },
        });
      }
    }
    return;
  }
  if (message.type === "user" && message.parent_tool_use_id === null) {
    if (session.cacheMaintenance && message.uuid === session.cacheMaintenance.uuid) {
      session.sink.started(session.cacheMaintenance.uuid);
      return;
    }
    noteRewindAnchor(session, message, emit);
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "tool_result"
      ) {
        const result = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
        const output = flattenToolResult(result.content);
        const name = session.toolNames.get(result.tool_use_id) ?? "tool";
        emit({
          type: "timeline.item",
          sessionId: session.id,
          item: {
            type: "tool_call",
            id: result.tool_use_id,
            callId: result.tool_use_id,
            name,
            ...(result.is_error
              ? { status: "failed" as const, error: output.text ?? "Tool failed" }
              : { status: "completed" as const, error: null }),
            detail: describeFinishedTool(name, session.toolInputs.get(result.tool_use_id), output.text),
          },
        });
        session.toolNames.delete(result.tool_use_id);
        session.toolInputs.delete(result.tool_use_id);
        // Tool results can carry screenshots as base64 image blocks. Base64
        // must never reach timeline text (it would be sent to the
        // translation endpoint), so each image is materialized to a
        // content-hashed file and referenced as `![Image](file://…)` markdown
        // exactly like the native providers; the host app renders those
        // natively and the timeline transformer passes them through
        // untranslated. The tool text keeps one "[image]" marker per
        // screenshot instead; the pixels stay available to Claude in the SDK
        // transcript.
        for (const [index, image] of output.images.entries()) {
          const materialized = materializeImageOutput(image.data, image.mimeType);
          emit({
            type: "timeline.item",
            sessionId: session.id,
            item: {
              type: "assistant_message",
              id: `${result.tool_use_id}-image-${index}`,
              text:
                materialized !== null
                  ? renderImageOutputMarkdown(materialized.uri)
                  : "Image output was omitted because it was not available as a file path or URL.",
            },
          });
        }
      }
    }
    return;
  }
  if (message.type === "result") {
    session.mainTurnInFlight = false;
    session.compacting = false;
    // Detect a missing resume against the id we asked the SDK to resume,
    // BEFORE overwriting it with this result's session_id. Official result
    // fixtures often omit session_id entirely; matching the stored id is
    // the only reliable signal.
    const missingConversation = readMissingConversationError(message, session.claudeSessionId);
    if (missingConversation !== null) {
      if (session.cacheMaintenance) {
        session.cacheMaintenance = null;
        context.cacheCoordinator?.finish(session.contextKey, false);
      }
      context.cacheCoordinator?.invalidate(session.contextKey);
      session.claudeSessionId = null;
      emit({
        type: "session.persistence",
        sessionId: session.id,
        persistence: { version: 1, data: {} },
      });
      emit({
        type: "session.notice",
        sessionId: session.id,
        notice: {
          id: "claude-resume-missing",
          severity: "warning",
          title: "Claude session not found",
          description:
            "The stored Claude transcript is gone; the next prompt starts a fresh session. " +
            missingConversation,
        },
      });
      const active = session.active;
      session.active = null;
      if (active !== null) {
        emit({
          type: "session.turn",
          sessionId: session.id,
          turnId: active.turnId,
          state: "failed",
          error: { message: missingConversation },
        });
      }
      // The rebuilt query starts from scratch: an autonomous turn from the
      // dead conversation cannot be closed by it, so settle it here.
      settleAutonomousTurn(session, emit, "failed", missingConversation);
      session.interrupted = false;
      session.pendingInterruptedResults = 0;
      // Detach so the iterator ending does not emit runtime_failed and
      // kill the daemon session. The next prompt rebuilds without resume.
      session.detached = true;
      session.abort.abort();
      session.sink.close();
      session.pendingUserAnchors = [];
      session.abort = new AbortController();
      for (const pending of session.pendingPermissions.values()) {
        pending.cleanup();
        pending.resolve({ behavior: "deny", message: "Claude session ended" });
      }
      session.pendingPermissions.clear();
      session.query = null;
      session.pump = null;
      return;
    }
    if (message.session_id) session.claudeSessionId = message.session_id;
    emit({
      type: "session.persistence",
      sessionId: session.id,
      persistence: claudePersistence(session),
    });
    // The CLI serializes foreground requests on this query. A canceled
    // request still owns its next terminal result, even if a replacement
    // prompt is already active or this result reports success. Consume that
    // ownership before touching the replacement's usage or turn state.
    if (session.pendingInterruptedResults > 0) {
      session.pendingInterruptedResults -= 1;
      session.interrupted &&= session.pendingInterruptedResults > 0;
      return;
    }
    if (session.cacheMaintenance) {
      const maintenance = session.cacheMaintenance;
      session.cacheMaintenance = null;
      session.sink.started(maintenance.uuid);
      const success = maintenance.boundarySeen && message.subtype === "success" && !message.is_error;
      context.cacheCoordinator?.finish(session.contextKey, success);
      settleAutonomousTurn(session, emit, success ? "completed" : "failed",
        success ? undefined : "Automatic compaction did not report a successful native compaction boundary");
      return;
    }
    // The per-model context windows recorded on every result keep the ring
    // denominator fresh even when the model changes mid-session.
    recordModelContextWindow(session, (message as { modelUsage?: unknown }).modelUsage);
    // The turn is over: streaming counters are stale for the next turn.
    session.streamInputTokens = null;
    session.streamOutputTokens = null;

    // Native parity: the interrupt flag is consumed by ANY result, and a
    // result arriving with only an autonomous turn open settles it.
    const wasInterrupted = session.interrupted;
    session.interrupted = false;
    if (message.subtype !== "success" || message.is_error) {
      const reason = message.subtype === "success" ? message.result : (message.errors[0] ?? "Claude turn failed");
      settleRootTools(session, emit, wasInterrupted ? "canceled" : "failed", reason);
    }
    const active = session.active?.announced ? session.active : null;
    if (active === null) {
      if (wasInterrupted) {
        settleAutonomousTurn(session, emit, "canceled");
      } else if (message.subtype === "success" && !message.is_error) {
        settleAutonomousTurn(session, emit, "completed");
      } else {
        const reason =
          message.subtype === "success"
            ? message.result
            : (message.errors[0] ?? "Claude turn failed");
        settleAutonomousTurn(session, emit, "failed", reason);
      }
      return;
    }
    const usage = buildResultUsage(session, message);
    if (usage !== undefined) {
      emit({
        type: "session.usage",
        sessionId: session.id,
        turnId: active.turnId,
        usage,
      });
    }
    session.active = null;
    if (wasInterrupted) {
      emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "canceled" });
    } else if (message.subtype === "success" && !message.is_error) {
      emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "completed" });
    } else {
      const reason =
        message.subtype === "success"
          ? message.result
          : (message.errors[0] ?? "Claude turn failed");
      emit({
        type: "session.turn",
        sessionId: session.id,
        turnId: active.turnId,
        state: "failed",
        error: { message: reason },
      });
    }
  }
}

interface ToolResultOutput {
  text: string | null;
  images: Array<{ mimeType: string; data: string }>;
}

/** Mirrors the native provider's stale-resume detection. */
function readMissingConversationError(
  message: SDKResultMessage,
  claudeSessionId: string | null,
): string | null {
  if (claudeSessionId === null) return null;
  if (message.type !== "result" || message.subtype !== "error_during_execution") return null;
  const errors = Array.isArray(message.errors) ? message.errors : [];
  for (const entry of errors) {
    if (typeof entry !== "string") continue;
    const match = /^No conversation found with session ID:\s*(.+)$/.exec(entry.trim());
    if (match !== null && match[1]?.trim() === claudeSessionId) return entry.trim();
  }
  return null;
}

function flattenToolResult(content: unknown): ToolResultOutput {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: null, images: [] };
  const parts: string[] = [];
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: unknown };
    if (record.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    } else if (record.type === "image") {
      const source = (block as { source?: unknown }).source;
      if (
        typeof source === "object" &&
        source !== null &&
        typeof (source as { data?: unknown }).data === "string" &&
        typeof (source as { media_type?: unknown }).media_type === "string"
      ) {
        // The payload itself never reaches timeline text (see the
        // tool_result handler above); the text keeps one marker per shot.
        images.push({
          mimeType: (source as { media_type: string }).media_type,
          data: (source as { data: string }).data,
        });
        parts.push("[image]");
      }
    }
  }
  return { text: parts.length > 0 ? parts.join("\n") : null, images };
}

/**
 * Per-turn main-loop usage from the result message, mirroring the native
 * provider: `inputTokens`/`outputTokens` are per-turn (the `result.usage`
 * shape), `cachedInputTokens` the cache reads, `totalCostUsd` the running
 * cumulative cost. The ring numerator comes from the latest per-call
 * measurement; the denominator from the largest `contextWindow` seen in
 * `modelUsage` (matching the native provider's resolution).
 */
function buildResultUsage(session: ClaudeSession, message: SDKResultMessage): ProviderUsage | undefined {
  const usage = message.usage;
  const usageRecord =
    typeof usage === "object" && usage !== null
      ? (usage as {
          input_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          output_tokens?: unknown;
          iterations?: unknown;
        })
      : undefined;
  const totalCostUsd =
    typeof message.total_cost_usd === "number" && Number.isFinite(message.total_cost_usd)
      ? message.total_cost_usd
      : undefined;
  const inputTokens = readFiniteToken(usageRecord?.input_tokens);
  const cachedInputTokens = readFiniteToken(usageRecord?.cache_read_input_tokens);
  const outputTokens = readFiniteToken(usageRecord?.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalCostUsd === undefined) {
    // No per-turn signal at all; the ring fields below may still be emitted.
    const ring = ringUsage(session);
    return ring === undefined ? undefined : { ...ring };
  }
  const result: ProviderUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
  const ring = ringUsage(session);
  return { ...result, ...ring };
}

function readFiniteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * Records the prompt size of the latest main-loop API call from each
 * assistant message's per-call usage: `input_tokens` plus cache reads and
 * cache writes (and that call's output, matching the native provider's
 * accounting) is the context that request carried. The turn's cumulative
 * `modelUsage` totals cannot serve as the ring numerator, so the last
 * per-call measurement is the persistent signal (context only grows between
 * calls, and a later assistant message always supersedes an older one).
 */
function noteAssistantContextUsage(
  session: ClaudeSession,
  message: { usage?: unknown },
): void {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return;
  const record = usage as {
    input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    output_tokens?: unknown;
  };
  if (typeof record.input_tokens !== "number" || record.input_tokens < 0) return;
  const promptUsed =
    record.input_tokens +
    (typeof record.cache_read_input_tokens === "number" && record.cache_read_input_tokens > 0
      ? record.cache_read_input_tokens
      : 0) +
    (typeof record.cache_creation_input_tokens === "number" && record.cache_creation_input_tokens > 0
      ? record.cache_creation_input_tokens
      : 0);
  // A frame with no measurable prompt (e.g. a zeroed synthetic /context
  // helper message) must never move the ring: keep the previous measurement.
  // Note this intentionally keeps fully-cached calls (input_tokens 0 with a
  // large cache read) — they are real prompt measurements. The call's own
  // output is added on top (the native provider counts it too).
  if (promptUsed <= 0) return;
  const output =
    typeof record.output_tokens === "number" && record.output_tokens > 0
      ? record.output_tokens
      : 0;
  session.contextUsage = { usedTokens: promptUsed + output };
}

/**
 * Records the ring denominator: the largest finite `contextWindow` across
 * `modelUsage` entries (the native provider resolves it the same way, since
 * entries for auxiliary models must never shrink the main model's window).
 */
function recordModelContextWindow(session: ClaudeSession, modelUsage: unknown): void {
  if (typeof modelUsage !== "object" || modelUsage === null) return;
  let max: number | undefined;
  for (const value of Object.values(modelUsage as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const window = (value as { contextWindow?: unknown }).contextWindow;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
    max = Math.max(max ?? 0, window);
  }
  if (max !== undefined) session.contextWindowMaxTokens = max;
}

/**
 * Ring fields for the app's context-usage display: used comes from the
 * latest per-call measurement (or the post-compaction value), the window
 * from the recorded denominator. Fail-soft on every miss: a turn without
 * either signal emits no ring fields at all.
 */
function ringUsage(
  session: ClaudeSession,
): { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | undefined {
  const used = session.contextUsage?.usedTokens;
  const max = session.contextWindowMaxTokens ?? undefined;
  if (used === undefined && max === undefined) return undefined;
  return {
    ...(used !== undefined ? { contextWindowUsedTokens: used } : {}),
    ...(max !== undefined ? { contextWindowMaxTokens: max } : {}),
  };
}

/**
 * Mid-turn ring updates from SDK stream events: `message_start` carries the
 * request's prompt size (input + cache reads/writes), `message_delta` the
 * growing output — exactly how the native provider refreshes the ring while
 * Claude is still streaming.
 */
function noteStreamEventUsage(
  session: ClaudeSession,
  message: SDKMessage,
  emit: (event: ProviderEvent) => void,
): void {
  const event = (message as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return;
  const record = event as { type?: unknown };
  let used: number | undefined;
  if (record.type === "message_start") {
    const request = readStreamRequestInputTokens(
      (event as { message?: unknown }).message,
    );
    if (request === undefined) return;
    session.streamInputTokens = request;
    session.streamOutputTokens = 0;
  } else if (record.type === "message_delta") {
    const output = readStreamRequestOutputTokens(event);
    if (output === undefined) return;
    session.streamOutputTokens = output;
  } else {
    return;
  }
  if (
    typeof session.streamInputTokens !== "number" ||
    typeof session.streamOutputTokens !== "number"
  ) {
    return;
  }
  used = session.streamInputTokens + session.streamOutputTokens;
  if (used <= 0) return;
  session.contextUsage = { usedTokens: used };
  emit({
    type: "session.usage",
    sessionId: session.id,
    ...(session.active !== null ? { turnId: session.active.turnId } : {}),
    usage: {
      contextWindowUsedTokens: used,
      ...(session.contextWindowMaxTokens !== null
        ? { contextWindowMaxTokens: session.contextWindowMaxTokens }
        : {}),
    },
  });
}

function readStreamRequestInputTokens(message: unknown): number | undefined {
  const usage =
    typeof message === "object" && message !== null
      ? (message as { usage?: unknown }).usage
      : undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as {
    input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  const inputTokens =
    typeof record.input_tokens === "number" && Number.isFinite(record.input_tokens)
      ? record.input_tokens
      : undefined;
  if (inputTokens === undefined || inputTokens < 0) return undefined;
  const cacheCreation =
    typeof record.cache_creation_input_tokens === "number" &&
    Number.isFinite(record.cache_creation_input_tokens) &&
    record.cache_creation_input_tokens > 0
      ? record.cache_creation_input_tokens
      : 0;
  const cacheRead =
    typeof record.cache_read_input_tokens === "number" &&
    Number.isFinite(record.cache_read_input_tokens) &&
    record.cache_read_input_tokens > 0
      ? record.cache_read_input_tokens
      : 0;
  return inputTokens + cacheCreation + cacheRead;
}

function readStreamRequestOutputTokens(event: unknown): number | undefined {
  const output =
    typeof event === "object" && event !== null
      ? (event as { usage?: unknown }).usage
      : undefined;
  const outputTokens =
    typeof output === "object" && output !== null
      ? (output as { output_tokens?: unknown }).output_tokens
      : undefined;
  return typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0
    ? outputTokens
    : undefined;
}

/**
 * Compaction progress: the CLI repeats a `compacting` status every 30s until
 * the boundary arrives, so the loading card is deduplicated.
 */
function noteCompactionStatus(
  session: ClaudeSession,
  message: SDKMessage,
  emit: (event: ProviderEvent) => void,
): void {
  const status = (message as { status?: unknown }).status;
  if (status !== "compacting") return;
  if (session.compactionMarkerOpen) return;
  session.compactionMarkerOpen = true;
  emit({
    type: "timeline.item",
    sessionId: session.id,
    item: { type: "compaction", id: "compaction", status: "loading" },
  });
}

/**
 * Auto-compaction completed: emit the terminal card and rebase the ring on
 * the post-compaction token count, exactly like the native provider.
 */
function noteCompactionBoundary(
  session: ClaudeSession,
  message: SDKMessage,
  emit: (event: ProviderEvent) => void,
): void {
  session.compactionMarkerOpen = false;
  const metadata = readCompactionMetadata(message);
  emit({
    type: "timeline.item",
    sessionId: session.id,
    item: {
      type: "compaction",
      id: "compaction",
      status: "completed",
      // An absent trigger is an automatic compaction (native parity).
      trigger: metadata?.trigger === "manual" ? "manual" : "auto",
      ...(metadata?.preTokens !== undefined ? { preTokens: metadata.preTokens } : {}),
    },
  });
  // Native parity: a compaction invalidates in-flight stream counters so a
  // later message_delta cannot rebuild the ring from the pre-compact prompt.
  session.streamInputTokens = null;
  session.streamOutputTokens = null;
  if (metadata?.postTokens !== undefined) {
    session.contextUsage = { usedTokens: metadata.postTokens };
    emit({
      type: "session.usage",
      sessionId: session.id,
      ...(session.active !== null ? { turnId: session.active.turnId } : {}),
      usage: {
        contextWindowUsedTokens: metadata.postTokens,
        ...(session.contextWindowMaxTokens !== null
          ? { contextWindowMaxTokens: session.contextWindowMaxTokens }
          : {}),
      },
    });
  }
}

function readCompactionMetadata(
  message: SDKMessage,
): { trigger?: string; preTokens?: number; postTokens?: number } | undefined {
  const record = message as Record<string, unknown>;
  const metadata =
    typeof record.compact_metadata === "object" && record.compact_metadata !== null
      ? record.compact_metadata
      : typeof record.compaction === "object" && record.compaction !== null
      ? record.compaction
      : typeof record.metadata === "object" && record.metadata !== null
        ? record.metadata
        : undefined;
  if (metadata === undefined) return undefined;
  const raw = metadata as Record<string, unknown>;
  const source = { trigger: raw.trigger, preTokens: raw.pre_tokens ?? raw.preTokens,
    postTokens: raw.post_tokens ?? raw.postTokens };
  return {
    ...(typeof source.trigger === "string" ? { trigger: source.trigger } : {}),
    ...(typeof source.preTokens === "number" && Number.isFinite(source.preTokens)
      ? { preTokens: source.preTokens }
      : {}),
    ...(typeof source.postTokens === "number" && Number.isFinite(source.postTokens)
      ? { postTokens: source.postTokens }
      : {}),
  };
}

/**
 * Rewind anchors: the SDK echoes each submitted user message back with its
 * Claude-side uuid. Each anchor becomes a user_message timeline item carrying
 * the uuid as its revertToken — the target the app's rewind menu sends back
 * in `session.revert`.
 */
function noteRewindAnchor(
  session: ClaudeSession,
  message: SDKMessage,
  emit: (event: ProviderEvent) => void,
): void {
  const uuid = (message as { uuid?: unknown }).uuid;
  if (typeof uuid !== "string" || uuid.length === 0) return;
  session.sink.started(uuid);
  // Tool-result frames are user-shaped too; only real user messages anchor.
  const content = (message as SDKUserMessage).message?.content;
  if (Array.isArray(content) && content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_result",
  )) {
    return;
  }
  if (session.rewindUserMessageIds.includes(uuid)) return;
  session.rewindUserMessageIds.push(uuid);
  const matched = session.pendingUserAnchors.findIndex((entry) => entry.uuid === uuid);
  const [anchor] = session.pendingUserAnchors.splice(matched >= 0 ? matched : 0, 1);
  if (anchor === undefined) return;
  emit({
    type: "timeline.item",
    sessionId: session.id,
    item: {
      type: "user_message",
      id: `um-${uuid}`,
      text: anchor.text,
      messageId: uuid,
      clientMessageId: anchor.clientMessageId,
      revertToken: uuid,
    },
  });
}

async function teardownSession(session: ClaudeSession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  session.cacheUnregister?.();
  session.cancellationEpoch += 1;
  session.sink.close();
  session.abort.abort();
  session.subagents?.reset();
  for (const pending of session.pendingPermissions.values()) {
    pending.cleanup();
    pending.resolve({ behavior: "deny", message: "Session closed" });
  }
  session.pendingPermissions.clear();
  await session.pump?.catch(() => undefined);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
