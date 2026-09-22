import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
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
  TRANSLATE_CLAUDE_PROVIDER_ID,
  TRANSLATE_CLAUDE_PROVIDER_LABEL,
  type TranslateSettingsValues,
} from "../shared/translate";

/** Minimal SDK Query surface this provider uses; test fakes implement the same. */
export interface ClaudeQueryHandle {
  interrupt(): Promise<unknown>;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  supportedModels?(): Promise<readonly ModelInfoLike[]>;
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
  "permission",
  "session.persistence",
  "session.configure",
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
  pendingPermissions: Map<string, (response: PermissionResultLike | null) => void>;
}

interface PromptSink {
  push(message: SDKUserMessage): void;
  iterable: AsyncIterable<SDKUserMessage>;
}

function createPromptSink(): PromptSink {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          const pending = queue.shift();
          if (pending !== undefined) return { value: pending, done: false };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          const message = queue.shift();
          return message === undefined
            ? { value: undefined, done: true }
            : { value: message, done: false };
        },
      };
    },
  };
  return {
    push(message) {
      queue.push(message);
      wake?.();
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
 * MVP surface: message prompts, streaming text, tool-call snapshots,
 * permission pass-through, interrupt, and session persistence via Claude's
 * session id. Steer, slash commands, images, subagent tracks, and model
 * discovery are not declared as capabilities, so the daemon never sends them.
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
        await session.query.interrupt().catch(() => undefined);
      }
      context.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.permission": {
      respondToPermission(context.sessions.get(input.sessionId), input.permissionId, input.response, context.emit);
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
    pendingPermissions: new Map(),
  };
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
  if (session.active !== null) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "A turn is already running on this session" } },
    });
    return;
  }
  if (input.prompt.input.type !== "message") {
    throw new Error("Translate Claude provider only accepts message prompts");
  }
  let translated: string;
  try {
    translated = await translatePromptContent(input.prompt.input.content, context);
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
    message: { role: "user", content: [{ type: "text", text: translated }] },
    parent_tool_use_id: null,
  });
}

async function translatePromptContent(
  content: ReadonlyArray<{ type?: unknown; text?: unknown } | unknown>,
  context: DispatchContext,
): Promise<string> {
  const values = await context.loadValues();
  const translate = values.translatePrompts
    ? (text: string) => context.translator.translate(text, "user-to-agent")
    : async (text: string) => text;
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push(await translatePromptFragment((block as { text: string }).text, translate));
    } else {
      // Structured attachments pass through serialized, exactly like the ACP
      // provider flattens them; their JSON must not be machine-translated.
      parts.push(JSON.stringify(block));
    }
  }
  const joined = parts.join("\n");
  if (joined.trim().length === 0) {
    throw new Error("Refusing to send an empty prompt");
  }
  return joined;
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
        context.emit,
      )) as unknown as NonNullable<Options["canUseTool"]>,
  };
  const query = context.queryFactory({ prompt: session.sink.iterable, options });
  session.query = query;
  session.pump = pumpQuery(session, query, context.emit);
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
  emit: (event: ProviderEvent) => void,
): Promise<PermissionResultLike | null> {
  return new Promise((resolve) => {
    const permissionId = toolOptions.requestId;
    session.pendingPermissions.set(permissionId, resolve);
    toolOptions.signal.addEventListener("abort", () => {
      const pending = session.pendingPermissions.get(permissionId);
      if (pending === undefined) return;
      session.pendingPermissions.delete(permissionId);
      pending({ behavior: "deny", message: "Permission request expired" });
      // Resolve the daemon-side card too: a superseded request would otherwise
      // linger until the turn ends and ignore taps.
      emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
    });
    emit({
      type: "session.permission",
      sessionId: session.id,
      request: {
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
    });
  });
}

function respondToPermission(
  session: ClaudeSession | undefined,
  permissionId: string,
  response: ProviderPermissionResponse,
  emit: (event: ProviderEvent) => void,
): void {
  if (session === undefined) return;
  const pending = session.pendingPermissions.get(permissionId);
  if (pending === undefined) return;
  session.pendingPermissions.delete(permissionId);
  if (response.behavior === "allow") {
    pending({
      behavior: "allow",
      updatedInput: response.updatedInput,
      updatedPermissions: response.updatedPermissions,
    });
  } else {
    pending({
      behavior: "deny",
      message: response.message ?? "Denied",
      interrupt: response.interrupt,
    });
  }
  emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
}

async function pumpQuery(
  session: ClaudeSession,
  query: ClaudeQueryHandle,
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  try {
    for await (const message of query) {
      if (session.closed) return;
      handleSdkMessage(session, message, emit);
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
  for (const pending of session.pendingPermissions.values()) {
    pending({ behavior: "deny", message: "Claude session ended" });
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
  emit: (event: ProviderEvent) => void,
): void {
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
        (block as { type?: unknown }).type === "tool_use"
      ) {
        const use = block as { id: string; name: string; input?: unknown };
        session.toolNames.set(use.id, use.name);
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
            detail: {
              type: "plain_text",
              label: use.name,
              text: JSON.stringify(use.input ?? {}),
            },
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
        const output = flattenToolResultContent(result.content);
        emit({
          type: "timeline.item",
          sessionId: session.id,
          item: {
            type: "tool_call",
            id: result.tool_use_id,
            callId: result.tool_use_id,
            name: session.toolNames.get(result.tool_use_id) ?? "tool",
            ...(result.is_error
              ? { status: "failed" as const, error: output ?? "Tool failed" }
              : { status: "completed" as const, error: null }),
            detail: { type: "plain_text", label: "output", text: output ?? "" },
          },
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

function flattenToolResultContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
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
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

async function teardownSession(session: ClaudeSession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  session.abort.abort();
  for (const pending of session.pendingPermissions.values()) {
    pending({ behavior: "deny", message: "Session closed" });
  }
  session.pendingPermissions.clear();
  await session.pump?.catch(() => undefined);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
