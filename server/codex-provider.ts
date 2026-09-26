import { randomUUID } from "node:crypto";
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
  buildCodexInitializeParams,
  resolvePathCodex,
  spawnCodexAppServer,
  type CodexClientFactoryOptions,
  type CodexClientLike,
} from "./codex-app-server";
import {
  extractUserText,
  formatCodexQuestionPrompts,
  isRecord,
  nonEmptyString,
  normalizeCodexQuestionPrompts,
  readThreadId,
  readTurnId,
  reasoningTextFromItem,
  threadItemToTimeline,
  toCodexUsage,
  toObjectRecord,
  type CodexQuestionPrompt,
} from "./codex-items";
import { materializeImageOutput } from "./image-output";
import {
  isSerializedAttachment,
  restorePromptFragment,
  translatePromptFragment,
} from "./prompt-text";
import { translateQuestionsForDisplay } from "./question";
import { translateSessionTitlesForDisplay } from "./session-titles";
import { createTranslator, type TranslatorDeps } from "./translate";
import {
  TRANSLATE_CODEX_PROVIDER_ID,
  TRANSLATE_CODEX_PROVIDER_LABEL,
  TRANSLATION_TEXT_LIMIT,
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
    auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    "auto-review": {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    },
    "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
  };

const FAST_MODE_MODELS = new Set([
  "gpt-6-astra",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
]);

const TURN_START_TIMEOUT_MS = 90_000;
const INTERRUPT_TIMEOUT_MS = 5_000;
const ASSISTANT_MESSAGE_BOUNDARY = "\n\n---\n\n";

const ALLOW_DENY_ACTIONS = [
  { id: "allow", label: "Allow", behavior: "allow" as const },
  { id: "deny", label: "Deny", behavior: "deny" as const },
];

interface PendingPermission {
  resolve: (response: unknown) => void;
  kind: "command" | "file" | "question";
  itemId?: string;
  questions?: CodexQuestionPrompt[];
  translatedQuestions?: unknown[];
}

interface CodexSession {
  id: string;
  config: ProviderSessionConfig;
  translatedSystemPrompt: string | null;
  desiredModel: string | null;
  desiredMode: string | null;
  desiredThinking: string | null;
  fastMode: boolean;
  client: CodexClientLike | null;
  threadId: string | null;
  nativeTurnId: string | null;
  active: { clientMessageId: string; turnId: string } | null;
  interrupted: boolean;
  closed: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  pendingAgentMessages: Map<string, string>;
  pendingReasoning: Map<string, string>;
  pendingUserAnchors: Array<{ clientMessageId: string; text: string }>;
  userMessageTurnIds: Map<string, string>;
  catalogModels: ProviderModel[];
  commands: ProviderCommand[];
  skills: Array<{ name: string; path: string }>;
  emittedUserMessageIds: Set<string>;
  pendingAssistantBoundary: boolean;
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
  const storedThreadId = readStoredThreadId(input.persistence);
  const session: CodexSession = {
    id: input.sessionId,
    config: input.config,
    translatedSystemPrompt,
    desiredModel: readConfigured(input.config.model),
    desiredMode: readConfigured(input.config.mode) ?? DEFAULT_MODE_ID,
    desiredThinking: readConfigured(input.config.thinkingOption),
    fastMode: input.config.settings?.["fast_mode"] === true,
    client: null,
    threadId: storedThreadId,
    nativeTurnId: null,
    active: null,
    interrupted: false,
    closed: false,
    pendingPermissions: new Map(),
    pendingAgentMessages: new Map(),
    pendingReasoning: new Map(),
    pendingUserAnchors: [],
    userMessageTurnIds: new Map(),
    catalogModels: [],
    commands: [],
    skills: [],
    emittedUserMessageIds: new Set(),
    pendingAssistantBoundary: false,
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
  if (session.client !== null) return session.client;
  const values = await context.loadValues();
  const command = resolveCodexCommand(values);
  const client = await context.createClient({
    command,
    args: ["app-server"],
    cwd: session.config.cwd,
    env: { ...process.env, ...session.config.env },
  });
  session.client = client;
  client.setUnexpectedTerminationHandler((error) => {
    handleClientExit(session, error, context);
  });
  client.setNotificationHandler((method, params) => {
    handleNotification(session, method, params, context);
  });
  client.setRequestHandler("item/commandExecution/requestApproval", (params) =>
    handleCommandApproval(session, params, context),
  );
  client.setRequestHandler("item/fileChange/requestApproval", (params) =>
    handleFileChangeApproval(session, params, context),
  );
  client.setRequestHandler("item/tool/requestUserInput", (params) =>
    handleQuestionApproval(session, params, context),
  );
  client.setRequestHandler("tool/requestUserInput", (params) =>
    handleQuestionApproval(session, params, context),
  );
  await client.request("initialize", buildCodexInitializeParams());
  client.notify("initialized", {});
  session.catalogModels = await loadModels(client);
  const loadedSkills = await loadSkills(client, session.config.cwd).catch(() => ({
    commands: [] as ProviderCommand[],
    skills: [] as Array<{ name: string; path: string }>,
  }));
  session.commands = loadedSkills.commands;
  session.skills = loadedSkills.skills;
  if (session.threadId !== null) {
    await resumeThread(session, client);
  }
  return client;
}

async function resumeThread(session: CodexSession, client: CodexClientLike): Promise<void> {
  const threadId = session.threadId;
  if (threadId === null) return;
  const params: Record<string, unknown> = { threadId };
  if (session.translatedSystemPrompt !== null) {
    params.developerInstructions = session.translatedSystemPrompt;
  }
  const inner = buildInnerConfig(session);
  if (inner !== null) params.config = inner;
  try {
    await client.request("thread/resume", params);
  } catch (error) {
    const message = describe(error);
    if (message.includes(`session ${threadId} is archived`)) {
      try {
        await client.request("thread/unarchive", { threadId });
      } catch (unarchiveError) {
        if (!describe(unarchiveError).includes("no archived rollout found")) throw unarchiveError;
      }
      await client.request("thread/resume", params);
      return;
    }
    throw new Error(`Failed to resume Codex thread ${threadId}: ${message}`, { cause: error });
  }
}

async function ensureThread(session: CodexSession, context: DispatchContext): Promise<string> {
  if (session.threadId !== null) return session.threadId;
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
  const preset = MODE_PRESETS[session.desiredMode ?? DEFAULT_MODE_ID] ?? MODE_PRESETS[DEFAULT_MODE_ID];
  const params: Record<string, unknown> = {
    model,
    cwd: session.config.cwd,
    approvalPolicy: preset.approvalPolicy,
    sandbox: preset.sandbox,
  };
  if (preset.approvalsReviewer !== undefined) params.approvalsReviewer = preset.approvalsReviewer;
  if (session.translatedSystemPrompt !== null) {
    params.developerInstructions = session.translatedSystemPrompt;
  }
  const inner = buildInnerConfig(session);
  if (inner !== null) params.config = inner;
  const threadId = readThreadId(await client.request("thread/start", params));
  if (threadId === null) throw new Error("Codex app-server did not return thread id");
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
      if (skillRecord === null) continue;
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
  let userInput: unknown[];
  try {
    userInput = await buildTurnInput(input.prompt.input.content, context);
  } catch (error) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
  await startTurn(session, userInput, input.prompt.clientMessageId, rawPromptText(input.prompt.input.content), context);
}

async function commandSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  context: DispatchContext,
  session: CodexSession,
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
  const name = input.prompt.input.name;
  const args = input.prompt.input.arguments;
  let translatedArgs = "";
  if (args.trim().length > 0) {
    try {
      const values = await context.loadValues();
      translatedArgs = values.translatePrompts
        ? await context.translator.translate(args, "user-to-agent")
        : args;
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
  await startTurn(
    session,
    buildCodexCommandInput(session, name, translatedArgs),
    input.prompt.clientMessageId,
    `/${name}${args.trim().length > 0 ? ` ${args}` : ""}`,
    context,
  );
}

function buildCodexCommandInput(
  session: CodexSession,
  name: string,
  translatedArgs: string,
): unknown[] {
  const skill = session.skills.find((entry) => entry.name === name);
  const text = translatedArgs.length > 0 ? `$${name} ${translatedArgs}` : `$${name}`;
  if (skill === undefined) return [toCodexTextInput(text)];
  return [{ type: "skill", name: skill.name, path: skill.path }, toCodexTextInput(text)];
}

async function startTurn(
  session: CodexSession,
  userInput: unknown[],
  clientMessageId: string,
  originalText: string,
  context: DispatchContext,
): Promise<void> {
  const client = await ensureClient(session, context);
  const threadId = await ensureThread(session, context);
  const turnId = randomUUID();
  session.active = { clientMessageId, turnId };
  session.interrupted = false;
  session.nativeTurnId = null;
  session.pendingAssistantBoundary = false;
  session.pendingAgentMessages.clear();
  session.pendingReasoning.clear();
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
    ...(session.desiredModel !== null ? { model: session.desiredModel } : {}),
    ...(session.desiredThinking !== null ? { effort: session.desiredThinking } : {}),
    ...(session.fastMode && FAST_MODE_MODELS.has(session.desiredModel ?? "")
      ? { serviceTier: "fast" }
      : {}),
    cwd: session.config.cwd,
  };
  const preset = MODE_PRESETS[session.desiredMode ?? DEFAULT_MODE_ID];
  if (preset !== undefined) {
    params.approvalPolicy = preset.approvalPolicy;
    params.sandboxPolicy = { type: toSandboxPolicyType(preset.sandbox) };
    if (preset.approvalsReviewer !== undefined) params.approvalsReviewer = preset.approvalsReviewer;
  }
  if (session.translatedSystemPrompt !== null) {
    params.developerInstructions = session.translatedSystemPrompt;
  }
  try {
    await client.request("turn/start", params, TURN_START_TIMEOUT_MS);
  } catch (error) {
    dropUnconsumedAnchors(session, clientMessageId);
    session.active = null;
    context.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId,
      state: "failed",
      error: { message: describe(error) },
    });
  }
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
    userInput = await buildTurnInput(input.prompt.input.content, context);
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
    denyPendingForSteer(session, context);
  }
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
    if (acknowledged !== null && acknowledged !== nativeTurnId) {
      throw new Error("Codex returned an invalid steer acknowledgement");
    }
  } catch (error) {
    context.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: describe(error) } },
    });
    return;
  }
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

async function interruptSession(
  session: CodexSession,
  context: DispatchContext | null = null,
): Promise<void> {
  session.interrupted = true;
  dropUnconsumedAnchors(session);
  denyPending(session, context);
  const client = session.client;
  const threadId = session.threadId;
  const nativeTurnId = session.nativeTurnId;
  if (client === null || threadId === null || nativeTurnId === null) return;
  try {
    await client.request("turn/interrupt", { threadId, turnId: nativeTurnId }, INTERRUPT_TIMEOUT_MS);
  } catch (error) {
    if (isIdleInterruptError(error)) return;
    throw error;
  }
}

function handleClientExit(session: CodexSession, error: Error, context: DispatchContext): void {
  session.client = null;
  dropUnconsumedAnchors(session);
  denyPending(session, context);
  const active = session.active;
  session.active = null;
  session.nativeTurnId = null;
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
  const record = toObjectRecord(params);
  if (method === "turn/started") {
    session.nativeTurnId = readTurnId(params);
    if (session.interrupted) void interruptSession(session, context);
    return;
  }
  if (method === "turn/completed") {
    finishTurn(session, record, context);
    return;
  }
  if (method === "item/agentMessage/delta") {
    appendTextDelta(session, record, "assistant", context);
    return;
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/delta") {
    appendTextDelta(session, record, "reasoning", context);
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = toCodexUsage(record?.tokenUsage ?? record);
    if (usage !== null) {
      context.emit({
        type: "session.usage",
        sessionId: session.id,
        ...(session.active !== null ? { turnId: session.active.turnId } : {}),
        usage,
      });
    }
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    handleItemLifecycle(session, record, method === "item/completed", context);
    return;
  }
  if (method === "turn/plan/updated") {
    handlePlanUpdate(session, record, context);
  }
}

function finishTurn(
  session: CodexSession,
  record: Record<string, unknown> | null,
  context: DispatchContext,
): void {
  const active = session.active;
  session.active = null;
  session.nativeTurnId = null;
  session.pendingAgentMessages.clear();
  session.pendingReasoning.clear();
  dropUnconsumedAnchors(session);
  const status = typeof record?.status === "string" ? record.status : "completed";
  session.interrupted = false;
  if (active === null) return;
  if (status === "failed") {
    context.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId: active.turnId,
      state: "failed",
      error: { message: nonEmptyString(record?.errorMessage) ?? "Codex turn failed" },
    });
    return;
  }
  if (status === "interrupted") {
    context.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId: active.turnId,
      state: "canceled",
    });
    return;
  }
  context.emit({
    type: "session.turn",
    sessionId: session.id,
    turnId: active.turnId,
    state: "completed",
  });
}

function emitStreamedTextCompletion(
  session: CodexSession,
  itemId: string,
  kind: "assistant" | "reasoning",
  completedText: string,
  context: DispatchContext,
): void {
  const streamed =
    kind === "assistant"
      ? (session.pendingAgentMessages.get(itemId) ?? "")
      : (session.pendingReasoning.get(itemId) ?? "");
  if (kind === "assistant") session.pendingAgentMessages.delete(itemId);
  else session.pendingReasoning.delete(itemId);
  const boundary =
    kind === "assistant" && streamed.startsWith(ASSISTANT_MESSAGE_BOUNDARY)
      ? ASSISTANT_MESSAGE_BOUNDARY
      : "";
  const streamedBody = streamed.slice(boundary.length);
  const body =
    completedText.length === 0
      ? streamedBody
      : completedText.startsWith(streamedBody) || streamedBody.length < completedText.length
        ? completedText
        : streamedBody;
  const next = `${boundary}${body}`;
  if (next.length === 0 || next === streamed) return;
  context.emit({
    type: "timeline.item",
    sessionId: session.id,
    item:
      kind === "assistant"
        ? { type: "assistant_message", id: itemId, text: next, messageId: itemId }
        : { type: "reasoning", id: itemId, text: next },
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

function isIdleInterruptError(error: unknown): boolean {
  const message = describe(error).toLowerCase();
  return (
    message.includes("no active turn") ||
    message.includes("already idle") ||
    message.includes("already completed") ||
    message.includes("already interrupted") ||
    message.includes("not found")
  );
}

function appendTextDelta(
  session: CodexSession,
  record: Record<string, unknown> | null,
  kind: "assistant" | "reasoning",
  context: DispatchContext,
): void {
  if (record === null) return;
  const itemId = nonEmptyString(record.itemId);
  const delta = typeof record.delta === "string" ? record.delta : "";
  if (itemId === null || delta.length === 0) return;
  if (kind === "assistant") {
    const prev = session.pendingAgentMessages.get(itemId) ?? "";
    const first = prev.length === 0;
    const chunk =
      first && session.pendingAssistantBoundary ? `${ASSISTANT_MESSAGE_BOUNDARY}${delta}` : delta;
    const accumulated = prev + chunk;
    session.pendingAgentMessages.set(itemId, accumulated);
    if (first) session.pendingAssistantBoundary = false;
    context.emit({
      type: "timeline.item",
      sessionId: session.id,
      item: { type: "assistant_message", id: itemId, text: accumulated, messageId: itemId },
    });
    return;
  }
  const prev = session.pendingReasoning.get(itemId) ?? "";
  const next = prev + delta;
  session.pendingReasoning.set(itemId, next);
  context.emit({
    type: "timeline.item",
    sessionId: session.id,
    item: { type: "reasoning", id: itemId, text: next },
  });
}

function handleItemLifecycle(
  session: CodexSession,
  record: Record<string, unknown> | null,
  completed: boolean,
  context: DispatchContext,
): void {
  const item = record?.item ?? record;
  const itemRecord = toObjectRecord(item);
  if (itemRecord === null) return;
  const type = typeof itemRecord.type === "string" ? itemRecord.type : "";
  if (type === "userMessage") {
    noteUserMessage(session, itemRecord, readTurnId(record), context);
    return;
  }
  const itemId = nonEmptyString(itemRecord.id);
  if (type === "agentMessage") {
    if (itemId !== null && session.pendingAgentMessages.has(itemId)) {
      if (completed) {
        emitStreamedTextCompletion(
          session,
          itemId,
          "assistant",
          typeof itemRecord.text === "string" ? itemRecord.text : "",
          context,
        );
        session.pendingAssistantBoundary = true;
      }
      return;
    }
    const mapped = threadItemToTimeline(itemRecord);
    if (mapped !== null) context.emit({ type: "timeline.item", sessionId: session.id, item: mapped });
    if (completed) session.pendingAssistantBoundary = true;
    return;
  }
  if (type === "reasoning") {
    if (itemId !== null && session.pendingReasoning.has(itemId)) {
      if (completed) {
        emitStreamedTextCompletion(
          session,
          itemId,
          "reasoning",
          reasoningTextFromItem(itemRecord),
          context,
        );
      }
      return;
    }
    const text = reasoningTextFromItem(itemRecord);
    if (text.length === 0) return;
    context.emit({
      type: "timeline.item",
      sessionId: session.id,
      item: { type: "reasoning", id: itemId ?? "reasoning", text },
    });
    return;
  }
  const mapped = threadItemToTimeline(itemRecord, { includeUserMessage: false });
  if (mapped !== null) context.emit({ type: "timeline.item", sessionId: session.id, item: mapped });
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
  const steps = Array.isArray(record?.steps) ? record.steps : [];
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
  const itemId = nonEmptyString(record.itemId) ?? randomUUID();
  const command = typeof record.command === "string" ? record.command : "";
  const cwd = typeof record.cwd === "string" ? record.cwd : session.config.cwd;
  const permissionId = `permission-${itemId}`;
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
  const itemId = nonEmptyString(record.itemId) ?? randomUUID();
  const permissionId = `permission-${itemId}`;
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
  const itemId = nonEmptyString(record.itemId) ?? randomUUID();
  const questions = normalizeCodexQuestionPrompts(record.questions);
  const permissionId = `permission-${itemId}`;
  let translatedQuestions: unknown[] = questions;
  try {
    const values = await context.loadValues();
    if (values.translateResponses) {
      translatedQuestions = await translateQuestionsForDisplay(questions, (text) =>
        context.translator.translate(text, "agent-to-user"),
      );
    }
  } catch (error) {
    console.warn(
      `[translate-codex] question display translation failed (${describe(error)}); keeping original text`,
    );
    translatedQuestions = questions;
  }
  context.emit({
    type: "timeline.item",
    sessionId: session.id,
    item: {
      type: "tool_call",
      id: itemId,
      callId: itemId,
      name: "request_user_input",
      status: "running",
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
      name: "request_user_input",
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
): Promise<unknown> {
  return new Promise((resolve) => {
    session.pendingPermissions.set(permissionId, {
      resolve,
      kind,
      ...(itemId !== undefined ? { itemId } : {}),
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
  const pending = session.pendingPermissions.get(permissionId);
  if (pending === undefined) return;
  session.pendingPermissions.delete(permissionId);
  context.emit({ type: "session.permission_resolved", sessionId: session.id, permissionId });
  if (pending.kind === "question") {
    const resolved = await resolveQuestionResponse(session, pending, response, context);
    settleQuestionTool(session, pending, resolved.cardResponse, context);
    pending.resolve({ answers: resolved.answers });
    return;
  }
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
      ? (text: string) => context.translator.translate(text, "user-to-agent")
      : async (text: string) => text;
    for (let index = 0; index < questions.length; index += 1) {
      const original = questions[index];
      const shown = toObjectRecord(translated[index]) ?? original;
      const raw =
        answersRecord?.[shown.header as string] ??
        answersRecord?.[original.header] ??
        answersRecord?.[original.id];
      if (typeof raw !== "string" || raw.trim().length === 0) continue;
      const pieces = original.multiSelect
        ? raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
        : [raw.trim()];
      const translatedPieces: string[] = [];
      for (const piece of pieces) {
        translatedPieces.push(await translateBack(piece));
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
  for (const [permissionId, pending] of session.pendingPermissions) {
    pending.resolve(pending.kind === "question" ? { answers: {} } : { decision: "cancel" });
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
  changes: {
    model?: string | null;
    mode?: string | null;
    thinkingOption?: string | null;
    settings?: Readonly<Record<string, unknown>>;
  },
  context: DispatchContext,
): void {
  if (changes.model !== undefined) {
    session.desiredModel = readConfigured(changes.model);
    if (!FAST_MODE_MODELS.has(session.desiredModel ?? "")) session.fastMode = false;
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
    session.fastMode = changes.settings["fast_mode"] === true;
  }
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
  try {
    if (session.active !== null) await interruptSession(session, context);
    denyPending(session, context);
    const response = await session.client.request("thread/fork", {
      threadId: session.threadId,
      beforeTurnId,
    });
    const forked = readThreadId(response);
    if (forked === null) throw new Error("Codex thread/fork did not return a thread id");
    session.threadId = forked;
    session.userMessageTurnIds.clear();
    context.emit({
      type: "session.persistence",
      sessionId: session.id,
      persistence: { version: 1, data: { threadId: forked } },
    });
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

async function replayHistory(session: CodexSession, context: DispatchContext): Promise<void> {
  if (session.client === null || session.threadId === null) return;
  let restore: ((block: string) => Promise<string>) | null = null;
  try {
    restore = await buildReplayRestore(context);
  } catch {
    restore = null;
  }
  const raw = toObjectRecord(
    await session.client.request("thread/read", { threadId: session.threadId, includeTurns: true }),
  );
  const thread = toObjectRecord(raw?.thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const turnRecord = toObjectRecord(turn);
    const turnId = nonEmptyString(turnRecord?.id);
    const items = Array.isArray(turnRecord?.items) ? turnRecord.items : [];
    for (const item of items) {
      const mapped = threadItemToTimeline(item);
      if (mapped === null) continue;
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
): Promise<unknown[]> {
  const values = await context.loadValues();
  const translate = values.translatePrompts
    ? (text: string) => context.translator.translate(text, "user-to-agent")
    : async (text: string) => text;
  const blocks: unknown[] = [];
  let hasContent = false;
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      const translated = await translatePromptFragment(block.text, translate);
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
  return blocks;
}

function toCodexTextInput(text: string): { type: "text"; text: string; text_elements: [] } {
  return { type: "text", text, text_elements: [] };
}

function toSandboxPolicyType(sandbox: string): string {
  if (sandbox === "danger-full-access") return "dangerFullAccess";
  if (sandbox === "workspace-write") return "workspaceWrite";
  if (sandbox === "read-only") return "readOnly";
  return sandbox;
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
    settings: FAST_MODE_MODELS.has(session.desiredModel ?? "")
      ? [
          {
            type: "toggle",
            id: "fast_mode",
            label: "Fast",
            description: "Priority inference at increased usage",
            value: session.fastMode,
          },
        ]
      : [],
  };
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
  const child = spawnCodexAppServer({
    command: options.command,
    cwd: options.cwd,
    env: options.env,
  });
  return new CodexAppServerClient(child);
}

async function teardownSession(
  session: CodexSession,
  context: DispatchContext | null = null,
): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  denyPending(session, context);
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
