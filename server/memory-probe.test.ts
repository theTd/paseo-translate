import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HeapInfo } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import {
  createFileDiagnosticSink,
  createMemoryProbe,
  createSizeWatch,
  createStepTracer,
  memoryProbeOptionsFromEnv,
  setDiagnosticSink,
} from "./memory-probe";

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

  it("reads the snapshot count from the environment", () => {
    expect(memoryProbeOptionsFromEnv({ TRANSLATE_HEAP_SNAPSHOT_NEAR_LIMIT: "0" }))
      .toEqual({ heapSnapshotNearLimit: 0 });
    expect(memoryProbeOptionsFromEnv({ TRANSLATE_HEAP_SNAPSHOT_NEAR_LIMIT: "2" }))
      .toEqual({ heapSnapshotNearLimit: 2 });
    expect(memoryProbeOptionsFromEnv({ TRANSLATE_HEAP_SNAPSHOT_NEAR_LIMIT: "x" })).toEqual({});
  });

  it("states in the header whether the snapshot writer was armed", () => {
    const armed: string[] = [];
    const lines: string[] = [];
    const probe = createMemoryProbe({
      intervalMs: 0,
      log: (line) => lines.push(line),
      armHeapSnapshot: (limit) => { armed.push(String(limit)); },
    });
    probe.start();

    expect(armed).toEqual(["1"]);
    expect(lines[0]).toContain("snapshot=armed:1");
    expect(lines[0]).toContain("cwd=");
  });

  it("reports a snapshot arming failure instead of throwing", () => {
    const lines: string[] = [];
    const probe = createMemoryProbe({
      intervalMs: 0,
      log: (line) => lines.push(line),
      armHeapSnapshot: () => { throw new Error("nope"); },
      heapSnapshotNearLimit: 1,
    });
    probe.start();
    expect(lines[0]).toContain("snapshot=failed:nope");
  });
});

describe("size watch", () => {
  function watch() {
    const lines: string[] = [];
    const size = createSizeWatch({
      label: "llm.sse",
      stepChars: 64,
      log: (line) => lines.push(line),
    });
    return { size, lines };
  }

  it("logs once per doubling magnitude, not per report", () => {
    const h = watch();
    h.size.report(63);
    expect(h.lines).toHaveLength(0);

    h.size.report(64);
    h.size.report(100);
    h.size.report(127);
    expect(h.lines).toEqual(["[translate] mem big llm.sse chars=64"]);

    h.size.report(128);
    expect(h.lines[1]).toBe("[translate] mem big llm.sse chars=128");

    h.size.report(1_000);
    expect(h.lines[2]).toBe("[translate] mem big llm.sse chars=1000");
    expect(h.lines).toHaveLength(3);
  });

  it("tracks the peak even below the first magnitude", () => {
    const h = watch();
    h.size.report(10);
    h.size.report(42);
    h.size.report(7);
    expect(h.size.peakChars).toBe(42);
    expect(h.lines).toHaveLength(0);
  });

  it("keeps the detail suffix for attribution", () => {
    const h = watch();
    h.size.report(200, "id=msg_1");
    expect(h.lines[0]).toBe("[translate] mem big llm.sse chars=200 id=msg_1");
  });
});

describe("step tracer", () => {
  function tracer(slowMs = 1_000) {
    const lines: string[] = [];
    let clock = 0;
    const t = createStepTracer({
      slowMs,
      log: (line) => lines.push(line),
      now: () => clock,
    });
    return { t, lines, advance: (ms: number) => { clock += ms; } };
  }

  it("logs the enter before the work, so a stall cannot hide it", () => {
    const h = tracer();
    h.t.start("endpoint.stream", "chars=108748");
    expect(h.lines).toEqual(["[translate] mem step enter #0 endpoint.stream chars=108748"]);
  });

  it("stays quiet on exit for a fast step", () => {
    const h = tracer();
    const done = h.t.start("cache.get");
    h.advance(3);
    done();
    expect(h.lines).toHaveLength(1);
  });

  it("logs the exit with elapsed time once a step is slow", () => {
    const h = tracer();
    const done = h.t.start("context.compact", "scope=s");
    h.advance(4_200);
    done();
    expect(h.lines[1]).toBe("[translate] mem step exit #0 context.compact scope=s ms=4200");
  });

  it("numbers steps and only reports each exit once", () => {
    const h = tracer();
    const first = h.t.start("a");
    const second = h.t.start("b");
    h.advance(2_000);
    first();
    first();
    second();
    expect(h.lines).toEqual([
      "[translate] mem step enter #0 a",
      "[translate] mem step enter #1 b",
      "[translate] mem step exit #0 a ms=2000",
      "[translate] mem step exit #1 b ms=2000",
    ]);
  });
});

describe("file diagnostic sink", () => {
  it("appends every line and keeps one backup past the byte cap", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "translate-trace-"));
    const file = path.join(directory, "trace.log");
    try {
      const sink = createFileDiagnosticSink({ file, maxBytes: 40 });
      sink("aaaa");
      sink("bbbb");
      const firstTwo = readFileSync(file, "utf8").trimEnd().split("\n");
      expect(firstTwo).toHaveLength(2);
      expect(firstTwo[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} aaaa$/);
      expect(firstTwo[1]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} bbbb$/);

      sink("c".repeat(40));
      const rotated = readFileSync(`${file}.1`, "utf8");
      expect(rotated).toContain("aaaa");
      expect(readFileSync(file, "utf8")).toContain("c".repeat(40));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes default marker output to whatever sink is installed", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      setDiagnosticSink((line) => lines.push(line));
      const probe = createMemoryProbe({
        intervalMs: 0,
        memoryUsage: () => ({
          rss: 0,
          heapTotal: 0,
          heapUsed: 0,
          external: 0,
          arrayBuffers: 0,
        }),
        heapStatistics: () => ({ heap_size_limit: 1 }) as unknown as HeapInfo,
        heapSpaces: () => [],
      });
      probe.start();
      expect(lines[0]).toContain("[translate] mem probe start");
      expect(spy).toHaveBeenCalled();
    } finally {
      setDiagnosticSink(undefined);
      spy.mockRestore();
      expect(existsSync(path.join(tmpdir(), "never-created"))).toBe(false);
    }
  });
});
