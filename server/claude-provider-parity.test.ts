import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { PROVIDER_CAPABILITIES, type ProviderEvent, type ProviderInput, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { createTranslateClaudeProvider, type ClaudeProviderDeps } from "./claude-provider";
import { ClaudeForkCoordinator } from "./claude-fork-coordinator";
import { translateSettings, type TranslateSettingsValues } from "../shared/translate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class SdkOutput implements AsyncIterable<SDKMessage> {
  private readonly frames: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  push(frame: SDKMessage): void { this.frames.push(frame); this.wake?.(); }
  end(): void { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const frame = this.frames.shift();
      if (frame) yield frame;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

class ControlledQuery {
  readonly output = new SdkOutput();
  readonly received: SDKUserMessage[] = [];
  readonly interrupt = vi.fn(async () => undefined);
  readonly cancelAsyncMessage = vi.fn(async (_uuid: string) => true);
  readonly setPermissionMode = vi.fn(async (_mode: string) => undefined);
  readonly setModel = vi.fn(async (_model?: string) => undefined);
  readonly applyFlagSettings = vi.fn(async (_settings: Record<string, unknown>) => undefined);
  readonly input: AsyncIterator<SDKUserMessage>;
  inputEnded = false;
  constructor(prompt: AsyncIterable<SDKUserMessage>, readonly options: Options, consume: boolean) {
    this.input = prompt[Symbol.asyncIterator]();
    options.abortController?.signal.addEventListener("abort", () => this.output.end(), { once: true });
    if (consume) void this.consume();
  }
  private async consume() {
    while (true) {
      const next = await this.input.next();
      if (next.done) { this.inputEnded = true; return; }
      this.received.push(next.value);
    }
  }
  [Symbol.asyncIterator]() { return this.output[Symbol.asyncIterator](); }
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

function message(text: string, id: string = randomUUID(), delivery: "auto" | "steer" = "auto"): Extract<ProviderInput, { type: "session.prompt" }> {
  return { type: "session.prompt", sessionId: "s", prompt: { clientMessageId: id, delivery,
    input: { type: "message", content: [{ type: "text", text }] } } };
}

function init(mode: "default" | "plan" | "bypassPermissions" = "default"): SDKMessage {
  return { type: "system", subtype: "init", uuid: randomUUID(), session_id: "real-session",
    apiKeySource: "none", claude_code_version: "2.1.280", cwd: "E:/repo", tools: [], mcp_servers: [],
    model: "claude-sonnet-5", permissionMode: mode, slash_commands: [], output_style: "default", skills: [], plugins: [] };
}

function success(): SDKMessage {
  return { type: "result", subtype: "success", session_id: "real-session", is_error: false, result: "done" } as SDKMessage;
}

function lifecycle(uuid: string, state: "started" | "cancelled"): SDKMessage {
  // command_lifecycle is emitted by the installed CLI but absent from SDKMessage.
  return { type: "command_lifecycle", command_uuid: uuid, state } as unknown as SDKMessage;
}

async function harness(settings: Partial<TranslateSettingsValues> = {}, deps: Partial<ClaudeProviderDeps> = {}, config: Partial<ProviderSessionConfig> = {}, consume = true) {
  const runs: ControlledQuery[] = [];
  const values = translateSettings.schema.parse({ translatePrompts: false, translationContextEnabled: false, ...settings });
  const provider = createTranslateClaudeProvider({ loadConfig: async () => values, ...deps,
    queryFactory: ({ prompt, options }) => {
      const query = new ControlledQuery(prompt, options, consume);
      runs.push(query);
      return query;
    } });
  const connection = await provider.connect({ versions: [1], capabilities: [...PROVIDER_CAPABILITIES] });
  closers.push(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({ type: "session.open", requestId: "open", sessionId: "s", history: "skip",
    config: { cwd: "E:/repo", env: {}, mcpServers: {}, settings: {}, persist: true, ...config } });
  const send = (input: ProviderInput) => connection.send(input);
  const stop = () => send({ type: "session.interrupt", sessionId: "s", requestId: randomUUID() });
  const start = async () => {
    await send(message("work"));
    const query = runs.at(-1)!;
    await vi.waitFor(() => expect(query.received).toHaveLength(1));
    query.output.push(lifecycle(query.received[0].uuid!, "started"));
    query.output.push(init());
    await vi.waitFor(() => expect(events.some((event) => event.type === "session.persistence")).toBe(true));
    return query;
  };
  return { connection, runs, events, send, stop, start };
}

describe("Claude native-provider parity regressions", () => {
  it("withdraws SDK-queued steers and keeps input usable after Stop acknowledgement", async () => {
    const h = await harness();
    const query = await h.start();
    const steer = message("follow-up", "steer", "steer");
    await h.send(steer);
    await vi.waitFor(() => expect(query.received).toHaveLength(2));
    const uuid = query.received[1].uuid;
    await h.stop();
    expect(query.cancelAsyncMessage).toHaveBeenCalledWith(uuid);
    expect(query.interrupt).toHaveBeenCalledTimes(1);
    expect(query.inputEnded).toBe(false);
    query.output.push(success());
    await h.send(message("new work"));
    await vi.waitFor(() => expect(query.received).toHaveLength(3));
    expect(query.received.every((prompt) => Boolean(prompt.uuid))).toBe(true);
  });

  it("withdraws a steer during its acknowledgement without creating EOF", async () => {
    const h = await harness();
    const query = await h.start();
    let stopping: Promise<void> | undefined;
    h.connection.onEvent((event) => {
      if (event.type === "session.prompt_result" && event.clientMessageId === "steer") stopping = h.stop();
    });
    await h.send(message("queued", "steer", "steer"));
    await stopping;
    expect(query.inputEnded).toBe(false);
    await h.send(message("next"));
    await vi.waitFor(() => expect(query.received.some((prompt) => JSON.stringify(prompt.message.content).includes("next"))).toBe(true));
  });

  it("does not infer that a queued foreground UUID started from an unbound init", async () => {
    const h = await harness({}, {}, {}, false);
    await h.send(message("queued foreground"));
    const query = h.runs[0];
    query.output.push(init());
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.persistence")).toBe(true));
    await h.stop();
    await h.send(message("next foreground"));
    expect((await query.input.next()).value.message.content).toEqual([{ type: "text", text: "next foreground" }]);
    expect(query.cancelAsyncMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])("cancels preparation without sending it (fork fence=%s)", async (fenced) => {
    const waiting = deferred<void>();
    const release = deferred<void>();
    let block = false;
    const values = translateSettings.schema.parse({ translatePrompts: false, translationContextEnabled: false });
    const h = await harness({}, { forkCoordinator: fenced ? new ClaudeForkCoordinator() : undefined,
      loadConfig: async () => { if (block) { waiting.resolve(); await release.promise; } return values; } });
    block = true;
    const sending = h.send(message("slow", "slow"));
    await waiting.promise;
    await h.stop();
    release.resolve();
    await sending;
    expect(h.runs).toHaveLength(0);
    expect(h.events.find((event) => event.type === "session.prompt_result" && event.clientMessageId === "slow"))
      .toMatchObject({ result: { type: "failed" } });
    block = false;
    await h.send(message("next"));
    expect(h.runs).toHaveLength(1);
  });

  it("cancels a prompt still waiting behind an already-held fork fence", async () => {
    const coordinator = new ClaudeForkCoordinator();
    const h = await harness({}, { forkCoordinator: coordinator });
    const entered = deferred<void>();
    const release = deferred<void>();
    const holding = coordinator.exclusive("s", async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const sending = h.send(message("waiting for fork", "waiting"));
    await h.stop();
    release.resolve();
    await holding;
    await sending;
    expect(h.runs).toHaveLength(0);
    expect(h.events.find((event) => event.type === "session.prompt_result" && event.clientMessageId === "waiting"))
      .toMatchObject({ result: { type: "failed", error: { message: "Prompt canceled before delivery" } } });
  });

  it("does not send a slash command canceled during preparation", async () => {
    const waiting = deferred<void>();
    const release = deferred<void>();
    const values = translateSettings.schema.parse({ translatePrompts: false });
    const h = await harness({}, { loadConfig: async () => { waiting.resolve(); await release.promise; return values; } });
    const sending = h.send({ type: "session.prompt", sessionId: "s", prompt: { clientMessageId: "command", delivery: "auto",
      input: { type: "command", name: "review", arguments: "pending" } } });
    await waiting.promise;
    await h.stop();
    release.resolve();
    await sending;
    expect(h.runs).toHaveLength(0);
  });

  it("does not spawn a query canceled while its startup settings load", async () => {
    const waiting = deferred<void>();
    const release = deferred<void>();
    let reads = 0;
    const values = translateSettings.schema.parse({ translatePrompts: false, translationContextEnabled: false });
    const h = await harness({}, { loadConfig: async () => {
      if (++reads === 2) { waiting.resolve(); await release.promise; }
      return values;
    } });
    const sending = h.send(message("startup"));
    await waiting.promise;
    await h.stop();
    release.resolve();
    await sending;
    expect(h.runs).toHaveLength(0);
  });

  it("does not send an old interrupt after a newer main turn has started", async () => {
    const h = await harness();
    const query = await h.start();
    await h.send(message("queued steer", "queued", "steer"));
    await vi.waitFor(() => expect(query.received).toHaveLength(2));
    const release = deferred<boolean>();
    query.cancelAsyncMessage.mockImplementationOnce(() => release.promise);
    const stopping = h.stop();
    await vi.waitFor(() => expect(query.cancelAsyncMessage).toHaveBeenCalledTimes(1));
    query.output.push(success());
    await h.send(message("replacement"));
    query.output.push(init("plan"));
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({ config: { mode: "plan" } }));
    release.resolve(true);
    await stopping;
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it.each(["mode", "model", "settings"] as const)("reports rejected %s changes without publishing a false new value", async (field) => {
    const h = await harness({}, {}, { mode: "bypassPermissions", model: "claude-opus-5" });
    const query = await h.start();
    query.output.push(init("bypassPermissions"));
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({ config: { mode: "bypassPermissions" } }));
    query.setPermissionMode.mockRejectedValueOnce(new Error("rejected mode"));
    query.setModel.mockRejectedValueOnce(new Error("rejected model"));
    query.applyFlagSettings.mockRejectedValueOnce(new Error("rejected fast mode"));
    const changes = field === "mode" ? { mode: "default" } : field === "model" ? { model: "claude-fable-5-1" } : { settings: { fast_mode: true } };
    await h.send({ type: "session.configure", sessionId: "s", requestId: "change", changes });
    expect(h.events.find((event) => event.type === "request.failed" && event.requestId === "change")).toBeDefined();
    expect(h.events.find((event) => event.type === "request.completed" && event.requestId === "change")).toBeUndefined();
    expect(h.events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({ config: { mode: "bypassPermissions" } });
  });

  it("keeps human-steer permissions cleared until its lifecycle starts", async () => {
    const h = await harness();
    const query = await h.start();
    const steer = message("different direction", "steer", "steer");
    steer.prompt.clearPendingPermissions = true;
    await h.send(steer);
    await vi.waitFor(() => expect(query.received).toHaveLength(2));
    const permission = () => query.options.canUseTool!("Write", {}, { requestId: "p", toolUseID: "tool", signal: new AbortController().signal });
    await expect(permission()).resolves.toMatchObject({ behavior: "deny" });
    expect(h.events.some((event) => event.type === "session.permission")).toBe(false);
    query.output.push(lifecycle(query.received[1].uuid!, "started"));
    query.output.push({ type: "assistant", uuid: "lifecycle-read", parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "Steer started" }] } } as unknown as SDKMessage);
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "timeline.item" && event.item.id === "lifecycle-read")).toBe(true));
    const pending = permission();
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.permission")).toBe(true));
    await h.send({ type: "session.permission", sessionId: "s", permissionId: "p", response: { behavior: "deny", message: "test" } });
    await pending;
  });

  it("uses a fresh input after a crash and resumes the init identity", async () => {
    const h = await harness({}, {}, {}, false);
    await h.send(message("original"));
    const query = h.runs[0];
    await query.input.next();
    query.output.push(init());
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.persistence")).toBe(true));
    await h.send(message("stale queued steer", "old", "steer"));
    query.output.end();
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.runtime_failed")).toBe(true));
    await h.send(message("fresh prompt"));
    const next = h.runs[1];
    expect(next.options.resume).toBe("real-session");
    expect((await next.input.next()).value.message.content).toEqual([{ type: "text", text: "fresh prompt" }]);
    expect((await query.input.next()).done).toBe(true);
  });

  it("gives a replacement query a new, un-aborted controller", async () => {
    const h = await harness();
    const query = await h.start();
    const controller = query.options.abortController!;
    controller.abort();
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.runtime_failed")).toBe(true));
    await h.send(message("after abort"));
    const replacement = h.runs[1];
    expect(replacement.options.abortController).not.toBe(controller);
    expect(replacement.options.abortController?.signal.aborted).toBe(false);
    await vi.waitFor(() => expect(replacement.received).toHaveLength(1));
  });

  it("adopts runtime modes from init and later status", async () => {
    const h = await harness();
    const query = await h.start();
    query.output.push(init("plan"));
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({ config: { mode: "plan", model: "claude-sonnet-5" } }));
    query.output.push({ type: "system", subtype: "status", status: null, permissionMode: "default" } as SDKMessage);
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === "session.config").at(-1)).not.toHaveProperty("config.mode"));
    expect(query.options.forwardSubagentText).toBe(true);
    expect(query.options.perTaskStopAffordance).toBe(true);
  });

  it("does not interrupt background-only work and accepts the next genuine wake-up", async () => {
    const h = await harness();
    const query = await h.start();
    query.output.push(success());
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.turn" && event.state === "completed")).toBe(true));
    await h.stop();
    expect(query.interrupt).not.toHaveBeenCalled();
    query.output.push(init());
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === "session.turn" && event.state === "started")).toHaveLength(2));
  });

  it("rejects already-aborted permissions and cleans listeners after a normal response", async () => {
    const h = await harness();
    const query = await h.start();
    const expired = new AbortController();
    expired.abort();
    await expect(query.options.canUseTool!("Write", {}, { requestId: "expired", toolUseID: "expired", signal: expired.signal }))
      .resolves.toMatchObject({ behavior: "deny" });
    expect(h.events.some((event) => event.type === "session.permission")).toBe(false);
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const pending = query.options.canUseTool!("Write", {}, { requestId: "normal", toolUseID: "normal", signal: abort.signal });
    await h.send({ type: "session.permission", sessionId: "s", permissionId: "normal", response: { behavior: "allow" } });
    await pending;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not create a question permission after Stop during display preparation", async () => {
    const waiting = deferred<void>();
    const release = deferred<void>();
    let block = false;
    const values = translateSettings.schema.parse({ translatePrompts: false, translateResponses: false });
    const h = await harness({}, { loadConfig: async () => {
      if (block) { waiting.resolve(); await release.promise; }
      return values;
    } });
    const query = await h.start();
    block = true;
    const signal = new AbortController().signal;
    const permission = query.options.canUseTool!("AskUserQuestion", { questions: [{ header: "Choice", question: "Which?", options: [] }] }, {
      requestId: "prepared-question", toolUseID: "question-tool", signal,
    });
    await waiting.promise;
    await h.stop();
    expect(signal.aborted).toBe(false);
    release.resolve();
    await expect(permission).resolves.toMatchObject({ behavior: "deny" });
    expect(h.events.some((event) => event.type === "session.permission" && event.request.id === "prepared-question")).toBe(false);
  });

  it.each([true, false])("keeps a preparing question superseded after the human steer starts (question first=%s)", async (questionFirst) => {
    const waiting = deferred<void>();
    const release = deferred<void>();
    let block = false;
    const values = translateSettings.schema.parse({ translatePrompts: false, translateResponses: false });
    const h = await harness({}, { loadConfig: async () => {
      if (block) { waiting.resolve(); await release.promise; }
      return values;
    } });
    const query = await h.start();
    const ask = () => query.options.canUseTool!("AskUserQuestion", { questions: [{ header: "Choice", question: "Which?", options: [] }] }, {
      requestId: "superseded-question", toolUseID: "question-tool", signal: new AbortController().signal,
    });
    let permission: ReturnType<typeof ask>;
    if (questionFirst) {
      block = true;
      permission = ask();
      await waiting.promise;
      block = false;
    }
    const steer = message("new direction", "clear-question", "steer");
    steer.prompt.clearPendingPermissions = true;
    await h.send(steer);
    await vi.waitFor(() => expect(query.received).toHaveLength(2));
    if (!questionFirst) {
      block = true;
      permission = ask();
    }
    query.output.push(lifecycle(query.received[1].uuid!, "started"));
    query.output.push({ type: "assistant", uuid: "clear-question-read", parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "New direction started" }] } } as unknown as SDKMessage);
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "timeline.item" && event.item.id === "clear-question-read")).toBe(true));
    release.resolve();
    await expect(permission!).resolves.toMatchObject({ behavior: "deny" });
    expect(h.events.some((event) => event.type === "session.permission" && event.request.id === "superseded-question")).toBe(false);
  });

  it("does not cancel a newer foreground child when an older interrupt response arrives", async () => {
    const h = await harness();
    const query = await h.start();
    const release = deferred<undefined>();
    query.interrupt.mockImplementationOnce(() => release.promise);
    const stopping = h.stop();
    await vi.waitFor(() => expect(query.interrupt).toHaveBeenCalledTimes(1));
    query.output.push(success());
    await h.send(message("new turn"));
    query.output.push(init());
    query.output.push({ type: "system", subtype: "task_started", task_id: "new-task", tool_use_id: "child-new",
      task_type: "local_agent", subagent_type: "Explore", is_backgrounded: false } as unknown as SDKMessage);
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.opened" && event.sessionId === "subagent:s:child-new")).toBe(true));
    release.resolve(undefined);
    await stopping;
    expect(h.events.filter((event) => event.type === "session.turn" && event.sessionId === "subagent:s:child-new" && event.state !== "started")).toEqual([]);
  });

  it("does not approve a plan canceled while its permission mode changes", async () => {
    const h = await harness();
    const query = await h.start();
    const permission = query.options.canUseTool!("ExitPlanMode", { plan: "Proceed" }, {
      requestId: "plan", toolUseID: "plan-tool", signal: new AbortController().signal,
    });
    const release = deferred<undefined>();
    query.setPermissionMode.mockImplementationOnce(() => release.promise);
    const response = h.send({ type: "session.permission", sessionId: "s", permissionId: "plan", response: { behavior: "allow" } });
    await vi.waitFor(() => expect(query.setPermissionMode).toHaveBeenCalledTimes(1));
    await h.stop();
    await expect(permission).resolves.toMatchObject({ behavior: "deny" });
    release.resolve(undefined);
    await response;
    expect(h.events.filter((event) => event.type === "session.permission_resolved" && event.permissionId === "plan")).toHaveLength(1);
  });

  it("settles root tool cards when the runtime dies", async () => {
    const h = await harness();
    const query = await h.start();
    query.output.push({ type: "assistant", uuid: randomUUID(), parent_tool_use_id: null, session_id: "real-session",
      message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "long job" } }] } } as unknown as SDKMessage);
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "timeline.item" && event.item.id === "bash")).toBe(true));
    query.output.end();
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === "timeline.item" && event.item.id === "bash").at(-1)).toMatchObject({ item: { status: "failed" } }));
  });

  it("sends slash commands after attachments and preserves Max effort", async () => {
    const h = await harness({}, {}, { thinkingOption: "max" });
    const prompt = message("/review this");
    if (prompt.prompt.input.type !== "message") throw new Error("message expected");
    prompt.prompt.input.content.push({ type: "image", mimeType: "image/png", data: "aGVsbG8=" });
    await h.send(prompt);
    const query = h.runs[0];
    await vi.waitFor(() => expect(query.received).toHaveLength(1));
    const content = query.received[0].message.content;
    expect(content).toEqual([expect.objectContaining({ type: "image" }), { type: "text", text: "/review this" }]);
    expect(query.options.effort).toBe("max");
  });

  it("rebuilds constructor-level thinking on the next turn", async () => {
    const h = await harness({}, {}, { thinkingOption: "off", model: "claude-sonnet-5" });
    const query = await h.start();
    query.output.push(success());
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "session.turn" && event.state === "completed")).toBe(true));
    await h.send({ type: "session.configure", sessionId: "s", requestId: "thinking", changes: { thinkingOption: "max" } });
    expect(query.options.thinking).toEqual({ type: "disabled" });
    await h.send(message("next"));
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1].options.effort).toBe("max");
    expect(h.runs[1].options.thinking).toEqual({ type: "adaptive" });
  });
});
