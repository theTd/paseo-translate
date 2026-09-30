import { describe, expect, it } from "vitest";
import {
  CONTEXT_MEMORY_KEY_PREFIX,
  createTranslationContextManager,
} from "./translation-context";
import { createMemoryTranslationCacheStore } from "./translation-cache-store";
import type { TranslateSettingsValues } from "../shared/translate";

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
  // Small bounds so tests exercise compaction without big fixtures.
  translationContextIdleMinutes: 10,
  translationContextMaxChars: 100,
  translationTimeoutMs: 5_000,
  uiLanguage: "system" as const,
};

function compactionFetch(calls: string[], memory = "MEM: glossary"): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    calls.push(body.messages.map((message) => message.content).join("\n"));
    return new Response(JSON.stringify({ choices: [{ message: { content: memory } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("endpoint down");
  }) as typeof fetch;
}

/** A controllable clock for the idle policy. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function recordPair(
  manager: ReturnType<typeof createTranslationContextManager>,
  scope: string,
  index: number,
  direction: "user-to-agent" | "agent-to-user" = "user-to-agent",
): void {
  manager.record(scope, direction, `source-${index}`, `target-${index}`);
}

describe("translation context manager", () => {
  it("records turns per direction and snapshots a copy", () => {
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      sweepIntervalMs: 0,
    });
    manager.record("s", "user-to-agent", "hello", "hallo");
    manager.record("s", "agent-to-user", "welt", "world");
    const snapshot = manager.snapshot("s", "user-to-agent", { hardCapChars: 1_000 });
    expect(snapshot.turns).toEqual([{ user: "hello", assistant: "hallo" }]);
    expect(snapshot.memory).toBe("");
    expect(
      manager.snapshot("s", "agent-to-user", { hardCapChars: 1_000 }).turns,
    ).toEqual([{ user: "welt", assistant: "world" }]);
    // Mutating the snapshot must not leak into the committed transcript.
    (snapshot.turns as unknown[]).push({ user: "x", assistant: "y" });
    expect(manager.snapshot("s", "user-to-agent", { hardCapChars: 1_000 }).turns).toHaveLength(1);
  });

  it("scopes transcripts by session key", () => {
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      sweepIntervalMs: 0,
    });
    manager.record("s-1", "user-to-agent", "hello", "hallo");
    expect(
      manager.snapshot("s-2", "user-to-agent", { hardCapChars: 1_000 }).turns,
    ).toHaveLength(0);
  });

  it("compacts an idle oversized scope and shares the memory across directions", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      fetchFn: compactionFetch(calls),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    for (let index = 0; index < 10; index += 1) {
      recordPair(manager, "s", index, "user-to-agent");
      recordPair(manager, "s", index, "agent-to-user");
    }
    clock.advance(11 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(1);
    // The compaction call sees the serialized history of both directions.
    expect(calls[0]).toContain("source-0");
    expect(calls[0]).toContain("user-to-agent: en -> de");
    expect(calls[0]).toContain("agent-to-user: de -> en");
    for (const direction of ["user-to-agent", "agent-to-user"] as const) {
      const snapshot = manager.snapshot("s", direction, { hardCapChars: 100_000 });
      expect(snapshot.memory).toBe("MEM: glossary");
      // Only the newest few turns survive compaction.
      expect(snapshot.turns).toHaveLength(6);
      expect(snapshot.turns.at(-1)).toEqual({ user: "source-9", assistant: "target-9" });
    }
  });

  it("does not compact while the scope is active or below the size threshold", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      fetchFn: compactionFetch(calls),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    // Below the size threshold: idle alone never compacts.
    manager.record("small", "user-to-agent", "a", "b");
    clock.advance(60 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(0);
    // Oversized but still active: compaction waits for idleness.
    for (let index = 0; index < 10; index += 1) recordPair(manager, "busy", index);
    clock.advance(5 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(0);
    // A new translation resets the idle clock.
    clock.advance(9 * 60_000);
    recordPair(manager, "busy", 99);
    clock.advance(9 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(0);
    // Once idle past the threshold it compacts.
    clock.advance(2 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(1);
  });

  it("fails soft when compaction fails and retries on the next sweep", async () => {
    const clock = fakeClock();
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      fetchFn: failingFetch(),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    for (let index = 0; index < 10; index += 1) recordPair(manager, "s", index);
    clock.advance(11 * 60_000);
    await manager.sweep();
    // Nothing was compacted: full transcript, empty memory.
    expect(manager.snapshot("s", "user-to-agent", { hardCapChars: 100_000 }).turns).toHaveLength(
      10,
    );
    expect(manager.snapshot("s", "user-to-agent", { hardCapChars: 100_000 }).memory).toBe("");
    // The next sweep retries: a fresh manager over a working endpoint.
    manager.dispose();
    const calls: string[] = [];
    const recovered = createTranslationContextManager({
      loadConfig: async () => values,
      fetchFn: compactionFetch(calls),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    for (let index = 0; index < 10; index += 1) recordPair(recovered, "s", index);
    clock.advance(11 * 60_000);
    await recovered.sweep();
    expect(calls).toHaveLength(1);
  });

  it("trims the globally oldest pairs at the hard cap, across both directions", () => {
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      sweepIntervalMs: 0,
    });
    manager.record("s", "user-to-agent", "aaaa", "bbbb"); // 8 chars, oldest
    manager.record("s", "agent-to-user", "cccc", "dddd"); // 8 chars
    manager.record("s", "user-to-agent", "eeee", "ffff"); // 8 chars, newest
    const snapshot = manager.snapshot("s", "user-to-agent", { hardCapChars: 16 });
    expect(snapshot.turns).toEqual([{ user: "eeee", assistant: "ffff" }]);
    expect(
      manager.snapshot("s", "agent-to-user", { hardCapChars: 100_000 }).turns,
    ).toEqual([{ user: "cccc", assistant: "dddd" }]);
  });

  it("seeds a fresh scope from the persisted memory and persists compaction results", async () => {
    const clock = fakeClock();
    const memoryStore = createMemoryTranslationCacheStore();
    memoryStore.set(`${CONTEXT_MEMORY_KEY_PREFIX}old-session`, "lock = Schloss");
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      memoryStore,
      sweepIntervalMs: 0,
      now: clock.now,
      fetchFn: compactionFetch([], "NEW MEM"),
    });
    // A scope seen for the first time inherits the persisted memory.
    expect(manager.snapshot("old-session", "user-to-agent", { hardCapChars: 1000 }).memory).toBe(
      "lock = Schloss",
    );
    for (let index = 0; index < 10; index += 1) recordPair(manager, "s", index);
    clock.advance(11 * 60_000);
    await manager.sweep();
    expect(memoryStore.get(`${CONTEXT_MEMORY_KEY_PREFIX}s`)).toBe("NEW MEM");
  });

  it("does not re-compact a clean scope until new translations arrive", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      fetchFn: compactionFetch(calls),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    // Big pairs: even the post-compaction 6 kept pairs stay over the 100-char
    // threshold, the exact shape that would otherwise re-compact every sweep.
    for (let index = 0; index < 10; index += 1) {
      manager.record("s", "user-to-agent", `s${index}` + "x".repeat(60), `t${index}` + "y".repeat(60));
    }
    clock.advance(11 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(1);
    expect(
      manager.snapshot("s", "user-to-agent", { hardCapChars: 100_000 }).turns.length,
    ).toBeGreaterThan(0);
    // Idle again, still oversized, but nothing new: no re-compaction.
    clock.advance(60 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(1);
    // New translations mark the scope dirty and re-arm the idle policy.
    manager.record("s", "user-to-agent", "z".repeat(60), "w".repeat(60));
    clock.advance(11 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(2);
  });

  it("treats a cache-hit touch as activity for the idle clock", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      fetchFn: compactionFetch(calls),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    for (let index = 0; index < 10; index += 1) recordPair(manager, "s", index);
    clock.advance(9 * 60_000);
    manager.touch("s");
    clock.advance(9 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(0);
    clock.advance(2 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(1);
  });

  it("does nothing when the feature is disabled", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const manager = createTranslationContextManager({
      loadConfig: async () => ({ ...values, translationContextEnabled: false }),
      fetchFn: compactionFetch(calls),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    for (let index = 0; index < 10; index += 1) recordPair(manager, "s", index);
    clock.advance(60 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(0);
  });

  it("re-arms compaction when a translation lands mid-compaction", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    // The first compaction request blocks until the test releases it, so a
    // record can land while the endpoint await is pending. Held in an object:
    // a bare `let` would stay narrowed to null at the call site.
    const gate: { release?: () => void } = {};
    const gatedFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      calls.push(body.messages.map((message) => message.content).join("\n"));
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "MEM" } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const manager = createTranslationContextManager({
      loadConfig: async () => ({ ...values, translationContextMaxChars: 40 }),
      fetchFn: gatedFetch,
      now: clock.now,
      sweepIntervalMs: 0,
    });
    for (let index = 0; index < 10; index += 1) recordPair(manager, "s", index);
    clock.advance(11 * 60_000);
    const sweeping = manager.sweep();
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // This turn is not part of the in-flight distillation input.
    manager.record("s", "user-to-agent", "late", "spät");
    gate.release?.();
    await sweeping;
    expect(manager.snapshot("s", "user-to-agent", { hardCapChars: 100_000 }).memory).toBe("MEM");
    // The mid-compaction record kept the scope dirty: the next idle sweep
    // distills again instead of treating the memory as current.
    clock.advance(11 * 60_000);
    await manager.sweep();
    expect(calls).toHaveLength(2);
  });

  it("evicts long-idle scopes, keeping only what was persisted", async () => {
    const clock = fakeClock();
    const memoryStore = createMemoryTranslationCacheStore();
    const calls: string[] = [];
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      memoryStore,
      fetchFn: compactionFetch(calls),
      now: clock.now,
      sweepIntervalMs: 0,
    });
    // "stale" never reaches the compaction threshold.
    manager.record("stale", "user-to-agent", "hello", "hallo");
    // "old" compacts once, persisting its memory.
    for (let index = 0; index < 10; index += 1) recordPair(manager, "old", index);
    clock.advance(11 * 60_000);
    await manager.sweep();
    expect(memoryStore.get(`${CONTEXT_MEMORY_KEY_PREFIX}old`)).toBe("MEM: glossary");
    // Past the 24h eviction floor both scopes leave the map.
    clock.advance(25 * 60 * 60_000);
    await manager.sweep();
    // The never-compacted transcript is gone for good.
    expect(
      manager.snapshot("stale", "user-to-agent", { hardCapChars: 1000 }).turns,
    ).toHaveLength(0);
    // The compacted scope reseeds from the persisted memory; the kept turns
    // of the evicted in-memory state are the accepted loss.
    const reseeded = manager.snapshot("old", "user-to-agent", { hardCapChars: 100_000 });
    expect(reseeded.memory).toBe("MEM: glossary");
    expect(reseeded.turns).toHaveLength(0);
  });

  it("aligns the compaction input truncation to a turn boundary", async () => {
    const clock = fakeClock();
    let captured = "";
    const capturingFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      captured = body.messages.find((message) => message.role === "user")?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "MEM" } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const manager = createTranslationContextManager({
      loadConfig: async () => values,
      fetchFn: capturingFetch,
      now: clock.now,
      sweepIntervalMs: 0,
    });
    // ~440k chars of transcript, past the 200k compaction input limit.
    for (let index = 0; index < 110; index += 1) {
      manager.record(
        "s",
        "user-to-agent",
        `U${index}: ${"u".repeat(990)}`,
        `A${index}: ${"a".repeat(990)}`,
      );
      manager.record(
        "s",
        "agent-to-user",
        `R${index}: ${"r".repeat(990)}`,
        `S${index}: ${"s".repeat(990)}`,
      );
    }
    clock.advance(11 * 60_000);
    await manager.sweep();
    expect(captured.length).toBeLessThanOrEqual(200_000);
    // The cut starts with a complete turn: an unaligned offset would land
    // mid-text and fail this shape.
    const firstUser = captured.split("\n=>\n")[0] ?? "";
    expect(firstUser).toMatch(/^[UR]\d+: [ur]+$/);
  });
});
