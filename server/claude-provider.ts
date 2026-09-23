import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
} from "@getpaseo/plugin/server/provider";
import { createTranslator, type TranslatorDeps } from "./translate";
import { translatePromptFragment } from "./prompt-text";
import {
  ASK_USER_QUESTION_TOOL,
  isAskUserQuestionRequest,
  normalizeQuestionRequestInput,
  resolveQuestionAnswers,
  stripQuestionUiMetadata,
  summarizeQuestions,
  translateQuestionsForDisplay,
} from "./question";
import { ClaudeSubagentTracker } from "./claude-subagents";
import { describeFinishedTool, describeRunningTool } from "./claude-tool-details";
import { readClaudeReplay } from "./claude-transcript";
import {
  TRANSLATE_CLAUDE_PROVIDER_ID,
  TRANSLATE_CLAUDE_PROVIDER_LABEL,
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
}

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "permission",
  "session.persistence",
  "session.configure",
  "session.subsession",
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
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
  pendingPermissions: Map<string, PendingPermission>;
  /** Live Task-protocol children, surfaced as provider subsessions. */
  subagents: ClaudeSubagentTracker | null;
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
 * Claude's session id, and best-effort history replay from Claude's own
 * transcript files. Archive/unarchive/revert/session-listing stay
 * capability-gated off: the daemon handles their absence gracefully.
 */
export function createTranslateClaudeProvider(deps: ClaudeProviderDeps): ProviderRegistration {
  const translator = createTranslator(deps);
  const queryFactory = deps.queryFactory ?? claudeQuery;
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, ClaudeSession>();
  const context: DispatchContext = {
    sessions,
    translator,
    queryFactory,
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
    case "session.revert":
      context.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `${input.type} is not supported by the Translate Claude provider` },
      });
      return;
    case "sessions":
      requireProviderCapabilities(capabilities, input);
      context.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: "Session listing is not supported by the Translate Claude provider" },
      });
      return;
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
    toolNames: new Map(),
    toolInputs: new Map(),
    pendingPermissions: new Map(),
    subagents: null,
    commandsPublished: false,
  };
  session.subagents = new ClaudeSubagentTracker(
    session.id,
    session.config.cwd,
    (event) => context.emit(event),
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
  const replay = await readClaudeReplay(session.config.cwd, session.claudeSessionId);
  for (const item of replay.rootItems) {
    if (session.closed) return;
    context.emit({ type: "timeline.item", sessionId: session.id, item });
  }
  for (const child of replay.children) {
    if (session.closed) return;
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

function configStateFor(session: ClaudeSession): {
  model?: string;
  mode?: string;
  thinkingOption?: string;
  models: ProviderModel[];
  modes: ProviderMode[];
  thinkingOptions: [];
  settings: [];
} {
  return {
    ...(session.desiredModel !== null ? { model: session.desiredModel } : {}),
    ...(session.desiredMode !== null ? { mode: session.desiredMode } : {}),
    ...(session.desiredThinking !== null ? { thinkingOption: session.desiredThinking } : {}),
    models: catalogModelsCache ?? [],
    modes: STATIC_MODES,
    thinkingOptions: [],
    settings: [],
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
  const options: Options = {
    cwd: session.config.cwd,
    env: { ...process.env, ...session.config.env },
    abortController: session.abort,
    ...(session.claudeSessionId !== null ? { resume: session.claudeSessionId } : {}),
    ...(session.desiredModel !== null ? { model: session.desiredModel } : {}),
    ...(session.translatedSystemPrompt !== null
      ? { systemPrompt: session.translatedSystemPrompt }
      : {}),
    ...(permissionMode !== undefined
      ? {
          permissionMode: permissionMode as Options["permissionMode"],
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
        }
      : {}),
    ...(executable !== null ? { pathToClaudeCodeExecutable: executable } : {}),
    ...thinkingStartOptions(session.desiredThinking),
    canUseTool: ((toolName: string, input: Record<string, unknown>, toolOptions: unknown) =>
      requestPermission(
        session,
        toolName,
        input,
        toolOptions as CanUseToolOptions,
        context,
      )) as unknown as NonNullable<Options["canUseTool"]>,
  };
  const query = context.queryFactory({ prompt: session.sink.iterable, options });
  session.query = query;
  session.pump = pumpQuery(session, query, context);
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

/** Applies model/mode/thinking changes; live on the running query when possible. */
async function applyConfigChanges(
  session: ClaudeSession,
  changes: { model?: string | null; mode?: string | null; thinkingOption?: string | null },
): Promise<void> {
  if (Object.hasOwn(changes, "model")) {
    const model = changes.model ?? null;
    session.desiredModel = model === null || model === "default" ? null : model;
    if (session.query?.setModel !== undefined) {
      await session.query.setModel(session.desiredModel ?? undefined).catch(() => undefined);
    }
  }
  if (Object.hasOwn(changes, "mode")) {
    const mode = changes.mode ?? null;
    if (mode === null || mode === "default") {
      session.desiredMode = null;
    } else if (VALID_MODES.has(mode)) {
      session.desiredMode = mode;
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
  return {
    id: info.value,
    label: info.displayName ?? info.value,
    ...(info.description !== undefined ? { description: info.description } : {}),
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
): Promise<PermissionResultLike | null> {
  return new Promise((resolve) => {
    session.pendingPermissions.set(permissionId, { resolve, ...(question !== undefined ? { question } : {}) });
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
  return waitForPermissionResponse(
    session,
    permissionId,
    {
      id: permissionId,
      name: toolName,
      kind: "tool",
      ...(toolOptions.title !== undefined ? { title: toolOptions.title } : {}),
      ...(toolOptions.description !== undefined
        ? { description: toolOptions.description }
        : toolOptions.displayName !== undefined
          ? { description: toolOptions.displayName }
          : {}),
      // The SDK hands a plain JSON object; round-trip keeps the wire shape
      // the daemon's JsonValue contract expects.
      input: JSON.parse(JSON.stringify(input)),
      actions: [
        { id: "allow", label: "Allow", behavior: "allow" },
        { id: "deny", label: "Deny", behavior: "deny" },
      ],
    },
    toolOptions,
    emit,
  );
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
    if (!session.closed) finishDeadQuery(session, describe(error), emit);
    return;
  }
  if (!session.closed) finishDeadQuery(session, "Claude exited unexpectedly", emit);
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
      error: { message },
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
    return;
  }
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (typeof parentToolUseId === "string" && parentToolUseId.length > 0) {
    session.subagents?.handleSidechainMessage(message, parentToolUseId);
    return;
  }
  if (message.type === "assistant" && message.parent_tool_use_id === null) {
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
        // must never reach the tool output text; each image renders as its
        // own markdown message instead (matching the native provider).
        output.images.forEach((image, index) => {
          emit({
            type: "timeline.item",
            sessionId: session.id,
            item: {
              type: "assistant_message",
              id: `${result.tool_use_id}-image-${index}`,
              text: `![tool image](data:${image.mimeType};base64,${image.data})`,
            },
          });
        });
      }
    }
    return;
  }
  if (message.type === "result") {
    session.claudeSessionId = message.session_id;
    emit({
      type: "session.persistence",
      sessionId: session.id,
      persistence: { version: 1, data: { claudeSessionId: message.session_id } },
    });
    const active = session.active;
    if (active === null) return;
    const usage = summarizeModelUsage(
      (message as { modelUsage?: unknown }).modelUsage,
    );
    if (usage !== undefined) {
      emit({ type: "session.usage", sessionId: session.id, turnId: active.turnId, usage });
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
 * Per-model totals (`modelUsage`) are cumulative across turns in a
 * streaming-input session and cover the main loop plus Task subagents, so
 * the latest result is the correct accounting signal — never a sum across
 * results.
 */
function summarizeModelUsage(modelUsage: unknown):
  | { inputTokens?: number; outputTokens?: number; totalCostUsd?: number }
  | undefined {
  if (typeof modelUsage !== "object" || modelUsage === null) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd = 0;
  for (const entry of Object.values(modelUsage)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { inputTokens?: unknown; outputTokens?: unknown; costUSD?: unknown };
    if (typeof record.inputTokens === "number") inputTokens += record.inputTokens;
    if (typeof record.outputTokens === "number") outputTokens += record.outputTokens;
    if (typeof record.costUSD === "number") totalCostUsd += record.costUSD;
  }
  if (inputTokens === 0 && outputTokens === 0 && totalCostUsd === 0) return undefined;
  return {
    ...(inputTokens > 0 ? { inputTokens: Math.round(inputTokens) } : {}),
    ...(outputTokens > 0 ? { outputTokens: Math.round(outputTokens) } : {}),
    ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
  };
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
