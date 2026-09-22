import { randomUUID } from "node:crypto";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
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
}

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQueryHandle;

export interface ClaudeProviderDeps extends TranslatorDeps {
  /** Test seam; defaults to the real claude-agent-sdk query. */
  queryFactory?: ClaudeQueryFactory;
}

const CAPABILITIES = ["prompt.message", "permission", "session.persistence"] as const;

type PermissionResultLike =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

interface ClaudeSession {
  id: string;
  config: ProviderSessionConfig;
  translatedSystemPrompt: string | null;
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
      context.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: {
          models: [{ id: "default", label: "Claude (CLI default)", isDefault: true }],
          modes: [],
        },
      });
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
    case "session.configure":
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
  const options: Options = {
    cwd: session.config.cwd,
    env: { ...process.env, ...session.config.env },
    abortController: session.abort,
    ...(session.claudeSessionId !== null ? { resume: session.claudeSessionId } : {}),
    ...(session.config.model !== undefined && session.config.model !== "default"
      ? { model: session.config.model }
      : {}),
    ...(session.translatedSystemPrompt !== null
      ? { systemPrompt: session.translatedSystemPrompt }
      : {}),
    ...(values.claudeExecutablePath.length > 0
      ? { pathToClaudeCodeExecutable: values.claudeExecutablePath }
      : {}),
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
