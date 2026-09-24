import { describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { createTranslateCodexProvider, type CodexClientFactory } from "./codex-provider";
import type { CodexClientLike, CodexRequestHandler } from "./codex-app-server";
import type { TranslateSettingsValues } from "../shared/translate";

const values: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  translationReasoningEffort: "default",
  translationSystemPrompt: "",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: [],
  innerAgentEnv: {},
  claudeExecutablePath: "",
  codexExecutablePath: "codex",
  translatePrompts: true,
  translateResponses: true,
  translateReasoning: false,
  translateAllTimelines: false,
  translationTimeoutMs: 5_000,
  uiLanguage: "system",
};

function translatingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((message) => message.role === "user");
    const text = user?.content ?? "";
    if (text.includes("FAIL")) throw new Error("endpoint down");
    return new Response(JSON.stringify({ choices: [{ message: { content: `DE(${text})` } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

function createFakeClient() {
  const state = {
    requests: [] as Array<{ method: string; params: unknown }>,
    options: null as { command: string; cwd: string } | null,
    disposed: 0,
    handlers: {} as Record<string, (params: unknown) => unknown>,
  };
  let notificationHandler: ((method: string, params: unknown) => void) | null = null;
  let terminationHandler: ((error: Error) => void) | null = null;
  const requestHandlers = new Map<string, CodexRequestHandler>();
  const client: CodexClientLike = {
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
    state.options = { command: options.command, cwd: options.cwd };
    return client;
  };
  return {
    factory,
    state,
    emit(method: string, params: unknown) {
      notificationHandler?.(method, params);
    },
    crash(error: Error) {
      terminationHandler?.(error);
    },
    async serverRequest(method: string, params: unknown) {
      const handler = requestHandlers.get(method);
      if (handler === undefined) throw new Error(`no handler for ${method}`);
      return handler(params, 1);
    },
  };
}

async function createHarness(overrides?: Partial<TranslateSettingsValues>) {
  const fake = createFakeClient();
  const provider = createTranslateCodexProvider({
    loadConfig: async () => ({ ...values, ...overrides }),
    fetchFn: translatingFetch(),
    createClient: fake.factory,
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
      sessions: [{ persistence: { data: { threadId: "thread-old" } }, title: "Yesterday" }],
    });
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
        defaultMode: "auto",
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
          questions: [{ header: "DE(Choice)", question: "DE(Which file?)" }],
        },
      },
    });
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: (permission as Extract<ProviderEvent, { type: "session.permission" }>).request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "DE(Choice)": "the src one" } },
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
      response: { behavior: "allow", updatedInput: { answers: { "DE(Choice)": "A" } } },
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
      response: { behavior: "allow", updatedInput: { answers: { "DE(Choice)": "please FAIL now" } } },
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
