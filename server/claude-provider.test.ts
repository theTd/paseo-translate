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
  translateAllTimelines: false,
  translationTimeoutMs: 5_000,
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

async function createHarness() {
  const fake = createFakeFactory();
  const provider = createTranslateClaudeProvider({
    loadConfig: async () => values,
    fetchFn: translatingFetch(),
    queryFactory: fake.factory,
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
