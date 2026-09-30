import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTranslateHandler,
  createTranslateStreamManager,
  createTranslator,
} from "./translate";
import {
  createMemoryTranslationCacheStore,
  createPersistentTranslationCacheStore,
} from "./translation-cache-store";
import {
  CONTEXT_MEMORY_KEY_PREFIX,
  createTranslationContextManager,
} from "./translation-context";
import {
  resolveLanguagePair,
  translationSystemPrompt,
  unwrapTranslationInput,
  wrapTranslationInput,
  type TranslateSettingsValues,
} from "../shared/translate";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const values: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  endpointProtocol: "chat-completions" as const,
  translationReasoningEffort: "default" as const,
  translationSystemPrompt: "",
  translationDomainContext: "",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: ["agent"],
  innerAgentEnv: {},
  claudeExecutablePath: "",
  codexExecutablePath: "",
  translatePrompts: true,
  translateResponses: true,
  translateReasoning: false,
  translateAllTimelines: false,
  translationContextEnabled: true,
  translationContextIdleMinutes: 30,
  translationContextMaxChars: 100_000,
  translationTimeoutMs: 5_000,
  uiLanguage: "system" as const,
};

interface Captured {
  body: { messages: Array<{ role: string; content: string }> } | null;
}

function translatingFetch(calls: Captured[], map: (text: string) => string): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    calls.push({ body });
    const user = body.messages.find((message) => message.role === "user");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: map(unwrapTranslationInput(user?.content ?? "")) } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("translate service", () => {
  it("sends the language pair in the system prompt", async () => {
    const calls: Captured[] = [];
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(calls, (text) => `DE:${text}`),
    });
    await expect(translator.translate("Hello", "user-to-agent")).resolves.toBe("DE:Hello");
    expect(calls[0].body?.messages[0]).toEqual({
      role: "system",
      content: translationSystemPrompt({ source: "en", target: "de" }),
    });
    // The source text travels wrapped in the input-delimiter tags.
    expect(calls[0].body?.messages[1]).toEqual({
      role: "user",
      content: wrapTranslationInput("Hello"),
    });
  });

  it("appends the domain context to the prompt and invalidates the cache when it changes", async () => {
    const calls: Captured[] = [];
    let current = { ...values, translationDomainContext: "coding assistant chat" };
    const translator = createTranslator({
      loadConfig: async () => current,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
    });
    await translator.translate("Hello", "user-to-agent");
    expect(calls[0].body?.messages[0]?.content).toContain(
      "Domain context: coding assistant chat",
    );
    // Same context: served from cache without a second endpoint call.
    await translator.translate("Hello", "user-to-agent");
    expect(calls).toHaveLength(1);
    // Editing the context changes the effective prompt, so the cache misses.
    current = { ...values, translationDomainContext: "legal documents" };
    await translator.translate("Hello", "user-to-agent");
    expect(calls).toHaveLength(2);
    expect(calls[1].body?.messages[0]?.content).toContain("Domain context: legal documents");
  });

  it("resolves the {context} placeholder in a custom system prompt", async () => {
    const calls: Captured[] = [];
    const translator = createTranslator({
      loadConfig: async () => ({
        ...values,
        translationSystemPrompt: "Custom {source} -> {target} engine for {context}.",
        translationDomainContext: "coding assistant chat",
      }),
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
    });
    await translator.translate("Hello", "user-to-agent");
    expect(calls[0].body?.messages[0]).toEqual({
      role: "system",
      content: "Custom en -> de engine for coding assistant chat.",
    });
  });

  it("reverses the pair for agent-to-user translations", () => {
    expect(resolveLanguagePair(values, "agent-to-user")).toEqual({ source: "de", target: "en" });
    expect(resolveLanguagePair(values, "user-to-agent")).toEqual({ source: "en", target: "de" });
    expect(translationSystemPrompt(resolveLanguagePair(values, "agent-to-user"))).toContain(
      "from de to en",
    );
  });

  it("caches per direction and text", async () => {
    const calls: Captured[] = [];
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
    });
    await translator.translate("Hello", "user-to-agent");
    await translator.translate("Hello", "user-to-agent");
    await translator.translate("Hello", "agent-to-user");
    expect(calls).toHaveLength(2);
  });

  it("keeps only the most recently used entries", async () => {
    const calls: Captured[] = [];
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
      cacheStore: createMemoryTranslationCacheStore({ maxEntries: 1 }),
    });
    await translator.translate("a", "user-to-agent");
    await translator.translate("b", "user-to-agent");
    await translator.translate("a", "user-to-agent");
    expect(calls).toHaveLength(3);
  });

  it("serves translations from the persistent cache across translator instances", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "translate-store-"));
    tempRoots.push(directory);
    const firstCalls: Captured[] = [];
    const first = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(firstCalls, (text) => `T:${text}`),
      cacheStore: createPersistentTranslationCacheStore({ directory }),
    });
    await expect(first.translate("Hello", "user-to-agent")).resolves.toBe("T:Hello");
    expect(firstCalls).toHaveLength(1);

    // A fresh translator over the same directory (the reopened-session case)
    // must not bill the endpoint again.
    const secondCalls: Captured[] = [];
    const second = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(secondCalls, (text) => `T:${text}`),
      cacheStore: createPersistentTranslationCacheStore({ directory }),
    });
    await expect(second.translate("Hello", "user-to-agent")).resolves.toBe("T:Hello");
    expect(secondCalls).toHaveLength(0);
  });

  it("sends a custom system prompt and invalidates the cache when it changes", async () => {
    const calls: Captured[] = [];
    let current = { ...values, translationSystemPrompt: "Custom {source} -> {target} engine." };
    const translator = createTranslator({
      loadConfig: async () => current,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
    });
    await translator.translate("Hello", "user-to-agent");
    expect(calls[0].body?.messages[0]).toEqual({
      role: "system",
      content: "Custom en -> de engine.",
    });
    // Same prompt: served from cache without a second endpoint call.
    await translator.translate("Hello", "user-to-agent");
    expect(calls).toHaveLength(1);
    // Editing the prompt changes the output, so the cache must miss.
    current = { ...values, translationSystemPrompt: "Rewritten {source} -> {target} engine." };
    await translator.translate("Hello", "user-to-agent");
    expect(calls).toHaveLength(2);
    expect(calls[1].body?.messages[0]?.content).toBe("Rewritten en -> de engine.");
  });

  it("retranslates after the language pair, model, or endpoint changes", async () => {
    const calls: Captured[] = [];
    let current = values;
    const translator = createTranslator({
      loadConfig: async () => current,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
    });
    await translator.translate("Hello", "user-to-agent");
    current = { ...values, agentLanguage: "fr" };
    await translator.translate("Hello", "user-to-agent");
    current = { ...values, endpointModel: "mt-v2" };
    await translator.translate("Hello", "user-to-agent");
    current = { ...values, translationReasoningEffort: "high" };
    await translator.translate("Hello", "user-to-agent");
    // Switching providers with the same model name must not reuse the other
    // endpoint's translations.
    current = { ...values, endpointBaseUrl: "https://other.example/v1" };
    await translator.translate("Hello", "user-to-agent");
    expect(calls).toHaveLength(5);
    expect(calls[1].body?.messages[0]?.content).toContain("from en to fr");
    expect(calls[2].body?.messages[0]?.content).toContain("from en to de");
  });

  it("retranslates after the endpoint protocol changes", async () => {
    const calls: Array<{ responses: boolean }> = [];
    let current = values;
    const translator = createTranslator({
      loadConfig: async () => current,
      // Serves whichever shape the request's protocol implies.
      fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input?: unknown };
        const isResponses = Array.isArray(body.input);
        calls.push({ responses: isResponses });
        const payload = isResponses
          ? { output: [{ type: "message", content: [{ type: "output_text", text: "T:Hello" }] }] }
          : { choices: [{ message: { content: "T:Hello" } }] };
        return new Response(JSON.stringify(payload), { status: 200 });
      }) as typeof fetch,
    });
    await expect(translator.translate("Hello", "user-to-agent")).resolves.toBe("T:Hello");
    current = { ...values, endpointProtocol: "responses" };
    // The protocol feeds the cache key: no stale chat-protocol hit.
    await expect(translator.translate("Hello", "user-to-agent")).resolves.toBe("T:Hello");
    expect(calls).toEqual([{ responses: false }, { responses: true }]);
  });

  it("passes blank fragments through without calling the endpoint", async () => {
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], () => ""),
    });
    await expect(translator.translate("   ", "user-to-agent")).resolves.toBe("   ");
  });

  it("refuses oversized fragments", async () => {
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], () => ""),
    });
    await expect(translator.translate("x".repeat(100_001), "user-to-agent")).rejects.toThrow(
      /Refusing to translate/,
    );
  });

  it("returns the original text when response translation is disabled", async () => {
    const handler = createTranslateHandler({
      loadConfig: async () => ({ ...values, translateResponses: false }),
      fetchFn: translatingFetch([], () => ""),
    });
    await expect(handler({ text: "Guten Tag", direction: "agent-to-user" })).resolves.toEqual({
      text: "Guten Tag",
    });
  });
});

function sseData(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** Serves SSE for stream:true and JSON otherwise; streamMode flips behavior. */
function streamingFetch(
  calls: Array<{ stream: boolean }>,
  map: (text: string) => string,
  streamMode: "ok" | "refuse" | "fail" = "ok",
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      stream?: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    calls.push({ stream: body.stream === true });
    const user = body.messages.find((message) => message.role === "user");
    const text = map(unwrapTranslationInput(user?.content ?? ""));
    if (body.stream === true) {
      if (streamMode === "refuse") {
        return new Response("stream unsupported", { status: 400 });
      }
      if (streamMode === "fail") throw new Error("boom");
      const half = Math.ceil(text.length / 2);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseData(text.slice(0, half))));
          controller.enqueue(encoder.encode(sseData(text.slice(half)) + "data: [DONE]\n\n"));
          controller.close();
        },
      });
      // Type-only cast; see sseResponse in llm-client.test.ts.
      return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

async function waitForPoll(
  manager: ReturnType<typeof createTranslateStreamManager>,
  jobId: string,
  done: boolean,
): Promise<{ text: string; done: boolean }> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const result = await manager.poll({ jobId });
    if (result.done === done) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting for poll state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("streaming translation jobs", () => {
  it("translates the unary path with one bounded plain completion, no stream attempt", async () => {
    const calls: Array<{ stream: boolean }> = [];
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: streamingFetch(calls, (text) => `DE:${text}`),
    });
    // Nobody consumes deltas on the fail-closed path: a stream attempt would
    // only double the worst case past translationTimeoutMs on a refusal.
    await expect(translator.translate("Hello", "user-to-agent")).resolves.toBe("DE:Hello");
    expect(calls).toEqual([{ stream: false }]);
  });

  it("streams partial text before completing", async () => {
    const calls: Array<{ stream: boolean }> = [];
    const manager = createTranslateStreamManager({
      loadConfig: async () => values,
      fetchFn: streamingFetch(calls, (text) => `DE:${text}`),
    });
    const { jobId } = await manager.start({ text: "Hello", direction: "agent-to-user" });
    const final = await waitForPoll(manager, jobId, true);
    expect(final.text).toBe("DE:Hello");
    expect(calls).toEqual([{ stream: true }]);
    // A completed job is single-shot: the terminal poll consumes it.
    await expect(manager.poll({ jobId })).rejects.toThrow(/Unknown translation job/);
  });

  it("serves cache hits without touching the endpoint", async () => {
    const calls: Array<{ stream: boolean }> = [];
    const cacheStore = createMemoryTranslationCacheStore();
    const deps = {
      loadConfig: async () => values,
      fetchFn: streamingFetch(calls, (text) => `DE:${text}`),
      cacheStore,
    };
    const first = createTranslateStreamManager(deps);
    const started = await first.start({ text: "Hello", direction: "agent-to-user" });
    await waitForPoll(first, started.jobId, true);
    expect(calls).toEqual([{ stream: true }]);
    // A second manager over the same store serves the warmed entry: the
    // first poll already carries the full text.
    const second = createTranslateStreamManager(deps);
    const retry = await second.start({ text: "Hello", direction: "agent-to-user" });
    await expect(waitForPoll(second, retry.jobId, true)).resolves.toEqual({
      text: "DE:Hello",
      done: true,
    });
    expect(calls).toEqual([{ stream: true }]);
  });

  it("falls back to a plain completion when the stream is refused", async () => {
    const calls: Array<{ stream: boolean }> = [];
    const manager = createTranslateStreamManager({
      loadConfig: async () => values,
      fetchFn: streamingFetch(calls, (text) => `DE:${text}`, "refuse"),
    });
    const { jobId } = await manager.start({ text: "Hello", direction: "agent-to-user" });
    const final = await waitForPoll(manager, jobId, true);
    expect(final.text).toBe("DE:Hello");
    expect(calls).toEqual([{ stream: true }, { stream: false }]);
  });

  it("surfaces endpoint errors through poll", async () => {
    const manager = createTranslateStreamManager({
      loadConfig: async () => values,
      fetchFn: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    const { jobId } = await manager.start({ text: "Hello", direction: "agent-to-user" });
    await expect(waitForPoll(manager, jobId, true)).rejects.toThrow(/down/);
  });

  it("rejects unknown jobs and oversized text", async () => {
    const manager = createTranslateStreamManager({
      loadConfig: async () => values,
      fetchFn: streamingFetch([], (text) => text),
    });
    await expect(manager.poll({ jobId: "nope" })).rejects.toThrow(/Unknown translation job/);
    await expect(
      manager.start({ text: "x".repeat(100_001), direction: "agent-to-user" }),
    ).rejects.toThrow(/Refusing to translate/);
  });

  it("returns the original text when response translation is disabled", async () => {
    const manager = createTranslateStreamManager({
      loadConfig: async () => ({ ...values, translateResponses: false }),
      fetchFn: streamingFetch([], () => ""),
    });
    const { jobId } = await manager.start({ text: "Guten Tag", direction: "agent-to-user" });
    await expect(manager.poll({ jobId })).resolves.toEqual({ text: "Guten Tag", done: true });
  });
});

describe("user original restoration", () => {
  it("records the reverse entry on a fresh translation and restores it", async () => {
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], (text) => `T:${text}`),
    });
    await expect(translator.translate("Hello", "user-to-agent")).resolves.toBe("T:Hello");
    expect(translator.restoreOriginalFragment("T:Hello")).toBe("Hello");
  });

  it("records the reverse entry on the cache-hit path and matches trimmed lookups", async () => {
    const cacheStore = createMemoryTranslationCacheStore();
    const first = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], (text) => `T:${text}`),
      cacheStore,
    });
    await first.translate("  Hello  ", "user-to-agent");
    // A second translator over the same store takes the cache-hit path: it
    // must not bill the endpoint and must still restore the original.
    const second = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], () => {
        throw new Error("must not bill the endpoint on a cache hit");
      }),
      cacheStore,
    });
    await expect(second.translate("  Hello  ", "user-to-agent")).resolves.toBe("T:  Hello  ");
    expect(second.restoreOriginalFragment("T:  Hello  ")).toBe("  Hello  ");
    // Replayed transcript blocks are trimmed on read; the lookup tolerates it.
    expect(second.restoreOriginalFragment("   T:  Hello   ")).toBe("  Hello  ");
  });

  it("ignores agent-to-user translations and misses", async () => {
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], (text) => `T:${text}`),
    });
    await translator.translate("Hallo", "agent-to-user");
    expect(translator.restoreOriginalFragment("T:Hallo")).toBeUndefined();
    expect(translator.restoreOriginalFragment("never seen")).toBeUndefined();
    expect(translator.restoreOriginalFragment("   ")).toBeUndefined();
  });

  it("persists reverse entries across instances (the reopened-session case)", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "translate-reverse-"));
    tempRoots.push(directory);
    const first = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], (text) => `T:${text}`),
      cacheStore: createPersistentTranslationCacheStore({ directory }),
    });
    await first.translate("Hello", "user-to-agent");
    const second = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], () => {
        throw new Error("must not bill the endpoint after a restart");
      }),
      cacheStore: createPersistentTranslationCacheStore({ directory }),
    });
    expect(second.restoreOriginalFragment("T:Hello")).toBe("Hello");
  });
});

/** Maps over the LAST user message, so transcript turns don't confuse it. */
function contextFetch(calls: Captured[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    calls.push({ body });
    const lastUser = body.messages.filter((message) => message.role === "user").at(-1);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `T:${unwrapTranslationInput(lastUser?.content ?? "")}` } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("session translation context", () => {
  it("conditions later translations on the session's prior turns", async () => {
    const calls: Captured[] = [];
    const context = createTranslationContextManager({
      loadConfig: async () => values,
      sweepIntervalMs: 0,
    });
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: contextFetch(calls),
      context,
    });
    await expect(
      translator.translate("Hello", "user-to-agent", { contextKey: "s" }),
    ).resolves.toBe("T:Hello");
    await expect(
      translator.translate("World", "user-to-agent", { contextKey: "s" }),
    ).resolves.toBe("T:World");
    expect(calls).toHaveLength(2);
    // The second request carries the committed first exchange, wrapped source
    // and all, between the system prompt and the new input.
    expect(calls[1].body?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(calls[1].body?.messages[1]?.content).toBe(wrapTranslationInput("Hello"));
    expect(calls[1].body?.messages[2]?.content).toBe("T:Hello");
    expect(calls[1].body?.messages[3]?.content).toBe(wrapTranslationInput("World"));
    // Another session stays standalone.
    await translator.translate("Hola", "user-to-agent", { contextKey: "other" });
    expect(calls[2].body?.messages).toHaveLength(2);
  });

  it("serves cache hits without re-recording them into the transcript", async () => {
    const calls: Captured[] = [];
    const context = createTranslationContextManager({
      loadConfig: async () => values,
      sweepIntervalMs: 0,
    });
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: contextFetch(calls),
      context,
    });
    await translator.translate("Hello", "user-to-agent", { contextKey: "s" });
    // Cache hit: no endpoint call, and no duplicate transcript entry.
    await translator.translate("Hello", "user-to-agent", { contextKey: "s" });
    expect(calls).toHaveLength(1);
    expect(context.snapshot("s", "user-to-agent", { hardCapChars: 100_000 }).turns).toHaveLength(1);
  });

  it("folds the compacted memory into both the system prompt and the cache key", async () => {
    const calls: Captured[] = [];
    const memoryStore = createMemoryTranslationCacheStore();
    memoryStore.set(`${CONTEXT_MEMORY_KEY_PREFIX}s-mem`, "cloud = Wolke");
    const context = createTranslationContextManager({
      loadConfig: async () => values,
      memoryStore,
      sweepIntervalMs: 0,
    });
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: contextFetch(calls),
      context,
    });
    await translator.translate("Hello", "user-to-agent", { contextKey: "s-mem" });
    expect(calls[0].body?.messages[0]?.content).toContain("cloud = Wolke");
    // Same session, same memory: served from cache.
    await translator.translate("Hello", "user-to-agent", { contextKey: "s-mem" });
    expect(calls).toHaveLength(1);
    // A session with a different (empty) memory must not inherit the
    // memory-conditioned result: it gets its own cache namespace.
    await translator.translate("Hello", "user-to-agent", { contextKey: "fresh" });
    expect(calls).toHaveLength(2);
    // Standalone translations live in a third namespace.
    await translator.translate("Hello", "user-to-agent");
    expect(calls).toHaveLength(3);
  });

  it("stays standalone when the setting is off or no context key is passed", async () => {
    const calls: Captured[] = [];
    const context = createTranslationContextManager({
      loadConfig: async () => values,
      sweepIntervalMs: 0,
    });
    const disabled = createTranslator({
      loadConfig: async () => ({ ...values, translationContextEnabled: false }),
      fetchFn: contextFetch(calls),
      context,
    });
    await disabled.translate("Hello", "user-to-agent", { contextKey: "s" });
    expect(calls[0].body?.messages).toHaveLength(2);
    expect(context.snapshot("s", "user-to-agent", { hardCapChars: 100_000 }).turns).toHaveLength(0);

    const noKey = createTranslator({
      loadConfig: async () => values,
      fetchFn: contextFetch(calls),
      context,
    });
    await noKey.translate("World", "user-to-agent");
    expect(calls[1].body?.messages).toHaveLength(2);
  });
});
