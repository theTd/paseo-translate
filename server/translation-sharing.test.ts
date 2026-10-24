import { describe, expect, it } from "vitest";
import {
  translateSettings,
  unwrapTranslationInput,
  type TranslateSettingsValues,
} from "../shared/translate";
import { createTranslateStreamManager, createTranslator, type TranslatorDeps } from "./translate";
import { createMemoryTranslationCacheStore } from "./translation-cache-store";
import { createTranslationInflightRegistry } from "./translation-inflight";

/**
 * Cross-path sharing of one endpoint request per text: the fail-closed
 * prompt path, display stream jobs (several clients), and cancellation of
 * superseded jobs.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HeldCall {
  source: string;
  stream: boolean;
  signal: AbortSignal | undefined;
}

const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;

/** Endpoint whose answers are held until `gate` resolves; honors aborts. */
function heldFetch(calls: HeldCall[], gate: Promise<void>, map: (text: string) => string): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      stream?: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    const source = unwrapTranslationInput(
      body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "",
    );
    const signal = (init?.signal ?? undefined) as AbortSignal | undefined;
    calls.push({ source, stream: body.stream === true, signal });
    const aborted = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
    if (body.stream !== true) {
      await Promise.race([gate, aborted]);
      return new Response(JSON.stringify({ choices: [{ message: { content: map(source) } }] }));
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await Promise.race([gate, aborted]);
        } catch (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(encoder.encode(sse(map(source))));
        controller.close();
      },
    });
    return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

function settingsValues(overrides: Partial<TranslateSettingsValues> = {}): TranslateSettingsValues {
  return {
    ...translateSettings.schema.parse({
      endpointBaseUrl: "https://llm.example/v1",
      endpointModel: "mt",
      endpointProtocol: "chat-completions",
      userLanguage: "de",
      agentLanguage: "en",
    }),
    ...overrides,
  };
}

function sharedDeps(fetchFn: typeof fetch, values = settingsValues()): TranslatorDeps {
  return {
    loadConfig: async () => values,
    fetchFn,
    cacheStore: createMemoryTranslationCacheStore(),
    inflight: createTranslationInflightRegistry(),
  };
}

type StreamManager = ReturnType<typeof createTranslateStreamManager>;

async function pollUntilDone(manager: StreamManager, jobId: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await manager.poll({ jobId });
    if (result.done) return result.text;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("translation job did not finish");
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

describe("one endpoint request per text across paths", () => {
  it("shows the user exactly the prompt translation the agent received, billed once", async () => {
    const calls: HeldCall[] = [];
    const gate = deferred();
    let answers = 0;
    // Every endpoint answer differs, as real LLM outputs may: a second
    // request would show the user a different translation than the agent got.
    const deps = sharedDeps(heldFetch(calls, gate.promise, (text) => `EN#${(answers += 1)}:${text}`));
    const translator = createTranslator(deps);
    const manager = createTranslateStreamManager(deps, { coalesceDelayMs: 0 });
    const text = "Bitte repariere die Tests";
    // Send: the fail-closed prompt translation and the user-row display job
    // start together, before either has a cached result.
    const prompt = translator.translate(text, "user-to-agent", { contextKey: "agent-1" });
    const { jobId } = await manager.start({ text, direction: "user-to-agent", sessionKey: "agent-1" });
    await until(() => calls.length >= 1);
    gate.resolve();
    const received = await prompt;
    expect(received).toBe(`EN#1:${text}`);
    await expect(pollUntilDone(manager, jobId)).resolves.toBe(received);
    expect(calls).toHaveLength(1);
    manager.dispose();
  });

  it("lets a second client's display job join the first one's request", async () => {
    const calls: HeldCall[] = [];
    const gate = deferred();
    const deps = sharedDeps(heldFetch(calls, gate.promise, (text) => `DE:${text}`));
    const manager = createTranslateStreamManager(deps, { coalesceDelayMs: 0 });
    const desktop = await manager.start({ text: "Fixed it.", direction: "agent-to-user", sessionKey: "a" });
    await until(() => calls.length === 1);
    const phone = await manager.start({ text: "Fixed it.", direction: "agent-to-user", sessionKey: "a" });
    gate.resolve();
    await expect(pollUntilDone(manager, desktop.jobId)).resolves.toBe("DE:Fixed it.");
    await expect(pollUntilDone(manager, phone.jobId)).resolves.toBe("DE:Fixed it.");
    expect(calls).toHaveLength(1);
    manager.dispose();
  });
});

describe("superseded display jobs", () => {
  it("aborts the endpoint request of a canceled job nobody else waits for", async () => {
    const calls: HeldCall[] = [];
    const gate = deferred();
    const deps = sharedDeps(heldFetch(calls, gate.promise, (text) => `DE:${text}`));
    const manager = createTranslateStreamManager(deps, { coalesceDelayMs: 0 });
    const stale = await manager.start({ text: "The fix is in", direction: "agent-to-user", sessionKey: "a" });
    await until(() => calls.length === 1);
    expect(manager.cancel({ jobId: stale.jobId })).toEqual({ canceled: true });
    await until(() => calls[0]?.signal?.aborted === true);
    // A canceled stream never falls back to a second, non-streaming request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    // The grown text starts its own request; the canceled job is gone.
    const current = await manager.start({
      text: "The fix is in src/app.ts.",
      direction: "agent-to-user",
      sessionKey: "a",
    });
    gate.resolve();
    await expect(pollUntilDone(manager, current.jobId)).resolves.toBe("DE:The fix is in src/app.ts.");
    await expect(manager.poll({ jobId: stale.jobId })).rejects.toThrow("Unknown translation job");
    expect(calls).toHaveLength(2);
    manager.dispose();
  });

  it("keeps the request running while another job still waits for it", async () => {
    const calls: HeldCall[] = [];
    const gate = deferred();
    const deps = sharedDeps(heldFetch(calls, gate.promise, (text) => `DE:${text}`));
    const manager = createTranslateStreamManager(deps, { coalesceDelayMs: 0 });
    const first = await manager.start({ text: "Done.", direction: "agent-to-user", sessionKey: "a" });
    await until(() => calls.length === 1);
    const second = await manager.start({ text: "Done.", direction: "agent-to-user", sessionKey: "a" });
    // Let the second job leave its coalesce window and join the request.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.cancel({ jobId: first.jobId })).toEqual({ canceled: true });
    gate.resolve();
    await expect(pollUntilDone(manager, second.jobId)).resolves.toBe("DE:Done.");
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(calls).toHaveLength(1);
    manager.dispose();
  });

  it("aborts a coalesced pack request only once every item was canceled", async () => {
    const calls: HeldCall[] = [];
    const gate = deferred();
    const deps = sharedDeps(heldFetch(calls, gate.promise, (text) => text));
    const manager = createTranslateStreamManager(deps, { coalesceDelayMs: 20 });
    const first = await manager.start({ text: "First row.", direction: "agent-to-user", sessionKey: "a" });
    const second = await manager.start({ text: "Second row.", direction: "agent-to-user", sessionKey: "a" });
    await until(() => calls.length === 1);
    expect(manager.cancel({ jobId: first.jobId })).toEqual({ canceled: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second item still wants its translation.
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(manager.cancel({ jobId: second.jobId })).toEqual({ canceled: true });
    await until(() => calls[0]?.signal?.aborted === true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No per-item fallback or plain-completion retry after the abort.
    expect(calls).toHaveLength(1);
    gate.resolve();
    manager.dispose();
  });

  it("drops a job canceled inside the coalesce window before any request", async () => {
    const calls: HeldCall[] = [];
    const gate = deferred();
    const deps = sharedDeps(heldFetch(calls, gate.promise, (text) => text));
    const manager = createTranslateStreamManager(deps, { coalesceDelayMs: 30 });
    const job = await manager.start({ text: "Hel", direction: "agent-to-user", sessionKey: "a" });
    expect(manager.cancel({ jobId: job.jobId })).toEqual({ canceled: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toHaveLength(0);
    expect(manager.cancel({ jobId: job.jobId })).toEqual({ canceled: false });
    gate.resolve();
    manager.dispose();
  });
});

describe("fail-closed prompt path joining a display translation", () => {
  it("keeps its own timeout as the hard bound", async () => {
    const calls: HeldCall[] = [];
    const never = new Promise<void>(() => undefined);
    const deps = sharedDeps(
      heldFetch(calls, never, (text) => text),
      settingsValues({ translationTimeoutMs: 200 }),
    );
    const translator = createTranslator(deps);
    const manager = createTranslateStreamManager(deps, { coalesceDelayMs: 0 });
    await manager.start({ text: "Hallo", direction: "user-to-agent", sessionKey: "a" });
    await until(() => calls.length === 1);
    const startedAt = Date.now();
    await expect(translator.translate("Hallo", "user-to-agent", { contextKey: "a" })).rejects.toThrow(
      "waiting for a running translation",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    manager.dispose();
  });
});
