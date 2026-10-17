import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
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
  type ProviderThinkingOption,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  buildCodexInitializeParams,
  resolvePathCodex,
  spawnCodexAppServer,
  validateCodexExecutable,
  type CodexClientFactoryOptions,
  type CodexClientLike,
} from "./codex-app-server";
import {
  extractUserText,
  formatCodexQuestionPrompts,
  isRecord,
  nonEmptyString,
  normalizeCodexQuestionPrompts,
  normalizeCodexItemType,
  readThreadId,
  readTurnStatus,
  readTurnId,
  threadItemToTimeline,
  threadItemTimelineEntries,
  toCodexUsage,
  toObjectRecord,
  type CodexQuestionPrompt,
} from "./codex-items";
import { materializeImageOutput } from "./image-output";
import { CodexItemStream, normalizeCodexNotification } from "./codex-item-stream";
import { normalizeCodexOutputSchema } from "./codex-output-schema";
import { codexCollaborationModes, codexSandboxPolicy, codexServiceTiers, type CodexCollaborationMode } from "./codex-session-settings";
import { codexHome, codexCustomPrompts, expandCodexCustomPrompt } from "./codex-commands";
import { readCodexHistory } from "./codex-history";
import { registerChildThreads, routeChildNotification, closeChildren, type CodexChildSession } from "./codex-child-sessions";
import {
  isSerializedAttachment,
  restorePromptFragment,
  translatePromptFragment,
} from "./prompt-text";
import type { PromptTranslationFragment } from "../shared/prompt-text";
import { translateQuestionsForDisplay } from "./question";
import { translateSessionTitlesForDisplay } from "./session-titles";
import { createTranslator, type TranslatorDeps } from "./translate";
import {
  TRANSLATE_CODEX_PROVIDER_ID,
  TRANSLATE_CODEX_PROVIDER_LABEL,
  TRANSLATION_TEXT_LIMIT,
  omitTranslationBridgeEnv,
  resolveTranslationContextKey,
  type TranslateSettingsValues,
} from "../shared/translate";

export type CodexClientFactory = (options: CodexClientFactoryOptions) => Promise<CodexClientLike>;

export interface CodexProviderDeps extends TranslatorDeps {
  /** Test seam; defaults to spawning `codex app-server`. */
  createClient?: CodexClientFactory;
}

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "prompt.output_schema",
  "session.subsession",
  "permission",
  "session.persistence",
  "session.configure",
  "session.list",
  "session.revert.conversation",
] as const;

/** Mirrors the native Codex provider's modes (read-only is not offered). */
const STATIC_MODES: ProviderMode[] = [
  {
    id: "auto",
    label: "Default Permissions",
    description: "Edit files and run commands with Codex's default approval flow.",
  },
  {
    id: "auto-review",
    label: "Auto-review",
    description:
      "Same workspace-write permissions as Default, but eligible on-request approvals are routed through the auto-reviewer subagent.",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edit files, run commands, and access the network without additional prompts.",
  },
];
const VALID_MODES = new Set(STATIC_MODES.map((mode) => mode.id));
const DEFAULT_MODE_ID = "auto";

const MODE_PRESETS: Record<string, { approvalPolicy: string; sandbox: string; approvalsReviewer?: string }> =
  {
    auto: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" },
    "auto-review": {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    },
    "full-access": { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" },
  };

const TURN_START_TIMEOUT_MS = 90_000;
const INTERRUPT_TIMEOUT_MS = 5_000;

const ALLOW_DENY_ACTIONS = [
  { id: "allow", label: "Allow", behavior: "allow" as const },
  { id: "deny", label: "Deny", behavior: "deny" as const },
];

interface PendingPermission {
  resolve: (response: unknown) => void;
  kind: "command" | "file" | "question" | "elicitation" | "plan";
  answering?: boolean;
  serverRequestId?: number;
  asyncItemId?: string;
  planText?: string;
  itemId?: string;
  questions?: CodexQuestionPrompt[];
  translatedQuestions?: unknown[];
}

interface CodexSession {
  id: string;
  config: ProviderSessionConfig;
  /** Translation-context scope: the bridged paseo agent id, else the provider session id. */
  contextKey: string;
  translatedSystemPrompt: string | null;
  desiredModel: string | null;
  defaultModel: string | null;
  desiredMode: string | null;
  desiredThinking: string | null;
  serviceTier: string;
  planMode: boolean;
  collaborationModes: CodexCollaborationMode[];
  proposedPlan: string | null;
  resolvedSandbox: Record<string, unknown>;
  resolvedApprovalPolicy: unknown;
  resolvedReviewer: string | null;
  resolvedModelProvider: string | null;
  connecting: Promise<CodexClientLike> | null;
  startingThread: Promise<string> | null;
  rewinding: boolean;
  permissionGeneration: number;
  preparingQuestions: Map<string, number>;
  stream: CodexItemStream;
  supportsSubsessions: boolean;
  children: Map<string, CodexChildSession>;
  childBuffer: Array<{ method: string; params: unknown }>;
  asyncQuestions: Map<string, { item: Record<string, unknown>; answered: boolean }>;
  client: CodexClientLike | null;
  threadId: string | null;
  nativeTurnId: string | null;
  supersededNativeTurnIds: Set<string>;
  active: { clientMessageId: string; turnId: string; phase: "preparing" | "starting" | "running"; canceled: boolean; identified: Promise<void>; identify: () => void } | null;
  /**
   * Native parity: root-thread turn activity arriving with no open foreground
   * turn (a turn/start ack timeout whose turn still started server-side) is
   * live work, so a synthetic turn is opened that the daemon tracks as a
   * running session until the turn/completed, the next prompt, an interrupt,
   * a rewind, or a process death.
   */
  autonomous: { turnId: string } | null;
  interrupted: boolean;
  closed: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  pendingUserAnchors: Array<{ clientMessageId: string; text: string }>;
  userMessageTurnIds: Map<string, string>;
  catalogModels: ProviderModel[];
  commands: ProviderCommand[];
  skills: Array<{ name: string; path: string }>;
  emittedUserMessageIds: Set<string>;
}

export function createTranslateCodexProvider(deps: CodexProviderDeps): ProviderRegistration {
  const translator = createTranslator(deps);
  const createClient = deps.createClient ?? createRealClient;
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, CodexSession>();
  const context: DispatchContext = {
    sessions,
    translator,
    createClient,
    loadValues: () => deps.loadConfig(),
    emit(event) {
      if (!connectionClosed) for (const listener of listeners) listener(event);
    },
  };
  let connectionClosed = false;

  return {
    id: TRANSLATE_CODEX_PROVIDER_ID,
    label: TRANSLATE_CODEX_PROVIDER_LABEL,
    description:
      "Talks to Codex directly through the official app-server. Prompts are translated before Codex sees them; replies stream back in Codex's language and are translated in the app after the stream completes.",
    icon: "icon.svg",
    async getCatalogCacheKey(options) {
      const values = await deps.loadConfig();
      const executable =
        values.codexExecutablePath.length > 0
          ? values.codexExecutablePath
          : (resolvePathCodex() ?? "missing");
      return options.scope === "workspace"
        ? JSON.stringify({ executable, cwd: options.cwd })
        : JSON.stringify({ executable });
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Translate Codex provider requires provider protocol version 1");
      }
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      const connection: ProviderConnection = {
        version: 1,
        capabilities,
        async send(input) {
          if (connectionClosed) throw new Error("Translate Codex provider connection is closed");
          await dispatch(input, context, capabilities);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          if (connectionClosed) return;
          for (const session of sessions.values()) await teardownSession(session, context);
          connectionClosed = true;
          sessions.clear();
          listeners.clear();
        },
      };
      return connection;
    },
  };
}

interface DispatchContext {
  sessions: Map<string, CodexSession>;
  translator: ReturnType<typeof createTranslator>;
  createClient: CodexClientFactory;
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
      try {
        const catalog = await probeCatalog(context);
        context.emit({ type: "catalog", requestId: input.requestId, catalog });
      } catch (error) {
        context.emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: describe(error) },
        });
      }
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
      try {
        if (session !== undefined) await interruptSession(session, context);
        context.emit({ type: "request.completed", requestId: input.requestId });
      } catch (error) {
        context.emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: describe(error) },
        });
      }
      return;
    }
    case "session.permission": {
      await respondToPermission(
        context.sessions.get(input.sessionId),
        input.permissionId,
        input.response,
        context,
      );
      return;
    }
    case "session.close": {
      const session = context.sessions.get(input.sessionId);
      context.sessions.delete(input.sessionId);
      if (session !== undefined) await teardownSession(session, context);
      context.emit({ type: "session.closed", sessionId: input.sessionId });
      context.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.configure": {
      requireProviderCapabilities(capabilities, input);
      const session = context.sessions.get(input.sessionId);
      if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
      applyConfigChanges(session, input.changes, context);
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
        error: { message: `${input.type} is not supported by the Translate Codex provider` },
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

async function probeCatalog(context: DispatchContext): Promise<ProviderCatalog> {
  const client = await connectEphemeralClient(context, process.cwd());
  try {
    const models = await loadModels(client);
    return {
      models,
      modes: STATIC_MODES,
      defaultMode: DEFAULT_MODE_ID,
      defaultModel: models.find((model) => model.isDefault)?.id ?? models[0]?.id,
      defaultThinkingOption: models.find((model) => model.isDefault)?.defaultThinkingOptionId,
    };
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

async function connectEphemeralClient(
  context: DispatchContext,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<CodexClientLike> {
  const values = await context.loadValues();
  const command = resolveCodexCommand(values);
  const client = await context.createClient({
    command,
    args: ["app-server"],
    cwd,
    env: { ...process.env, ...env },
  });
  await client.request("initialize", buildCodexInitializeParams());
  client.notify("initialized", {});
  return client;
}

function resolveCodexCommand(values: TranslateSettingsValues): string {
  const override = values.codexExecutablePath.trim();
  if (override.length > 0) return override;
  const fromPath = resolvePathCodex();
  if (fromPath !== null) return fromPath;
  throw new Error(
    "Codex binary not found. Install the Codex CLI (https://github.com/openai/codex) and ensure it is available in your shell PATH. Microsoft Store installs are not auto-detected — set the Codex executable path in Translate settings to the full path of codex.exe.",
  );
}

async function loadModels(client: CodexClientLike): Promise<ProviderModel[]> {
  const raw = toObjectRecord(await client.request("model/list", {}));
  const data = Array.isArray(raw?.data) ? raw.data : [];
  const models: ProviderModel[] = [];
  for (const entry of data) {
    const record = toObjectRecord(entry);
    if (record === null) continue;
    const id = nonEmptyString(record.id);
    if (id === null) continue;
    const thinking = thinkingOptionsFromModel(record);
    models.push({
      id,
      metadata: { model: typeof record.model === "string" ? record.model : id, serviceTiers: z.json().parse(record.serviceTiers ?? []) },
      label: nonEmptyString(record.displayName) ?? id,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(record.isDefault === true ? { isDefault: true } : {}),
      ...(thinking.options.length > 0 ? { thinkingOptions: thinking.options } : {}),
      ...(thinking.defaultId !== undefined ? { defaultThinkingOptionId: thinking.defaultId } : {}),
    });
  }
  return models;
}

function thinkingOptionsFromModel(record: Record<string, unknown>): {
  options: ProviderThinkingOption[];
  defaultId?: string;
} {
  const defaultId =
    typeof record.defaultReasoningEffort === "string" && record.defaultReasoningEffort !== "default"
      ? record.defaultReasoningEffort
      : undefined;
  const options: ProviderThinkingOption[] = [];
  const seen = new Set<string>();
  const efforts = Array.isArray(record.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts
    : [];
  for (const entry of efforts) {
    const id =
      typeof entry === "string"
        ? entry
        : typeof toObjectRecord(entry)?.reasoningEffort === "string"
          ? (toObjectRecord(entry)?.reasoningEffort as string)
          : null;
    if (id === null || id === "default" || seen.has(id)) continue;
    seen.add(id);
    const description =
      isRecord(entry) && typeof entry.description === "string" ? entry.description : undefined;
    options.push({
      id,
      label: id,
      ...(description !== undefined ? { description } : {}),
      ...(id === defaultId ? { isDefault: true } : {}),
    });
  }
  if (defaultId !== undefined && !seen.has(defaultId)) {
    options.push({
      id: defaultId,
      label: defaultId,
      description: "Model default reasoning effort",
      isDefault: true,
    });
  }
  return { options, defaultId: defaultId ?? options.find((option) => option.isDefault)?.id };
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  context: DispatchContext,
  capabilities: readonly string[],
): Promise<void> {
  if (context.sessions.has(input.sessionId)) {
    throw new Error(`Session already exists: ${input.sessionId}`);
  }
  const contextKey = resolveTranslationContextKey(input.config.env, input.sessionId);
  let translatedSystemPrompt: string | null = null;
  if (typeof input.config.systemPrompt === "string" && input.config.systemPrompt.trim().length > 0) {
    if ((await context.loadValues()).translatePrompts) {
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
  const storedThreadId = readStoredThreadId(input.persistence);
  const session: CodexSession = {
    id: input.sessionId,
    config: input.config,
    contextKey,
    translatedSystemPrompt,
    desiredModel: readConfigured(input.config.model),
    defaultModel: null,
    desiredMode: readConfigured(input.config.mode) ?? DEFAULT_MODE_ID,
    desiredThinking: readConfigured(input.config.thinkingOption),
    serviceTier: readConfigured(input.config.settings?.service_tier) ?? (input.config.settings?.fast_mode === true ? "fast" : "default"),
    planMode: input.config.settings?.plan_mode === true,
    collaborationModes: [],
    proposedPlan: null,
    resolvedSandbox: {},
    resolvedApprovalPolicy: undefined,
    resolvedReviewer: null,
    resolvedModelProvider: null,
    connecting: null,
    startingThread: null,
    rewinding: false,
    permissionGeneration: 0,
    preparingQuestions: new Map(),
    stream: new CodexItemStream(input.config.cwd),
    supportsSubsessions: capabilities.includes("session.subsession"),
    children: new Map(),
    childBuffer: [],
    asyncQuestions: readStoredQuestions(input.persistence),
    client: null,
    threadId: storedThreadId,
    nativeTurnId: null,
    supersededNativeTurnIds: new Set(),
    active: null,
    autonomous: null,
    interrupted: false,
    closed: false,
    pendingPermissions: new Map(),
    pendingUserAnchors: [],
    userMessageTurnIds: new Map(),
    catalogModels: [],
    commands: [],
    skills: [],
    emittedUserMessageIds: new Set(),
  };
  context.sessions.set(input.sessionId, session);
  context.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities,
    restoration: "core",
    ...(storedThreadId !== null ? { persistence: { version: 1, data: { threadId: storedThreadId } } } : {}),
    title: input.config.title,
    cwd: input.config.cwd,
  });
  try {
    await ensureClient(session, context);
    if (input.history === "replay" && storedThreadId !== null) {
      await replayHistory(session, context);
    } else {
      for (const saved of session.asyncQuestions.values()) await receiveAsyncQuestion(session, saved.item, context);
    }
  } catch (error) {
    context.sessions.delete(input.sessionId);
    await teardownSession(session).catch(() => undefined);
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: describe(error) },
    });
    return;
  }
  context.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  context.emit({
    type: "session.config",
    sessionId: input.sessionId,
    config: configStateFor(session),
  });
  if (session.commands.length > 0) {
    context.emit({ type: "session.commands", sessionId: session.id, commands: session.commands });
  }
}

async function ensureClient(session: CodexSession, context: DispatchContext): Promise<CodexClientLike> {
  if (session.closed) throw new Error("Codex session is closed");
  if (session.connecting !== null) return session.connecting;
  if (session.client !== null) return session.client;
  session.connecting = initializeSessionClient(session, context);
  try { return await session.connecting; }
  finally { session.connecting = null; }
}

async function initializeSessionClient(session: CodexSession, context: DispatchContext): Promise<CodexClientLike> {
  const values = await context.loadValues();
  const command = resolveCodexCommand(values);
  const client = await context.createClient({
    command,
    args: ["app-server"],
    cwd: session.config.cwd,
    env: { ...process.env, ...omitTranslationBridgeEnv(session.config.env) },
  });
  if (session.closed) { await client.dispose(); throw new Error("Codex session is closed"); }
  session.client = client;
  client.setUnexpectedTerminationHandler((error) => {
    if (session.client === client && !session.closed) handleClientExit(session, error, context);
  });
  client.setNotificationHandler((method, params) => {
    if (session.client === client && !session.closed) handleNotification(session, method, params, context);
  });
  client.setRequestHandler("item/commandExecution/requestApproval", (params) =>
    session.client === client ? handleCommandApproval(session, params, context) : { decision: "cancel" },
  );
  client.setRequestHandler("item/fileChange/requestApproval", (params) =>
    session.client === client ? handleFileChangeApproval(session, params, context) : { decision: "cancel" },
  );
  client.setRequestHandler("item/tool/requestUserInput", (params) =>
    session.client === client ? handleQuestionApproval(session, params, context) : { answers: {} },
  );
  client.setRequestHandler("tool/requestUserInput", (params) =>
    session.client === client ? handleQuestionApproval(session, params, context) : { answers: {} },
  );
  client.setRequestHandler("mcpServer/elicitation/request", (params, id) => session.client === client ? handleElicitation(session, params, id, context) : { action: "cancel", content: null, _meta: null });
  try {
  await client.request("initialize", buildCodexInitializeParams());
  client.notify("initialized", {});
  session.catalogModels = await loadModels(client);
  const resolved = toObjectRecord(toObjectRecord(await client.request("config/read", { cwd: session.config.cwd, includeLayers: false }).catch(() => ({})))?.config) ?? {};
  session.defaultModel = readConfigured(resolved.model) ?? session.catalogModels.find((model) => model.isDefault)?.id ?? null;
  session.desiredModel ??= session.defaultModel;
  session.desiredThinking ??= readConfigured(resolved.model_reasoning_effort);
  session.resolvedSandbox = toObjectRecord(resolved.sandbox_workspace_write) ?? {};
  session.resolvedApprovalPolicy = resolved.approval_policy;
  session.resolvedReviewer = readConfigured(resolved.approvals_reviewer);
  session.resolvedModelProvider = readConfigured(resolved.model_provider);
  if (session.config.settings?.service_tier === undefined && session.config.settings?.fast_mode === undefined) session.serviceTier = readConfigured(resolved.service_tier) ?? "default";
  session.collaborationModes = codexCollaborationModes(await client.request("collaborationMode/list", {}).catch(() => ({})));
  await refreshCommands(session, client, context);
  if (session.threadId !== null) {
    await resumeThread(session, client);
  }
  if (session.closed || session.client !== client) throw new Error("Codex client closed during initialization");
  return client;
  } catch (error) {
    if (session.client === client) session.client = null;
    await client.dispose().catch(() => undefined);
    throw error;
  }
}

async function resumeThread(session: CodexSession, client: CodexClientLike): Promise<void> {
  const threadId = session.threadId;
  if (threadId === null) return;
  const params: Record<string, unknown> = { threadId };
  if (session.config.model != null) params.model = session.desiredModel;
  if (session.config.mode != null) {
    const workflow = threadConfiguration(session);
    for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox"]) if (workflow[key] !== undefined) params[key] = workflow[key];
  }
  if (session.config.settings?.service_tier !== undefined || session.config.settings?.fast_mode !== undefined) params.serviceTier = selectedServiceTier(session);
  if (session.translatedSystemPrompt !== null) {
    params.developerInstructions = session.translatedSystemPrompt;
  }
  const inner = buildInnerConfig(session);
  if (inner !== null) params.config = inner;
  try {
    adoptThreadSettings(session, await client.request("thread/resume", params));
  } catch (error) {
    const message = describe(error);
    if (message.includes(`session ${threadId} is archived`)) {
      try {
        await client.request("thread/unarchive", { threadId });
      } catch (unarchiveError) {
        if (!describe(unarchiveError).includes("no archived rollout found")) throw unarchiveError;
      }
      adoptThreadSettings(session, await client.request("thread/resume", params));
      return;
    }
    throw new Error(`Failed to resume Codex thread ${threadId}: ${message}`, { cause: error });
  }
}

async function ensureThread(session: CodexSession, context: DispatchContext): Promise<string> {
  if (session.startingThread) return session.startingThread;
  if (session.threadId !== null) return session.threadId;
  session.startingThread = createThread(session, context);
  try { return await session.startingThread; }
  finally { session.startingThread = null; }
}

async function createThread(session: CodexSession, context: DispatchContext): Promise<string> {
  const client = await ensureClient(session, context);
  if (session.catalogModels.length === 0) {
    session.catalogModels = await loadModels(client);
  }
  const model =
    session.desiredModel ??
    session.catalogModels.find((entry) => entry.isDefault)?.id ??
    session.catalogModels[0]?.id;
  if (model === undefined) throw new Error("No models available from Codex app-server");
  session.desiredModel = model;
  const params: Record<string, unknown> = {
    ...threadConfiguration(session),
    model,
    cwd: session.config.cwd,
  };
  if (session.translatedSystemPrompt !== null) {
    params.developerInstructions = session.translatedSystemPrompt;
  }
  const inner = buildInnerConfig(session);
  if (inner !== null) params.config = inner;
  const response = await client.request("thread/start", params);
  const threadId = readThreadId(response);
  if (session.closed || session.client !== client) throw new Error("Codex client closed during thread creation");
  if (threadId === null) throw new Error("Codex app-server did not return thread id");
  adoptThreadSettings(session, response);
  session.threadId = threadId;
  context.emit({
    type: "session.persistence",
    sessionId: session.id,
    persistence: { version: 1, data: { threadId } },
  });
  return threadId;
}

function buildInnerConfig(session: CodexSession): Record<string, unknown> | null {
  const inner: Record<string, unknown> = {};
  if (session.resolvedModelProvider) inner.model_provider = session.resolvedModelProvider;
  if (Object.keys(session.resolvedSandbox).length) {
    const workspace = codexSandboxPolicy("workspace-write", session.resolvedSandbox, undefined);
    inner.sandbox_workspace_write = { writable_roots: workspace.writableRoots, network_access: workspace.networkAccess, exclude_slash_tmp: workspace.excludeSlashTmp, exclude_tmpdir_env_var: workspace.excludeTmpdirEnvVar };
  }
  const servers = toCodexMcpServers(session.config.mcpServers);
  if (servers !== null) inner.mcp_servers = servers;
  const raw = session.config.providerOptions;
  if (isRecord(raw)) Object.assign(inner, raw);
  return Object.keys(inner).length > 0 ? inner : null;
}

function toCodexMcpServers(
  servers: ProviderSessionConfig["mcpServers"],
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (name.length === 0) continue;
    if (server.type === "stdio") {
      result[name] = {
        command: server.command,
        ...(server.args !== undefined ? { args: [...server.args] } : {}),
        ...(server.env !== undefined ? { env: { ...server.env } } : {}),
      };
    } else if (server.type === "http" || server.type === "sse") {
      result[name] = {
        url: server.url,
        ...(server.headers !== undefined ? { http_headers: { ...server.headers } } : {}),
      };
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function loadSkills(
  client: CodexClientLike,
  cwd: string,
): Promise<{ commands: ProviderCommand[]; skills: Array<{ name: string; path: string }> }> {
  const raw = toObjectRecord(await client.request("skills/list", { cwds: [cwd] }));
  const entries = Array.isArray(raw?.data) ? raw.data : [];
  const commands: ProviderCommand[] = [];
  const skills: Array<{ name: string; path: string }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = toObjectRecord(entry);
    const list = Array.isArray(record?.skills) ? record.skills : [];
    for (const skill of list) {
      const skillRecord = toObjectRecord(skill);
      if (skillRecord === null || skillRecord.enabled === false) continue;
      const name = nonEmptyString(skillRecord.name);
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      const description =
        nonEmptyString(skillRecord.description) ??
        nonEmptyString(skillRecord.shortDescription) ??
        "Skill";
      const skillPath = nonEmptyString(skillRecord.path) ?? name;
      commands.push({ name, description });
      skills.push({ name, path: skillPath });
    }
  }
  return { commands, skills };
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
): Promise<void> {
  const session = context.sessions.get(input.sessionId);
  if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
  if (session.rewinding) {
    context.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: "Conversation rewind is in progress" } } });
    return;
  }
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
  const admission = reserveTurn(session, input.prompt.clientMessageId);
  let userInput: unknown[];
  try {
    userInput = await buildTurnInput(input.prompt.input.content, context, session.contextKey);
    if (!ownsAdmission(session, admission)) return cancelPreparation(session, admission, context);
    const outputSchema = input.prompt.outputSchema === undefined ? undefined : normalizeCodexOutputSchema(input.prompt.outputSchema);
    await startTurn(session, userInput, input.prompt.clientMessageId, rawPromptText(input.prompt.input.content), context, admission, outputSchema);
  } catch (error) {
    if (session.active !== admission) { if (admission.canceled && !session.closed) cancelPreparation(session, admission, context); return; }
    session.active = null;
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
}

async function commandSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
  session: CodexSession,
): Promise<void> {
  if (input.prompt.input.type !== "command") return;
  if (["compact", "goal"].includes(input.prompt.input.name)) {
    await runBuiltinCommand(session, input, context);
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
  const admission = reserveTurn(session, input.prompt.clientMessageId);
  const name = input.prompt.input.name;
  const args = input.prompt.input.arguments;
  let translatedArgs = "";
  if (args.trim().length > 0 && !name.startsWith("prompts:")) {
    try {
      const values = await context.loadValues();
      translatedArgs = values.translatePrompts
        ? await context.translator.translate(args, "user-to-agent", {
            contextKey: session.contextKey,
          })
        : args;
    } catch (error) {
      if (session.active !== admission) { if (admission.canceled && !session.closed) cancelPreparation(session, admission, context); return; }
      session.active = null;
      context.emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: describe(error) } },
      });
      return;
    }
  }
  try {
    const client = await ensureClient(session, context);
    await refreshCommands(session, client, context);
    const commandInput = name.startsWith("prompts:")
      ? await buildTurnInput([{ type: "text", text: await expandCodexCustomPrompt(codexHome(session.config.env), name, args) }], context, session.contextKey)
      : buildCodexCommandInput(session, name, translatedArgs);
    if (!ownsAdmission(session, admission)) return cancelPreparation(session, admission, context);
    const outputSchema = input.prompt.outputSchema === undefined ? undefined : normalizeCodexOutputSchema(input.prompt.outputSchema);
    await startTurn(
      session,
      commandInput,
      input.prompt.clientMessageId,
      `/${name}${args.trim().length > 0 ? ` ${args}` : ""}`,
      context,
      admission,
      outputSchema,
    );
  } catch (error) {
    if (session.active !== admission) { if (admission.canceled && !session.closed) cancelPreparation(session, admission, context); return; }
    session.active = null;
    context.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: describe(error) } } });
  }
}

function buildCodexCommandInput(
  session: CodexSession,
  name: string,
  translatedArgs: string,
): unknown[] {
  const skill = session.skills.find((entry) => entry.name === name);
  if (skill === undefined) throw new Error(`Unknown or disabled Codex command: /${name}`);
  const text = translatedArgs.length > 0 ? `$${name} ${translatedArgs}` : `$${name}`;
  return [{ type: "skill", name: skill.name, path: skill.path }, toCodexTextInput(text)];
}

async function startTurn(
  session: CodexSession,
  userInput: unknown[],
  clientMessageId: string,
  originalText: string,
  context: DispatchContext,
  admission: NonNullable<CodexSession["active"]>,
  outputSchema?: Record<string, unknown>,
  requireAcceptedDelivery = false,
): Promise<boolean> {
  const client = await ensureClient(session, context);
  if (!ownsAdmission(session, admission)) { cancelPreparation(session, admission, context); return false; }
  const threadId = await ensureThread(session, context);
  if (!ownsAdmission(session, admission)) { cancelPreparation(session, admission, context); return false; }
  const turnId = admission.turnId;
  admission.phase = "starting";
  session.interrupted = false;
  // Native parity: a new foreground turn supersedes an open autonomous one
  // (out-of-band work that outlived the previous turn's local state).
  settleAutonomousTurn(session, context, "completed");
  if (session.nativeTurnId !== null) session.supersededNativeTurnIds.add(session.nativeTurnId);
  session.nativeTurnId = null;
  session.stream.clear();
  session.proposedPlan = null;
  context.emit({
    type: "session.prompt_result",
    sessionId: session.id,
    clientMessageId,
    result: { type: "turn", turnId },
  });
  context.emit({ type: "session.turn", sessionId: session.id, turnId, state: "started" });
  session.pendingUserAnchors.push({ clientMessageId, text: originalText });
  const params: Record<string, unknown> = {
    threadId,
    input: userInput,
    clientUserMessageId: clientMessageId,
    ...(session.desiredModel !== null ? { model: session.desiredModel } : {}),
    effort: session.desiredThinking ?? session.catalogModels.find((model) => model.id === session.desiredModel)?.defaultThinkingOptionId ?? null,
    serviceTier: selectedServiceTier(session),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    cwd: session.config.cwd,
  };
  Object.assign(params, turnWorkflowPolicy(session));
  if (session.translatedSystemPrompt !== null) {
    params.developerInstructions = session.translatedSystemPrompt;
  }
  const collaboration = session.collaborationModes.find((mode) => mode.mode === (session.planMode ? "plan" : "default"));
  if (collaboration) params.collaborationMode = { mode: collaboration.mode, settings: { ...collaboration.settings,
    model: session.desiredModel ?? collaboration.settings.model,
    reasoning_effort: session.desiredThinking ?? collaboration.settings.reasoning_effort ?? null,
    developer_instructions: [collaboration.settings.developer_instructions, session.translatedSystemPrompt].filter((text) => typeof text === "string" && text.length).join("\n\n") || null } };
  try {
    if (admission.canceled || session.closed || session.active !== admission) {
      if (session.active === admission) session.active = null;
      if (!session.closed) context.emit({ type: "session.turn", sessionId: session.id, turnId, state: "canceled" });
      return false;
    }
    const response = await client.request("turn/start", params, TURN_START_TIMEOUT_MS);
    if (session.active === admission) {
      session.nativeTurnId ??= readTurnId(response);
      admission.phase = "running";
    }
    return true;
  } catch (error) {
    // Notifications may finish the turn before its start acknowledgement fails.
    if (session.active?.turnId !== turnId) { if (requireAcceptedDelivery) throw error; return false; }
    dropUnconsumedAnchors(session, clientMessageId);
    session.active = null;
    context.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId,
      state: "failed",
      error: { message: describe(error) },
    });
    if (session.nativeTurnId !== null && !session.interrupted) {
      startAutonomousTurn(session, context);
    }
    if (requireAcceptedDelivery) throw error;
    return false;
  } finally {
    admission.identify();
  }
}

function reserveTurn(session: CodexSession, clientMessageId: string): NonNullable<CodexSession["active"]> {
  let identify!: () => void;
  const identified = new Promise<void>((resolve) => { identify = resolve; });
  const admission: NonNullable<CodexSession["active"]> = { clientMessageId, turnId: randomUUID(), phase: "preparing", canceled: false, identified, identify };
  session.active = admission;
  return admission;
}

function ownsAdmission(session: CodexSession, admission: NonNullable<CodexSession["active"]>): boolean {
  return !session.closed && session.active === admission && !admission.canceled;
}

function cancelPreparation(session: CodexSession, admission: NonNullable<CodexSession["active"]>, context: DispatchContext): void {
  admission.identify();
  if (session.active === admission) session.active = null;
  if (!session.closed) context.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: admission.clientMessageId,
    result: { type: "failed", error: { message: "Prompt canceled before starting" } } });
}

async function steerSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
  session: CodexSession,
): Promise<void> {
  const active = session.active;
  const client = session.client;
  const threadId = session.threadId;
  const nativeTurnId = session.nativeTurnId;
  if (active === null || client === null || threadId === null || nativeTurnId === null) {
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
  let userInput: unknown[];
  try {
    userInput = await buildTurnInput(input.prompt.input.content, context, session.contextKey);
  } catch (error) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
  if (session.closed || session.active !== active || active.canceled || session.client !== client || session.threadId !== threadId || session.nativeTurnId !== nativeTurnId) {
    context.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "The active turn changed while preparing the follow-up" } } });
    return;
  }
  const anchor = { clientMessageId: input.prompt.clientMessageId, text: rawPromptText(input.prompt.input.content) };
  session.pendingUserAnchors.push(anchor);
  try {
    const response = await client.request(
      "turn/steer",
      {
        threadId,
        expectedTurnId: nativeTurnId,
        input: userInput,
        clientUserMessageId: input.prompt.clientMessageId,
      },
      TURN_START_TIMEOUT_MS,
    );
    const acknowledged = readTurnId(response) ?? nonEmptyString(toObjectRecord(response)?.turnId);
    if (acknowledged !== nativeTurnId) {
      throw new Error("Codex returned an invalid steer acknowledgement");
    }
  } catch (error) {
    dropUnconsumedAnchors(session, input.prompt.clientMessageId);
    if (!isDefinitiveSteerRejection(error)) throw error;
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
  if (input.prompt.clearPendingPermissions === true && session.active === active) denyPendingForSteer(session, context);
  context.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "steer", turnId: active.turnId },
  });
}

async function interruptSession(
  session: CodexSession,
  context: DispatchContext | null = null,
): Promise<void> {
  if (context) dismissAsyncQuestions(session, context);
  let admission = session.active;
  if (admission === null && session.autonomous === null && session.nativeTurnId === null) {
    denyPending(session, context);
    return;
  }
  if (admission !== null) {
    admission.canceled = true;
    if (admission.phase === "preparing") {
      session.active = null;
      admission.identify();
      denyPending(session, context);
      if (session.autonomous === null && session.nativeTurnId === null) return;
      admission = null;
    }
  }
  session.interrupted = true;
  const autonomous = session.autonomous;
  dropUnconsumedAnchors(session);
  denyPending(session, context);
  const client = session.client;
  const threadId = session.threadId;
  if (admission?.phase === "starting" && session.nativeTurnId === null) await admission.identified;
  if (session.active !== admission || session.client !== client || session.threadId !== threadId) return;
  const nativeTurnId = session.nativeTurnId;
  try {
    if (client !== null && threadId !== null && nativeTurnId !== null) {
      await client.request("turn/interrupt", { threadId, turnId: nativeTurnId }, INTERRUPT_TIMEOUT_MS);
    }
  } catch (error) {
    if (!isIdleInterruptError(error)) {
      if (session.nativeTurnId === nativeTurnId) {
        session.interrupted = false;
        if (session.active === admission && admission) admission.canceled = false;
      }
      throw error;
    }
    if (session.active === admission && session.nativeTurnId === nativeTurnId && session.client === client && session.threadId === threadId) {
      if (nativeTurnId) session.supersededNativeTurnIds.add(nativeTurnId);
      session.nativeTurnId = null;
      session.interrupted = false;
      session.active = null;
      admission?.identify();
      if (context) {
        for (const item of session.stream.settle("canceled", "Codex is already idle")) context.emit({ type: "timeline.item", sessionId: session.id, item });
        if (admission) context.emit({ type: "session.turn", sessionId: session.id, turnId: admission.turnId, state: "canceled" });
      }
    }
  }
  // Keep live work tracked when interruption fails. Completion notifications
  // may already have settled this turn while the interrupt was in flight.
  if (context !== null && session.autonomous === autonomous) {
    settleAutonomousTurn(session, context, "canceled");
  }
}

function handleClientExit(session: CodexSession, error: Error, context: DispatchContext): void {
  session.client = null;
  dropUnconsumedAnchors(session);
  denyPending(session, context);
  closeChildren(session, context);
  const active = session.active;
  active?.identify();
  session.active = null;
  session.nativeTurnId = null;
  session.supersededNativeTurnIds.clear();
  // A dead process ends out-of-band work too: its autonomous turn settles
  // alongside the foreground one.
  settleAutonomousTurn(session, context, "failed", error.message);
  if (active !== null) {
    context.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId: active.turnId,
      state: "failed",
      error: { message: error.message },
    });
    return;
  }
  if (!session.closed) {
    context.emit({
      type: "session.runtime_failed",
      sessionId: session.id,
      error: { message: error.message },
    });
  }
}

function handleNotification(
  session: CodexSession,
  method: string,
  params: unknown,
  context: DispatchContext,
): void {
  ({ method, params } = normalizeCodexNotification(method, params));
  const record = toObjectRecord(params);
  if (method === "thread/started") {
    const thread = toObjectRecord(record?.thread);
    const parentThreadId = nonEmptyString(thread?.parentThreadId);
    const threadId = nonEmptyString(thread?.id);
    if (threadId && parentThreadId && (parentThreadId === session.threadId || session.children.has(parentThreadId))) registerChildThreads(session, parentThreadId, { id: `spawn-${threadId}`, agentThreadId: threadId, agentNickname: thread?.agentNickname }, context);
    else if (threadId && session.threadId === null && session.startingThread) session.threadId = threadId;
    return;
  }
  // Native parity (resolveCodexThreadRoute): a notification whose threadId is
  // neither absent nor the session's root thread is sub-agent activity — its
  // turn lifecycle must not settle the root turn or overwrite its native
  // turn id, and its text must not surface as root replies.
  const notificationThreadId =
    record !== null && typeof record.threadId === "string" && record.threadId.length > 0
      ? record.threadId
      : null;
  const childThread =
    notificationThreadId !== null &&
    session.threadId !== null &&
    notificationThreadId !== session.threadId;
  if (childThread) {
    routeChildNotification(session, notificationThreadId, method, params, context);
    return;
  }
  const eventTurnId = readTurnId(record);
  if (eventTurnId !== null && session.supersededNativeTurnIds.has(eventTurnId)) return;
  if (eventTurnId !== null && session.nativeTurnId !== null && eventTurnId !== session.nativeTurnId && method !== "turn/started") return;
  if (method === "turn/started") {
    const nativeTurnId = readTurnId(params);
    if (nativeTurnId !== null && session.supersededNativeTurnIds.has(nativeTurnId)) return;
    session.nativeTurnId = nativeTurnId;
    // Native parity: a root-thread turn starting with no open foreground
    // turn is live work the plugin is not tracking (a turn/start ack timeout
    // whose turn still started server-side, or trailing activity after a
    // settled turn). Open a synthetic turn so the daemon keeps the session
    // listed as running. Trailing activity of a killed request (interrupted)
    // must not wake it, or a turn nothing closes wedges the status.
    if ((session.active === null || session.active.phase === "preparing") && !session.interrupted) {
      startAutonomousTurn(session, context);
    }
    if (session.active?.phase !== "preparing") session.active?.identify();
    if (session.interrupted && session.active?.canceled && session.active.phase === "running") {
      void interruptSession(session, context).catch((error) => emitRuntimeNotice(session, error, context));
    }
    return;
  }
  if (method === "turn/completed") {
    finishTurn(session, record, context);
    return;
  }
  if (method === "serverRequest/resolved") {
    for (const [id, pending] of session.pendingPermissions) {
      if (pending.serverRequestId === record?.requestId) {
        session.pendingPermissions.delete(id);
        pending.resolve({ action: "cancel", content: null, _meta: null });
        context.emit({ type: "session.permission_resolved", sessionId: session.id, permissionId: id });
      }
    }
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = toCodexUsage(record?.tokenUsage ?? record);
    if (usage !== null) context.emit({ type: "session.usage", sessionId: session.id,
      ...(session.active !== null ? { turnId: session.active.turnId } : {}), usage });
    return;
  }
  if (method === "turn/plan/updated") { handlePlanUpdate(session, record, context); return; }
  if (method === "item/started" || method === "item/completed") {
    const item = toObjectRecord(record?.item);
    if (item) {
      const itemType = normalizeCodexItemType(item.type);
      registerChildThreads(session, notificationThreadId ?? session.threadId, item, context);
      if (itemType === "userMessage") { noteUserMessage(session, item, readTurnId(record), context); return; }
      if (itemType === "plan" && typeof item.text === "string") session.proposedPlan = item.text;
      if (method === "item/completed" && item.delivery === "async") {
        void receiveAsyncQuestion(session, item, context).catch((error) => emitRuntimeNotice(session, error, context));
        return;
      }
    }
  }
  for (const item of session.stream.observe(method, params)) context.emit({ type: "timeline.item", sessionId: session.id, item });
}

function finishTurn(
  session: CodexSession,
  record: Record<string, unknown> | null,
  context: DispatchContext,
): void {
  const nativeTurnId = readTurnId(record);
  if (nativeTurnId !== null) {
    if (session.supersededNativeTurnIds.has(nativeTurnId)) return;
    if (session.nativeTurnId !== null && nativeTurnId !== session.nativeTurnId) return;
  }
  const active = session.active?.phase === "preparing" ? null : session.active;
  if (nativeTurnId) session.supersededNativeTurnIds.add(nativeTurnId);
  if (session.nativeTurnId) session.supersededNativeTurnIds.add(session.nativeTurnId);
  const autonomous = session.autonomous;
  if (active) session.active = null;
  active?.identify();
  session.autonomous = null;
  session.nativeTurnId = null;
  dropUnconsumedAnchors(session);
  const { status, errorMessage } = readTurnStatus(record);
  if (status === "failed" || status === "interrupted") {
    for (const item of session.stream.settle(status === "failed" ? "failed" : "canceled", errorMessage ?? "Turn ended")) context.emit({ type: "timeline.item", sessionId: session.id, item });
  }
  if (status === "interrupted") dismissAsyncQuestions(session, context);
  if (status !== "failed" && status !== "interrupted" && session.planMode && session.proposedPlan) offerPlanApproval(session, session.proposedPlan, context);
  // Native parity: the interrupt flag is consumed by ANY turn/completed, so
  // the trailing output of a killed request cannot wedge the status.
  session.interrupted = false;
  // The open turn settles the same way whether it is foreground or the
  // synthetic autonomous turn a late turn/started opened.
  const openTurn = active ?? autonomous;
  if (openTurn === null) return;
  const turnId = openTurn.turnId;
  if (status === "failed") {
    context.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId,
      state: "failed",
      error: { message: errorMessage ?? "Codex turn failed" },
    });
    return;
  }
  if (status === "interrupted") {
    context.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId,
      state: "canceled",
    });
    return;
  }
  context.emit({
    type: "session.turn",
    sessionId: session.id,
    turnId,
    state: "completed",
  });
}

/**
 * Mirrors the native adapter's out-of-band turn handling: the native
 * provider emits turn_started for root-thread turns regardless of its
 * foreground bookkeeping, so a session keeps reporting as running while
 * untracked work is live. Without this synthetic turn the daemon-side agent
 * settles to idle and the session list shows a still-working session as
 * stopped.
 */
function startAutonomousTurn(session: CodexSession, context: DispatchContext): void {
  if (session.autonomous !== null) return;
  const turnId = randomUUID();
  session.autonomous = { turnId };
  context.emit({ type: "session.turn", sessionId: session.id, turnId, state: "started" });
}

/** Ends the open autonomous turn, if any, with the given terminal state. */
function settleAutonomousTurn(
  session: CodexSession,
  context: DispatchContext,
  state: "completed" | "failed" | "canceled",
  error?: string,
): void {
  const autonomous = session.autonomous;
  if (autonomous === null) return;
  session.autonomous = null;
  context.emit({
    type: "session.turn",
    sessionId: session.id,
    turnId: autonomous.turnId,
    state,
    ...(error !== undefined ? { error: { message: error } } : {}),
  });
}

function dropUnconsumedAnchors(session: CodexSession, clientMessageId?: string): void {
  if (clientMessageId === undefined) {
    session.pendingUserAnchors = [];
    return;
  }
  session.pendingUserAnchors = session.pendingUserAnchors.filter(
    (anchor) => anchor.clientMessageId !== clientMessageId,
  );
}

function isDefinitiveSteerRejection(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) return false;
  if (error.code === -32601) return true;
  if (error.code !== -32600) return false;
  const info = toObjectRecord(toObjectRecord(error.data)?.codexErrorInfo);
  return isRecord(info?.activeTurnNotSteerable) || error.message === "no active turn to steer" ||
    /^expected active turn id `[^`]+` but found `[^`]+`$/.test(error.message) ||
    error.message === "active turn uses a different output schema";
}

function isIdleInterruptError(error: unknown): boolean {
  return error instanceof CodexAppServerRpcError && error.code === -32600 && error.message === "no active turn to interrupt";
}

function noteUserMessage(
  session: CodexSession,
  item: Record<string, unknown>,
  turnId: string | null,
  context: DispatchContext,
): void {
  const messageId = nonEmptyString(item.id);
  if (messageId === null || session.emittedUserMessageIds.has(messageId)) return;
  session.emittedUserMessageIds.add(messageId);
  if (turnId !== null) session.userMessageTurnIds.set(messageId, turnId);
  const anchor = session.pendingUserAnchors.shift();
  const text = anchor?.text ?? extractUserText(item.content);
  context.emit({
    type: "timeline.item",
    sessionId: session.id,
    item: {
      type: "user_message",
      id: `um-${messageId}`,
      text,
      messageId,
      ...(anchor !== undefined ? { clientMessageId: anchor.clientMessageId } : {}),
      revertToken: messageId,
    },
  });
}

function handlePlanUpdate(
  session: CodexSession,
  record: Record<string, unknown> | null,
  context: DispatchContext,
): void {
  const steps = Array.isArray(record?.plan) ? record.plan : Array.isArray(record?.steps) ? record.steps : [];
  const items = steps.flatMap((entry, index) => {
    const stepRecord = toObjectRecord(entry);
    const text = nonEmptyString(stepRecord?.step);
    if (text === null) return [];
    const status =
      stepRecord?.status === "completed"
        ? ("completed" as const)
        : stepRecord?.status === "inProgress" || stepRecord?.status === "in_progress"
          ? ("in_progress" as const)
          : ("pending" as const);
    return [{ id: String(index), text, status, completed: status === "completed" }];
  });
  if (items.length === 0) return;
  context.emit({
    type: "timeline.item",
    sessionId: session.id,
    item: { type: "todo", id: `plan-${session.active?.turnId ?? "todo"}`, items },
  });
}

function handleCommandApproval(
  session: CodexSession,
  params: unknown,
  context: DispatchContext,
): Promise<unknown> {
  const record = toObjectRecord(params) ?? {};
  if (!requestIsCurrent(session, record)) return Promise.resolve({ decision: "cancel" });
  const itemId = nonEmptyString(record.itemId) ?? randomUUID();
  const command = typeof record.command === "string" ? record.command : "";
  const cwd = typeof record.cwd === "string" ? record.cwd : session.config.cwd;
  const permissionId = `permission-${nonEmptyString(record.approvalId) ?? itemId}`;
  return waitForPermission(session, permissionId, "command", context, {
    id: permissionId,
    name: "CodexBash",
    kind: "tool",
    title: command.length > 0 ? `Run command: ${command}` : "Run command",
    ...(typeof record.reason === "string" ? { description: record.reason } : {}),
    input: { command, cwd },
    detail: { type: "shell", command, cwd },
    actions: ALLOW_DENY_ACTIONS,
  });
}

function handleFileChangeApproval(
  session: CodexSession,
  params: unknown,
  context: DispatchContext,
): Promise<unknown> {
  const record = toObjectRecord(params) ?? {};
  if (!requestIsCurrent(session, record)) return Promise.resolve({ decision: "cancel" });
  const itemId = nonEmptyString(record.itemId) ?? randomUUID();
  const permissionId = `permission-${nonEmptyString(record.approvalId) ?? itemId}`;
  return waitForPermission(session, permissionId, "file", context, {
    id: permissionId,
    name: "CodexFileChange",
    kind: "tool",
    title: "Apply file changes",
    ...(typeof record.reason === "string" ? { description: record.reason } : {}),
    actions: ALLOW_DENY_ACTIONS,
  });
}

async function handleQuestionApproval(
  session: CodexSession,
  params: unknown,
  context: DispatchContext,
): Promise<unknown> {
  const record = toObjectRecord(params) ?? {};
  if (!requestIsCurrent(session, record)) return { answers: {} };
  const itemId = nonEmptyString(record.itemId) ?? randomUUID();
  const questions = normalizeCodexQuestionPrompts(record.questions);
  const permissionId = `permission-${itemId}`;
  const generation = session.permissionGeneration;
  const activeAtRequest = session.active;
  const turnAtRequest = session.nativeTurnId;
  if (session.preparingQuestions.has(permissionId) || session.pendingPermissions.has(permissionId)) return { answers: {} };
  session.preparingQuestions.set(permissionId, generation);
  let translatedQuestions: unknown[] = questions;
  try {
    const values = await context.loadValues();
    if (values.translateResponses) {
      translatedQuestions = await translateQuestionsForDisplay(questions, (text) =>
        context.translator.translate(text, "agent-to-user", { contextKey: session.contextKey }),
      );
    }
  } catch (error) {
    console.warn(
      `[translate-codex] question display translation failed (${describe(error)}); keeping original text`,
    );
    translatedQuestions = questions;
  }
  if (session.preparingQuestions.get(permissionId) === generation) session.preparingQuestions.delete(permissionId);
  if (session.closed || generation !== session.permissionGeneration) return { answers: {} };
  if (session.asyncQuestions.get(itemId)?.answered) return { answers: {} };
  if (!session.asyncQuestions.has(itemId) && (session.active !== activeAtRequest || session.nativeTurnId !== turnAtRequest)) return { answers: {} };
  context.emit({
    type: "timeline.item",
    sessionId: session.id,
    item: {
      type: "tool_call",
      id: itemId,
      callId: itemId,
      name: session.asyncQuestions.has(itemId) ? "request_user_input_async" : "request_user_input",
      status: session.asyncQuestions.has(itemId) ? "completed" : "running",
      error: null,
      detail: {
        type: "plain_text",
        text: formatCodexQuestionPrompts(questions),
        icon: "brain",
      },
    },
  });
  return waitForPermission(
    session,
    permissionId,
    "question",
    context,
    {
      id: permissionId,
      name: session.asyncQuestions.has(itemId) ? "request_user_input_async" : "request_user_input",
      kind: "question",
      title: "Question",
      input: { questions: JSON.parse(JSON.stringify(translatedQuestions)) },
      detail: {
        type: "plain_text",
        text: formatCodexQuestionPrompts(
          Array.isArray(translatedQuestions)
            ? normalizeCodexQuestionPrompts(translatedQuestions)
            : questions,
        ),
        icon: "brain",
      },
    },
    questions,
    translatedQuestions,
    itemId,
  );
}

function waitForPermission(
  session: CodexSession,
  permissionId: string,
  kind: PendingPermission["kind"],
  context: DispatchContext,
  request: Extract<ProviderEvent, { type: "session.permission" }>["request"],
  questions?: CodexQuestionPrompt[],
  translatedQuestions?: unknown[],
  itemId?: string,
  ownership?: { serverRequestId?: number; planText?: string },
): Promise<unknown> {
  return new Promise((resolve) => {
    if (session.closed) { resolve(kind === "question" ? { answers: {} } : { decision: "cancel" }); return; }
    const previous = session.pendingPermissions.get(permissionId);
    if (previous) previous.resolve(previous.kind === "question" ? { answers: {} } : { decision: "cancel" });
    session.pendingPermissions.set(permissionId, {
      resolve,
      kind,
      ...ownership,
      ...(itemId !== undefined ? { itemId } : {}),
      ...(itemId !== undefined && session.asyncQuestions.has(itemId) ? { asyncItemId: itemId } : {}),
      ...(questions !== undefined ? { questions } : {}),
      ...(translatedQuestions !== undefined ? { translatedQuestions } : {}),
    });
    context.emit({ type: "session.permission", sessionId: session.id, request });
  });
}

async function respondToPermission(
  session: CodexSession | undefined,
  permissionId: string,
  response: ProviderPermissionResponse,
  context: DispatchContext,
): Promise<void> {
  if (session === undefined) return;
  if (session.rewinding) throw new Error("Cannot answer permissions while rewinding");
  const pending = session.pendingPermissions.get(permissionId);
  if (pending === undefined || pending.answering) return;
  pending.answering = true;
  if (pending.kind === "question") {
    const resolved = await resolveQuestionResponse(session, pending, response, context);
    if (session.closed || session.pendingPermissions.get(permissionId) !== pending) return;
    if (pending.asyncItemId && response.behavior === "allow" && resolved.cardResponse.behavior !== "allow") { pending.answering = false; throw new Error("Answer translation failed"); }
    if (pending.asyncItemId && resolved.cardResponse.behavior === "allow") {
      try { await deliverAsyncAnswer(session, pending, resolved.answers, context); }
      catch (error) { pending.answering = false; throw error; }
      if (session.pendingPermissions.get(permissionId) !== pending) return;
    }
    session.pendingPermissions.delete(permissionId);
    context.emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
    settleQuestionTool(session, pending, resolved.cardResponse, context);
    pending.resolve({ answers: resolved.answers });
    if (pending.asyncItemId) {
      const saved = session.asyncQuestions.get(pending.asyncItemId);
      if (saved) { saved.answered = true; saved.item.answers = resolved.answers; }
      emitPersistence(session, context);
    }
    return;
  }
  if (pending.kind === "plan" && response.behavior === "allow") {
    try {
      if (session.active !== null) throw new Error("Wait for the active turn before implementing the plan");
      session.planMode = false;
      const admission = reserveTurn(session, `plan-${randomUUID()}`);
      let accepted: boolean;
      try { accepted = await startTurn(session, [toCodexTextInput(`Implement the plan.\n\n${pending.planText ?? ""}\n\nCarry out the approved plan and verify the result.`)], admission.clientMessageId, "Implement the plan.", context, admission, undefined, true); }
      catch (error) { if (admission.phase === "preparing" && session.active === admission) session.active = null; admission.identify(); throw error; }
      if (!accepted) throw new Error("Plan implementation was canceled before delivery");
      context.emit({ type: "session.config", sessionId: session.id, config: configStateFor(session) });
    } catch (error) { pending.answering = false; throw error; }
  }
  session.pendingPermissions.delete(permissionId);
  context.emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
  if (pending.kind === "elicitation") { pending.resolve({ action: permissionDecision(response), content: response.behavior === "allow" ? {} : null, _meta: null }); return; }
  pending.resolve({ decision: permissionDecision(response) });
}

function settleQuestionTool(
  session: CodexSession,
  pending: PendingPermission,
  response: ProviderPermissionResponse,
  context: DispatchContext,
): void {
  if (pending.itemId === undefined) return;
  const status =
    response.behavior === "allow" ? "completed" : response.interrupt ? "canceled" : "failed";
  const detail = {
    type: "plain_text" as const,
    text: formatCodexQuestionPrompts(pending.questions ?? []),
    icon: "brain" as const,
  };
  context.emit({
    type: "timeline.item",
    sessionId: session.id,
    item:
      status === "failed"
        ? {
            type: "tool_call",
            id: pending.itemId,
            callId: pending.itemId,
            name: "request_user_input",
            status,
            error: { message: "Question dismissed" },
            detail,
          }
        : {
            type: "tool_call",
            id: pending.itemId,
            callId: pending.itemId,
            name: "request_user_input",
            status,
            error: null,
            detail,
          },
  });
}

async function resolveQuestionResponse(
  session: CodexSession,
  pending: PendingPermission,
  response: ProviderPermissionResponse,
  context: DispatchContext,
): Promise<{
  answers: Record<string, { answers: string[] }>;
  cardResponse: ProviderPermissionResponse;
}> {
  const questions = pending.questions ?? [];
  if (response.behavior !== "allow") {
    return { answers: {}, cardResponse: response };
  }
  const answersRecord = isRecord(response.updatedInput)
    ? toObjectRecord(response.updatedInput.answers)
    : null;
  const answers: Record<string, { answers: string[] }> = {};
  const translated = Array.isArray(pending.translatedQuestions)
    ? pending.translatedQuestions
    : questions;
  try {
    const values = await context.loadValues();
    const translateBack = values.translatePrompts
      ? (text: string) =>
          context.translator.translate(text, "user-to-agent", { contextKey: session.contextKey })
      : async (text: string) => text;
    for (let index = 0; index < questions.length; index += 1) {
      const original = questions[index];
      const shown = toObjectRecord(translated[index]) ?? original;
      const raw =
        answersRecord?.[shown.header as string] ??
        answersRecord?.[original.header] ??
        answersRecord?.[original.id];
      if (typeof raw !== "string" || raw.trim().length === 0) continue;
      // Display labels are bilingual (`译文 (原文)`); a picked label maps
      // straight back to the original without an endpoint round trip that
      // would garble the combined string. Only free text goes through MT.
      const displayedLabelToOriginal = new Map<string, string>();
      const optionsField: unknown =
        typeof shown === "object" && shown !== null && "options" in shown ? shown.options : [];
      const shownOptions: unknown[] = Array.isArray(optionsField) ? optionsField : [];
      for (let optionIndex = 0; optionIndex < shownOptions.length; optionIndex += 1) {
        const shownOption = toObjectRecord(shownOptions[optionIndex]);
        const sourceOption = original.options[optionIndex];
        const displayed = shownOption !== null ? nonEmptyString(shownOption.label) : null;
        const source = sourceOption !== undefined ? nonEmptyString(sourceOption.label) : null;
        if (displayed !== null && source !== null && !displayedLabelToOriginal.has(displayed)) {
          displayedLabelToOriginal.set(displayed, source);
        }
      }
      const pieces = original.multiSelect
        ? raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
        : [raw.trim()];
      const translatedPieces: string[] = [];
      for (const piece of pieces) {
        translatedPieces.push(displayedLabelToOriginal.get(piece) ?? (await translateBack(piece)));
      }
      answers[original.id] = { answers: translatedPieces };
    }
  } catch (error) {
    console.warn(`[translate-codex] question answer translation failed (${describe(error)}); declining`);
    return {
      answers: {},
      cardResponse: { behavior: "deny", message: "Answer translation failed" },
    };
  }
  return { answers, cardResponse: response };
}

function permissionDecision(response: ProviderPermissionResponse): "accept" | "cancel" | "decline" {
  if (response.behavior === "allow") return "accept";
  if (response.interrupt) return "cancel";
  return "decline";
}

function denyPending(session: CodexSession, context: DispatchContext | null): void {
  session.permissionGeneration += 1;
  session.preparingQuestions.clear();
  for (const [permissionId, pending] of session.pendingPermissions) {
    pending.resolve(pending.kind === "question" ? { answers: {} } : pending.kind === "elicitation" ? { action: "cancel", content: null, _meta: null } : { decision: "cancel" });
    if (context !== null) {
      context.emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
      if (pending.kind === "question" && pending.itemId !== undefined) {
        context.emit({
          type: "timeline.item",
          sessionId: session.id,
          item: {
            type: "tool_call",
            id: pending.itemId,
            callId: pending.itemId,
            name: "request_user_input",
            status: "canceled",
            error: null,
            detail: {
              type: "plain_text",
              text: formatCodexQuestionPrompts(pending.questions ?? []),
              icon: "brain",
            },
          },
        });
      }
    }
  }
  session.pendingPermissions.clear();
}

function denyPendingForSteer(session: CodexSession, context: DispatchContext): void {
  denyPending(session, context);
}

function applyConfigChanges(
  session: CodexSession,
  changes: Extract<ProviderInput, { type: "session.configure" }>["changes"],
  context: DispatchContext,
): void {
  if (session.rewinding) throw new Error("Cannot configure a session while rewinding");
  const nextModel = changes.model !== undefined ? readConfigured(changes.model) ?? session.defaultModel : session.desiredModel;
  const nextMode = changes.mode !== undefined ? readConfigured(changes.mode) ?? DEFAULT_MODE_ID : session.desiredMode;
  if (nextMode !== null && !VALID_MODES.has(nextMode)) throw new Error(`Invalid Codex mode "${nextMode}"`);
  for (const setting of ["fast_mode", "plan_mode"]) if (changes.settings?.[setting] !== undefined && typeof changes.settings[setting] !== "boolean") throw new Error(`${setting} must be a boolean`);
  const requestedTier = changes.settings?.service_tier ?? (changes.settings?.fast_mode !== undefined ? (changes.settings.fast_mode ? "fast" : "default") : undefined);
  if (requestedTier !== undefined && requestedTier !== "default" && !codexServiceTiers(session.catalogModels, nextModel).some((tier) => tier.id === requestedTier)) throw new Error(`Unsupported service tier: ${String(requestedTier)}`);
  if (changes.settings?.plan_mode === true && !session.collaborationModes.some((mode) => mode.mode === "plan")) throw new Error("Plan mode is unavailable from this Codex server");
  if (changes.model !== undefined) {
    session.desiredModel = readConfigured(changes.model) ?? session.defaultModel;
    if (!codexServiceTiers(session.catalogModels, session.desiredModel).some((tier) => tier.id === session.serviceTier)) session.serviceTier = "default";
  }
  if (changes.mode !== undefined) {
    const mode = readConfigured(changes.mode);
    if (mode !== null && !VALID_MODES.has(mode)) {
      throw new Error(`Invalid Codex mode "${mode}"`);
    }
    session.desiredMode = mode ?? DEFAULT_MODE_ID;
    if (session.active !== null) {
      context.emit({
        type: "session.notice",
        sessionId: session.id,
        notice: {
          id: "mode-next-turn",
          severity: "info",
          title: "Mode applies on the next turn",
        },
      });
    }
  }
  if (changes.thinkingOption !== undefined) {
    const thinking = readConfigured(changes.thinkingOption);
    session.desiredThinking = thinking === "default" ? null : thinking;
    if (session.active !== null) {
      context.emit({
        type: "session.notice",
        sessionId: session.id,
        notice: {
          id: "thinking-next-turn",
          severity: "info",
          title: "Thinking level applies on the next turn",
        },
      });
    }
  }
  if (changes.settings?.["fast_mode"] !== undefined) {
    const enabled = changes.settings["fast_mode"] === true;
    if (enabled && !codexServiceTiers(session.catalogModels, session.desiredModel).some((tier) => tier.id === "fast")) throw new Error("Fast service tier is unavailable for this model");
    session.serviceTier = enabled ? "fast" : "default";
  }
  if (changes.settings?.service_tier !== undefined) {
    const tier = String(changes.settings.service_tier);
    if (tier !== "default" && !codexServiceTiers(session.catalogModels, session.desiredModel).some((entry) => entry.id === tier)) throw new Error(`Unsupported service tier: ${tier}`);
    session.serviceTier = tier;
  }
  if (changes.settings?.plan_mode !== undefined) {
    if (changes.settings.plan_mode === true && !session.collaborationModes.some((mode) => mode.mode === "plan")) throw new Error("Plan mode is unavailable from this Codex server");
    session.planMode = changes.settings.plan_mode === true;
  }
  session.config = { ...session.config,
    ...(changes.model !== undefined ? { model: session.desiredModel ?? undefined } : {}),
    ...(changes.mode !== undefined ? { mode: session.desiredMode ?? undefined } : {}),
    ...(changes.thinkingOption !== undefined ? { thinkingOption: session.desiredThinking ?? undefined } : {}),
    settings: { ...session.config.settings, ...changes.settings } };
}

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
  if (session.rewinding) {
    context.emit({ type: "request.failed", requestId: input.requestId, error: { message: "Conversation rewind is already in progress" } });
    return;
  }
  if (input.scope !== "conversation") {
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: "Translate (Codex) only supports conversation rewind" },
    });
    return;
  }
  const messageId = typeof input.token === "string" ? input.token : "";
  if (messageId.length === 0 || session.threadId === null || session.client === null) {
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: `Invalid rewind target: ${JSON.stringify(input.token)}` },
    });
    return;
  }
  const beforeTurnId = session.userMessageTurnIds.get(messageId);
  if (beforeTurnId === undefined) {
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: `No Codex turn mapping for rewind target ${messageId}` },
    });
    return;
  }
  session.rewinding = true;
  const client = session.client;
  try {
    // A rewind must also end out-of-band work: the forked thread will never
    // deliver the old thread's turn/completed.
    if (session.active !== null || session.autonomous !== null) await interruptSession(session, context);
    denyPending(session, context);
    const history = await readCodexHistory(client, session.threadId);
    const forkParams = {
      threadId: session.threadId,
      ...threadConfiguration(session, true),
      excludeTurns: false,
      persistExtendedHistory: true,
    };
    const modernRevert = codexVersionAtLeast(client.version, 0, 159);
    const directFork = !modernRevert && (history.mode === "paginated" || codexVersionAtLeast(client.version, 0, 156));
    const response = await client.request("thread/fork", directFork ? { ...forkParams, beforeTurnId } : forkParams);
    const forked = readThreadId(response);
    if (forked === null) throw new Error("Codex thread/fork did not return a thread id");
    if (modernRevert) await client.request("thread/revert", { threadId: forked, beforeTurnId });
    else if (!directFork) {
      const index = history.turns.findIndex((turn) => turn.id === beforeTurnId);
      if (index < 0) throw new Error("Rewind turn was not found in Codex history");
      await client.request("thread/rollback", { threadId: forked, numTurns: history.turns.length - index });
    }
    const replacement: CodexSession = { ...session, threadId: forked, active: null, autonomous: null, nativeTurnId: null, interrupted: false,
      stream: new CodexItemStream(session.config.cwd), children: new Map(), childBuffer: [], userMessageTurnIds: new Map(), emittedUserMessageIds: new Set(),
      asyncQuestions: new Map(session.asyncQuestions), pendingPermissions: new Map(), preparingQuestions: new Map(), proposedPlan: null };
    const preparedEvents: ProviderEvent[] = [];
    await replayHistory(replacement, { ...context, emit: (event) => { preparedEvents.push(event); } }, false);
    if (session.closed || session.client !== client) throw new Error("Codex client closed during rewind");
    session.active?.identify();
    if (session.active) context.emit({ type: "session.turn", sessionId: session.id, turnId: session.active.turnId, state: "canceled" });
    session.threadId = forked;
    session.active = null;
    if (session.nativeTurnId) session.supersededNativeTurnIds.add(session.nativeTurnId);
    session.nativeTurnId = null;
    session.interrupted = false;
    closeChildren(session, context);
    session.stream = replacement.stream;
    session.children = replacement.children;
    session.childBuffer = replacement.childBuffer;
    session.userMessageTurnIds = replacement.userMessageTurnIds;
    session.emittedUserMessageIds = replacement.emittedUserMessageIds;
    session.asyncQuestions = replacement.asyncQuestions;
    session.proposedPlan = replacement.proposedPlan;
    emitPersistence(session, context);
    for (const event of preparedEvents) context.emit(event);
    for (const saved of session.asyncQuestions.values()) await receiveAsyncQuestion(session, saved.item, context);
    if (session.planMode && session.proposedPlan) offerPlanApproval(session, session.proposedPlan, context);
    context.emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "notification",
        id: `rewind-${randomUUID()}`,
        level: "info",
        message: `Rewound conversation to message ${messageId}.`,
      },
    });
    context.emit({ type: "request.completed", requestId: input.requestId });
  } catch (error) {
    context.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: describe(error) },
    });
  } finally {
    session.rewinding = false;
  }
}

async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  context: DispatchContext,
): Promise<void> {
  let sessions: ProviderSessionSummary[] = [];
  try {
    const client = await connectEphemeralClient(context, input.cwd ?? process.cwd());
    try {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      const raw = toObjectRecord(await client.request("thread/list", { limit, cwd: input.cwd ?? null }));
      const data = Array.isArray(raw?.data) ? raw.data : [];
      for (const entry of data) {
        const record = toObjectRecord(entry);
        const threadId = nonEmptyString(record?.id);
        if (threadId === null) continue;
        const cwd = nonEmptyString(record?.cwd) ?? input.cwd ?? process.cwd();
        if (input.cwd !== undefined && !sameCwd(cwd, input.cwd)) continue;
        const title = nonEmptyString(record?.name) ?? nonEmptyString(record?.preview) ?? undefined;
        const updatedAt =
          typeof record?.updatedAt === "number"
            ? new Date(record.updatedAt * 1000).toISOString()
            : undefined;
        sessions.push({
          persistence: { version: 1, data: { threadId } },
          cwd,
          ...(title !== undefined ? { title } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        });
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  } catch {
    sessions = [];
  }
  // Thread names/previews are engine-generated in the agent language; render
  // them for display (fail soft: a failed title keeps its original text).
  context.emit({
    type: "sessions",
    requestId: input.requestId,
    sessions: await translateSessionTitlesForDisplay(sessions, context),
  });
  context.emit({ type: "request.completed", requestId: input.requestId });
}

async function replayHistory(session: CodexSession, context: DispatchContext, restoreQuestions = true): Promise<void> {
  if (session.client === null || session.threadId === null) return;
  let restore: ((block: string) => Promise<string>) | null = null;
  try {
    restore = await buildReplayRestore(context);
  } catch {
    restore = null;
  }
  const { turns } = await readCodexHistory(session.client, session.threadId);
  const retainedQuestions = new Set<string>();
  for (const turn of turns) {
    session.proposedPlan = null;
    const turnRecord = toObjectRecord(turn);
    const turnId = nonEmptyString(turnRecord?.id);
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : [];
    for (const item of items) {
      if (isRecord(item)) {
        registerChildThreads(session, session.threadId, item, context);
        if (normalizeCodexItemType(item.type) === "plan" && typeof item.text === "string") session.proposedPlan = item.text;
        if (item.delivery === "async" && typeof item.id === "string") {
          retainedQuestions.add(item.id);
          if (restoreQuestions) await receiveAsyncQuestion(session, item, context);
          else if (!session.asyncQuestions.has(item.id)) session.asyncQuestions.set(item.id, { item, answered: false });
          continue;
        }
      }
      for (const mapped of threadItemTimelineEntries(item, session.config.cwd)) {
      if (mapped.type === "user_message") {
        const messageId = mapped.messageId;
        if (typeof messageId === "string") {
          session.emittedUserMessageIds.add(messageId);
          if (turnId !== null) session.userMessageTurnIds.set(messageId, turnId);
        }
        if (restore !== null) {
          mapped.text = await restore(mapped.text);
        }
      }
      context.emit({ type: "timeline.item", sessionId: session.id, item: mapped });
      }
    }
  }
  for (const id of session.asyncQuestions.keys()) if (!retainedQuestions.has(id)) session.asyncQuestions.delete(id);
  if (restoreQuestions && session.planMode && session.proposedPlan) offerPlanApproval(session, session.proposedPlan, context);
  const replayed = new Set<string>();
  for (const [threadId, child] of session.children) {
    if (replayed.has(threadId)) continue;
    replayed.add(threadId);
    try {
      const history = await readCodexHistory(session.client, threadId);
      for (const turn of history.turns) for (const item of Array.isArray(turn.items) ? turn.items : []) {
        if (!isRecord(item)) continue;
        registerChildThreads(session, threadId, item, context);
        if (item.type === "userMessage") {
          const mapped = threadItemToTimeline(item);
          if (mapped) context.emit({ type: "timeline.item", sessionId: child.id, item: mapped });
        } else for (const entry of child.stream.observe(turn.status === "inProgress" ? "item/started" : "item/completed", { item })) context.emit({ type: "timeline.item", sessionId: child.id, item: entry });
      }
    } catch (error) { emitRuntimeNotice(session, new Error(`Could not restore subagent ${threadId}: ${describe(error)}`), context); }
  }
}

async function buildReplayRestore(
  context: DispatchContext,
): Promise<(block: string) => Promise<string>> {
  const lookupExact = (fragment: string): string | undefined => {
    try {
      return context.translator.restoreOriginalFragment(fragment);
    } catch {
      return undefined;
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
        } catch {
          return undefined;
        }
      };
    }
  } catch {
    translateBack = undefined;
  }
  return async (block: string) => {
    const restored = restorePromptFragment(block, lookupExact);
    if (restored !== block) return restored;
    if (translateBack === undefined) return block;
    return (await translateBack(block)) ?? block;
  };
}

async function buildTurnInput(
  content: ReadonlyArray<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown } | unknown>,
  context: DispatchContext,
  contextKey: string,
): Promise<unknown[]> {
  const values = await context.loadValues();
  const translate = values.translatePrompts
    ? (text: string) =>
        context.translator.translate(text, "user-to-agent", { contextKey })
    : async (text: string) => text;
  const blocks: unknown[] = [];
  const displayFragments: PromptTranslationFragment[] = [];
  let hasContent = false;
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      const translated = await translatePromptFragment(block.text, translate);
      displayFragments.push({ original: block.text, translated });
      if (translated.trim().length > 0) hasContent = true;
      blocks.push(toCodexTextInput(translated));
    } else if (
      isRecord(block) &&
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      hasContent = true;
      const materialized = materializeImageOutput(block.data, block.mimeType);
      if (materialized !== null) {
        blocks.push({ type: "localImage", path: materialized.path });
      } else {
        blocks.push(toCodexTextInput("User attached an image that could not be written to disk."));
      }
    } else {
      hasContent = true;
      blocks.push(toCodexTextInput(JSON.stringify(block)));
    }
  }
  if (!hasContent) throw new Error("Refusing to send an empty prompt");
  if (values.translatePrompts) await context.translator.rememberPromptDisplay(displayFragments, { contextKey });
  return blocks;
}

function toCodexTextInput(text: string): { type: "text"; text: string; text_elements: [] } {
  return { type: "text", text, text_elements: [] };
}

function configStateFor(session: CodexSession): {
  model?: string;
  mode?: string;
  thinkingOption?: string;
  models: ProviderModel[];
  modes: ProviderMode[];
  thinkingOptions: ProviderThinkingOption[];
  settings: ProviderSetting[];
} {
  const selected = session.catalogModels.find((model) => model.id === session.desiredModel);
  const thinkingOptions = selected?.thinkingOptions ?? [];
  return {
    ...(session.desiredModel !== null ? { model: session.desiredModel } : {}),
    ...(session.desiredMode !== null ? { mode: session.desiredMode } : {}),
    ...(session.desiredThinking !== null ? { thinkingOption: session.desiredThinking } : {}),
    models: session.catalogModels,
    modes: STATIC_MODES,
    thinkingOptions: [...thinkingOptions],
    settings: [
      ...(codexServiceTiers(session.catalogModels, session.desiredModel).length ? [{ type: "select" as const, id: "service_tier", label: "Service tier", value: selectedServiceTier(session), options: [
        { value: "default", label: "Default" }, ...codexServiceTiers(session.catalogModels, session.desiredModel).filter((tier) => tier.id !== "default").map((tier) => ({ value: tier.id, label: tier.name })),
      ] }] : []),
      ...(session.collaborationModes.some((mode) => mode.mode === "plan") ? [{ type: "toggle" as const, id: "plan_mode", label: "Plan", value: session.planMode }] : []),
    ],
  };
}

function readStoredQuestions(persistence: { data: unknown } | undefined): CodexSession["asyncQuestions"] {
  const records = toObjectRecord(persistence?.data)?.asyncQuestions;
  const questions: CodexSession["asyncQuestions"] = new Map();
  if (Array.isArray(records)) for (const record of records) {
    if (isRecord(record) && isRecord(record.item) && typeof record.item.id === "string" && Array.isArray(record.item.questions)) questions.set(record.item.id, { item: record.item, answered: record.answered === true });
  }
  return questions;
}

function emitPersistence(session: CodexSession, context: DispatchContext): void {
  if (!session.closed && session.threadId) context.emit({ type: "session.persistence", sessionId: session.id,
    persistence: { version: 1, data: z.json().parse({ threadId: session.threadId, asyncQuestions: [...session.asyncQuestions.values()] }) } });
}

async function receiveAsyncQuestion(session: CodexSession, item: Record<string, unknown>, context: DispatchContext): Promise<void> {
  if (typeof item.id !== "string" || !Array.isArray(item.questions)) return;
  const questions = item.questions.flatMap((question, index) => isRecord(question) && typeof question.title === "string" && question.title.trim()
    ? [{ id: String(index), header: `Question ${index + 1}`, question: question.title, options: Array.isArray(question.options) ? question.options.filter((label): label is string => typeof label === "string").map((label) => ({ label })) : [] }] : []);
  if (!questions.length) return;
  const saved = session.asyncQuestions.get(item.id);
  if (!saved) { session.asyncQuestions.set(item.id, { item, answered: false }); emitPersistence(session, context); }
  if (saved?.answered) {
    context.emit({ type: "timeline.item", sessionId: session.id, item: { type: "tool_call", id: item.id, callId: item.id, name: "request_user_input_async", status: "completed", error: null,
      detail: { type: "plain_text", text: formatCodexQuestionPrompts(questions) + `\n\n${JSON.stringify(saved.item.answers ?? "Dismissed")}`, icon: "brain" } } });
    return;
  }
  void handleQuestionApproval(session, { itemId: item.id, questions }, context).catch((error) => emitRuntimeNotice(session, error, context));
}

async function deliverAsyncAnswer(session: CodexSession, pending: PendingPermission, answers: Record<string, { answers: string[] }>, context: DispatchContext): Promise<void> {
  if ((pending.questions ?? []).some((question) => !answers[question.id]?.answers.length)) throw new Error("Answer every question before submitting");
  const text = "Answers to your questions:\n\n" + (pending.questions ?? []).map((question) => `${question.question}\n${answers[question.id].answers.join(", ")}`).join("\n\n");
  const messageId = `async-answer-${randomUUID()}`;
  if (session.active) {
    const nativeTurnId = session.nativeTurnId;
    if (!session.client || !session.threadId || !nativeTurnId || session.active.canceled) throw new Error("The active Codex turn is not ready for an answer");
    const response = await session.client.request("turn/steer", { threadId: session.threadId, expectedTurnId: nativeTurnId, input: [toCodexTextInput(text)], clientUserMessageId: messageId });
    if (readTurnId(response) !== nativeTurnId) throw new Error("Invalid Codex answer acknowledgement");
  } else {
    const admission = reserveTurn(session, messageId);
    let accepted: boolean;
    try { accepted = await startTurn(session, [toCodexTextInput(text)], messageId, text, context, admission, undefined, true); }
    catch (error) { if (admission.phase === "preparing" && session.active === admission) session.active = null; admission.identify(); throw error; }
    if (!accepted) throw new Error("Answer delivery was canceled before starting");
  }
}

function offerPlanApproval(session: CodexSession, plan: string, context: DispatchContext): void {
  if ([...session.pendingPermissions.values()].some((pending) => pending.kind === "plan")) return;
  const id = `permission-plan-${randomUUID()}`;
  session.proposedPlan = plan;
  void waitForPermission(session, id, "plan", context, { id, name: "CodexPlan", kind: "tool", title: "Implement this plan?",
    detail: { type: "plain_text", text: plan }, actions: [{ id: "implement", label: "Implement", behavior: "allow" }, { id: "dismiss", label: "Dismiss", behavior: "deny" }] }, undefined, undefined, undefined, { planText: plan });
}

function dismissAsyncQuestions(session: CodexSession, context: DispatchContext): void {
  let changed = false;
  for (const [id, saved] of session.asyncQuestions) if (!saved.answered) {
    saved.answered = true;
    saved.item = { ...saved.item, answers: "Dismissed" };
    changed = true;
    const permissionId = `permission-${id}`;
    const pending = session.pendingPermissions.get(permissionId);
    if (pending) {
      session.pendingPermissions.delete(permissionId);
      pending.resolve({ answers: {} });
      context.emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
    }
    void receiveAsyncQuestion(session, saved.item, context).catch((error) => emitRuntimeNotice(session, error, context));
  }
  if (changed) emitPersistence(session, context);
}

function threadConfiguration(session: CodexSession, preserveResolved = false): Record<string, unknown> {
  const preset = MODE_PRESETS[session.desiredMode ?? DEFAULT_MODE_ID] ?? MODE_PRESETS[DEFAULT_MODE_ID];
  return { cwd: session.config.cwd, model: session.desiredModel, serviceTier: selectedServiceTier(session),
    ...(session.config.mode !== undefined && session.config.providerOptions?.approval_policy === undefined ? { approvalPolicy: preset.approvalPolicy } : {}),
    ...(preserveResolved && session.config.mode === undefined && session.resolvedApprovalPolicy !== undefined ? { approvalPolicy: session.resolvedApprovalPolicy } : {}),
    ...(session.config.mode !== undefined ? { approvalsReviewer: preset.approvalsReviewer } : session.resolvedReviewer ? { approvalsReviewer: session.resolvedReviewer } : {}),
    ...(session.config.mode !== undefined && session.config.providerOptions?.sandbox_mode === undefined ? { sandbox: preset.sandbox } : {}),
    ...(preserveResolved && session.config.mode === undefined && typeof session.resolvedSandbox.type === "string" ? { sandbox: ({ workspaceWrite: "workspace-write", readOnly: "read-only", dangerFullAccess: "danger-full-access" } as Record<string, string>)[session.resolvedSandbox.type] } : {}),
    ...(session.translatedSystemPrompt ? { developerInstructions: session.translatedSystemPrompt } : {}),
    ...(buildInnerConfig(session) ? { config: buildInnerConfig(session) } : {}) };
}

function turnWorkflowPolicy(session: CodexSession): Record<string, unknown> {
  const preset = MODE_PRESETS[session.desiredMode ?? DEFAULT_MODE_ID] ?? MODE_PRESETS[DEFAULT_MODE_ID];
  const explicitMode = session.config.mode !== undefined;
  const sandbox = readConfigured(session.config.providerOptions?.sandbox_mode) ?? (explicitMode ? preset.sandbox : null);
  return {
    ...(explicitMode && session.config.providerOptions?.approval_policy === undefined ? { approvalPolicy: preset.approvalPolicy } : {}),
    ...(explicitMode ? { approvalsReviewer: preset.approvalsReviewer } : {}),
    ...(sandbox ? { sandboxPolicy: codexSandboxPolicy(sandbox, session.resolvedSandbox, session.config.providerOptions?.sandbox_workspace_write) } : {}),
  };
}

function selectedServiceTier(session: CodexSession): string {
  return codexServiceTiers(session.catalogModels, session.desiredModel).some((tier) => tier.id === session.serviceTier) ? session.serviceTier : "default";
}

function adoptThreadSettings(session: CodexSession, response: unknown): void {
  const record = toObjectRecord(response) ?? {};
  if (session.config.model == null) session.desiredModel = readConfigured(record.model) ?? session.desiredModel;
  if (session.config.thinkingOption == null) session.desiredThinking = readConfigured(record.reasoningEffort) ?? session.desiredThinking;
  if (session.config.settings?.service_tier === undefined && session.config.settings?.fast_mode === undefined) session.serviceTier = readConfigured(record.serviceTier) ?? session.serviceTier;
  if (session.config.settings?.plan_mode === undefined && isRecord(record.collaborationMode)) session.planMode = record.collaborationMode.mode === "plan";
  if (isRecord(record.sandbox)) session.resolvedSandbox = record.sandbox;
  if (record.approvalPolicy !== undefined) session.resolvedApprovalPolicy = record.approvalPolicy;
  session.resolvedReviewer = readConfigured(record.approvalsReviewer) ?? session.resolvedReviewer;
  session.resolvedModelProvider = readConfigured(record.modelProvider) ?? session.resolvedModelProvider;
  if (session.config.mode == null) {
    if (record.approvalPolicy === "never" && toObjectRecord(record.sandbox)?.type === "dangerFullAccess") session.desiredMode = "full-access";
    else if (record.approvalsReviewer === "auto_review") session.desiredMode = "auto-review";
  }
}

async function refreshCommands(session: CodexSession, client: CodexClientLike, context: DispatchContext): Promise<void> {
  const loaded = await loadSkills(client, session.config.cwd);
  const prompts = await codexCustomPrompts(codexHome(session.config.env));
  session.skills = loaded.skills;
  session.commands = [{ name: "compact", description: "Compact the context" },
    ...(goalsEnabled(session, client) ? [{ name: "goal", description: "Set, pause, resume, or clear the agent's goal" }] : []),
    ...prompts, ...loaded.commands];
  if (!session.closed) context.emit({ type: "session.commands", sessionId: session.id, commands: session.commands });
}

async function runBuiltinCommand(session: CodexSession, input: Extract<ProviderInput, { type: "session.prompt" }>, context: DispatchContext): Promise<void> {
  if (input.prompt.input.type !== "command") return;
  try {
    const client = await ensureClient(session, context);
    const threadId = await ensureThread(session, context);
    const { name, arguments: args } = input.prompt.input;
    if (name === "compact") await client.request("thread/compact/start", { threadId });
    else {
      if (!goalsEnabled(session, client)) throw new Error("Codex goals are not enabled for this session");
      const objective = args.trim();
      if (!objective) throw new Error("Usage: /goal <objective>|pause|resume|clear");
      await client.request(objective === "clear" ? "thread/goal/clear" : "thread/goal/set", { threadId,
        ...(objective === "clear" ? {} : objective === "pause" ? { status: "paused" } : objective === "resume" ? { status: "active" } : { objective, status: "active" }) });
    }
    context.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: input.prompt.clientMessageId, result: { type: "completed" } });
  } catch (error) {
    context.emit({ type: "session.prompt_result", sessionId: session.id, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: describe(error) } } });
  }
}

function handleElicitation(session: CodexSession, params: unknown, serverRequestId: number, context: DispatchContext): Promise<unknown> {
  const record = toObjectRecord(params) ?? {};
  if (!requestIsCurrent(session, record)) return Promise.resolve({ action: "cancel", content: null, _meta: null });
  const required = toObjectRecord(record.requestedSchema)?.required;
  if (!["form", "openai/form"].includes(String(record.mode)) || (Array.isArray(required) && required.length > 0)) return Promise.resolve({ action: "decline", content: null, _meta: null });
  const id = `permission-mcp-${serverRequestId}`;
  const result = waitForPermission(session, id, "elicitation", context, { id, name: "CodexMcpElicitation", kind: "tool", title: `MCP approval: ${String(record.serverName ?? "MCP")}`,
    description: typeof record.message === "string" ? record.message : undefined, actions: ALLOW_DENY_ACTIONS }, undefined, undefined, undefined, { serverRequestId });
  return result;
}

function emitRuntimeNotice(session: CodexSession, error: unknown, context: DispatchContext): void {
  if (!session.closed) context.emit({ type: "session.notice", sessionId: session.id, notice: { id: randomUUID(), severity: "error", title: describe(error) } });
}

function readStoredThreadId(persistence: { version: number; data: unknown } | undefined): string | null {
  if (persistence === undefined || !isRecord(persistence.data)) return null;
  const stored = persistence.data.threadId;
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

function readConfigured(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function rawPromptText(content: ReadonlyArray<{ type?: unknown; text?: unknown } | unknown>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : "[attachment]";
}

async function createRealClient(options: CodexClientFactoryOptions): Promise<CodexClientLike> {
  const version = await validateCodexExecutable(options);
  const child = spawnCodexAppServer({
    command: options.command,
    args: codexVersionAtLeast(version, 0, 128) ? [...options.args, "--enable", "goals"] : options.args,
    cwd: options.cwd,
    env: options.env,
  });
  const client = new CodexAppServerClient(child, options.command);
  client.version = version;
  return client;
}

function codexVersionAtLeast(version: string | undefined, major: number, minor: number): boolean {
  const parts = version?.match(/^(\d+)\.(\d+)\./);
  return !!parts && (Number(parts[1]) > major || (Number(parts[1]) === major && Number(parts[2]) >= minor));
}

function requestIsCurrent(session: CodexSession, params: Record<string, unknown>): boolean {
  const threadId = nonEmptyString(params.threadId);
  const turnId = nonEmptyString(params.turnId);
  return !session.closed && !session.interrupted && (!threadId || !session.threadId || threadId === session.threadId || session.children.has(threadId)) && (!turnId || !session.supersededNativeTurnIds.has(turnId));
}

function goalsEnabled(session: CodexSession, client: CodexClientLike): boolean {
  return toObjectRecord(session.config.providerOptions?.features)?.goals !== false && (codexVersionAtLeast(client.version, 0, 128) || toObjectRecord(session.config.providerOptions?.features)?.goals === true);
}

async function teardownSession(
  session: CodexSession,
  context: DispatchContext | null = null,
): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  session.active?.identify();
  denyPending(session, context);
  if (context) closeChildren(session, context);
  const client = session.client;
  session.client = null;
  await client?.dispose().catch(() => undefined);
}

function sameCwd(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { scanPathForCodex } from "./codex-app-server";
