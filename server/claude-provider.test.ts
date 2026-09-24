import { describe, expect, it } from "vitest";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  PROVIDER_CAPABILITIES,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { createTranslateClaudeProvider } from "./claude-provider";
import { translatePromptFragment } from "./prompt-text";
import type { TranslateSettingsValues } from "../shared/translate";

const values: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  translationReasoningEffort: "default" as const,
  translationSystemPrompt: "",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: [],
  innerAgentEnv: {},
  claudeExecutablePath: "",
  translatePrompts: true,
  translateResponses: true,
  translateReasoning: false,
  translateAllTimelines: false,
  translationTimeoutMs: 5_000,
  uiLanguage: "system" as const,
};

/** Translation endpoint stub: DE(...) or FAIL for texts containing FAIL. */
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

type PromptScript = (pushed: SDKUserMessage) => AsyncGenerator<SDKMessage>;

function createFakeFactory() {
  const state = {
    received: [] as SDKUserMessage[],
    options: null as Options | null,
    allOptions: [] as Options[],
    interrupted: 0,
    spawnCount: 0,
    setModelCalls: [] as Array<string | undefined>,
    setPermissionModeCalls: [] as string[],
    applyFlagSettingsCalls: [] as Array<Record<string, unknown>>,
    supportedCommands: null as Array<{
      name: string;
      description?: string;
      argumentHint?: string;
    }> | null,
    supportedModels: null as
      | Array<{
          value: string;
          displayName?: string;
          description?: string;
          supportsEffort?: boolean;
          supportedEffortLevels?: string[];
          supportsAdaptiveThinking?: boolean;
        }>
      | null,
  };
  let script: PromptScript = async function* () {};
  const factory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    state.spawnCount += 1;
    state.options = params.options;
    state.allOptions.push(params.options);
    // Faithful to the real SDK: aborting the controller ends the iterator.
    const aborted = new Promise<void>((resolve) => {
      params.options.abortController?.signal.addEventListener("abort", () => resolve());
    });
    const prompts = params.prompt[Symbol.asyncIterator]();
    const iterator = (async function* () {
      while (true) {
        const next = await Promise.race([
          prompts.next(),
          aborted.then(() => "aborted" as const),
        ]);
        if (next === "aborted" || next.done) return;
        state.received.push(next.value);
        const scripted = script(next.value);
        while (true) {
          const nextMessage = await scripted.next();
          if (nextMessage.done) {
            // A script may end the whole iterator (modeling an SDK that
            // terminates after interrupt) by returning END_ITERATOR.
            if (nextMessage.value === END_ITERATOR) return;
            break;
          }
          yield nextMessage.value;
        }
      }
    })();
    return {
      async interrupt() {
        state.interrupted += 1;
        return undefined;
      },
      async supportedModels() {
        if (state.supportedModels === null) throw new Error("no models mocked");
        return state.supportedModels;
      },
      ...(state.supportedCommands === null
        ? {}
        : {
            async supportedCommands() {
              return state.supportedCommands ?? [];
            },
          }),
      async setModel(model?: string) {
        state.setModelCalls.push(model);
      },
      async setPermissionMode(mode: string) {
        state.setPermissionModeCalls.push(mode);
      },
      async applyFlagSettings(settings: Record<string, unknown>) {
        state.applyFlagSettingsCalls.push(settings);
      },
      [Symbol.asyncIterator]: () => iterator,
    };
  };
  return {
    factory,
    state,
    use(nextScript: PromptScript) {
      script = nextScript;
    },
  };
}

/** Returned from a test script to end the fake iterator entirely. */
const END_ITERATOR = Symbol("end-iterator");

function assistantText(uuid: string, text: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid,
    session_id: "cs-1",
  } as unknown as SDKMessage;
}

function resultSuccess(sessionId: string, text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    errors: [],
    session_id: sessionId,
  } as unknown as SDKMessage;
}

async function createHarness(
  overrides?: Partial<TranslateSettingsValues>,
  cacheStore?: import("./translation-cache-store").TranslationCacheStore,
) {
  const fake = createFakeFactory();
  const provider = createTranslateClaudeProvider({
    loadConfig: async () => ({ ...values, ...overrides }),
    fetchFn: translatingFetch(),
    queryFactory: fake.factory,
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

function promptInput(text: string, clientMessageId = "m-1"): Extract<ProviderInput, { type: "session.prompt" }> {
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

describe("translate claude provider", () => {
  it("opens a session and restores persisted Claude session ids", async () => {
    const { events, send, registration } = await createHarness();
    await send(openInput);
    await send({ ...openInput, requestId: "r-open-2", persistence: { version: 1, data: { claudeSessionId: "cs-old" } } }).catch(() => undefined);
    await registration.close();
    const opened = events.filter((event) => event.type === "session.opened");
    expect(opened[0]).toMatchObject({
      requestId: "r-open",
      sessionId: "s",
      restoration: "core",
      cwd: "E:\\repo",
    });
    expect(events.some((event) => event.type === "session.ready")).toBe(true);
    // The second open with an existing session id fails (duplicate), which
    // proves the first registration held; restore is covered below instead.
  });

  it("translates the prompt before Claude sees it and streams the turn lifecycle", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* (_pushed) {
      yield assistantText("a-1", "Hallo Welt");
      yield resultSuccess("cs-42", "fertig");
    });
    await send(promptInput("Hello world"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");

    expect(fake.state.received).toHaveLength(1);
    const pushedContent = fake.state.received[0].message.content;
    expect(JSON.stringify(pushedContent)).toContain("DE(Hello world)");
    expect(fake.state.options?.cwd).toBe("E:\\repo");
    expect(fake.state.options?.resume).toBeUndefined();

    const items = events.filter((event) => event.type === "timeline.item");
    expect(items[0]).toMatchObject({
      sessionId: "s",
      item: { type: "assistant_message", id: "a-1", text: "Hallo Welt" },
    });
    const persistence = events.find((event) => event.type === "session.persistence");
    expect(persistence).toMatchObject({
      sessionId: "s",
      persistence: { version: 1, data: { claudeSessionId: "cs-42" } },
    });
    const promptResult = events.find((event) => event.type === "session.prompt_result");
    expect(promptResult).toMatchObject({ clientMessageId: "m-1", result: { type: "turn" } });
  });

  it("resumes the stored Claude session and translates the system prompt", async () => {
    const { fake, events, send } = await createHarness();
    await send({
      ...openInput,
      persistence: { version: 1, data: { claudeSessionId: "cs-old" } },
      config: { ...openInput.config, systemPrompt: "Be terse.", model: "claude-sonnet-4-5" },
    });
    fake.use(async function* () {
      yield resultSuccess("cs-old", "ok");
    });
    await send(promptInput("Hi"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    expect(fake.state.options?.resume).toBe("cs-old");
    expect(fake.state.options?.systemPrompt).toBe("DE(Be terse.)");
    expect(fake.state.options?.model).toBe("claude-sonnet-4-5");
    const opened = events.find((event) => event.type === "session.opened");
    expect(opened).toMatchObject({ persistence: { data: { claudeSessionId: "cs-old" } } });
  });

  it("fails closed: an untranslatable prompt never spawns Claude", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    await send(promptInput("FAIL this"));
    await waitFor(events, (event) => event.type === "session.prompt_result");
    const failed = events.find((event) => event.type === "session.prompt_result");
    expect(failed).toMatchObject({
      clientMessageId: "m-1",
      result: { type: "failed", error: { message: expect.stringContaining("endpoint down") } },
    });
    expect(fake.state.spawnCount).toBe(0);
    expect(events.some((event) => event.type === "session.turn")).toBe(false);
  });

  it("passes permission requests through and applies the response", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* (_pushed) {
      const decision = await fake.state.options?.canUseTool?.(
        "Bash",
        { command: "rm -rf /" },
        {
          signal: new AbortController().signal,
          requestId: "perm-1",
          title: "Run command",
          toolUseID: "tu-1",
        },
      );
      yield assistantText("a-1", `decision:${decision?.behavior ?? "none"}`);
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Clean up"));
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({
      sessionId: "s",
      request: { id: "perm-1", name: "Bash", kind: "tool", title: "Run command" },
    });
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: "perm-1",
      response: { behavior: "deny", message: "Not that command", interrupt: false },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const denial = events.find((event) => event.type === "session.permission_resolved");
    expect(denial).toMatchObject({ sessionId: "s", permissionId: "perm-1" });
    const items = events.filter((event) => event.type === "timeline.item");
    expect(items[0]).toMatchObject({ item: { text: "decision:deny" } });
  });

  it("surfaces AskUserQuestion as a translated question permission and translates answers back", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    let decision: unknown;
    fake.use(async function* (_pushed) {
      decision = await fake.state.options?.canUseTool?.(
        "AskUserQuestion",
        {
          questions: [
            {
              header: "Farbe",
              question: "Welche Farbe?",
              options: [{ label: "Blau" }, { label: "Grün" }],
            },
          ],
        },
        { signal: new AbortController().signal, requestId: "perm-q", toolUseID: "tu-q" },
      );
      yield assistantText("a-1", "noted");
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Choose"));
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({
      sessionId: "s",
      request: {
        id: "perm-q",
        name: "AskUserQuestion",
        kind: "question",
        title: "DE(Welche Farbe?)",
        description: "DE(Blau) / DE(Grün)",
      },
    });
    const emittedInput = (
      permission as Extract<ProviderEvent, { type: "session.permission" }>
    ).request.input as { questions: Array<Record<string, unknown>> };
    expect(emittedInput.questions[0]).toMatchObject({
      header: "DE(Farbe)",
      question: "DE(Welche Farbe?)",
      allowOther: true,
    });
    expect(
      (emittedInput.questions[0].options as Array<Record<string, unknown>>).map(
        (option) => option.label,
      ),
    ).toEqual(["DE(Blau)", "DE(Grün)"]);
    expect(
      (permission as Extract<ProviderEvent, { type: "session.permission" }>).request.actions,
    ).toBeUndefined();

    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: "perm-q",
      response: {
        behavior: "allow",
        updatedInput: JSON.parse(
          JSON.stringify({ ...emittedInput, answers: { "DE(Farbe)": "Grün" } }),
        ),
      },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    // Claude receives agent-language keys and values; the UI-only flag is stripped.
    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Welche Farbe?": "DE(Grün)" } },
    });
    const resolvedQuestions = (decision as { updatedInput: { questions: Array<Record<string, unknown>> } })
      .updatedInput.questions;
    expect(resolvedQuestions[0]).not.toHaveProperty("allowOther");
    expect(resolvedQuestions[0]).toMatchObject({ header: "Farbe", question: "Welche Farbe?" });
  });

  it("fails closed: an untranslatable answer denies instead of leaking user text", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    let decision: unknown;
    fake.use(async function* (_pushed) {
      decision = await fake.state.options?.canUseTool?.(
        "AskUserQuestion",
        { questions: [{ header: "Farbe", question: "Welche Farbe?", options: [] }] },
        { signal: new AbortController().signal, requestId: "perm-q2", toolUseID: "tu-q2" },
      );
      yield assistantText("a-1", "noted");
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Choose"));
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    const emittedInput = (
      permission as Extract<ProviderEvent, { type: "session.permission" }>
    ).request.input as { questions: Array<Record<string, unknown>> };
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: "perm-q2",
      response: {
        behavior: "allow",
        updatedInput: JSON.parse(
          JSON.stringify({ ...emittedInput, answers: { "DE(Farbe)": "FAIL bitte" } }),
        ),
      },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    expect(decision).toMatchObject({ behavior: "deny", message: expect.stringContaining("endpoint down") });
  });

  it("degrades gracefully: a failed question translation still asks with the original text", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* (_pushed) {
      const decision = await fake.state.options?.canUseTool?.(
        "AskUserQuestion",
        { questions: [{ header: "Farbe", question: "FAIL Farbe?", options: [] }] },
        { signal: new AbortController().signal, requestId: "perm-q3", toolUseID: "tu-q3" },
      );
      yield assistantText("a-1", `decision:${decision && typeof decision === "object" && "behavior" in decision ? (decision as { behavior: string }).behavior : "none"}`);
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Choose"));
    await waitFor(events, (event) => event.type === "session.permission");
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({
      request: { id: "perm-q3", kind: "question", title: "FAIL Farbe?" },
    });
    await send({
      type: "session.permission",
      sessionId: "s",
      permissionId: "perm-q3",
      response: { behavior: "deny", message: "no" },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const items = events.filter((event) => event.type === "timeline.item");
    expect(items[0]).toMatchObject({ item: { text: "decision:deny" } });
  });

  it("does not hang when the session closes mid question translation", async () => {
    let fetchCalled = false;
    let releaseFetch: ((content: string) => void) | null = null;
    const gate = new Promise<string>((resolve) => {
      releaseFetch = resolve;
    });
    const gatedFetch = (async () => {
      fetchCalled = true;
      const text = await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const fake = createFakeFactory();
    const provider = createTranslateClaudeProvider({
      loadConfig: async () => values,
      fetchFn: gatedFetch,
      queryFactory: fake.factory,
    });
    const registration = await provider.connect({
      versions: [1],
      capabilities: [...PROVIDER_CAPABILITIES],
    });
    const events: ProviderEvent[] = [];
    registration.onEvent((event) => events.push(event));
    const send = (input: ProviderInput) => registration.send(input);
    await send(openInput);
    let decision: unknown;
    fake.use(async function* (_pushed) {
      decision = await fake.state.options?.canUseTool?.(
        "AskUserQuestion",
        { questions: [{ header: "Farbe", question: "Welche Farbe?", options: [] }] },
        { signal: new AbortController().signal, requestId: "perm-qc", toolUseID: "tu-qc" },
      );
      yield assistantText("a-1", "noted");
      yield resultSuccess("cs-1", "done");
    });
    const prompting = send(promptInput("Choose"));
    // Wait until the display translation is actually in flight, then close.
    // The prompt send itself is left unawaited: it stays parked on the gated
    // translation fetch until released below.
    const start = Date.now();
    while (!fetchCalled && Date.now() - start < 4_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fetchCalled).toBe(true);
    // Do not await the close yet: teardown waits on the pump, which waits on
    // the gated translation. Release first, then the close must settle.
    const closing = send({ type: "session.close", requestId: "r-close-q", sessionId: "s" });
    (releaseFetch as unknown as (content: string) => void)("EN(x)");
    await closing;
    await prompting;
    // Releasing with any text proves teardown never waited on a ghost pending:
    // session.closed arrives only after the pump settles.
    await waitFor(events, (event) => event.type === "session.closed");
    const decisionStart = Date.now();
    while (decision === undefined && Date.now() - decisionStart < 4_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(events.some((event) => event.type === "session.permission")).toBe(false);
    await registration.close();
  });

  it("marks the turn canceled after an interrupt", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.use(async function* () {
      yield assistantText("a-1", "Teils");
      await gate;
      yield resultSuccess("cs-1", "aborted");
    });
    await send(promptInput("Work"));
    await waitFor(events, (event) => event.type === "timeline.item");
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    await waitFor(events, (_event) => fake.state.interrupted > 0);
    (release as unknown as () => void)();
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "canceled");
    expect(fake.state.interrupted).toBe(1);
  });

  it("recovers when the iterator ends after an interrupt", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    let endIteration: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      endIteration = resolve;
    });
    fake.use(async function* () {
      yield assistantText("a-1", "Teils");
      // An SDK that ends the iterator after interrupt instead of yielding a
      // result frame: the script ends the whole iterator.
      await gate;
      return END_ITERATOR;
    });
    await send(promptInput("Work"));
    await waitFor(events, (event) => event.type === "timeline.item");
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    await waitFor(events, (_event) => fake.state.interrupted > 0);
    (endIteration as unknown as () => void)();
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "canceled");
    expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);

    // The next prompt rebuilds the query from the latest Claude session id.
    fake.use(async function* () {
      yield resultSuccess("cs-2", "ok");
    });
    await send(promptInput("Again", "m-2"));
    await waitFor(
      events,
      (event) => event.type === "session.turn" && event.state === "completed",
    );
    expect(fake.state.spawnCount).toBe(2);
    // The interrupted turn never produced a result frame, so no Claude
    // session id was captured yet and the rebuild starts without resume.
    expect(fake.state.options?.resume).toBeUndefined();
  });

  it("keeps command words and serialized attachments untranslated", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    const attachment = JSON.stringify({
      type: "forge_issue",
      mimeType: "application/paseo-forge-issue",
      number: 3,
      title: "Bug",
    });
    await send({
      ...promptInput("placeholder"),
      prompt: {
        clientMessageId: "m-1",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "/review fix the login flow" },
            { type: "text", text: attachment },
          ],
        },
      },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const pushed = String(JSON.stringify(fake.state.received[0].message.content));
    expect(pushed).toContain("/review DE(fix the login flow)");
    expect(pushed).toContain("application/paseo-forge-issue");
    // The serialized attachment must pass through without machine translation.
    expect(pushed).not.toContain("DE({");
  });

  it("closes sessions cleanly and aborts the SDK process", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Bye"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    await send({ type: "session.close", requestId: "r-close", sessionId: "s" });
    await waitFor(events, (event) => event.type === "session.closed");
    expect(fake.state.options?.abortController?.signal.aborted).toBe(true);
  });

  it("streams thinking blocks as reasoning items", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Der Nutzer will…" }] },
        parent_tool_use_id: null,
        uuid: "t-1",
        session_id: "cs-1",
      } as unknown as SDKMessage;
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Think"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const reasoning = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "reasoning",
    );
    expect(reasoning).toMatchObject({
      sessionId: "s",
      item: { type: "reasoning", id: "t-1", text: "Der Nutzer will…" },
    });
  });

  it("builds the catalog from the CLI's reported models", async () => {
    const { fake, events, send } = await createHarness();
    fake.state.supportedModels = [
      {
        value: "claude-opus-5",
        displayName: "Opus 5",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "xhigh"],
        supportsAdaptiveThinking: true,
      },
      { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
    ];
    await send({ type: "catalog", requestId: "r-cat" });
    await waitFor(events, (event) => event.type === "catalog");
    const catalogEvent = events.find((event) => event.type === "catalog");
    if (catalogEvent?.type !== "catalog") throw new Error("catalog event missing");
    expect(catalogEvent.requestId).toBe("r-cat");
    expect(catalogEvent.catalog.defaultMode).toBe("default");
    expect(catalogEvent.catalog.modes.map((mode) => mode.id)).toEqual([
      "plan",
      "default",
      "acceptEdits",
      "bypassPermissions",
    ]);
    const models = catalogEvent.catalog.models;
    expect(models.map((model) => model.id)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
    const opus = models[0];
    expect(opus.label).toBe("Opus 5");
    expect(opus.defaultThinkingOptionId).toBe("default");
    expect(opus.thinkingOptions?.map((option) => option.id)).toEqual([
      "default",
      "adaptive",
      "low",
      "high",
      "xhigh",
    ]);
    expect(opus.thinkingOptions?.find((option) => option.id === "xhigh")?.label).toBe("Extra high");
    expect(models[1].thinkingOptions?.map((option) => option.id)).toEqual(["default"]);
    // The probe query is discarded immediately.
    expect(fake.state.options?.abortController?.signal.aborted).toBe(true);
  });

  it("applies model, mode, and thinking changes live on the running query", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Work"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    await send({
      type: "session.configure",
      requestId: "r-cfg",
      sessionId: "s",
      changes: { model: "claude-opus-5", mode: "acceptEdits", thinkingOption: "high" },
    });
    await waitFor(events, (event) => event.type === "request.completed");
    expect(fake.state.setModelCalls).toEqual(["claude-opus-5"]);
    expect(fake.state.setPermissionModeCalls).toEqual(["acceptEdits"]);
    expect(fake.state.applyFlagSettingsCalls).toEqual([{ effortLevel: "high" }]);
    const config = events.filter((event) => event.type === "session.config").at(-1);
    expect(config).toMatchObject({
      sessionId: "s",
      config: { model: "claude-opus-5", mode: "acceptEdits", thinkingOption: "high" },
    });
  });

  it("clears a live bypass mode back to default when switched", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Work"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    await send({
      type: "session.configure",
      requestId: "r-bypass",
      sessionId: "s",
      changes: { mode: "bypassPermissions" },
    });
    await waitFor(events, (event) => event.type === "request.completed");
    await send({
      type: "session.configure",
      requestId: "r-back",
      sessionId: "s",
      changes: { mode: "default" },
    });
    await waitFor(
      events,
      (event) => event.type === "request.completed" && event !== undefined,
    );
    // The running query must be told to leave bypass; a stored-only clear
    // would keep auto-approving while the UI shows Always Ask.
    expect(fake.state.setPermissionModeCalls).toEqual(["bypassPermissions", "default"]);
  });

  it("resets thinking flags when switching off and back to default", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Work"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    await send({
      type: "session.configure",
      requestId: "r-off",
      sessionId: "s",
      changes: { thinkingOption: "off" },
    });
    await waitFor(events, (event) => event.type === "request.completed");
    await send({
      type: "session.configure",
      requestId: "r-def",
      sessionId: "s",
      changes: { thinkingOption: "default" },
    });
    await waitFor(events, (event) => event.type === "request.completed");
    expect(fake.state.applyFlagSettingsCalls).toEqual([
      { effortLevel: null, alwaysThinkingEnabled: false },
      { effortLevel: null, alwaysThinkingEnabled: null },
    ]);
  });

  it("carries configured model, mode, and thinking into the next query", async () => {
    const { fake, events, send } = await createHarness();
    await send({
      ...openInput,
      config: {
        ...openInput.config,
        model: "claude-sonnet-5",
        mode: "plan",
        thinkingOption: "adaptive",
      },
    });
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Hi"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    expect(fake.state.options?.model).toBe("claude-sonnet-5");
    expect(fake.state.options?.permissionMode).toBe("plan");
    expect(fake.state.options?.thinking).toEqual({ type: "adaptive" });

    // "max" is session-scoped in the SDK: at query start it falls back to
    // the closest persisted effort level instead of being dropped silently.
    const second = { ...openInput, sessionId: "s2", config: { ...openInput.config, thinkingOption: "max" } };
    await send(second);
    fake.use(async function* () {
      yield resultSuccess("cs-2", "ok");
    });
    await send({ ...promptInput("Again", "m-2"), sessionId: "s2" });
    await waitFor(
      events,
      (event) => event.type === "session.turn" && event.state === "completed" && event.sessionId === "s2",
    );
    const secondOptions = fake.state.allOptions.at(-1);
    expect(secondOptions?.settings).toEqual({ effortLevel: "xhigh" });
  });
});

function taskStarted(
  taskId: string,
  toolUseId: string,
  extra: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "Explore the repo",
    subagent_type: "Explore",
    task_type: "local_agent",
    prompt: "List all source files",
    uuid: `u-${taskId}`,
    session_id: "cs-1",
    ...extra,
  } as unknown as SDKMessage;
}

function taskNotification(taskId: string, status: string): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    output_file: "",
    summary: "",
    uuid: `n-${taskId}-${status}`,
    session_id: "cs-1",
  } as unknown as SDKMessage;
}

function sidechainText(parentToolUseId: string, uuid: string, text: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: parentToolUseId,
    uuid,
    session_id: "cs-1",
  } as unknown as SDKMessage;
}

function rootToolUse(uuid: string, id: string, name: string, input: unknown): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: null,
    uuid,
    session_id: "cs-1",
  } as unknown as SDKMessage;
}

describe("translate claude provider subagents", () => {
  it("declares Task children as subsessions with timelines and terminal turns", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield rootToolUse("a-task", "tu-1", "Task", {
        name: "Explorer",
        subagent_type: "Explore",
        description: "Explore the repo",
      });
      yield taskStarted("t-1", "tu-1");
      yield sidechainText("tu-1", "s-1", "Found three files");
      yield taskNotification("t-1", "completed");
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Go"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const childId = "subagent:s:tu-1";
    const opened = events.find(
      (event) => event.type === "session.opened" && event.sessionId === childId,
    );
    expect(opened).toMatchObject({
      parentSessionId: "s",
      toolCallId: "tu-1",
      restoration: "parent",
      title: "Explorer",
      description: "Explore the repo",
    });
    const childItems = events.filter(
      (event) => event.type === "timeline.item" && event.sessionId === childId,
    );
    expect(childItems.map((event) => event.type === "timeline.item" && event.item.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    const childTurns = events.filter(
      (event) => event.type === "session.turn" && event.sessionId === childId,
    );
    expect(childTurns.map((event) => event.type === "session.turn" && event.state)).toEqual([
      "started",
      "completed",
    ]);
  });

  it("normalizes workflows and drops shells, housekeeping, and undeclared tasks", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield taskStarted("t-wf", "tu-wf", {
        task_type: "local_workflow",
        subagent_type: undefined,
        description: "Spec workflow",
        prompt: "console.log('source')",
      });
      yield taskStarted("t-bash", "tu-bash", { task_type: "local_bash", subagent_type: undefined });
      yield taskStarted("t-skip", "tu-skip", { skip_transcript: true });
      yield taskNotification("t-ghost", "completed");
      yield taskNotification("t-bash", "completed");
      yield taskNotification("t-wf", "completed");
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Go"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const opened = events.filter((event) => event.type === "session.opened");
    // Only the root and the workflow child.
    expect(opened.map((event) => event.type === "session.opened" && event.sessionId).sort()).toEqual(
      ["s", "subagent:s:tu-wf"],
    );
    const workflow = opened.find(
      (event) => event.type === "session.opened" && event.sessionId === "subagent:s:tu-wf",
    );
    expect(workflow).toMatchObject({ title: "Workflow", description: "Spec workflow" });
    const workflowPrompt = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.sessionId === "subagent:s:tu-wf" &&
        event.item.type === "user_message",
    );
    // A workflow prompt is script source; the opener uses the summary instead.
    expect(workflowPrompt).toMatchObject({ item: { text: "Spec workflow" } });
  });

  it("treats a resumed task alias as the same child and nests grandchildren", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield rootToolUse("a-task", "tu-1", "Task", { subagent_type: "Explore" });
      yield taskStarted("t-1", "tu-1");
      // A resumed task is re-announced with a new tool id for the same task.
      yield taskStarted("t-1", "tu-1-resumed");
      // A Task call inside the child's sidechain spawns a grandchild.
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-2", name: "Task", input: { subagent_type: "Bash" } }],
        },
        parent_tool_use_id: "tu-1",
        uuid: "s-task",
        session_id: "cs-1",
      } as unknown as SDKMessage;
      yield taskStarted("t-2", "tu-2");
      yield taskNotification("t-2", "completed");
      yield taskNotification("t-1", "completed");
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Go"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const childOpens = events.filter(
      (event) => event.type === "session.opened" && event.sessionId === "subagent:s:tu-1",
    );
    expect(childOpens).toHaveLength(1);
    const grandchild = events.find(
      (event) => event.type === "session.opened" && event.sessionId === "subagent:s:tu-2",
    );
    expect(grandchild).toMatchObject({ parentSessionId: "subagent:s:tu-1", toolCallId: "tu-2" });
  });

  it("keeps backgrounded children running across an interrupt", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.use(async function* () {
      yield rootToolUse("a-fg", "tu-fg", "Task", { subagent_type: "Explore" });
      yield taskStarted("t-fg", "tu-fg");
      yield rootToolUse("a-bg", "tu-bg", "Task", { subagent_type: "Explore" });
      yield taskStarted("t-bg", "tu-bg", { is_backgrounded: true });
      await gate;
      return END_ITERATOR;
    });
    await send(promptInput("Work"));
    await waitFor(
      events,
      (event) => event.type === "session.opened" && event.sessionId === "subagent:s:tu-bg",
    );
    await send({ type: "session.interrupt", requestId: "r-int", sessionId: "s" });
    await waitFor(
      events,
      (event) =>
        event.type === "session.turn" &&
        event.sessionId === "subagent:s:tu-fg" &&
        event.state === "canceled",
    );
    // The backgrounded child outlives the turn: no terminal event for it.
    expect(
      events.some(
        (event) => event.type === "session.turn" && event.sessionId === "subagent:s:tu-bg",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.sessionId === "subagent:s:tu-bg" &&
          event.state !== "started",
      ),
    ).toBe(false);
    (release as unknown as () => void)();
  });
});

describe("translate claude provider extended protocol", () => {
  it("steers the active turn with next priority and reports unavailable when idle", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.use(async function* () {
      yield assistantText("a-1", "Working");
      await gate;
      yield resultSuccess("cs-1", "done");
    });
    await send(promptInput("Work"));
    await waitFor(events, (event) => event.type === "timeline.item");
    const steerTurn = events.find(
      (event) => event.type === "session.turn" && event.state === "started",
    );
    if (steerTurn?.type !== "session.turn") throw new Error("turn missing");
    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "actually use pnpm" }] },
      },
    });
    await waitFor(
      events,
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "m-steer",
    );
    const steerResult = events.find(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "m-steer",
    );
    expect(steerResult).toMatchObject({ result: { type: "steer", turnId: steerTurn.turnId } });
    // No new turn opens for a steer; the follow-up queues behind the running one.
    expect(
      events.filter((event) => event.type === "session.turn" && event.state === "started"),
    ).toHaveLength(1);
    (release as unknown as () => void)();
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    // The fake consumes queued input sequentially, so the steer lands after
    // the gate releases; a live SDK reads it concurrently mid-turn.
    await waitFor(events, (_event) => fake.state.received.length >= 2);
    expect(fake.state.received[1]).toMatchObject({ priority: "next" });
    expect(JSON.stringify(fake.state.received[1].message.content)).toContain(
      "DE(actually use pnpm)",
    );

    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-steer-idle",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "later" }] },
      },
    });
    await waitFor(
      events,
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "m-steer-idle",
    );
    expect(
      events.find(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "m-steer-idle",
      ),
    ).toMatchObject({ result: { type: "failed" } });
  });

  it("accepts slash commands with a verbatim command word", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-cmd",
        delivery: "auto",
        input: { type: "command", name: "review", arguments: "fix the login flow" },
      },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const pushed = String(JSON.stringify(fake.state.received[0].message.content));
    expect(pushed).toContain("/review DE(fix the login flow)");
  });

  it("passes image blocks to Claude natively", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "m-img",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        },
      },
    });
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const content = fake.state.received[0].message.content as unknown[];
    const image = content.find(
      (block) => typeof block === "object" && block !== null && (block as { type: unknown }).type === "image",
    ) as { source: { media_type: string; data: string } };
    expect(image.source).toMatchObject({ media_type: "image/png", data: "aGVsbG8=" });
    expect(JSON.stringify(content)).toContain("DE(What is this?)");
  });

  it("maps tool calls to structured details and reports usage", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield rootToolUse("a-bash", "tu-bash", "Bash", { command: "pnpm test" });
      yield {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu-bash", content: "2 passed" }],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        errors: [],
        session_id: "cs-1",
        modelUsage: {
          "claude-sonnet-4-5": { inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
        },
      } as unknown as SDKMessage;
    });
    await send(promptInput("Run tests"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const running = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.callId === "tu-bash",
    );
    expect(running).toMatchObject({
      item: { name: "Bash", status: "running", detail: { type: "shell", command: "pnpm test" } },
    });
    const usage = events.find((event) => event.type === "session.usage");
    expect(usage).toMatchObject({ usage: { inputTokens: 100, outputTokens: 50 } });
  });

  it("keeps tool-result screenshots out of translatable timeline text", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield rootToolUse("a-shot", "tu-shot", "Bash", { command: "screenshot" });
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-shot",
              content: [
                { type: "text", text: "captured" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                },
              ],
            },
          ],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Take a screenshot"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    // The tool card keeps a marker so the screenshot is still visible as
    // having been returned, but the base64 payload must never enter any
    // timeline text (it would be sent to the translation endpoint).
    const toolCall = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.callId === "tu-shot" &&
        event.item.status === "completed",
    );
    expect(toolCall).toBeDefined();
    if (toolCall?.type !== "timeline.item" || toolCall.item.type !== "tool_call") return;
    // Pinned to the shell detail's output field: the marker must survive in
    // the card itself, not just somewhere in the event envelope.
    expect(JSON.stringify(toolCall.item.detail)).toContain("[image]");
    expect(JSON.stringify(toolCall.item.detail)).not.toContain("base64");
    const texts = events
      .filter((event) => event.type === "timeline.item" && "text" in event.item)
      .map((event) => (event.type === "timeline.item" && "text" in event.item ? event.item.text : ""));
    expect(texts.some((text) => text.includes("base64") || text.includes("data:image"))).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.id === "tu-shot-image-0",
      ),
    ).toBe(false);
  });

  it("marks image-only tool results without leaking base64", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield rootToolUse("a-shot-only", "tu-shot-only", "Bash", { command: "screenshot" });
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-shot-only",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                },
              ],
            },
          ],
        },
        parent_tool_use_id: null,
      } as unknown as SDKMessage;
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Take a screenshot"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");
    const toolCall = events.find(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.callId === "tu-shot-only" &&
        event.item.status === "completed",
    );
    expect(toolCall).toBeDefined();
    if (toolCall?.type !== "timeline.item" || toolCall.item.type !== "tool_call") return;
    // No text blocks at all: the whole output is the marker.
    expect(JSON.stringify(toolCall.item.detail)).toContain("[image]");
    expect(JSON.stringify(events)).not.toContain("base64");
  });

  it("publishes slash commands reported by the CLI", async () => {
    const { fake, events, send } = await createHarness();
    fake.state.supportedCommands = [{ name: "review", description: "Review code" }];
    await send(openInput);
    fake.use(async function* () {
      yield resultSuccess("cs-1", "ok");
    });
    await send(promptInput("Hi"));
    await waitFor(events, (event) => event.type === "session.commands");
    expect(events.find((event) => event.type === "session.commands")).toMatchObject({
      sessionId: "s",
      commands: [{ name: "review", description: "Review code" }],
    });
  });

  it("replays persisted transcripts including subagent sidecars", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathModule = await import("node:path");
    const configDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-config-"));
    const cwd = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-cwd-"));
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = pathModule.join(configDir, "projects", encoded);
    await fs.mkdir(pathModule.join(projectDir, "cs-replay", "subagents"), { recursive: true });
    await fs.writeFile(
      pathModule.join(projectDir, "cs-replay.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "Hello" }] },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hi" }] },
          parent_tool_use_id: null,
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      pathModule.join(projectDir, "cs-replay", "subagents", "agent-a1.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Explore", toolUseId: "tu-9" }),
    );
    await fs.writeFile(
      pathModule.join(projectDir, "cs-replay", "subagents", "agent-a1.jsonl"),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Child found it" }] },
      }),
    );
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = configDir;
    try {
      // Prompt translation disabled: the fixture holds original user text
      // (never translated), so replay must keep it verbatim instead of
      // back-translating it.
      const { events, send } = await createHarness({ translatePrompts: false });
      await send({
        ...openInput,
        config: { ...openInput.config, cwd },
        persistence: { version: 1, data: { claudeSessionId: "cs-replay" } },
        history: "replay",
      });
      await waitFor(events, (event) => event.type === "session.ready");
      const rootTexts = events
        .filter((event) => event.type === "timeline.item" && event.sessionId === "s")
        .map((event) => (event.type === "timeline.item" && "text" in event.item ? event.item.text : null));
      expect(rootTexts).toContain("Hello");
      expect(rootTexts).toContain("Hi");
      const childOpened = events.find(
        (event) => event.type === "session.opened" && event.sessionId === "subagent:s:tu-9",
      );
      expect(childOpened).toMatchObject({ parentSessionId: "s", title: "Explore" });
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("replays newer transcript shapes (inline usage, string prompts, sidechain flags)", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathModule = await import("node:path");
    const configDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-config-"));
    const cwd = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-cwd-"));
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = pathModule.join(configDir, "projects", encoded);
    await fs.mkdir(pathModule.join(projectDir, "cs-new", "subagents"), { recursive: true });
    await fs.writeFile(
      pathModule.join(projectDir, "cs-new.jsonl"),
      [
        JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          message: { content: [{ type: "text", text: "leaked sidechain" }] },
        }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "Hello" }] },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      pathModule.join(projectDir, "cs-new", "subagents", "agent-b1.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Explore", toolUseId: "tu-10" }),
    );
    await fs.writeFile(
      pathModule.join(projectDir, "cs-new", "subagents", "agent-b1.jsonl"),
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Do a review" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Reviewed" }],
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
              output_tokens: 40,
            },
          },
        }),
      ].join("\n"),
    );
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = configDir;
    try {
      // Same as above: untranslated fixture text with prompt translation
      // disabled replays verbatim.
      const { events, send } = await createHarness({ translatePrompts: false });
      await send({
        ...openInput,
        config: { ...openInput.config, cwd },
        persistence: { version: 1, data: { claudeSessionId: "cs-new" } },
        history: "replay",
      });
      await waitFor(events, (event) => event.type === "session.ready");
      const rootTexts = events
        .filter((event) => event.type === "timeline.item" && event.sessionId === "s")
        .map((event) =>
          event.type === "timeline.item" && "text" in event.item ? event.item.text : null,
        );
      expect(rootTexts).toContain("Hello");
      expect(rootTexts).not.toContain("leaked sidechain");
      const childItems = events.filter(
        (event) => event.type === "timeline.item" && event.sessionId === "subagent:s:tu-10",
      );
      expect(childItems.map((event) => event.type === "timeline.item" && event.item.type)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      const usage = events.find(
        (event) => event.type === "session.usage" && event.sessionId === "subagent:s:tu-10",
      );
      expect(usage).toMatchObject({ usage: { contextWindowUsedTokens: 100 } });
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("restores the original user text on replay instead of the translated transcript", async () => {
    const { fake, events, send } = await createHarness();
    await send(openInput);
    fake.use(async function* () {
      yield assistantText("a-rt", "Hallo");
      yield resultSuccess("cs-rt-live", "fertig");
    });
    await send(promptInput("Hello world"));
    await waitFor(events, (event) => event.type === "session.turn" && event.state === "completed");

    // Claude persisted the translated prompt; replay must show the original.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathModule = await import("node:path");
    const configDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-config-"));
    const cwd = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-cwd-"));
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = pathModule.join(configDir, "projects", encoded);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      pathModule.join(projectDir, "cs-rt.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "DE(Hello world)" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hallo" }] },
        }),
      ].join("\n"),
    );
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = configDir;
    try {
      await send({
        ...openInput,
        requestId: "r-rt",
        sessionId: "s-rt",
        config: { ...openInput.config, cwd },
        persistence: { version: 1, data: { claudeSessionId: "cs-rt" } },
        history: "replay",
      });
      await waitFor(
        events,
        (event) => event.type === "session.ready" && event.sessionId === "s-rt",
      );
      const texts = events
        .filter((event) => event.type === "timeline.item" && event.sessionId === "s-rt")
        .map((event) => (event.type === "timeline.item" && "text" in event.item ? event.item.text : null));
      expect(texts).toContain("Hello world");
      expect(texts).not.toContain("DE(Hello world)");
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("back-translates pre-fix transcripts for the root timeline but never for sidecars", async () => {    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathModule = await import("node:path");
    const configDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-config-"));
    const cwd = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-cwd-"));
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = pathModule.join(configDir, "projects", encoded);
    await fs.mkdir(pathModule.join(projectDir, "cs-fb", "subagents"), { recursive: true });
    // "Guten Morgen" was never translated through this harness, so no exact
    // reverse entry exists: the root fallback back-translates it via the
    // stub endpoint (DE(...)). The sidecar Task prompt is agent-language by
    // design and must stay untouched.
    await fs.writeFile(
      pathModule.join(projectDir, "cs-fb.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "Guten Morgen" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hallo" }] },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      pathModule.join(projectDir, "cs-fb", "subagents", "agent-c1.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Explore", toolUseId: "tu-c1" }),
    );
    await fs.writeFile(
      pathModule.join(projectDir, "cs-fb", "subagents", "agent-c1.jsonl"),
      JSON.stringify({ type: "user", message: { role: "user", content: "Task prompt" } }),
    );
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = configDir;
    try {
      const { events, send } = await createHarness();
      await send({
        ...openInput,
        config: { ...openInput.config, cwd },
        persistence: { version: 1, data: { claudeSessionId: "cs-fb" } },
        history: "replay",
      });
      await waitFor(events, (event) => event.type === "session.ready");
      const rootTexts = events
        .filter((event) => event.type === "timeline.item" && event.sessionId === "s")
        .map((event) => (event.type === "timeline.item" && "text" in event.item ? event.item.text : null));
      expect(rootTexts).toContain("DE(Guten Morgen)");
      expect(rootTexts).not.toContain("Guten Morgen");
      const childTexts = events
        .filter((event) => event.type === "timeline.item" && event.sessionId === "subagent:s:tu-c1")
        .map((event) => (event.type === "timeline.item" && "text" in event.item ? event.item.text : null));
      expect(childTexts).toEqual(["Task prompt"]);
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps serialized attachments and oversized blocks verbatim on replay", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathModule = await import("node:path");
    const configDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-config-"));
    const cwd = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-cwd-"));
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = pathModule.join(configDir, "projects", encoded);
    await fs.mkdir(projectDir, { recursive: true });
    const attachment = JSON.stringify({ type: "note", mimeType: "text/plain", extra: 1 });
    const big = `prefix-${"x".repeat(100_001)}`;
    await fs.writeFile(
      pathModule.join(projectDir, "cs-keep.jsonl"),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: attachment }, { type: "text", text: big }] },
      }),
    );
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = configDir;
    try {
      const { events, send } = await createHarness();
      await send({
        ...openInput,
        config: { ...openInput.config, cwd },
        persistence: { version: 1, data: { claudeSessionId: "cs-keep" } },
        history: "replay",
      });
      await waitFor(events, (event) => event.type === "session.ready");
      const texts = events
        .filter((event) => event.type === "timeline.item" && event.sessionId === "s")
        .map((event) => (event.type === "timeline.item" && "text" in event.item ? event.item.text : null));
      // Neither block may reach the endpoint (the stub would wrap it in
      // DE(...)): attachments pass through, oversized blocks are refused.
      expect(texts).toEqual([`${attachment}\n${big}`]);
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("restores originals across daemon restarts via the persistent store", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathModule = await import("node:path");
    const { createPersistentTranslationCacheStore } = await import("./translation-cache-store");
    const configDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-config-"));
    const cwd = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-cwd-"));
    const cacheDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "translate-cache-"));
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = pathModule.join(configDir, "projects", encoded);
    await fs.mkdir(projectDir, { recursive: true });
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = configDir;
    try {
      // First "process": prompt, translating and recording the reverse entry.
      const first = await createHarness(undefined, createPersistentTranslationCacheStore({ directory: cacheDir }));
      await first.send(openInput);
      first.fake.use(async function* () {
        yield assistantText("a-persist", "Hallo");
        yield resultSuccess("cs-persist-live", "fertig");
      });
      await first.send(promptInput("Hello world"));
      await waitFor(first.events, (event) => event.type === "session.turn" && event.state === "completed");
      await first.registration.close();

      // Claude persisted the translated prompt.
      await fs.writeFile(
        pathModule.join(projectDir, "cs-persist.jsonl"),
        [
          JSON.stringify({
            type: "user",
            message: { content: [{ type: "text", text: "DE(Hello world)" }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Hallo" }] },
          }),
        ].join("\n"),
      );

      // Second "process": a fresh store over the same directory must restore
      // the original with zero endpoint calls — the fetch rejects on any use.
      const fake2 = createFakeFactory();
      const provider2 = createTranslateClaudeProvider({
        loadConfig: async () => values,
        fetchFn: (async () => {
          throw new Error("endpoint must not be billed on exact restore");
        }) as typeof fetch,
        queryFactory: fake2.factory,
        cacheStore: createPersistentTranslationCacheStore({ directory: cacheDir }),
      });
      const registration2 = await provider2.connect({
        versions: [1],
        capabilities: [...PROVIDER_CAPABILITIES],
      });
      const events2: ProviderEvent[] = [];
      registration2.onEvent((event) => events2.push(event));
      await registration2.send({
        ...openInput,
        requestId: "r-persist",
        sessionId: "s-persist",
        config: { ...openInput.config, cwd },
        persistence: { version: 1, data: { claudeSessionId: "cs-persist" } },
        history: "replay",
      });
      await waitFor(events2, (event) => event.type === "session.ready");
      const texts = events2
        .filter((event) => event.type === "timeline.item" && event.sessionId === "s-persist")
        .map((event) => (event.type === "timeline.item" && "text" in event.item ? event.item.text : null));
      expect(texts).toContain("Hello world");
      expect(texts).not.toContain("DE(Hello world)");
      await registration2.close();
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("PATH claude resolution", () => {
  it("resolves claude from PATH, preferring native executables over shell shims", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const pathModule = await import("node:path");
    const { scanPathForClaude } = await import("./claude-provider");
    const shimDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-shim-"));
    const exeDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-exe-"));
    await fs.writeFile(pathModule.join(shimDir, "claude.cmd"), "");
    await fs.writeFile(pathModule.join(exeDir, "claude.exe"), "");
    try {
      // .exe wins over .cmd even when the shim comes first on PATH.
      expect(scanPathForClaude(`Z:\\missing;${shimDir};${exeDir}`, "win32")).toBe(
        pathModule.join(exeDir, "claude.exe"),
      );
      expect(scanPathForClaude(`Z:\\missing;${shimDir}`, "win32")).toBe(
        pathModule.join(shimDir, "claude.cmd"),
      );
      // Unix looks for the bare name only.
      expect(scanPathForClaude(`Z:\\missing;${exeDir}`, "linux")).toBeNull();
      const unixDir = await fs.mkdtemp(pathModule.join(os.tmpdir(), "claude-unix-"));
      await fs.writeFile(pathModule.join(unixDir, "claude"), "");
      try {
        if (process.platform === "win32") {
          // Windows never grants X_OK to an extensionless file, so the
          // unix-style scan can only report a miss from a Windows host.
          expect(scanPathForClaude(`/missing:${unixDir}`, "linux")).toBeNull();
        } else {
          expect(scanPathForClaude(`/missing:${unixDir}`, "linux")).toBe(
            pathModule.join(unixDir, "claude"),
          );
        }
      } finally {
        await fs.rm(unixDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(shimDir, { recursive: true, force: true });
      await fs.rm(exeDir, { recursive: true, force: true });
    }
  });
});

describe("claude provider bundle", () => {
  it("ships a pre-bundled factory so the daemon compiler never walks the SDK types", async () => {
    const dist = await import("./claude-provider.dist.cjs");
    expect(typeof dist.createTranslateClaudeProvider).toBe("function");
    // The bundle must stay external to the host SDK only: the single
    // non-relative import face is checked in the build; here we assert the
    // factory accepts the same deps shape the entry passes it.
    const provider = dist.createTranslateClaudeProvider({
      loadConfig: async () => ({}),
    });
    expect(provider.id).toBe("translate-claude");
  });
});

describe("translatePromptFragment (shared prompt-text handling)", () => {
  it("keeps the command word and translates the remainder", async () => {
    const translate = async (text: string) => `DE(${text})`;
    await expect(translatePromptFragment("/model switch engines", translate)).resolves.toBe(
      "/model DE(switch engines)",
    );
    await expect(translatePromptFragment("/compact", translate)).resolves.toBe("/compact");
    await expect(translatePromptFragment("Hello", translate)).resolves.toBe("DE(Hello)");
  });

  it("passes serialized attachments through untouched", async () => {
    const attachment = JSON.stringify({ mimeType: "application/paseo-forge-issue", number: 1 });
    let called = false;
    await translatePromptFragment(attachment, async () => {
      called = true;
      return "DE(x)";
    });
    expect(called).toBe(false);
  });
});
