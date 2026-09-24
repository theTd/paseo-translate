import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
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
import { claudeModelSupportsFastMode, findClaudeModel } from "./claude-model-manifest";
import { listClaudeTranscriptSummaries } from "./claude-sessions";
import { forkSession as sdkForkSession } from "./claude-rewind";
import {
  isSerializedAttachment,
  restorePromptFragment,
  translatePromptFragment,
} from "./prompt-text";
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
import { materializeImageOutput, renderImageOutputMarkdown } from "./image-output";
import { describeFinishedTool, describeRunningTool } from "./claude-tool-details";
import { readClaudeReplay, type ReplayUserTextRestore } from "./claude-transcript";
import {
  TRANSLATE_CLAUDE_PROVIDER_ID,
  TRANSLATE_CLAUDE_PROVIDER_LABEL,
  TRANSLATION_TEXT_LIMIT,
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

/** Mirrors the native Claude provider's modes (auto requires the API transport). */
const STATIC_MODES: ProviderMode[] = [
  { id: "plan", label: "Plan Mode", description: "Analyze the codebase without executing tools or edits" },
  { id: "default", label: "Always Ask", description: "Prompts for permission the first time a tool is used" },
  { id: "acceptEdits", label: "Accept File Edits", description: "Automatically approves edit-focused tools without prompting" },
  { id: "bypassPermissions", label: "Bypass", description: "Skip all permission prompts (use with caution)" },
];
const VALID_MODES = new Set(STATIC_MODES.map((mode) => mode.id));

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
  id: string;
  config: ProviderSessionConfig;
  translatedSystemPrompt: string | null;
  /** Configured overrides applied at query start and live where possible. */
  desiredModel: string | null;
  desiredMode: string | null;
  desiredThinking: string | null;
  sink: PromptSink;
  query: ClaudeQueryHandle | null;
  abort: AbortController;
  pump: Promise<void> | null;
  claudeSessionId: string | null;
  active: { clientMessageId: string; turnId: string } | null;
  interrupted: boolean;
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
  pendingUserAnchors: Array<{ clientMessageId: string; text: string }>;
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

interface PromptSink {
  push(message: SDKUserMessage): void;
  /**
   * Queue a steer behind the running turn. Returns an id the sink tracks
   * until the SDK actually dequeues the message, so an interrupt can discard
   * steers Claude never read instead of resuming a stopped turn.
   */
  pushSteer(message: SDKUserMessage): void;
  discardPendingSteers(): void;
  iterable: AsyncIterable<SDKUserMessage>;
}

interface SinkEntry {
  message: SDKUserMessage;
  steer: boolean;
  delivered: boolean;
}

function createPromptSink(): PromptSink {
  const queue: SinkEntry[] = [];
  let wake: (() => void) | null = null;
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          const pending = queue.shift();
          if (pending !== undefined) {
            pending.delivered = true;
            return { value: pending.message, done: false };
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          const message = queue.shift();
          if (message === undefined) return { value: undefined, done: true };
          message.delivered = true;
          return { value: message.message, done: false };
        },
      };
    },
  };
  return {
    push(message) {
      queue.push({ message, steer: false, delivered: false });
      wake?.();
    },
    pushSteer(message) {
      queue.push({ message, steer: true, delivered: false });
      wake?.();
    },
    discardPendingSteers() {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const entry = queue[index];
        if (entry !== undefined && entry.steer && !entry.delivered) {
          queue.splice(index, 1);
        }
      }
    },
    iterable,
  };
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
  const context: DispatchContext = {
    sessions,
    translator,
    queryFactory,
    forkClaudeSession,
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
    icon: "icon.svg",
    async getCatalogCacheKey(options) {
      const values = await deps.loadConfig();
      // The catalog reflects the CLI build behind this executable; `force` is
      // intentionally ignored, workspace discovery keys on the target cwd.
      const executable =
        values.claudeExecutablePath.length > 0
          ? values.claudeExecutablePath
          : (resolvePathClaude() ?? "bundled");
      return options.scope === "workspace"
        ? JSON.stringify({ executable, cwd: options.cwd })
        : JSON.stringify({ executable });
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
          await dispatch(input, context, capabilities);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          if (connectionClosed) return;
          connectionClosed = true;
          for (const session of sessions.values()) await teardownSession(session);
          sessions.clear();
          listeners.clear();
        },
      };
      return connection;
    },
  };
}

interface DispatchContext {
  sessions: Map<string, ClaudeSession>;
  translator: ReturnType<typeof createTranslator>;
  queryFactory: ClaudeQueryFactory;
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
      if (session !== undefined && session.query !== null) {
        session.interrupted = true;
        // Discard steers Claude never read first: the SDK would otherwise
        // dequeue one and resume the turn just stopped.
        session.sink.discardPendingSteers();
        await session.query.interrupt().catch(() => undefined);
        // A canceled turn ends its foreground children; backgrounded ones
        // outlive it and keep their descriptors for the later settle.
        session.subagents?.cancelRunningForegroundTasks();
      }
      context.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.permission": {
      await respondToPermission(context.sessions.get(input.sessionId), input.permissionId, input.response, context);
      return;
    }
    case "session.close": {
      const session = context.sessions.get(input.sessionId);
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
      await applyConfigChanges(session, input.changes);
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
 */
async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  context: DispatchContext,
): Promise<void> {
  const sessions = await listClaudeTranscriptSummaries(
    input.cwd ?? process.cwd(),
    Math.max(1, Math.min(input.limit ?? 20, 100)),
  );
  context.emit({ type: "sessions", requestId: input.requestId, sessions });
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
): Promise<void> {
  // Native parity: checkpoints live on the running query. Conversation
  // rewind tears that query down, so a later files-only rewind must
  // rebuild it first (and a never-prompted session must start one).
  await ensureQuery(session, context);
  if (session.query?.rewindFiles === undefined) {
    throw new Error("This Claude build does not expose file rewind");
  }
  const result = await session.query.rewindFiles(messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
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
  session.claudeSessionId = fork.sessionId;
  await resetQuery(session, (event) => context.emit(event));
  context.emit({
    type: "session.persistence",
    sessionId: session.id,
    persistence: { version: 1, data: { claudeSessionId: fork.sessionId } },
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
): Promise<void> {
  session.detached = true;
  session.abort.abort();
  session.abort = new AbortController();
  for (const pending of session.pendingPermissions.values()) {
    pending.resolve({ behavior: "deny", message: "Superseded by a rewind" });
  }
  session.pendingPermissions.clear();
  const pump = session.pump;
  session.query = null;
  session.pump = null;
  const active = session.active;
  session.active = null;
  await pump?.catch(() => undefined);
  session.detached = false;
  if (active !== null) {
    emit({ type: "session.turn", sessionId: session.id, turnId: active.turnId, state: "canceled" });
  }
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  context: DispatchContext,
  capabilities: readonly string[],
): Promise<void> {
  if (context.sessions.has(input.sessionId)) {
    throw new Error(`Session already exists: ${input.sessionId}`);
  }
  let translatedSystemPrompt: string | null = null;
  if (typeof input.config.systemPrompt === "string" && input.config.systemPrompt.trim().length > 0) {
    if ((await context.loadValues()).translatePrompts) {
      try {
        translatedSystemPrompt = await context.translator.translate(
          input.config.systemPrompt,
          "user-to-agent",
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
    id: input.sessionId,
    config: input.config,
    translatedSystemPrompt,
    desiredModel: readConfigured(input.config.model),
    desiredMode: readConfigured(input.config.mode),
    desiredThinking: readConfigured(input.config.thinkingOption),
    sink: createPromptSink(),
    query: null,
    abort: new AbortController(),
    pump: null,
    claudeSessionId: readStoredSessionId(input.persistence),
    active: null,
    interrupted: false,
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
  context.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities,
    restoration: "core",
    ...(session.claudeSessionId !== null
      ? { persistence: { version: 1, data: { claudeSessionId: session.claudeSessionId } } }
      : {}),
    title: input.config.title,
    cwd: input.config.cwd,
  });
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
  const restore = await buildReplayRestore(context);
  const replay = await readClaudeReplay(session.config.cwd, session.claudeSessionId, restore);
  for (const item of replay.rootItems) {
    if (session.closed) return;
    context.emit({ type: "timeline.item", sessionId: session.id, item });
  }
  for (const child of replay.children) {
    if (session.closed) return;
    if (!session.supportsSubsessions) {
      // Same degradation as the live tracker: no child sessions, child
      // content flattened into the parent timeline (see
      // flattenSubagentItemForParent).
      for (const item of child.items) {
        context.emit({
          type: "timeline.item",
          sessionId: session.id,
          item: flattenSubagentItemForParent(child.title ?? "Subagent", item),
        });
      }
      continue;
    }
    const providerId = `subagent:${session.id}:${child.canonicalId}`;
    const parentProviderId =
      child.parentCanonicalId !== undefined
        ? `subagent:${session.id}:${child.parentCanonicalId}`
        : session.id;
    const turnId = randomUUID();
    context.emit({
      type: "session.opened",
      sessionId: providerId,
      parentSessionId: parentProviderId,
      toolCallId: child.canonicalId,
      capabilities: [],
      restoration: "parent",
      title: child.title ?? "Subagent",
      ...(child.description !== undefined ? { description: child.description } : {}),
      cwd: session.config.cwd,
    });
    context.emit({ type: "session.turn", sessionId: providerId, turnId, state: "started" });
    for (const item of child.items) {
      context.emit({ type: "timeline.item", sessionId: providerId, item });
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
 * - back-translation fallback for sessions predating the reverse index,
 *   billed once per block then served from the normal translation cache.
 * Only the root timeline gets the fallback: Task sidechain prompts are
 * agent-language by design and must never be back-translated.
 *
 * Explicit tradeoff of the fallback (no language tag distinguishes a
 * translated block from an untranslated one): transcripts that were NEVER
 * translated — prompt translation disabled at the time, or a Claude session
 * imported from another provider — have no exact entries, so every block
 * misses and is back-translated once prompt translation is on. Such text
 * is usually already in the user language, in which case a well-behaved
 * endpoint returns it unchanged and the `back === block` guard below keeps
 * it verbatim; but an endpoint that paraphrases same-language input can
 * rewrite those blocks. Sessions translated under an older language pair
 * have the same exposure (the fallback always uses the CURRENT pair, while
 * the exact path is settings-independent and unaffected). If that ever
 * matters, gate the fallback behind a setting or drop it: exact-only is
 * the conservative mode, and pre-fix sessions then keep their translated
 * text instead of an approximate back-translation.
 */
async function buildReplayRestore(context: DispatchContext): Promise<ReplayUserTextRestore> {
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
      // would fall through to a billed back-translation on every reopen.
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
  let translateBack: ((block: string) => Promise<string | undefined>) | undefined;
  try {
    const values = await context.loadValues();
    if (values.translatePrompts) {
      translateBack = async (block: string) => {
        if (block.trim().length === 0 || isSerializedAttachment(block)) return undefined;
        if (block.length > TRANSLATION_TEXT_LIMIT) return undefined;
        try {
          const back = await translatePromptFragment(block, (fragment) =>
            context.translator.translate(fragment, "agent-to-user"),
          );
          if (back.trim().length === 0 || back === block) return undefined;
          return back;
        } catch (error) {
          console.warn(
            `[translate] history back-translation failed (${error instanceof Error ? error.message : String(error)}); keeping the translated text`,
          );
          return undefined;
        }
      };
    }
  } catch {
    translateBack = undefined;
  }
  return {
    restoreRootBlock: async (block: string) =>
      exactOriginal(block) ?? (translateBack !== undefined ? (await translateBack(block)) ?? block : block),
    restoreChildBlock: (block: string) => exactOriginal(block) ?? block,
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
  return {
    ...(session.desiredModel !== null ? { model: session.desiredModel } : {}),
    ...(session.desiredMode !== null ? { mode: session.desiredMode } : {}),
    ...(session.desiredThinking !== null ? { thinkingOption: session.desiredThinking } : {}),
    models: catalogModelsCache ?? [],
    modes: STATIC_MODES,
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

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
): Promise<void> {
  const session = context.sessions.get(input.sessionId);
  if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
  if (input.prompt.input.type === "command") {
    await commandSession(input, context, session);
    return;
  }
  if (input.prompt.delivery === "steer") {
    await steerSession(input, context, session);
    return;
  }
  if (session.active !== null) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "A turn is already running on this session" } },
    });
    return;
  }
  let blocks: SdkContentBlock[];
  try {
    blocks = await buildMessageBlocks(input.prompt.input.content, context);
  } catch (error) {
    // Fail closed: the prompt never reaches Claude untranslated.
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
  await ensureQuery(session, context);
  const turnId = randomUUID();
  session.active = { clientMessageId: input.prompt.clientMessageId, turnId };
  session.interrupted = false;
  context.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "turn", turnId },
  });
  context.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
  session.sink.push({
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
  });
  // Rewind anchor: the SDK echoes this prompt back with its Claude-side uuid,
  // at which point a user_message item carrying the revertToken is emitted.
  session.pendingUserAnchors.push({
    clientMessageId: input.prompt.clientMessageId,
    text: rawPromptText(input.prompt.input.content),
  });
  await publishCommands(session, context);
}

/**
 * Slash-command prompts (`prompt.command`). The command word travels
 * verbatim; only free-text arguments are translated, matching the flattened
 * `/name args` handling of the ACP provider.
 */
async function commandSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
  session: ClaudeSession,
): Promise<void> {
  if (session.active !== null) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "A turn is already running on this session" } },
    });
    return;
  }
  if (input.prompt.input.type !== "command") return;
  let text = `/${input.prompt.input.name}`;
  const args = input.prompt.input.arguments;
  if (args.trim().length > 0) {
    try {
      const values = await context.loadValues();
      const translated = values.translatePrompts
        ? await context.translator.translate(args, "user-to-agent")
        : args;
      text += ` ${translated}`;
    } catch (error) {
      context.emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: describe(error) } },
      });
      return;
    }
  }
  await ensureQuery(session, context);
  const turnId = randomUUID();
  session.active = { clientMessageId: input.prompt.clientMessageId, turnId };
  session.interrupted = false;
  context.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "turn", turnId },
  });
  context.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
  session.sink.push({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  });
  session.pendingUserAnchors.push({
    clientMessageId: input.prompt.clientMessageId,
    text: `/${input.prompt.input.name}${args.trim().length > 0 ? ` ${args}` : ""}`,
  });
  await publishCommands(session, context);
}

/**
 * Active-turn steering (`prompt.steer`). The message is queued behind the
 * running turn with SDK `next` priority instead of opening a new turn; the
 * daemon falls back to interrupt-and-replace when this reports failure.
 */
async function steerSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
  session: ClaudeSession,
): Promise<void> {
  const active = session.active;
  if (active === null || session.query === null) {
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
    blocks = await buildMessageBlocks(input.prompt.input.content, context);
  } catch (error) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
  if (input.prompt.clearPendingPermissions === true) {
    denyPendingForSteer(session, (event) => context.emit(event));
  }
  session.sink.pushSteer({
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
    priority: "next",
    uuid: randomUUID(),
  });
  session.pendingUserAnchors.push({
    clientMessageId: input.prompt.clientMessageId,
    text: rawPromptText(input.prompt.input.content),
  });
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
function denyPendingForSteer(
  session: ClaudeSession,
  emit: (event: ProviderEvent) => void,
): void {
  for (const permissionId of session.pendingPermissions.keys()) {
    const pending = session.pendingPermissions.get(permissionId);
    if (pending === undefined) continue;
    session.pendingPermissions.delete(permissionId);
    pending.resolve({ behavior: "deny", message: "Superseded by a follow-up prompt" });
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
): Promise<SdkContentBlock[]> {
  const values = await context.loadValues();
  const translate = values.translatePrompts
    ? (text: string) => context.translator.translate(text, "user-to-agent")
    : async (text: string) => text;
  const blocks: SdkContentBlock[] = [];
  let hasContent = false;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const translated = await translatePromptFragment((block as { text: string }).text, translate);
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
  return blocks;
}

async function ensureQuery(session: ClaudeSession, context: DispatchContext): Promise<void> {
  if (session.query !== null) return;
  const values = await context.loadValues();
  // Prefer the settings override, then the user's PATH claude (their own
  // install and login); the daemon-bundled CLI is only the last resort.
  const executable =
    values.claudeExecutablePath.length > 0 ? values.claudeExecutablePath : resolvePathClaude();
  const permissionMode = session.desiredMode ?? undefined;
  const providerOptions = resolveProviderOptions(session);
  const thinking = thinkingStartOptions(session.desiredThinking);
  const effortLevel =
    thinking.settings !== undefined &&
    typeof thinking.settings === "object" &&
    thinking.settings !== null &&
    "effortLevel" in thinking.settings
      ? (thinking.settings as { effortLevel?: unknown }).effortLevel
      : undefined;
  const settings: Record<string, unknown> = {
    ...providerOptions.settings,
    // Thinking effort wins over a leftover providerOptions.settings.effortLevel
    // so a mode picker change is not silently ignored.
    ...(effortLevel !== undefined ? { effortLevel } : {}),
    ...(session.fastMode ? { fastMode: true } : {}),
  };
  const options: Options = {
    cwd: session.config.cwd,
    env: { ...process.env, ...session.config.env },
    abortController: session.abort,
    // Token-level stream events drive the mid-turn context ring (the timeline
    // itself still renders complete messages).
    includePartialMessages: true,
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
    ...(permissionMode !== undefined
      ? { permissionMode: permissionMode as Options["permissionMode"] }
      : {}),
    ...(session.config.persist ? { persistSession: true } : {}),
    ...(executable !== null ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(thinking.thinking !== undefined ? { thinking: thinking.thinking } : {}),
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
  spread: Pick<Options, "allowedTools" | "disallowedTools" | "sandbox" | "additionalDirectories">;
  settings: Record<string, unknown>;
} {
  const allowedTools = toolPolicyAllowedTools(session.config.toolPolicy);
  const disallowedTools: string[] = [];
  const additionalDirectories: string[] = [];
  const settings: Record<string, unknown> = {};
  let sandbox: unknown;
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
    const seen = new Map<string, ProviderCommand>();
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
function thinkingStartOptions(thinking: string | null): Pick<Options, "thinking" | "settings"> {
  if (thinking === null || thinking === "default") return {};
  if (thinking === "adaptive") return { thinking: { type: "adaptive" } };
  if (thinking === "off") return { thinking: { type: "disabled" } };
  if (START_EFFORT.has(thinking)) {
    return { settings: { effortLevel: thinking as "low" | "medium" | "high" | "xhigh" } };
  }
  // "max" is session-scoped in the SDK and cannot persist at query start;
  // start at the closest persisted level instead.
  if (thinking === "max") {
    return { settings: { effortLevel: "xhigh" } };
  }
  return {};
}

/**
 * Applies model/mode/thinking/settings changes; live on the running query
 * when possible. Mode changes also maintain the plan resume anchor the plan
 * permission actions use (mirrors the native provider).
 */
async function applyConfigChanges(
  session: ClaudeSession,
  changes: {
    model?: string | null;
    mode?: string | null;
    thinkingOption?: string | null;
    settings?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  if (Object.hasOwn(changes, "model")) {
    const model = changes.model ?? null;
    session.desiredModel = model === null || model === "default" ? null : model;
    session.fastModeSupported = claudeModelSupportsFastMode(session.desiredModel);
    // The ring denominator follows the model: re-resolve it from the manifest.
    session.contextWindowMaxTokens =
      findClaudeModel(session.desiredModel)?.contextWindowMaxTokens ?? session.contextWindowMaxTokens;
    if (session.fastMode && !session.fastModeSupported) {
      session.fastMode = false;
      if (session.query?.applyFlagSettings !== undefined) {
        await session.query.applyFlagSettings({ fastMode: false }).catch(() => undefined);
      }
    }
    if (session.query?.setModel !== undefined) {
      await session.query.setModel(session.desiredModel ?? undefined).catch(() => undefined);
    }
  }
  if (Object.hasOwn(changes, "mode")) {
    const mode = changes.mode ?? null;
    const previousMode = session.desiredMode ?? "default";
    if (mode === null || mode === "default") {
      session.desiredMode = null;
    } else if (VALID_MODES.has(mode)) {
      session.desiredMode = mode;
    }
    // Track the mode a plan approval should return to (see respondToPermission).
    if (session.desiredMode === "plan") {
      if (previousMode !== "plan") session.planResumeMode = previousMode;
    } else {
      session.planResumeMode = session.desiredMode ?? "default";
    }
    if (session.query?.setPermissionMode !== undefined) {
      // Always apply live, including the return to "default": a stored-only
      // clear would leave a running bypass session auto-approving while the
      // UI already shows Always Ask.
      await session.query
        .setPermissionMode(session.desiredMode ?? "default")
        .catch(() => undefined);
    }
  }
  if (Object.hasOwn(changes, "thinkingOption")) {
    const thinking = changes.thinkingOption ?? null;
    session.desiredThinking =
      thinking === null || thinking === "default" || thinking.length === 0 ? null : thinking;
    if (session.query?.applyFlagSettings !== undefined) {
      await session.query
        .applyFlagSettings(thinkingFlagSettings(session.desiredThinking))
        .catch(() => undefined);
    }
  }
  if (Object.hasOwn(changes, "settings")) {
    const settings = changes.settings ?? {};
    if (Object.hasOwn(settings, "fast_mode")) {
      session.fastMode = settings["fast_mode"] === true;
      if (session.fastMode && !session.fastModeSupported) {
        session.fastMode = false;
      }
      if (session.query?.applyFlagSettings !== undefined) {
        await session.query.applyFlagSettings({ fastMode: session.fastMode }).catch(() => undefined);
      }
    }
  }
}

/** Live thinking application through the flag-settings layer. */
function thinkingFlagSettings(thinking: string | null): Record<string, unknown> {
  // Null clears a flag-layer key (documented SDK contract), so every branch
  // resets what the other modes may have set.
  if (thinking === null || thinking === "default") {
    return { effortLevel: null, alwaysThinkingEnabled: null };
  }
  if (thinking === "adaptive") return { effortLevel: null, alwaysThinkingEnabled: true };
  if (thinking === "off") return { effortLevel: null, alwaysThinkingEnabled: false };
  return { effortLevel: thinking };
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
  return { models, modes: STATIC_MODES, defaultMode: "default" };
}

async function probeModels(context: DispatchContext): Promise<ProviderModel[]> {
  const values = await context.loadValues();
  const executable =
    values.claudeExecutablePath.length > 0 ? values.claudeExecutablePath : resolvePathClaude();
  const abort = new AbortController();
  const query = context.queryFactory({
    prompt: createPromptSink().iterable,
    options: {
      cwd: process.cwd(),
      env: { ...process.env },
      abortController: abort,
      ...(executable !== null ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  });
  try {
    if (query.supportedModels === undefined) return fallbackModels();
    const infos = await withTimeout(query.supportedModels(), 20_000, "model probe timed out");
    const mapped = infos.map(modelInfoToProviderModel);
    if (mapped.length === 0) return fallbackModels();
    catalogModelsCache = mapped;
    return mapped;
  } catch {
    return fallbackModels();
  } finally {
    abort.abort();
  }
}

function fallbackModels(): ProviderModel[] {
  return [
    { id: "default", label: "Claude (CLI default)", isDefault: true },
  ];
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
  if (info.supportsAdaptiveThinking === true) {
    options.push({ id: "adaptive", label: "Adaptive" });
  }
  if (info.supportsEffort === true && Array.isArray(info.supportedEffortLevels)) {
    for (const level of info.supportedEffortLevels) {
      options.push({ id: level, label: labelForEffort(level) });
    }
  }
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
  return new Promise((resolve) => {
    session.pendingPermissions.set(permissionId, {
      resolve,
      ...(question !== undefined ? { question } : {}),
      ...(plan ? { plan: true } : {}),
    });
    toolOptions.signal.addEventListener("abort", () => {
      const pending = session.pendingPermissions.get(permissionId);
      if (pending === undefined) return;
      session.pendingPermissions.delete(permissionId);
      pending.resolve({ behavior: "deny", message: "Permission request expired" });
      // Resolve the daemon-side card too: a superseded request would otherwise
      // linger until the turn ends and ignore taps.
      emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
    });
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
              ...(typeof input.plan === "string" && input.plan.length > 0
                ? { planText: input.plan }
                : {}),
            },
            actions: buildPlanPermissionActions(session.planResumeMode),
          }
        : {}),
      ...(kind === "tool"
        ? {
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
        context.translator.translate(text, "agent-to-user"),
      );
    }
  } catch {
    // Display-only: keep the original text rather than breaking the turn.
    translatedQuestions = originalQuestions;
  }
  if (toolOptions.signal.aborted || session.closed) {
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
  if (pending === undefined) return;
  session.pendingPermissions.delete(permissionId);
  if (response.behavior === "allow") {
    if (pending.question !== undefined) {
      await resolveQuestionAllow(pending.question, response, pending.resolve, context);
    } else {
      if (pending.plan === true) {
        // A plan approval switches the mode the native provider would switch
        // to, then lets the turn continue on the approved plan.
        const shouldResumeBypass =
          response.selectedActionId === "implement_resume" &&
          session.planResumeMode === "bypassPermissions";
        const targetMode = shouldResumeBypass ? "bypassPermissions" : "acceptEdits";
        session.desiredMode = targetMode;
        session.planResumeMode = targetMode;
        if (session.query?.setPermissionMode !== undefined) {
          await session.query.setPermissionMode(targetMode).catch(() => undefined);
        }
        emit({
          type: "session.config",
          sessionId: session.id,
          config: configStateFor(session),
        });
      }
      pending.resolve({
        behavior: "allow",
        updatedInput: response.updatedInput,
        updatedPermissions: response.updatedPermissions,
      });
    }
  } else {
    pending.resolve({
      behavior: "deny",
      message: response.message ?? "Denied",
      interrupt: response.interrupt,
    });
  }
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
): Promise<void> {
  try {
    const values = await context.loadValues();
    const translate = values.translatePrompts
      ? (text: string) => context.translator.translate(text, "user-to-agent")
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

async function pumpQuery(
  session: ClaudeSession,
  query: ClaudeQueryHandle,
  context: DispatchContext,
): Promise<void> {
  const emit = (event: ProviderEvent) => context.emit(event);
  try {
    for await (const message of query) {
      if (session.closed) return;
      handleSdkMessage(session, message, context);
    }
  } catch (error) {
    if (session.closed) return;
    if (session.detached) {
      session.detached = false;
      return;
    }
    finishDeadQuery(session, describe(error), emit);
    return;
  }
  if (session.closed) return;
  if (session.detached) {
    session.detached = false;
    return;
  }
  finishDeadQuery(session, "Claude exited unexpectedly", emit);
}

/**
 * The long-lived query is gone (process death, or an SDK that ends the
 * iterator after an interrupt). Reset it so the next prompt rebuilds the
 * process from the latest Claude session id, settle the active turn
 * (canceled when the user interrupted, failed otherwise), and only surface a
 * runtime failure when the exit was not interrupt-driven.
 */
function finishDeadQuery(
  session: ClaudeSession,
  message: string,
  emit: (event: ProviderEvent) => void,
): void {
  session.query = null;
  session.pump = null;
  const wasInterrupted = session.interrupted;
  session.interrupted = false;
  const active = session.active;
  if (active !== null) {
    session.active = null;
    if (wasInterrupted) {
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
  // An interrupt ends foreground children; a dead process fails everything
  // still running, including backgrounded work that outlived its turn.
  if (wasInterrupted) session.subagents?.cancelRunningForegroundTasks();
  else session.subagents?.failRunningTasks();
  for (const pending of session.pendingPermissions.values()) {
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

function handleSdkMessage(
  session: ClaudeSession,
  message: SDKMessage,
  context: DispatchContext,
): void {
  const emit = (event: ProviderEvent) => context.emit(event);
  // The Task protocol owns subagent identity and status; sidechain frames
  // only feed the timelines of children it declared.
  if (session.subagents?.observeSystemMessage(message) === true) return;
  if (message.type === "system") {
    if (message.subtype === "init") void publishCommands(session, context);
    if (message.subtype === "status") {
      noteCompactionStatus(session, message, emit);
      return;
    }
    if (message.subtype === "compact_boundary") {
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
    return;
  }
  if (message.type === "assistant" && message.parent_tool_use_id === null) {
    noteAssistantContextUsage(session, message.message);
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const text = (block as { text: string }).text;
        if (text.trim().length === 0) continue;
        emit({
          type: "timeline.item",
          sessionId: session.id,
          item: {
            type: "assistant_message",
            id: message.uuid,
            text,
            messageId: message.uuid,
          },
        });
      } else if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "thinking" &&
        typeof (block as { thinking?: unknown }).thinking === "string"
      ) {
        const thinking = (block as { thinking: string }).thinking;
        if (thinking.trim().length === 0) continue;
        // Reasoning streams in the agent language and is not translated;
        // the daemon renders it through the built-in reasoning projection.
        emit({
          type: "timeline.item",
          sessionId: session.id,
          item: {
            type: "reasoning",
            id: message.uuid,
            text: thinking,
          },
        });
      } else if (
        typeof block === "object" &&
        block !== null &&
        ((block as { type?: unknown }).type === "tool_use" ||
          (block as { type?: unknown }).type === "mcp_tool_use" ||
          (block as { type?: unknown }).type === "server_tool_use")
      ) {
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
    // Detect a missing resume against the id we asked the SDK to resume,
    // BEFORE overwriting it with this result's session_id. Official result
    // fixtures often omit session_id entirely; matching the stored id is
    // the only reliable signal.
    const missingConversation = readMissingConversationError(message, session.claudeSessionId);
    if (missingConversation !== null) {
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
      // Detach so the iterator ending does not emit runtime_failed and
      // kill the daemon session. The next prompt rebuilds without resume.
      session.detached = true;
      session.abort.abort();
      session.abort = new AbortController();
      for (const pending of session.pendingPermissions.values()) {
        pending.resolve({ behavior: "deny", message: "Claude session ended" });
      }
      session.pendingPermissions.clear();
      session.query = null;
      session.pump = null;
      return;
    }
    session.claudeSessionId = message.session_id;
    emit({
      type: "session.persistence",
      sessionId: session.id,
      persistence: { version: 1, data: { claudeSessionId: message.session_id } },
    });
    // The per-model context windows recorded on every result keep the ring
    // denominator fresh even when the model changes mid-session.
    recordModelContextWindow(session, (message as { modelUsage?: unknown }).modelUsage);
    // The turn is over: streaming counters are stale for the next turn.
    session.streamInputTokens = null;
    session.streamOutputTokens = null;
    const active = session.active;
    if (active === null) return;
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
    const wasInterrupted = session.interrupted;
    session.interrupted = false;
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
    typeof record.compaction === "object" && record.compaction !== null
      ? record.compaction
      : typeof record.metadata === "object" && record.metadata !== null
        ? record.metadata
        : undefined;
  if (metadata === undefined) return undefined;
  const source = metadata as { trigger?: unknown; preTokens?: unknown; postTokens?: unknown };
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
  const anchor = session.pendingUserAnchors.shift();
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
  session.abort.abort();
  session.subagents?.reset();
  for (const pending of session.pendingPermissions.values()) {
    pending.resolve({ behavior: "deny", message: "Session closed" });
  }
  session.pendingPermissions.clear();
  await session.pump?.catch(() => undefined);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
