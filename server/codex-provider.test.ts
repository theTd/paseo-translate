import { describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { createTranslateCodexProvider, type CodexClientFactory } from "./codex-provider";
import { createTranslateHandler } from "./translate";
import { createMemoryTranslationCacheStore, type TranslationCacheStore } from "./translation-cache-store";
import type { CodexClientLike, CodexRequestHandler } from "./codex-app-server";
import { CodexAppServerRpcError } from "./codex-app-server";
import { createTranslationContextManager } from "./translation-context";
import {
  TRANSLATE_AGENT_ID_ENV,
  unwrapTranslationInput,
  type TranslateSettingsValues,
} from "../shared/translate";

const values: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  endpointProtocol: "chat-completions" as const,
  translationReasoningEffort: "default",
  translationSystemPrompt: "",
  translationDomainContext: "",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: [],
  innerAgentEnv: {},
  claudeExecutablePath: "",
  codexExecutablePath: "codex",
  translatePrompts: true,
  translateResponses: true,
  translateNotifications: false,
  translateReasoning: false,
  translateAllTimelines: false,
  translationContextEnabled: true,
  translationContextIdleMinutes: 30,
  translationContextMaxChars: 100_000,
  translationTimeoutMs: 5_000,
  uiLanguage: "system",
};

function translatingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((message) => message.role === "user");
    const text = unwrapTranslationInput(user?.content ?? "");
    if (text.includes("FAIL")) throw new Error("endpoint down");
    return new Response(JSON.stringify({ choices: [{ message: { content: `DE(${text})` } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

function createFakeClient() {
  const state = {
    version: "0.155.0",
    requests: [] as Array<{ method: string; params: unknown }>,
    options: null as { command: string; cwd: string; env: NodeJS.ProcessEnv } | null,
    disposed: 0,
    handlers: {} as Record<string, (params: unknown) => unknown>,
  };
  let notificationHandler: ((method: string, params: unknown) => void) | null = null;
  let terminationHandler: ((error: Error) => void) | null = null;
  const requestHandlers = new Map<string, CodexRequestHandler>();
  const client: CodexClientLike = {
    get version() { return state.version; },
    async request(method, params) {
      state.requests.push({ method, params });
      if (state.handlers[method] !== undefined) return state.handlers[method](params);
      if (method === "initialize") return {};
      if (method === "model/list") {
        return {
          data: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "medium" },
                { reasoningEffort: "high" },
              ],
            },
          ],
        };
      }
      if (method === "skills/list") {
        return {
          data: [
            {
              skills: [
                { name: "review", description: "Review the change", path: "/skills/review.md" },
              ],
            },
          ],
        };
      }
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "thread/resume") return {};
      if (method === "thread/read") return { thread: { turns: [] } };
      if (method === "thread/list") {
        return {
          data: [{ id: "thread-old", cwd: "E:\\repo", name: "Yesterday", updatedAt: 1_700_000_000 }],
        };
      }
      if (method === "thread/fork") return { thread: { id: "thread-fork" } };
      if (method === "turn/start") return {};
      if (method === "turn/interrupt") return {};
      if (method === "turn/steer") return { turnId: "native-1" };
      return {};
    },
    notify() {},
    setNotificationHandler(handler) {
      notificationHandler = handler;
    },
    setRequestHandler(method, handler) {
      requestHandlers.set(method, handler);
    },
    setUnexpectedTerminationHandler(handler) {
      terminationHandler = handler;
    },
    async dispose() {
      state.disposed += 1;
    },
  };
  const factory: CodexClientFactory = async (options) => {
    state.options = { command: options.command, cwd: options.cwd, env: options.env };
    return client;
  };
  return {
    factory,
    client,
    state,
    emit(method: string, params: unknown) {
      notificationHandler?.(method, params);
    },
    crash(error: Error) {
      terminationHandler?.(error);
    },
    async serverRequest(method: string, params: unknown, id = 1) {
      const handler = requestHandlers.get(method);
      if (handler === undefined) throw new Error(`no handler for ${method}`);
      return handler(params, id);
    },
  };
}

async function createHarness(
  overrides?: Partial<TranslateSettingsValues>,
  context?: import("./translation-context").TranslationContextManager,
  cacheStore?: TranslationCacheStore,
  fetchOverride?: typeof fetch,
) {
  const fake = createFakeClient();
  const provider = createTranslateCodexProvider({
    loadConfig: async () => ({ ...values, ...overrides }),
    fetchFn: fetchOverride ?? translatingFetch(),
    createClient: fake.factory,
    ...(context !== undefined ? { context } : {}),
    ...(cacheStore !== undefined ? { cacheStore } : {}),
  });
  const registration = await provider.connect({
    versions: [1],
    capabilities: [...PROVIDER_CAPABILITIES],
  });
  const events: ProviderEvent[] = [];
  registration.onEvent((event) => events.push(event));
  const send = (input: ProviderInput) => registration.send(input);
  return { fake, registration, events, send };
}

async function waitFor(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => boolean,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.some(predicate)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for event; got ${JSON.stringify(events)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const openInput: Extract<ProviderInput, { type: "session.open" }> = {
  type: "session.open",
  requestId: "r-open",
  sessionId: "s",
  config: {
    cwd: "E:\\repo",
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
  },
  history: "skip",
};

function promptInput(
  text: string,
  clientMessageId = "m-1",
): Extract<ProviderInput, { type: "session.prompt" }> {
  return {
    type: "session.prompt",
    sessionId: "s",
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function gatedTranslation(fragment: string) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const base = translatingFetch();
  const fetchFn: typeof fetch = async (input, init) => {
    if (String(init?.body).includes(fragment)) { entered.resolve(); await release.promise; }
    return base(input, init);
  };
  return { entered, release, fetchFn };
}

const questionParams = {
  itemId: "ask-1", threadId: "thread-1", turnId: "native-1",
  questions: [{ id: "q", header: "Choice", question: "Pick a direction", options: [{ label: "North" }] }],
};

function commandInput(name: string, args = ""): Extract<ProviderInput, { type: "session.prompt" }> {
  return { type: "session.prompt", sessionId: "s", prompt: { clientMessageId: `command-${name}`, delivery: "auto", input: { type: "command", name, arguments: args } } };
}

describe("Codex parity regressions", () => {
  it("owns admission before translation and cancels preparation on Stop", async () => {
    const gate = gatedTranslation("delayed-admission");
    const { send, fake, events } = await createHarness(undefined, undefined, undefined, gate.fetchFn);
    await send(openInput);
    const first = send(promptInput("delayed-admission"));
    await gate.entered.promise;
    await send(promptInput("concurrent", "m-2"));
    expect(events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "m-2", result: expect.objectContaining({ type: "failed" }) }));
    await send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    gate.release.resolve();
    await first;
    expect(fake.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
    await send(promptInput("new admission", "m-3"));
    expect(fake.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  });

  it("waits for a starting turn's identity and interrupts that turn", async () => {
    const { send, fake } = await createHarness({ translatePrompts: false });
    await send(openInput);
    const started = deferred<void>();
    const ack = deferred<unknown>();
    fake.state.handlers["turn/start"] = () => { started.resolve(); return ack.promise; };
    const prompt = send(promptInput("start"));
    await started.promise;
    const stop = send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-1" });
    await stop;
    expect(fake.state.requests.filter((request) => request.method === "turn/interrupt")).toEqual([{ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "native-1" } }]);
    ack.resolve({ turn: { id: "native-1" } });
    await prompt;
  });

  it("does not attach idle Stop to future autonomous activity", async () => {
    const { send, fake } = await createHarness({ translatePrompts: false });
    await send(openInput);
    await send(promptInput("first"));
    fake.emit("turn/started", { turnId: "native-1" });
    fake.emit("turn/completed", { turnId: "native-1" });
    await send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    fake.emit("turn/started", { threadId: "thread-1", turnId: "new-autonomous" });
    expect(fake.state.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
  });

  it("rejects a translated steer whose original turn ended", async () => {
    const gate = gatedTranslation("delayed-followup");
    const { send, fake, events } = await createHarness(undefined, undefined, undefined, gate.fetchFn);
    await send(openInput);
    await send(promptInput("first"));
    fake.emit("turn/started", { turnId: "native-1" });
    const followup = promptInput("delayed-followup", "followup"); followup.prompt.delivery = "steer";
    const pending = send(followup);
    await gate.entered.promise;
    fake.emit("turn/completed", { turnId: "native-1" });
    await send(promptInput("replacement", "m-2"));
    fake.emit("turn/started", { turnId: "native-2" });
    gate.release.resolve();
    await pending;
    expect(fake.state.requests.some((request) => request.method === "turn/steer")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "followup", result: expect.objectContaining({ type: "failed" }) }));
  });

  it.each(["timeout", "empty-ack"])("propagates ambiguous steer %s and preserves approval ownership", async (failure) => {
    const { send, fake, events } = await createHarness({ translatePrompts: false });
    await send(openInput); await send(promptInput("first"));
    fake.emit("turn/started", { turnId: "native-1" });
    const approval = fake.serverRequest("item/commandExecution/requestApproval", { itemId: "cmd" });
    fake.state.handlers["turn/steer"] = () => { if (failure === "timeout") throw new Error("request timed out"); return {}; };
    const followup = promptInput("followup", "steer"); followup.prompt.delivery = "steer"; followup.prompt.clearPendingPermissions = true;
    await expect(send(followup)).rejects.toThrow(failure === "timeout" ? "timed out" : "acknowledgement");
    expect(events.some((event) => event.type === "session.permission_resolved")).toBe(false);
    expect(events.some((event) => event.type === "session.prompt_result" && event.clientMessageId === "steer")).toBe(false);
    await send({ type: "session.permission", sessionId: "s", permissionId: "permission-cmd", response: { behavior: "allow" } });
    expect(await approval).toEqual({ decision: "accept" });
  });

  it("reports definitive steer unavailability without hiding it as acceptance", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false });
    await send(openInput); await send(promptInput("first")); fake.emit("turn/started", { turnId: "native-1" });
    fake.state.handlers["turn/steer"] = () => { throw new CodexAppServerRpcError("Method not found", -32601, null); };
    const followup = promptInput("followup", "steer"); followup.prompt.delivery = "steer";
    await send(followup);
    expect(events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "steer", result: expect.objectContaining({ type: "failed" }) }));
  });

  it("keeps multiple approval callbacks for one item independent", async () => {
    const { send, fake, events } = await createHarness(); await send(openInput);
    const first = fake.serverRequest("item/commandExecution/requestApproval", { itemId: "cmd", approvalId: "a" });
    const second = fake.serverRequest("item/commandExecution/requestApproval", { itemId: "cmd", approvalId: "b" });
    expect(events.filter((event) => event.type === "session.permission").map((event) => event.request.id)).toEqual(["permission-a", "permission-b"]);
    await send({ type: "session.permission", sessionId: "s", permissionId: "permission-a", response: { behavior: "allow" } });
    await send({ type: "session.permission", sessionId: "s", permissionId: "permission-b", response: { behavior: "deny" } });
    expect(await first).toEqual({ decision: "accept" }); expect(await second).toEqual({ decision: "decline" });
  });

  it("does not publish a question whose display translation was canceled", async () => {
    const gate = gatedTranslation("Pick a direction");
    const { send, fake, events } = await createHarness(undefined, undefined, undefined, gate.fetchFn); await send(openInput);
    const question = fake.serverRequest("item/tool/requestUserInput", questionParams);
    await gate.entered.promise;
    await send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    gate.release.resolve();
    expect(await question).toEqual({ answers: {} });
    expect(events.some((event) => event.type === "session.permission")).toBe(false);
  });

  it("cancels question answers while free-text translation is in flight", async () => {
    const gate = gatedTranslation("delayed-answer");
    const { send, fake, events } = await createHarness(undefined, undefined, undefined, gate.fetchFn); await send(openInput);
    const question = fake.serverRequest("item/tool/requestUserInput", questionParams);
    await waitFor(events, (event) => event.type === "session.permission");
    const answer = send({ type: "session.permission", sessionId: "s", permissionId: "permission-ask-1", response: { behavior: "allow", updatedInput: { answers: { Choice: "delayed-answer" } } } });
    await gate.entered.promise;
    await send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    gate.release.resolve(); await answer;
    expect(await question).toEqual({ answers: {} });
    expect(events.filter((event) => event.type === "session.permission_resolved")).toHaveLength(1);
  });

  it("buffers early child prose, opens nested routes, and isolates token usage", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false }); await send(openInput); await send(promptInput("spawn"));
    fake.emit("item/agentMessage/delta", { threadId: "child", itemId: "reply", delta: "early child text" });
    fake.emit("item/completed", { threadId: "thread-1", item: { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", receiverThreadIds: ["child"], status: "completed" } });
    fake.emit("item/completed", { threadId: "child", item: { type: "subAgentActivity", id: "nested-spawn", agentThreadId: "grandchild", status: "running" } });
    fake.emit("thread/tokenUsage/updated", { threadId: "child", tokenUsage: { last: { inputTokens: 98765 } } });
    expect(events).toContainEqual(expect.objectContaining({ type: "session.opened", sessionId: "s:codex:grandchild", parentSessionId: "s:codex:child", toolCallId: "nested-spawn" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", sessionId: "s:codex:child", item: expect.objectContaining({ text: "early child text" }) }));
    expect(events.filter((event) => event.type === "session.usage").map((event) => event.sessionId)).toEqual(["s:codex:child"]);
  });

  it("renders the documented plan update payload", async () => {
    const { send, fake, events } = await createHarness(); await send(openInput);
    fake.emit("turn/plan/updated", { plan: [{ step: "Verify the fix", status: "inProgress" }] });
    expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ type: "todo", items: [{ id: "0", text: "Verify the fix", status: "in_progress", completed: false }] }) }));
  });

  it("settles local work when Codex definitively reports already idle", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false }); await send(openInput); await send(promptInput("first"));
    fake.emit("turn/started", { turnId: "native-1" });
    fake.state.handlers["turn/interrupt"] = () => { throw new CodexAppServerRpcError("no active turn to interrupt", -32600, null); };
    await send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    expect(events.filter((event) => event.type === "session.turn").at(-1)).toMatchObject({ state: "canceled" });
    await send(promptInput("second", "next"));
    expect(fake.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    fake.emit("turn/completed", { turnId: "native-1" });
    expect(events.filter((event) => event.type === "session.turn").at(-1)).toMatchObject({ state: "started" });
  });

  it("also interrupts autonomous work that starts while a foreground prompt translates", async () => {
    const gate = gatedTranslation("delayed-with-autonomous");
    const { send, fake } = await createHarness(undefined, undefined, undefined, gate.fetchFn);
    await send({ ...openInput, persistence: { version: 1, data: { threadId: "thread-1" } } });
    const prompt = send(promptInput("delayed-with-autonomous"));
    await gate.entered.promise;
    fake.emit("turn/started", { threadId: "thread-1", turnId: "autonomous" });
    await send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    gate.release.resolve(); await prompt;
    expect(fake.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
    expect(fake.state.requests).toContainEqual({ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "autonomous" } });
  });

  it.each(["failed", "interrupted"])("settles outstanding child tools when a child turn is %s", async (status) => {
    const { send, fake, events } = await createHarness({ translatePrompts: false }); await send(openInput); await send(promptInput("spawn"));
    fake.emit("item/completed", { threadId: "thread-1", item: { type: "collabAgentToolCall", id: "spawn", receiverThreadIds: ["child"] } });
    fake.emit("turn/started", { threadId: "child", turnId: "child-turn" });
    fake.emit("item/started", { threadId: "child", item: { type: "commandExecution", id: "child-tool", command: "work" } });
    fake.emit("turn/completed", { threadId: "child", turn: { id: "child-turn", status } });
    expect(events.filter((event) => event.type === "timeline.item" && event.sessionId === "s:codex:child").at(-1)).toMatchObject({ item: { id: "child-tool", status: status === "failed" ? "failed" : "canceled" } });
  });

  it("uses resolved workspace settings and resets the reviewer and service tier", async () => {
    const { send, fake } = await createHarness({ translatePrompts: false });
    fake.state.handlers["config/read"] = () => ({ config: { model: "arbitrary-model", model_reasoning_effort: "high", sandbox_workspace_write: { writable_roots: ["E:\\extra"], network_access: true, exclude_slash_tmp: true } } });
    fake.state.handlers["model/list"] = () => ({ data: [{ id: "arbitrary-model", isDefault: true, serviceTiers: [{ id: "fast", name: "Fast" }] }] });
    await send(openInput);
    expect(fake.state.requests.find((request) => request.method === "config/read")?.params).toMatchObject({ cwd: "E:\\repo" });
    await send({ type: "session.configure", sessionId: "s", requestId: "config", changes: { mode: "auto-review", settings: { service_tier: "fast" } } });
    await send(promptInput("first"));
    let params = fake.state.requests.filter((request) => request.method === "turn/start").at(-1)?.params;
    expect(params).toMatchObject({ model: "arbitrary-model", effort: "high", approvalsReviewer: "auto_review", serviceTier: "fast", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["E:\\extra"], networkAccess: true, excludeSlashTmp: true } });
    fake.emit("turn/completed", {});
    await send({ type: "session.configure", sessionId: "s", requestId: "reset", changes: { mode: "auto", settings: { service_tier: "default" } } });
    await send(promptInput("second", "m-2"));
    params = fake.state.requests.filter((request) => request.method === "turn/start").at(-1)?.params;
    expect(params).toMatchObject({ approvalsReviewer: "user", serviceTier: "default" });
  });

  it("adopts resume configuration without replacing saved values with defaults", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false });
    fake.state.handlers["thread/resume"] = () => ({ model: "saved-model", reasoningEffort: "high", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: { type: "workspaceWrite", networkAccess: true, writableRoots: ["E:\\saved"] } });
    await send({ ...openInput, persistence: { version: 1, data: { threadId: "saved" } } });
    expect(fake.state.requests.find((request) => request.method === "thread/resume")?.params).not.toHaveProperty("model");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.config", config: expect.objectContaining({ model: "saved-model", mode: "auto-review", thinkingOption: "high" }) }));
    await send(promptInput("continue"));
    expect(fake.state.requests.find((request) => request.method === "turn/start")?.params).not.toHaveProperty("sandboxPolicy");
  });

  it.each([false, true])("preserves provider workflow precedence on start and resume (resume=%s)", async (resume) => {
    const { send, fake } = await createHarness({ translatePrompts: false });
    await send({ ...openInput, ...(resume ? { persistence: { version: 1, data: { threadId: "saved" } } } : {}), config: { ...openInput.config, mode: "auto", providerOptions: { sandbox_mode: "read-only", approval_policy: "never" } } });
    await send(promptInput("read only"));
    const thread = fake.state.requests.find((request) => request.method === (resume ? "thread/resume" : "thread/start"))?.params;
    const turn = fake.state.requests.find((request) => request.method === "turn/start")?.params;
    expect(thread).not.toHaveProperty("approvalPolicy"); expect(thread).not.toHaveProperty("sandbox");
    expect(thread).toMatchObject({ config: { sandbox_mode: "read-only", approval_policy: "never" } });
    expect(turn).not.toHaveProperty("approvalPolicy"); expect(turn).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
  });

  it("ignores repeated old completions and user items during a newer start", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false }); await send(openInput); await send(promptInput("first"));
    fake.emit("turn/started", { turnId: "old" }); fake.emit("turn/completed", { turnId: "old" });
    const started = deferred<void>(); const ack = deferred<unknown>();
    fake.state.handlers["turn/start"] = () => { started.resolve(); return ack.promise; };
    const next = send(promptInput("second", "new-message")); await started.promise;
    fake.emit("turn/completed", { turnId: "old" }); fake.emit("turn/completed", { turnId: "old" });
    fake.emit("item/started", { turnId: "old", item: { type: "userMessage", id: "late-old", content: [{ type: "text", text: "old text" }] } });
    fake.emit("turn/started", { turnId: "new" });
    fake.emit("item/started", { turnId: "new", item: { type: "userMessage", id: "new-user", content: [] } });
    ack.resolve({ turn: { id: "new" } }); await next;
    expect(events.filter((event) => event.type === "session.turn").map((event) => event.state)).toEqual(["started", "completed", "started"]);
    expect(events.some((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.messageId === "late-old")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ messageId: "new-user", clientMessageId: "new-message", text: "second" }) }));
  });

  it("blocks prompt admission during rewind and retains the source if fork hydration fails", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false }); fake.state.version = "0.159.3";
    await send(openInput); await send(promptInput("first")); fake.emit("turn/started", { turnId: "old" });
    fake.emit("item/started", { turnId: "old", item: { id: "old-user", type: "userMessage", content: [] } }); fake.emit("turn/completed", { turnId: "old" });
    const forking = deferred<void>(); const release = deferred<unknown>();
    fake.state.handlers["thread/fork"] = () => { forking.resolve(); return release.promise; };
    fake.state.handlers["thread/read"] = (params) => {
      if ((params as { threadId: string }).threadId === "thread-fork") throw new Error("fork hydration failed");
      return { thread: { turns: [{ id: "old", items: [] }] } };
    };
    const rewind = send({ type: "session.revert", sessionId: "s", requestId: "rewind", token: "old-user", scope: "conversation" });
    await forking.promise;
    await send(promptInput("during rewind", "blocked"));
    expect(fake.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    release.resolve({ thread: { id: "thread-fork" } }); await rewind;
    expect(events).toContainEqual(expect.objectContaining({ type: "request.failed", requestId: "rewind", error: { message: "fork hydration failed" } }));
    expect(events.filter((event) => event.type === "session.persistence").at(-1)).toMatchObject({ persistence: { data: { threadId: "thread-1" } } });
    delete fake.state.handlers["turn/start"];
    await send(promptInput("continue source", "continue"));
    expect(fake.state.requests.filter((request) => request.method === "turn/start").at(-1)?.params).toMatchObject({ threadId: "thread-1" });
  });

  it("persists Stop dismissal even while async question display is translating", async () => {
    const gate = gatedTranslation("async-question-in-translation");
    const { send, fake, events } = await createHarness(undefined, undefined, undefined, gate.fetchFn);
    await send(openInput); await send(promptInput("first"));
    fake.emit("item/completed", { item: { type: "agentMessage", id: "async-q", delivery: "async", questions: [{ title: "async-question-in-translation" }] } });
    await gate.entered.promise;
    await send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
    gate.release.resolve();
    const persistence = events.filter((event) => event.type === "session.persistence").at(-1);
    if (persistence?.type !== "session.persistence") throw new Error("No persistence");
    await send({ type: "session.close", sessionId: "s", requestId: "close" });
    events.length = 0;
    await send({ ...openInput, persistence: persistence.persistence });
    expect(events.some((event) => event.type === "session.permission")).toBe(false);
    expect(JSON.stringify(persistence)).toContain('"answered":true');
  });

  it("offers plan approval and implements in Code mode with the approved text", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false });
    fake.state.handlers["collaborationMode/list"] = () => ({ data: [{ name: "Plan", mode: "plan" }, { name: "Code", mode: "default" }] });
    await send(openInput);
    await send({ type: "session.configure", sessionId: "s", requestId: "plan", changes: { settings: { plan_mode: true } } });
    await send(promptInput("make a plan"));
    expect(fake.state.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ collaborationMode: { mode: "plan" } });
    fake.emit("item/completed", { item: { type: "plan", id: "plan", text: "The approved plan text" } });
    fake.emit("turn/completed", {});
    const permission = events.find((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("No plan approval");
    await send(promptInput("a follow-up before approving", "followup"));
    fake.emit("turn/completed", {});
    await send({ type: "session.permission", sessionId: "s", permissionId: permission.request.id, response: { behavior: "allow" } });
    const implementation = fake.state.requests.filter((request) => request.method === "turn/start").at(-1)?.params;
    expect(implementation).toMatchObject({ collaborationMode: { mode: "default" } });
    expect(JSON.stringify(implementation)).toContain("The approved plan text");
  });

  it("keeps async questions answerable after completion and persists their resolution", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false, translateResponses: false }); await send(openInput); await send(promptInput("ask"));
    fake.emit("item/completed", { item: { type: "agentMessage", id: "async-q", delivery: "async", questions: [{ title: "Which option?", options: ["First", "Second"] }] } });
    fake.emit("turn/completed", {});
    await waitFor(events, (event) => event.type === "session.permission");
    await send({ type: "session.permission", sessionId: "s", permissionId: "permission-async-q", response: { behavior: "allow", updatedInput: { answers: { "Question 1": "First" } } } });
    const starts = fake.state.requests.filter((request) => request.method === "turn/start");
    expect(starts).toHaveLength(2); expect(JSON.stringify(starts[1].params)).toContain("Answers to your questions");
    const persistence = events.filter((event) => event.type === "session.persistence").at(-1);
    expect(persistence).toMatchObject({ persistence: { data: { asyncQuestions: [{ answered: true, item: { id: "async-q" } }] } } });
  });

  it("restores pending async questions even when timeline replay is skipped", async () => {
    const { send, events } = await createHarness({ translateResponses: false });
    await send({ ...openInput, persistence: { version: 1, data: { threadId: "saved", asyncQuestions: [{ item: { type: "agentMessage", id: "saved-question", timestamp: "2025-01-01T00:00:00Z", delivery: "async", questions: [{ title: "Continue?" }] }, answered: false }] } } });
    await waitFor(events, (event) => event.type === "session.permission");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.permission", request: expect.objectContaining({ id: "permission-saved-question" }) }));
    expect(events.find((event) => event.type === "timeline.item" && event.item.id === "saved-question"))
      .toMatchObject({ timestamp: "2025-01-01T00:00:00.000Z" });
  });

  it("runs compact and goal commands outside the foreground turn", async () => {
    const { send, fake } = await createHarness({ translatePrompts: false }); await send(openInput); await send(promptInput("work"));
    await send(commandInput("compact")); await send(commandInput("goal", "finish parity")); await send(commandInput("goal", "pause"));
    expect(fake.state.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(fake.state.requests).toContainEqual({ method: "thread/compact/start", params: { threadId: "thread-1" } });
    expect(fake.state.requests).toContainEqual({ method: "thread/goal/set", params: { threadId: "thread-1", objective: "finish parity", status: "active" } });
    expect(fake.state.requests).toContainEqual({ method: "thread/goal/set", params: { threadId: "thread-1", status: "paused" } });
    expect(fake.state.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
  });

  it("declines unsupported MCP forms and owns supported elicitation until resolution", async () => {
    const { send, fake, events } = await createHarness(); await send(openInput);
    expect(await fake.serverRequest("mcpServer/elicitation/request", { mode: "url" })).toEqual({ action: "decline", content: null, _meta: null });
    expect(await fake.serverRequest("mcpServer/elicitation/request", { mode: "form", requestedSchema: { required: ["secret"] } })).toEqual({ action: "decline", content: null, _meta: null });
    const form = fake.serverRequest("mcpServer/elicitation/request", { mode: "form", serverName: "test", message: "Approve?" }, 3);
    await send({ type: "session.permission", sessionId: "s", permissionId: "permission-mcp-3", response: { behavior: "allow" } });
    expect(await form).toEqual({ action: "accept", content: {}, _meta: null });
    const canceled = fake.serverRequest("mcpServer/elicitation/request", { mode: "form", serverName: "test" }, 4);
    fake.emit("serverRequest/resolved", { requestId: 4 });
    expect(await canceled).toEqual({ action: "cancel", content: null, _meta: null });
    expect(events).toContainEqual({ type: "session.permission_resolved", sessionId: "s", permissionId: "permission-mcp-4" });
  });

  it("refreshes enabled skills before dispatching a command", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false }); await send(openInput);
    fake.state.handlers["skills/list"] = () => ({ data: [{ skills: [{ name: "review", enabled: false, path: "/disabled" }, { name: "new-skill", enabled: true, path: "/new" }] }] });
    await send(commandInput("review"));
    expect(fake.state.requests.some((request) => request.method === "turn/start")).toBe(false);
    await send(commandInput("new-skill"));
    expect(fake.state.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ input: [{ type: "skill", name: "new-skill", path: "/new" }, expect.anything()] });
    expect(events.filter((event) => event.type === "session.commands").at(-1)?.commands.some((command) => command.name === "review")).toBe(false);
  });

  it("normalizes and forwards output schemas without making them sticky", async () => {
    const { send, fake, registration } = await createHarness({ translatePrompts: false }); await send(openInput);
    expect(registration.capabilities).toContain("prompt.output_schema");
    const structured = promptInput("structured"); structured.prompt.outputSchema = { type: "object", properties: { result: { type: "string" } } };
    await send(structured);
    expect(fake.state.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ outputSchema: { type: "object", additionalProperties: false, required: ["result"] } });
    fake.emit("turn/completed", {}); await send(promptInput("ordinary", "m-2"));
    expect(fake.state.requests.filter((request) => request.method === "turn/start").at(-1)?.params).not.toHaveProperty("outputSchema");
  });

  it("hydrates paginated item envelopes and rewinds modern Codex on a configured fork", async () => {
    const { send, fake, events } = await createHarness({ translatePrompts: false }); fake.state.version = "0.159.3";
    fake.state.handlers["thread/read"] = () => ({ thread: { historyMode: "paginated" } });
    fake.state.handlers["thread/turns/list"] = (params) => ({ data: (params as { threadId: string }).threadId === "saved" ? [{ id: "turn-old" }] : [], nextCursor: null });
    fake.state.handlers["thread/items/list"] = () => ({ data: [{ turnId: "turn-old", item: { id: "user-old", type: "userMessage", content: [{ type: "text", text: "Original" }] } }], nextCursor: null });
    await send({ ...openInput, history: "replay", persistence: { version: 1, data: { threadId: "saved" } }, config: { ...openInput.config, providerOptions: { model_provider: "custom" } } });
    expect(events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ messageId: "user-old" }) }));
    await send({ type: "session.revert", sessionId: "s", requestId: "rewind", token: "user-old", scope: "conversation" });
    expect(fake.state.requests.find((request) => request.method === "thread/fork")?.params).toMatchObject({ cwd: "E:\\repo", model: "gpt-5.4", serviceTier: "default", config: { model_provider: "custom" }, persistExtendedHistory: true });
    expect(fake.state.requests).toContainEqual({ method: "thread/revert", params: { threadId: "thread-fork", beforeTurnId: "turn-old" } });
    expect(events).toContainEqual({ type: "request.completed", requestId: "rewind" });
  });
});

describe("translate Codex provider", () => {
  it("registers as translate-codex", async () => {
    const { registration } = await createHarness();
    expect(registration).toBeDefined();
    const provider = createTranslateCodexProvider({
      loadConfig: async () => values,
      createClient: createFakeClient().factory,
    });
    expect(provider.id).toBe("translate-codex");
    expect(provider.label).toBe("Translate (Codex)");
  });

  it("opens a session, probes models, and restores a persisted thread", async () => {
    const { events, send, fake, registration } = await createHarness();
    await send({
      ...openInput,
      persistence: { version: 1, data: { threadId: "thread-old" } },
      config: { ...openInput.config, systemPrompt: "Be terse." },
    });
    await waitFor(events, (event) => event.type === "session.ready");
    expect(events.find((event) => event.type === "session.opened")).toMatchObject({
      sessionId: "s",
      restoration: "core",
      persistence: { version: 1, data: { threadId: "thread-old" } },
    });
    expect(fake.state.requests.some((request) => request.method === "thread/resume")).toBe(true);
    expect(JSON.stringify(fake.state.requests)).toContain("DE(Be terse.)");
    expect(fake.state.options).toMatchObject({ command: "codex", cwd: "E:\\repo" });
    const config = events.find((event) => event.type === "session.config");
    expect(config).toMatchObject({
      config: { modes: [{ id: "auto" }, { id: "auto-review" }, { id: "full-access" }] },
    });
    await registration.close();
  });

  it("records a multi-fragment prompt for display without translating it again", async () => {
    const cacheStore = createMemoryTranslationCacheStore();
    const { events, send, registration } = await createHarness(undefined, undefined, cacheStore);
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    const prompt = promptInput("Hello");
    if (prompt.prompt.input.type !== "message") throw new Error("Expected message input");
    prompt.prompt.input.content.push({ type: "text", text: "World" });
    await send(prompt);
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    const display = createTranslateHandler({ loadConfig: async () => values, cacheStore, fetchFn: async () => { throw new Error("Display must use the prompt cache"); } });
    await expect(display({ text: "Hello\nWorld", direction: "user-to-agent" })).resolves.toEqual({ text: "DE(Hello)\nDE(World)" });
    await registration.close();
  });

  it("translates the prompt before Codex sees it and streams the turn", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello world"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    const turnStart = fake.state.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params)).toContain("DE(Hello world)");
    expect(JSON.stringify(turnStart?.params)).not.toContain('"Hello world"');
    fake.emit("turn/started", { turnId: "native-1" });
    fake.emit("item/started", {
      item: { type: "userMessage", id: "u-1", content: [{ type: "text", text: "DE(Hello world)" }] },
      turnId: "native-1",
    });
    fake.emit("item/agentMessage/delta", { itemId: "a-1", delta: "Hallo" });
    fake.emit("item/agentMessage/delta", { itemId: "a-1", delta: " Welt" });
    fake.emit("turn/completed", { status: "completed" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const items = events.filter((event) => event.type === "timeline.item");
    expect(items.some((event) => event.type === "timeline.item" && event.item.type === "user_message")).toBe(
      true,
    );
    const assistant = items.filter(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant.at(-1)).toMatchObject({
      item: { type: "assistant_message", text: "Hallo Welt", messageId: "a-1" },
    });
    expect(events.find((event) => event.type === "session.persistence")).toMatchObject({
      persistence: { version: 1, data: { threadId: "thread-1" } },
    });
  });

  it("scopes the translation transcript to the bridged agent id from the session env", async () => {
    const context = createTranslationContextManager({
      loadConfig: async () => values,
      sweepIntervalMs: 0,
    });
    const { fake, events, send } = await createHarness(undefined, context);
    await send({
      ...openInput,
      config: {
        ...openInput.config,
        env: { [TRANSLATE_AGENT_ID_ENV]: "agent-1", KEEP_ME: "1" },
      },
    });
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello world"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    expect(
      context.snapshot("agent-1", "user-to-agent", { hardCapChars: 100_000 }).turns,
    ).toHaveLength(1);
    expect(
      context.snapshot("s", "user-to-agent", { hardCapChars: 100_000 }).turns,
    ).toHaveLength(0);
    // The bridge var must not leak into the app-server process environment;
    // user env passes through untouched.
    expect(fake.state.options?.env?.[TRANSLATE_AGENT_ID_ENV]).toBeUndefined();
    expect(fake.state.options?.env?.KEEP_ME).toBe("1");
  });

  it("fail-closes when prompt translation fails", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    fake.state.requests = [];
    await send(promptInput("please FAIL now"));
    await waitFor(events, (event) => event.type === "session.prompt_result");
    expect(events.find((event) => event.type === "session.prompt_result")).toMatchObject({
      result: { type: "failed" },
    });
    expect(fake.state.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("interrupts an in-flight turn", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.emit("turn/started", { turnId: "native-1" });
    const approval = fake.serverRequest("item/commandExecution/requestApproval", {
      itemId: "cmd-int",
      command: "ls",
    });
    await waitFor(events, (event) => event.type === "session.permission");
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    expect(fake.state.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
    await expect(approval).resolves.toEqual({ decision: "cancel" });
    expect(
      events.some(
        (event) =>
          event.type === "session.permission_resolved" && event.permissionId === "permission-cmd-int",
      ),
    ).toBe(true);
    fake.emit("turn/completed", { status: "interrupted" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "canceled");
  });

  it("keeps the root turn running through sub-agent child threads", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("spawn a subagent"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-root" });
    // Codex spawns a collab sub-agent on a child thread while the root turn runs.
    fake.emit("item/completed", {
      threadId: "thread-1",
      item: {
        type: "collabAgentToolCall",
        id: "call-sub",
        tool: "spawnAgent",
        status: "inProgress",
        prompt: "Report findings.",
        receiverThreadIds: ["child-thread-1"],
      },
    });
    fake.emit("turn/started", { threadId: "child-thread-1", turnId: "native-child" });
    fake.emit("item/agentMessage/delta", {
      threadId: "child-thread-1",
      itemId: "child-msg-1",
      delta: "Found the path.",
    });
    fake.emit("item/completed", {
      threadId: "child-thread-1",
      item: { type: "userMessage", id: "child-user-1", content: [{ type: "text", text: "Go" }] },
    });
    // The child thread finishing must not settle the still-running root turn.
    fake.emit("turn/completed", { threadId: "child-thread-1", turn: { status: "completed" } });
    const turnStates = events
      .filter((event) => event.type === "session.turn" && event.sessionId === "s")
      .map((event) => (event.type === "session.turn" ? event.state : ""));
    expect(turnStates).toEqual(["started"]);
    // Sub-agent text never surfaces as root rows, but the spawn card does.
    const items = events.flatMap((event) =>
      event.type === "timeline.item" && event.sessionId === "s" ? [event.item] : [],
    );
    expect(items.some((item) => item.type === "assistant_message")).toBe(false);
    expect(items.some((item) => item.type === "user_message")).toBe(false);
    expect(items.some((item) => item.type === "tool_call")).toBe(true);
    // An interrupt still targets the root turn, not the child's turn id.
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    const interrupts = fake.state.requests.filter((request) => request.method === "turn/interrupt");
    expect(interrupts.at(-1)?.params).toEqual({ threadId: "thread-1", turnId: "native-root" });
    fake.emit("turn/completed", { threadId: "thread-1", turn: { status: "interrupted" } });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "canceled");
    expect(
      events
        .filter((event) => event.type === "session.turn" && event.sessionId === "s")
        .map((event) => (event.type === "session.turn" ? event.state : "")),
    ).toEqual(["started", "canceled"]);
  });

  it("reads the nested turn/completed status shapes", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.emit("turn/started", { threadId: "thread-1", turn: { id: "native-1" } });
    fake.emit("turn/completed", {
      threadId: "thread-1",
      turn: { status: "failed", error: { message: "model unavailable" } },
    });
    const failed = events.find(
      (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
        event.type === "session.turn" && event.state === "failed",
    );
    expect(failed?.error?.message).toBe("model unavailable");
  });

  it("opens an autonomous turn for a turn that outlived its start ack failure", async () => {
    const { fake, events, send } = await createHarness();
    fake.state.handlers["turn/start"] = () => {
      throw new Error("ack timeout");
    };
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "failed");
    // The ack timed out locally, but Codex actually started the turn.
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-late" });
    fake.emit("item/agentMessage/delta", { threadId: "thread-1", itemId: "a-1", delta: "Working" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.emit("turn/completed", { threadId: "thread-1", turn: { status: "completed" } });
    const turns = events
      .filter((event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
        event.type === "session.turn",
      )
      .map((event) => ({ state: event.state, turnId: event.turnId }));
    expect(turns).toHaveLength(4);
    expect(turns[0]?.state).toBe("started");
    expect(turns[1]?.state).toBe("failed");
    expect(turns[2]?.turnId).not.toBe(turns[0]?.turnId);
    expect(turns[2]?.state).toBe("started");
    expect(turns[3]).toMatchObject({ turnId: turns[2]?.turnId, state: "completed" });
    // The late turn's items still surfaced on the timeline while it ran.
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "Working",
      ),
    ).toBe(true);
  });

  it.each([false, true])("handles start acknowledgement failure after native activity (completed=%s)", async (completed) => {
    const { fake, events, send } = await createHarness();
    fake.state.handlers["turn/start"] = () => {
      fake.emit("turn/started", { threadId: "thread-1", turn: { id: "native-early" } });
      if (completed) {
        fake.emit("turn/completed", {
          threadId: "thread-1",
          turn: { id: "native-early", status: "completed" },
        });
      }
      throw new Error("ack timeout");
    };
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    const turns = events.filter(
      (event): event is Extract<ProviderEvent, { type: "session.turn" }> => event.type === "session.turn",
    );
    expect(turns.map((turn) => turn.state)).toEqual(
      completed ? ["started", "completed"] : ["started", "failed", "started"],
    );
    if (!completed) {
      expect(turns[2]?.turnId).not.toBe(turns[0]?.turnId);
      fake.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "native-early", status: "completed" },
      });
      expect(events.at(-1)).toMatchObject({
        type: "session.turn", turnId: turns[2]?.turnId, state: "completed",
      });
    }
  });

  it("keeps an autonomous turn running when interruption fails", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    fake.state.handlers["turn/start"] = () => { throw new Error("ack timeout"); };
    await send(promptInput("Hello"));
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-auto" });
    fake.state.handlers["turn/interrupt"] = () => { throw new Error("interrupt refused"); };
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    expect(events.some((event) => event.type === "request.failed" && event.requestId === "r-int")).toBe(true);
    expect(events.filter((event) => event.type === "session.turn")).toHaveLength(3);
    // Repeated native activity must not retry the failed interrupt or duplicate the turn.
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-auto" });
    expect(fake.state.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
    fake.emit("turn/completed", {
      threadId: "thread-1", turn: { id: "native-auto", status: "completed" },
    });
    expect(events.filter((event) => event.type === "session.turn").map((event) => event.state))
      .toEqual(["started", "failed", "started", "completed"]);
  });

  it("settles an autonomous turn on interrupt and silences trailing activity", async () => {
    const { fake, events, send } = await createHarness();
    fake.state.handlers["turn/start"] = () => {
      throw new Error("ack timeout");
    };
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "failed");
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-late" });
    await waitFor(
      events,
      (event) =>
        event.type === "session.turn" &&
        event.state === "started" &&
        events.filter((turn) => turn.type === "session.turn").length === 3,
    );
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "canceled");
    const interrupts = fake.state.requests.filter((request) => request.method === "turn/interrupt");
    expect(interrupts.at(-1)?.params).toEqual({ threadId: "thread-1", turnId: "native-late" });
    // Trailing activity of the killed request must not re-open a turn.
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-late-2" });
    fake.emit("item/agentMessage/delta", { threadId: "thread-1", itemId: "a-2", delta: "Trailing" });
    fake.emit("turn/completed", { threadId: "thread-1", turn: { status: "completed" } });
    expect(
      events
        .filter((event) => event.type === "session.turn")
        .map((event) => (event.type === "session.turn" ? event.state : "")),
    ).toEqual(["started", "failed", "started", "canceled"]);
  });

  it.each([false, true])("ignores superseded completion with the next prompt (new native turn started=%s)", async (nextStarted) => {
    const { fake, events, send } = await createHarness();
    fake.state.handlers["turn/start"] = () => {
      throw new Error("ack timeout");
    };
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "failed");
    fake.emit("turn/started", { threadId: "thread-1", turnId: "native-late" });
    await waitFor(
      events,
      (event) =>
        event.type === "session.turn" &&
        event.state === "started" &&
        events.filter((turn) => turn.type === "session.turn").length === 3,
    );
    fake.state.handlers["turn/start"] = () => {
      if (nextStarted) fake.emit("turn/started", { threadId: "thread-1", turnId: "native-next" });
      fake.emit("turn/started", { threadId: "thread-1", turnId: "native-late" });
      fake.emit("turn/completed", {
        threadId: "thread-1", turn: { id: "native-late", status: "completed" },
      });
      return {};
    };
    await send(promptInput("Again", "m-2"));
    const turns = events
      .filter((event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
        event.type === "session.turn",
      )
      .map((event) => ({ state: event.state, turnId: event.turnId }));
    expect(turns).toHaveLength(5);
    expect(turns[3]).toMatchObject({ turnId: turns[2]?.turnId, state: "completed" });
    expect(turns[4]?.state).toBe("started");
    expect(turns[4]?.turnId).not.toBe(turns[2]?.turnId);
    if (!nextStarted) fake.emit("turn/started", { threadId: "thread-1", turnId: "native-next" });
    fake.emit("item/started", {
      threadId: "thread-1", turnId: "native-next",
      item: { type: "userMessage", id: "u-next", content: [{ type: "text", text: "DE(Again)" }] },
    });
    expect(events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message").at(-1))
      .toMatchObject({ item: { text: "Again", clientMessageId: "m-2" } });
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    expect(fake.state.requests.filter((request) => request.method === "turn/interrupt").at(-1)?.params)
      .toEqual({ threadId: "thread-1", turnId: "native-next" });
    fake.emit("turn/completed", {
      threadId: "thread-1", turn: { id: "native-next", status: "interrupted" },
    });
    expect(events.at(-1)).toMatchObject({ type: "session.turn", turnId: turns[4]?.turnId, state: "canceled" });
  });

  it("round-trips command approvals", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("run it"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    const approval = fake.serverRequest("item/commandExecution/requestApproval", {
      itemId: "cmd-1",
      command: "ls",
      cwd: "E:\\repo",
    });
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({
      request: { name: "CodexBash", kind: "tool", detail: { type: "shell", command: "ls" } },
    });
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: (permission as Extract<ProviderEvent, { type: "session.permission" }>).request.id,
      response: { behavior: "allow" },
    });
    await expect(approval).resolves.toEqual({ decision: "accept" });
  });

  it("lists Codex threads and rewinds by forking", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    fake.emit("turn/started", { turnId: "native-1" });
    fake.emit("item/started", {
      item: { type: "userMessage", id: "u-1", content: [{ type: "text", text: "DE(Hello)" }] },
      turnId: "native-1",
    });
    fake.emit("turn/completed", { status: "completed" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    await send({ type: "sessions", requestId: "r-list", cwd: "E:\\repo", limit: 10 });
    await waitFor(events, (event) => event.type === "sessions");
    expect(events.find((event) => event.type === "sessions")).toMatchObject({
      // Thread names are engine-generated agent-language text; the listing
      // renders them for display through the agent-to-user endpoint stub.
      sessions: [{ persistence: { data: { threadId: "thread-old" } }, title: "DE(Yesterday)" }],
    });
    fake.state.handlers["thread/read"] = () => ({ thread: { turns: [{ id: "native-1", items: [] }] } });
    await send({
      type: "session.revert",
      requestId: "r-rewind",
      sessionId: "s",
      token: "u-1",
      scope: "conversation",
    });
    await waitFor(events, (event) => event.type === "request.completed" && event.requestId === "r-rewind");
    expect(fake.state.requests.some((request) => request.method === "thread/fork")).toBe(true);
    expect(events.find((event) => event.type === "session.persistence" && JSON.stringify(event).includes("thread-fork"))).toBeDefined();
  });

  it("fails rewind when the user message has no Codex turn mapping", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.emit("turn/completed", { status: "completed" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    fake.state.requests = [];
    await send({
      type: "session.revert",
      requestId: "r-rewind-miss",
      sessionId: "s",
      token: "missing-msg",
      scope: "conversation",
    });
    await waitFor(
      events,
      (event) => event.type === "request.failed" && event.requestId === "r-rewind-miss",
    );
    expect(fake.state.requests.some((request) => request.method === "thread/fork")).toBe(false);
  });

  it("steers the active turn", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.emit("turn/started", { turnId: "native-1" });
    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "also this" }] },
      },
    });
    await waitFor(events, (event) => event.type === "session.prompt_result" && event.clientMessageId === "m-steer");
    const steer = fake.state.requests.find((request) => request.method === "turn/steer");
    expect(JSON.stringify(steer?.params)).toContain("DE(also this)");
    expect(events.find((event) => event.type === "session.prompt_result" && event.clientMessageId === "m-steer")).toMatchObject({
      result: { type: "steer" },
    });
  });

  it("resolves pending permissions when the session closes", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("run it"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    const approval = fake.serverRequest("item/commandExecution/requestApproval", {
      itemId: "cmd-close",
      command: "ls",
    });
    await waitFor(events, (event) => event.type === "session.permission");
    await send({ type: "session.close", requestId: "r-close-perm", sessionId: "s" });
    await expect(approval).resolves.toEqual({ decision: "cancel" });
    expect(
      events.some(
        (event) =>
          event.type === "session.permission_resolved" && event.permissionId === "permission-cmd-close",
      ),
    ).toBe(true);
  });

  it("lists threads from equivalent workspace paths", async () => {
    const { events, send } = await createHarness();
    await send({ type: "sessions", requestId: "r-list-cwd", cwd: "E:\\repo\\", limit: 10 });
    await waitFor(events, (event) => event.type === "sessions");
    expect(events.find((event) => event.type === "sessions")).toMatchObject({
      sessions: [{ persistence: { data: { threadId: "thread-old" } } }],
    });
    await send({ type: "sessions", requestId: "r-list-slash", cwd: "E:/repo", limit: 10 });
    await waitFor(events, (event) => event.type === "sessions" && event.requestId === "r-list-slash");
    expect(events.find((event) => event.type === "sessions" && event.requestId === "r-list-slash")).toMatchObject({
      sessions: [{ persistence: { data: { threadId: "thread-old" } } }],
    });
  });

  it("probes the catalog from model/list", async () => {
    const { events, send } = await createHarness();
    await send({ type: "catalog", requestId: "r-cat" });
    await waitFor(events, (event) => event.type === "catalog");
    expect(events.find((event) => event.type === "catalog")).toMatchObject({
      catalog: {
        defaultModel: "gpt-5.4",
        defaultMode: "auto-review",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      },
    });
  });

  it("refuses an empty prompt without starting a turn", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    fake.state.requests = [];
    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-empty",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "   " }] },
      },
    });
    await waitFor(
      events,
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "m-empty",
    );
    expect(events.find((event) => event.type === "session.prompt_result" && event.clientMessageId === "m-empty")).toMatchObject({
      result: { type: "failed" },
    });
    expect(fake.state.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("translates question display and answers both ways", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("ask me"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    const approval = fake.serverRequest("item/tool/requestUserInput", {
      itemId: "q-1",
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which file?",
          options: [{ label: "Keep going" }],
        },
      ],
    });
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({
      request: {
        kind: "question",
        input: {
          questions: [{ header: "DE(Choice) (Choice)", question: "DE(Which file?)\nWhich file?" }],
        },
      },
    });
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: (permission as Extract<ProviderEvent, { type: "session.permission" }>).request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "DE(Choice) (Choice)": "the src one" } },
      },
    });
    await expect(approval).resolves.toEqual({
      answers: { choice: { answers: ["DE(the src one)"] } },
    });
  });

  it("fails the active turn when the app-server process exits", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.crash(new Error("Codex app-server exited with code 17"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "failed");
    expect(events.find((event) => event.type === "session.turn" && event.state === "failed")).toMatchObject({
      error: { message: "Codex app-server exited with code 17" },
    });
  });

  it("restores original user text on history replay", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello world"));
    fake.emit("turn/started", { turnId: "native-1" });
    fake.emit("turn/completed", { status: "completed" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    fake.state.handlers["thread/read"] = () => ({
      thread: {
        turns: [
          {
            id: "native-1",
            items: [
              {
                type: "userMessage",
                id: "u-hist",
                content: [{ type: "text", text: "DE(Hello world)" }],
              },
              { type: "agentMessage", id: "a-hist", text: "Hallo Welt" },
            ],
          },
        ],
      },
    });
    await send({ type: "session.close", requestId: "r-close", sessionId: "s" });
    await send({
      ...openInput,
      requestId: "r-open-2",
      sessionId: "s2",
      history: "replay",
      persistence: { version: 1, data: { threadId: "thread-1" } },
    });
    await waitFor(events, (event) => event.type === "session.ready" && event.sessionId === "s2");
    const replayed = events.filter(
      (event) => event.type === "timeline.item" && event.sessionId === "s2",
    );
    expect(replayed[0]).toMatchObject({
      item: { type: "user_message", text: "Hello world", messageId: "u-hist" },
    });
    expect(replayed[1]).toMatchObject({
      item: { type: "assistant_message", text: "Hallo Welt" },
    });
  });

  it("does not reuse a failed turn's user-text anchor on the next prompt", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    fake.state.handlers["turn/start"] = () => {
      throw new Error("turn/start refused");
    };
    await send(promptInput("first prompt", "m-a"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "failed");
    delete fake.state.handlers["turn/start"];
    await send(promptInput("second prompt", "m-b"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    fake.emit("turn/started", { turnId: "native-2" });
    fake.emit("item/started", {
      item: { type: "userMessage", id: "u-2", content: [{ type: "text", text: "DE(second prompt)" }] },
      turnId: "native-2",
    });
    const user = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "user_message",
    );
    expect(user.at(-1)).toMatchObject({ item: { text: "second prompt", clientMessageId: "m-b" } });
  });

  it("emits the completed assistant suffix after partial deltas", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    fake.emit("item/agentMessage/delta", { itemId: "a-suf", delta: "Hel" });
    fake.emit("item/completed", { item: { type: "agentMessage", id: "a-suf", text: "Hello" } });
    await waitFor(
      events,
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.text === "Hello",
    );
    fake.emit("item/completed", { item: { type: "agentMessage", id: "a-suf", text: "Hello" } });
    fake.emit("item/agentMessage/delta", { itemId: "a-suf-2", delta: "Wor" });
    fake.emit("item/completed", { item: { type: "agentMessage", id: "a-suf-2", text: "World" } });
    await waitFor(
      events,
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        event.item.text === "\n\n---\n\nWorld",
    );
  });

  it("marks the question tool card completed after an answer", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("ask me"));
    const approval = fake.serverRequest("item/tool/requestUserInput", {
      itemId: "q-term",
      questions: [{ id: "choice", header: "Choice", question: "Which?", options: [{ label: "A" }] }],
    });
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: (permission as Extract<ProviderEvent, { type: "session.permission" }>).request.id,
      response: { behavior: "allow", updatedInput: { answers: { "DE(Choice) (Choice)": "DE(A) (A)" } } },
    });
    await approval;
    const cards = events.filter(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.callId === "q-term",
    );
    expect(cards.at(-1)).toMatchObject({ item: { status: "completed" } });
  });

  it("declines a question when answer translation fails", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("ask me"));
    const approval = fake.serverRequest("item/tool/requestUserInput", {
      itemId: "q-fail",
      questions: [{ id: "choice", header: "Choice", question: "Which?", options: [{ label: "A" }] }],
    });
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: (permission as Extract<ProviderEvent, { type: "session.permission" }>).request.id,
      response: { behavior: "allow", updatedInput: { answers: { "DE(Choice) (Choice)": "please FAIL now" } } },
    });
    await expect(approval).resolves.toEqual({ answers: {} });
    const cards = events.filter(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.callId === "q-fail",
    );
    expect(cards.at(-1)).toMatchObject({ item: { status: "failed" } });
  });

  it("keeps slash command names verbatim and only translates arguments", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-cmd",
        delivery: "auto",
        input: { type: "command", name: "review", arguments: "this file" },
      },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    const turnStart = fake.state.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params)).toContain('"type":"skill"');
    expect(JSON.stringify(turnStart?.params)).toContain('"name":"review"');
    expect(JSON.stringify(turnStart?.params)).toContain("/skills/review.md");
    expect(JSON.stringify(turnStart?.params)).toContain("$review DE(this file)");
    expect(JSON.stringify(turnStart?.params)).not.toContain("/review DE(this file)");
  });

  it("sends images as localImage inputs", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-img",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        },
      },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "started");
    const turnStart = fake.state.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params)).toContain('"type":"localImage"');
    expect(JSON.stringify(turnStart?.params)).toContain("paseo-attachments");
  });

  it("does not rewrite a completed turn as canceled after interrupt", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await waitFor(events, (event) => event.type === "session.ready");
    await send(promptInput("Hello"));
    fake.emit("turn/started", { turnId: "native-1" });
    fake.state.handlers["turn/interrupt"] = () => {
      throw new Error("interrupt exploded");
    };
    await send({ type: "session.interrupt", requestId: "r-int-fail", sessionId: "s" });
    await waitFor(events, (event) => event.type === "request.failed" && event.requestId === "r-int-fail");
    fake.emit("turn/completed", { status: "completed" });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
  });
});


it.each([false, true])("honors MCP preapprovals on %s resume", async (resume) => {
  const { fake, send, registration } = await createHarness();
  await send({ ...openInput, ...(resume ? { persistence: { version: 1, data: { threadId: "saved" } } } : {}),
    config: { ...openInput.config, mcpServers: { paseo: { type: "stdio", command: "paseo-mcp", args: ["serve"] } },
      toolPolicy: { preapproved: [{ kind: "mcp", server: "paseo", tool: "read" }, { kind: "mcp", server: "paseo", tool: "read" }] } } });
  if (!resume) await send(promptInput("Work"));
  expect(registration.capabilities).toContain("permission.tool_policy");
  expect(fake.state.requests.find((request) => request.method === (resume ? "thread/resume" : "thread/start")))
    .toMatchObject({ params: { config: { mcp_servers: { paseo: { command: "paseo-mcp", args: ["serve"], enabled_tools: ["read"],
      default_tools_approval_mode: "prompt", tools: { read: { approval_mode: "approve" } } } } } } });
  await registration.close();
});

it("uses configured model and reasoning defaults in the catalog and session", async () => {
  const { fake, send, events, registration } = await createHarness();
  fake.state.handlers["model/list"] = () => ({ data: [
    { id: "advertised", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"] },
    { id: "configured", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"] },
  ] });
  fake.state.handlers["config/read"] = () => ({ config: { model: "configured", model_reasoning_effort: "high" } });
  await send({ type: "catalog", requestId: "configured-catalog" });
  const catalog = events.find((event) => event.type === "catalog");
  expect(catalog).toMatchObject({ catalog: { defaultModel: "configured", defaultThinkingOption: "high",
    models: [expect.objectContaining({ id: "advertised", isDefault: false }), expect.objectContaining({ id: "configured", isDefault: true,
      defaultThinkingOptionId: "high", thinkingOptions: expect.arrayContaining([expect.objectContaining({ id: "high", isDefault: true })]) })] } });
  await send(openInput);
  expect(events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({ config: { model: "configured", thinkingOption: "high" } });
  await registration.close();
});

it.each(["0.114.9", "0.115.0", "0.155.0"])("gates Auto-review with Codex %s", async (version) => {
  const { fake, send, events, registration } = await createHarness();
  fake.state.version = version;
  const supported = version !== "0.114.9";
  await send({ type: "catalog", requestId: "version-gate" });
  const catalog = events.find((event) => event.type === "catalog");
  expect(catalog).toMatchObject({ catalog: { defaultMode: supported ? "auto-review" : "auto" } });
  if (catalog?.type !== "catalog") throw new Error("catalog missing");
  expect(catalog.catalog.modes.some((mode) => mode.id === "auto-review")).toBe(supported);
  await send(openInput);
  await send({ type: "session.configure", sessionId: "s", requestId: "set-auto-review", changes: { mode: "auto-review" } });
  expect(events.some((event) => event.type === "request.failed" && event.requestId === "set-auto-review")).toBe(!supported);
  await registration.close();
});

it("archives native threads and verifies an already-restored thread", async () => {
  const { fake, send, events, registration } = await createHarness();
  const persistence = { version: 1, data: { threadId: "saved-thread" } };
  await send({ type: "session.archive", requestId: "archive", persistence });
  fake.state.handlers["thread/unarchive"] = () => { throw new Error("no archived rollout found for thread id saved-thread"); };
  await send({ type: "session.unarchive", requestId: "restore", persistence });
  expect(fake.state.requests.filter((request) => ["thread/archive", "thread/unarchive", "thread/read"].includes(request.method)))
    .toEqual([{ method: "thread/archive", params: { threadId: "saved-thread" } },
      { method: "thread/unarchive", params: { threadId: "saved-thread" } }, { method: "thread/read", params: { threadId: "saved-thread" } }]);
  expect(events.filter((event) => event.type === "request.completed").map((event) => event.requestId)).toEqual(["archive", "restore"]);
  expect(fake.state.disposed).toBe(2);
  await registration.close();
});

it("reports archive failures and disposes an unsuccessful ephemeral handshake", async () => {
  const { fake, send, events, registration } = await createHarness();
  fake.state.handlers.initialize = () => { throw new Error("handshake failed"); };
  await send({ type: "session.archive", requestId: "failed-archive", persistence: { version: 1, data: { threadId: "saved" } } });
  expect(events.find((event) => event.type === "request.failed")).toMatchObject({ requestId: "failed-archive", error: { message: "handshake failed" } });
  expect(fake.state.disposed).toBe(1);
  await registration.close();
});

it("requests last-use order and follows session pages beyond 100 rows", async () => {
  const { fake, send, events, registration } = await createHarness({ translateResponses: false });
  fake.state.handlers["thread/list"] = (params) => {
    const cursor = (params as { cursor?: string }).cursor;
    const offset = cursor ? 99 : 0;
    return { data: Array.from({ length: cursor ? 51 : 100 }, (_, index) => ({ id: `session-${offset + index}`, cwd: "E:/repo", name: `Session ${offset + index}` })), nextCursor: cursor ? null : "second-page" };
  };
  await send({ type: "sessions", requestId: "paginated", cwd: "E:/repo", limit: 150 });
  const listed = events.find((event) => event.type === "sessions");
  if (listed?.type !== "sessions") throw new Error("listing missing");
  expect(listed.sessions).toHaveLength(150);
  expect(new Set(listed.sessions.map((entry) => JSON.stringify(entry.persistence))).size).toBe(150);
  expect(fake.state.requests.filter((request) => request.method === "thread/list")).toEqual([
    { method: "thread/list", params: { limit: 100, cwd: "E:/repo", sortKey: "updated_at" } },
    { method: "thread/list", params: { limit: 50, cwd: "E:/repo", sortKey: "updated_at", cursor: "second-page" } },
  ]);
  await registration.close();
});

it("restores event timestamps and consolidates completed historical subagent activity", async () => {
  const { fake, send, events, registration } = await createHarness({ translatePrompts: false });
  fake.state.handlers["thread/read"] = (params) => {
    if ((params as { threadId: string }).threadId === "child") return { thread: { turns: [{ id: "child-turn", status: "completed", startedAt: 1_700_000_000,
      completedAt: 1_700_000_100, items: [{ id: "child-message", type: "agentMessage", text: "Child reply" }] }] } };
    return { thread: { turns: [{ id: "root-turn", startedAt: 1_700_000_000, completedAt: 1_700_000_100, items: [
      { id: "user", type: "userMessage", content: [{ type: "text", text: "Work" }] },
      { id: "spawn", type: "subAgentActivity", agentThreadId: "child", kind: "started" },
      { id: "reply", type: "agentMessage", text: "Reply", timestamp: "2023-11-14T22:14:00Z" },
      { id: "interact", type: "subAgentActivity", agentThreadId: "child", kind: "interacted" },
    ] }] } };
  };
  await send({ ...openInput, history: "replay", persistence: { version: 1, data: { threadId: "saved" } } });
  const timeline = events.filter((event) => event.type === "timeline.item");
  expect(timeline.find((event) => event.item.id === "user")).toMatchObject({ timestamp: "2023-11-14T22:13:20.000Z" });
  expect(timeline.find((event) => event.item.id === "reply")).toMatchObject({ timestamp: "2023-11-14T22:14:00.000Z" });
  expect(timeline.filter((event) => event.item.type === "tool_call")).toMatchObject([{ item: { callId: "spawn", status: "completed" } }]);
  expect(timeline.find((event) => event.item.id === "child-message")).toMatchObject({ sessionId: "s:codex:child", timestamp: "2023-11-14T22:15:00.000Z" });
  expect(events.filter((event) => event.type === "session.turn" && event.sessionId === "s:codex:child").at(-1)).toMatchObject({ state: "completed" });
  expect(timeline.every((event) => !("timestamp" in event.item))).toBe(true);
  await registration.close();
});

it("tracks a manual compaction through loading and completion", async () => {
  const { fake, send, events, registration } = await createHarness();
  await send(openInput);
  await send({ type: "session.prompt", sessionId: "s", prompt: { clientMessageId: "compact", delivery: "auto", input: { type: "command", name: "compact", arguments: "" } } });
  fake.emit("item/started", { threadId: "thread-1", item: { id: "compact-item", type: "contextCompaction" } });
  fake.emit("thread/compacted", { threadId: "thread-1" });
  fake.emit("item/completed", { threadId: "thread-1", item: { id: "compact-item", type: "contextCompaction" } });
  expect(events.flatMap((event) => event.type === "timeline.item" && event.item.type === "compaction" ? [event.item] : []))
    .toEqual([{ type: "compaction", id: "compact-item", status: "loading", trigger: "manual" }, { type: "compaction", id: "compact-item", status: "completed", trigger: "manual" }]);
  await registration.close();
});


it("keeps pending manual compaction attribution when a new turn starts first", async () => {
  const { fake, send, events, registration } = await createHarness({ translatePrompts: false });
  await send(openInput);
  await send(commandInput("compact"));
  await send(promptInput("Next work"));
  fake.emit("item/started", { threadId: "thread-1", item: { id: "delayed-compact", type: "contextCompaction" } });
  fake.emit("item/completed", { threadId: "thread-1", item: { id: "delayed-compact", type: "contextCompaction" } });
  expect(events.flatMap((event) => event.type === "timeline.item" && event.item.type === "compaction" ? [event.item] : []))
    .toEqual([{ type: "compaction", id: "delayed-compact", status: "loading", trigger: "manual" },
      { type: "compaction", id: "delayed-compact", status: "completed", trigger: "manual" }]);
  await registration.close();
});

it.each(["failed", "interrupted"])("settles unfinished historical child tools when its turn was %s", async (status) => {
  const { fake, send, events, registration } = await createHarness({ translatePrompts: false });
  fake.state.handlers["thread/read"] = (params) => ({ thread: { turns: (params as { threadId: string }).threadId === "child"
    ? [{ id: "child-turn", status, completedAt: 1_700_000_100, items: [{ id: "unfinished-child-tool", type: "commandExecution", command: "work", status: "inProgress" }] }]
    : [{ id: "root-turn", items: [{ id: "spawn", type: "subAgentActivity", agentThreadId: "child", kind: "started" }] }] } });
  await send({ ...openInput, history: "replay", persistence: { version: 1, data: { threadId: "saved" } } });
  expect(events.filter((event) => event.type === "timeline.item" && event.item.id === "unfinished-child-tool").at(-1))
    .toMatchObject({ timestamp: "2023-11-14T22:15:00.000Z", item: { status: status === "failed" ? "failed" : "canceled" } });
  expect(events.filter((event) => event.type === "session.turn" && event.sessionId === "s:codex:child").at(-1))
    .toMatchObject({ state: status === "failed" ? "failed" : "canceled" });
  await registration.close();
});
