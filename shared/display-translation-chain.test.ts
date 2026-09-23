import { describe, expect, it, vi } from "vitest";
import {
  hasVisibleTranslation,
  runDisplayTranslationChain,
  type DisplayTranslationCallbacks,
  type DisplayTranslationRpcs,
} from "./display-translation-chain";
import {
  DISPLAY_STREAM_MAX_ATTEMPTS,
  DISPLAY_UNARY_MAX_ATTEMPTS,
  displayStreamIdleTimeoutMs,
} from "./translation-retry";

interface Harness {
  rpcs: DisplayTranslationRpcs & {
    startCalls: number;
    pollCalls: string[];
    unaryCalls: number;
  };
  callbacks: DisplayTranslationCallbacks & {
    partials: string[];
    sleeps: number[];
  };
  setCancelled(value: boolean): void;
  /** Current virtual time. */
  now(): number;
  /** Jumps the virtual clock, like a device waking from sleep. */
  advance(ms: number): void;
}

function createHarness(behavior: {
  start?: (call: number) => Promise<string>;
  poll?: (jobId: string, call: number) => Promise<{ text: string; done: boolean }>;
  unary?: (call: number) => Promise<string>;
}): Harness {
  let nowMs = 0;
  let cancelled = false;
  const partials: string[] = [];
  const sleeps: number[] = [];
  const harness: Harness = {
    rpcs: {
      startCalls: 0,
      pollCalls: [],
      unaryCalls: 0,
      startStream: async () => {
        harness.rpcs.startCalls += 1;
        if (behavior.start) return behavior.start(harness.rpcs.startCalls);
        return `job-${harness.rpcs.startCalls}`;
      },
      pollStream: async (jobId: string) => {
        harness.rpcs.pollCalls.push(jobId);
        if (behavior.poll) return behavior.poll(jobId, harness.rpcs.pollCalls.length);
        return { text: "", done: true };
      },
      translateUnary: async () => {
        harness.rpcs.unaryCalls += 1;
        if (behavior.unary) return behavior.unary(harness.rpcs.unaryCalls);
        return "unary";
      },
    },
    callbacks: {
      partials,
      sleeps,
      onPartial: (text: string) => {
        partials.push(text);
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
        nowMs += ms;
        return true;
      },
      now: () => nowMs,
      isCancelled: () => cancelled,
      random: () => 0,
    },
    setCancelled: (value: boolean) => {
      cancelled = value;
    },
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
  return harness;
}

describe("hasVisibleTranslation", () => {
  it("stays false until the first token arrives", () => {
    expect(hasVisibleTranslation(undefined)).toBe(false);
    expect(hasVisibleTranslation("")).toBe(false);
  });

  it("treats whitespace-only partials as not yet visible", () => {
    expect(hasVisibleTranslation("   ")).toBe(false);
    expect(hasVisibleTranslation(" \n\t ")).toBe(false);
  });

  it("turns true on the first non-blank token", () => {
    expect(hasVisibleTranslation("你好")).toBe(true);
    expect(hasVisibleTranslation("  hello")).toBe(true);
  });
});

describe("runDisplayTranslationChain", () => {
  it("propagates a unary success after exhausted stream attempts (N1 regression)", async () => {
    const harness = createHarness({
      start: async () => {
        throw new Error("boom");
      },
      unary: async () => "UNARY",
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks);
    expect(outcome).toEqual({ status: "translated", text: "UNARY" });
    expect(harness.rpcs.startCalls).toBe(DISPLAY_STREAM_MAX_ATTEMPTS);
    expect(harness.rpcs.unaryCalls).toBe(1);
    expect(harness.callbacks.partials).toEqual(["UNARY"]);
  });

  it("streams partials to done without touching unary", async () => {
    const harness = createHarness({
      poll: async (jobId: string, call: number) => {
        expect(jobId).toBe("job-1");
        if (call === 1) return { text: "a", done: false };
        if (call === 2) return { text: "ab", done: false };
        return { text: "ab", done: true };
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks);
    expect(outcome).toEqual({ status: "translated", text: "ab" });
    expect(harness.rpcs.unaryCalls).toBe(0);
    expect(harness.callbacks.partials).toEqual(["a", "ab", "ab"]);
  });

  it("restarts from a fresh job when a poll rejects with an unknown job", async () => {
    const seen = new Set<string>();
    const harness = createHarness({
      poll: async (jobId: string) => {
        if (!seen.has(jobId)) {
          seen.add(jobId);
          if (jobId === "job-1") throw new Error("Unknown translation job");
        }
        return { text: `via-${jobId}`, done: true };
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks);
    expect(outcome).toEqual({ status: "translated", text: "via-job-2" });
    expect(harness.rpcs.startCalls).toBe(2);
    expect(harness.rpcs.unaryCalls).toBe(0);
  });

  it("fails fast on fatal errors without retrying or falling back", async () => {
    const harness = createHarness({
      start: async () => {
        throw new Error("Refusing to translate 123456 characters (limit 100000)");
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks);
    expect(outcome.status).toBe("failed");
    expect(harness.rpcs.startCalls).toBe(1);
    expect(harness.rpcs.unaryCalls).toBe(0);
    expect(harness.callbacks.sleeps).toEqual([]);
  });

  it("backs busy refusals off longer than default retries", async () => {
    const harness = createHarness({
      start: async () => {
        throw new Error("Translation is busy; try again in a moment");
      },
      unary: async () => {
        throw new Error("Translation is busy; try again in a moment");
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks);
    expect(outcome.status).toBe("failed");
    expect(harness.rpcs.startCalls).toBe(DISPLAY_STREAM_MAX_ATTEMPTS);
    expect(harness.rpcs.unaryCalls).toBe(DISPLAY_UNARY_MAX_ATTEMPTS);
    // busy base 2000 with random()=0 jitters to 0.75×2000 on every step.
    expect(harness.callbacks.sleeps).toEqual([1500, 1500, 1500]);
  });

  it("retries unary once before succeeding", async () => {
    const harness = createHarness({
      start: async () => {
        throw new Error("boom");
      },
      unary: async (call: number) => {
        if (call === 1) throw new Error("boom");
        return "U2";
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks);
    expect(outcome).toEqual({ status: "translated", text: "U2" });
    expect(harness.rpcs.unaryCalls).toBe(2);
  });

  it("keeps a slow stream alive as long as its text keeps growing", async () => {
    const idleTimeoutMs = displayStreamIdleTimeoutMs(30_000);
    const harness = createHarness({
      // Grows every pass and finishes only after 5 virtual minutes, far
      // beyond the idle timeout.
      poll: async () => {
        const elapsed = harness.now();
        return { text: `t${elapsed}`, done: elapsed >= 5 * 60_000 };
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks, {
      idleTimeoutMs,
    });
    expect(outcome.status).toBe("translated");
    expect(harness.now()).toBeGreaterThan(idleTimeoutMs);
    expect(harness.rpcs.startCalls).toBe(1);
    expect(harness.rpcs.unaryCalls).toBe(0);
  });

  it("gives up a job whose text stops changing and retries from a fresh job", async () => {
    const harness = createHarness({
      poll: async (jobId: string) =>
        jobId === "job-1" ? { text: "stuck", done: false } : { text: "fresh", done: true },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks, {
      idleTimeoutMs: 10_000,
    });
    expect(outcome).toEqual({ status: "translated", text: "fresh" });
    expect(harness.rpcs.startCalls).toBe(2);
    // 10s idle at 200ms per pass: the first read sets the baseline, then
    // 50 unchanged passes trip the timeout.
    expect(harness.rpcs.pollCalls.filter((jobId) => jobId === "job-1")).toHaveLength(51);
  });

  it("reads a job that finished while the device slept instead of timing out", async () => {
    const harness = createHarness({
      poll: async (_jobId: string, call: number) => {
        if (call === 1) {
          // The device sleeps for ten minutes during the next wait.
          harness.advance(10 * 60_000);
          return { text: "partial", done: false };
        }
        return { text: "full translation", done: true };
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks, {
      idleTimeoutMs: 10_000,
    });
    expect(outcome).toEqual({ status: "translated", text: "full translation" });
    expect(harness.rpcs.pollCalls).toEqual(["job-1", "job-1"]);
  });

  it("does not bill a sleep's clock jump as idle time", async () => {
    const harness = createHarness({
      poll: async (_jobId: string, call: number) => {
        // The jump lands on a pass whose text did not change, so without
        // the per-pass clamp it would count as ten idle minutes.
        if (call === 2) harness.advance(10 * 60_000);
        // Unchanged text across the jump, then done a few passes later.
        return { text: "partial", done: call >= 4 };
      },
    });
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks, {
      idleTimeoutMs: 10_000,
    });
    expect(outcome).toEqual({ status: "translated", text: "partial" });
    expect(harness.rpcs.startCalls).toBe(1);
  });

  it("reports cancellation without further RPC traffic", async () => {
    const harness = createHarness({
      poll: vi.fn(async () => ({ text: "a", done: false })),
    });
    harness.setCancelled(true);
    const outcome = await runDisplayTranslationChain(harness.rpcs, harness.callbacks);
    expect(outcome).toEqual({ status: "cancelled" });
    expect(harness.rpcs.unaryCalls).toBe(0);
  });
});
