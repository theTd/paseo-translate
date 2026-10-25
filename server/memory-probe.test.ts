import type { HeapInfo } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import { createMemoryProbe, memoryProbeOptionsFromEnv } from "./memory-probe";

const MEGABYTE = 1024 * 1024;

function harness(overrides: {
  heapUsed?: number;
  intervalMs?: number;
  alarmBytes?: number[];
} = {}) {
  const lines: string[] = [];
  let clock = 0;
  let heapUsed = overrides.heapUsed ?? 100 * MEGABYTE;
  const probe = createMemoryProbe({
    // 0 keeps the timer off so each test drives sample() explicitly.
    intervalMs: overrides.intervalMs ?? 0,
    alarmBytes: overrides.alarmBytes ?? [],
    log: (line) => lines.push(line),
    now: () => clock,
    memoryUsage: () => ({
      rss: 900 * MEGABYTE,
      heapTotal: 200 * MEGABYTE,
      heapUsed,
      external: 7 * MEGABYTE,
      arrayBuffers: 2 * MEGABYTE,
    }),
    heapStatistics: () => ({ heap_size_limit: 4_000 * MEGABYTE }) as unknown as HeapInfo,
    heapSpaces: () => [],
  });
  return {
    probe,
    lines,
    advance(seconds: number, nextHeapUsed?: number) {
      clock += seconds * 1000;
      if (nextHeapUsed !== undefined) heapUsed = nextHeapUsed;
    },
  };
}

describe("memory probe", () => {
  it("renders one line with heap, delta and each gauge", () => {
    const h = harness({ heapUsed: 300 * MEGABYTE });
    h.probe.track({ name: "cache", read: () => ({ entries: 13_272, chars: 6_129_495 }) });
    h.probe.track({ name: "inflight", read: () => 3 });
    h.advance(60, 312 * MEGABYTE);

    h.probe.sample();

    expect(h.lines).toHaveLength(1);
    const line = h.lines[0] ?? "";
    expect(line).toContain("[translate] mem up=1.0m");
    expect(line).toContain("heap=312.0MB/4000.0MB");
    // Baseline is captured at creation, so the first delta is real growth.
    expect(line).toContain("d=+12.0MB/60s");
    expect(line).toContain("rss=900.0MB");
    expect(line).toContain("| cache.entries=13272 cache.chars=6129495 inflight=3");
  });

  it("logs each alarm threshold once, then keeps sampling", () => {
    const h = harness({
      heapUsed: 900 * MEGABYTE,
      alarmBytes: [1_024 * MEGABYTE, 2_048 * MEGABYTE, 3_584 * MEGABYTE],
    });
    h.probe.track({ name: "cache", read: () => 0 });

    h.probe.sample();
    h.advance(60, 1_100 * MEGABYTE);
    h.probe.sample();
    h.advance(60, 1_200 * MEGABYTE);
    h.probe.sample();
    h.advance(60, 3_600 * MEGABYTE);
    h.probe.sample();

    const alarms = h.lines.filter((line) => line.includes("ALARM"));
    expect(alarms).toHaveLength(3);
    expect(alarms[0]).toContain("threshold=1024.0MB");
    expect(alarms[1]).toContain("threshold=2048.0MB");
    expect(alarms[2]).toContain("threshold=3584.0MB");
    // Four detail lines; the alarm lines carry "up=" too but sit behind ALARM.
    expect(h.lines.filter((line) => line.includes("[translate] mem up="))).toHaveLength(4);
  });

  it("reports a gauge that throws instead of breaking the tick", () => {
    const h = harness();
    h.probe.track({
      name: "context",
      read: () => {
        throw new Error("store unavailable");
      },
    });

    h.probe.sample();

    expect(h.lines[0]).toContain("context.ERROR=threw");
  });

  it("heads a started probe with pid, heap limit and alarm list", () => {
    vi.useFakeTimers();
    try {
      const h = harness({ intervalMs: 60_000, alarmBytes: [512 * MEGABYTE] });
      h.probe.track({ name: "cache", read: () => 1 });
      h.probe.start();

      expect(h.lines[0]).toContain("[translate] mem probe start pid=");
      expect(h.lines[0]).toContain("heapLimit=4000.0MB");
      expect(h.lines[0]).toContain("alarms=512MB");
      expect(h.lines[0]).toContain("gauges=cache");

      vi.advanceTimersByTime(120_000);
      expect(h.lines.filter((line) => line.includes("up="))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs exactly one closing sample on dispose, even when disabled", () => {
    const h = harness();
    h.probe.start();
    h.probe.dispose();
    h.probe.dispose();

    expect(h.lines.filter((line) => line.includes("final"))).toHaveLength(1);
  });

  it("reads interval and alarm overrides from the environment", () => {
    expect(memoryProbeOptionsFromEnv({
      TRANSLATE_MEMORY_PROBE_MS: "5000",
      TRANSLATE_MEMORY_PROBE_ALARM_MB: "100, 250",
    })).toEqual({ intervalMs: 5000, alarmBytes: [100 * MEGABYTE, 250 * MEGABYTE] });

    expect(memoryProbeOptionsFromEnv({})).toEqual({});
    expect(memoryProbeOptionsFromEnv({
      TRANSLATE_MEMORY_PROBE_MS: "soon",
      TRANSLATE_MEMORY_PROBE_ALARM_MB: "0,-4,x",
    })).toEqual({});
  });
});
