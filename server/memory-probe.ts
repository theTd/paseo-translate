import { appendFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import v8 from "node:v8";

/**
 * Process memory probe for the plugin host.
 *
 * Why this exists: the plugin server runs in a Paseo-owned child process, so
 * when that process exhausts the V8 heap the daemon records exactly one line —
 * "Plugin process exited: <id>" — and the reason never reaches us. This probe
 * writes a fixed-shape line to stdout on a timer; the daemon captures plugin
 * stdout as "Plugin output" in the daemon log (`paseo plugin logs translate`),
 * so the growth curve and the store counters next to it survive the crash.
 *
 * Gauges are pull-based: a module registers a counter, or a small record of
 * counters, and the probe reads it once per tick. Each gauge is therefore read
 * exactly once per sample, and callers stay independent of the probe.
 *
 * Probes are opt-in through TRANSLATE_DIAGNOSTIC_PROBES=1. Once enabled,
 * these overrides retune an investigation without a rebuild:
 *   TRANSLATE_MEMORY_PROBE_MS          tick interval; 0 keeps only the header
 *   TRANSLATE_MEMORY_PROBE_ALARM_MB    comma-separated heapUsed alarm thresholds
 *   TRANSLATE_HEAP_SNAPSHOT_NEAR_LIMIT snapshots to write near the heap limit
 */

/** A gauge is one number, or a small named group rendered as `name.key=value`. */
export type MemoryGaugeValue = number | Readonly<Record<string, number>>;

export interface MemoryGauge {
  /** Short greppable name; it lands in the log line verbatim. */
  name: string;
  read: () => MemoryGaugeValue;
}

export interface MemoryProbeOptions {
  /** Tick interval; 0 disables the timer and keeps the start/stop headers. */
  intervalMs?: number;
  /** heapUsed thresholds in bytes; each crossing is logged once, in order. */
  alarmBytes?: readonly number[];
  /**
   * Snapshots to write as the heap nears its limit (0 disables). Node's
   * `setHeapSnapshotNearHeapLimit` runs from the allocation path, so it still
   * fires while the main thread is stuck in whatever is eating the heap —
   * which is the only reason a usable artifact exists at all here.
   */
  heapSnapshotNearLimit?: number;
  log?: (line: string) => void;
  memoryUsage?: () => NodeJS.MemoryUsage;
  now?: () => number;
  heapStatistics?: () => v8.HeapInfo;
  heapSpaces?: () => readonly v8.HeapSpaceInfo[];
  /** Injectable for tests; defaults to the real v8 API when it exists. */
  armHeapSnapshot?: (limit: number) => void;
}

const MEGABYTE = 1024 * 1024;
export const DIAGNOSTIC_PROBES_ENV = "TRANSLATE_DIAGNOSTIC_PROBES";

export function diagnosticProbesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DIAGNOSTIC_PROBES_ENV] === "1";
}

/**
 * 10s, not 60s: the fatal events this probe exists for are shorter than a
 * minute — the observed crash went from a flat ~78MB heap to the 4GB ceiling
 * in under 120s, and a 60s tick lost the whole last interval because the main
 * thread was already stuck. One line per 10s is cheap next to that blind spot.
 */
const DEFAULT_INTERVAL_MS = 10_000;
/** One snapshot when the heap nears its limit: the crash we cannot reproduce. */
const DEFAULT_SNAPSHOT_NEAR_LIMIT = 1;
/** Default alarms sit under the ~4 GB default old-space ceiling this host hit. */
const DEFAULT_ALARM_STEPS_MB = [1_024, 2_048, 3_072, 3_584] as const;
const LINE_PREFIX = "[translate] mem";

type DiagnosticLineSink = (line: string) => void;

let extraSink: DiagnosticLineSink | undefined;

/**
 * Adds a second destination for every diagnostic line.
 *
 * Markers normally reach a file through the host: plugin stdout becomes
 * "Plugin output" in the daemon log. That pipeline has failed twice here — a
 * rotated daemon log stopped being written for hours, and a crash that lands
 * in that window leaves nothing behind. A file the plugin owns keeps the trace
 * independent of the host's log plumbing; stdout stays for live tailing.
 */
export function setDiagnosticSink(sink: DiagnosticLineSink | undefined): void {
  extraSink = sink;
}

/** Default destination for every marker: stdout, plus the installed file. */
function defaultLog(line: string): void {
  console.log(line);
  extraSink?.(line);
}

/** Writes one process-lifecycle marker through the same durable sink. */
export function writeDiagnostic(line: string): void {
  defaultLog(line);
}

export interface FileDiagnosticSinkOptions {
  /** Absolute path of the append-only trace file. */
  file: string;
  /** Rotate to `${file}.1` past this many bytes; 0 keeps one file forever. */
  maxBytes?: number;
}

/**
 * Wall clock for trace lines. The file carries no host log envelope, so
 * without this the last-marker's time could only be guessed from the file's
 * mtime — which says nothing about ordering inside a burst.
 */
function clockStamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/**
 * Append-only trace sink the plugin owns. Failures are swallowed on purpose:
 * diagnostics must never be the reason a translation fails.
 */
export function createFileDiagnosticSink(
  options: FileDiagnosticSinkOptions,
): DiagnosticLineSink & { file: string } {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  let bytes = 0;
  try {
    const stat = statSync(options.file);
    bytes = stat.size;
  } catch {
    bytes = 0;
  }
  const sink = (line: string): void => {
    const text = `${clockStamp()} ${line}\n`;
    try {
      if (maxBytes > 0 && bytes + text.length > maxBytes) {
        // One backup only: the interesting window is the last crash, not a
        // week of history.
        try {
          renameSync(options.file, `${options.file}.1`);
        } catch {
          // No previous file yet; the append below recreates it.
        }
        writeFileSync(options.file, "", "utf8");
        bytes = 0;
      }
      appendFileSync(options.file, text, "utf8");
      bytes += text.length;
    } catch {
      // A broken diagnostics file must not break translation.
    }
  };
  return Object.assign(sink, { file: options.file });
}

/** Heap spaces worth naming; everything else is internal or negligible here. */
const SPACE_LABELS: Readonly<Record<string, string>> = {
  old_space: "old",
  new_space: "new",
  large_object_space: "lo",
  code_space: "code",
  read_only_space: "ro",
};

export function memoryProbeOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MemoryProbeOptions {
  const options: MemoryProbeOptions = {};
  const interval = Number.parseInt(env.TRANSLATE_MEMORY_PROBE_MS ?? "", 10);
  if (Number.isFinite(interval) && interval >= 0) options.intervalMs = interval;
  const alarms = (env.TRANSLATE_MEMORY_PROBE_ALARM_MB ?? "")
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((megabytes) => Number.isFinite(megabytes) && megabytes > 0);
  if (alarms.length > 0) options.alarmBytes = alarms.map((megabytes) => megabytes * MEGABYTE);
  const snapshots = Number.parseInt(env.TRANSLATE_HEAP_SNAPSHOT_NEAR_LIMIT ?? "", 10);
  if (Number.isFinite(snapshots) && snapshots >= 0) options.heapSnapshotNearLimit = snapshots;
  return options;
}

/**
 * Arms Node's near-heap-limit snapshot writer. Returns the state the header
 * prints, so a missing artifact is never a mystery: either it was armed, or
 * the reason it was not is on the same line.
 */function armHeapSnapshotWriter(limit: number): string {
  if (limit <= 0) return "off";
  const api = (v8 as { setHeapSnapshotNearHeapLimit?: (count: number) => void })
    .setHeapSnapshotNearHeapLimit;
  if (typeof api !== "function") return "unavailable";
  try {
    api(limit);
    return `armed:${limit}`;
  } catch (error) {
    return `failed:${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createMemoryProbe(options: MemoryProbeOptions = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? defaultLog;
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  const now = options.now ?? (() => Date.now());
  const heapStatistics = options.heapStatistics ?? (() => v8.getHeapStatistics());
  const heapSpaces = options.heapSpaces ?? (() => v8.getHeapSpaceStatistics());
  const alarms = [...(options.alarmBytes ?? DEFAULT_ALARM_STEPS_MB.map((mb) => mb * MEGABYTE))]
    .sort((left, right) => left - right);
  const heapSnapshotNearLimit = options.heapSnapshotNearLimit ?? DEFAULT_SNAPSHOT_NEAR_LIMIT;

  const gauges: MemoryGauge[] = [];
  const startedAt = now();
  let lastSampleAt = startedAt;
  // Baseline at creation, which for this plugin is load time: the first tick's
  // delta is then real growth rather than the whole heap.
  let lastHeapUsed = memoryUsage().heapUsed;
  let nextAlarm = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function megabytes(bytes: number): string {
    return (bytes / MEGABYTE).toFixed(1);
  }

  function duration(milliseconds: number): string {
    return (milliseconds / 60_000).toFixed(1);
  }

  function spaceSummary(): string {
    const parts: string[] = [];
    for (const space of heapSpaces()) {
      const label = SPACE_LABELS[space.space_name];
      if (label === undefined) continue;
      parts.push(`${label}=${megabytes(space.space_used_size)}`);
    }
    return parts.join(" ");
  }

  function gaugeSummary(): string {
    const parts: string[] = [];
    for (const gauge of gauges) {
      let value: MemoryGaugeValue;
      try {
        value = gauge.read();
      } catch (error) {
        // A broken gauge must never break the tick that would have shown it.
        parts.push(`${gauge.name}.ERROR=${error instanceof Error ? "threw" : "unknown"}`);
        continue;
      }
      if (typeof value === "number") {
        parts.push(`${gauge.name}=${Math.round(value)}`);
        continue;
      }
      for (const [key, count] of Object.entries(value)) {
        parts.push(`${gauge.name}.${key}=${Math.round(count)}`);
      }
    }
    return parts.join(" ");
  }

  function activeResourceCount(): number | undefined {
    // Node exposes this from 17.3 on; where it is absent the probe omits it.
    const host = process as { getActiveResourcesInfo?: () => unknown[] };
    if (typeof host.getActiveResourcesInfo !== "function") return undefined;
    return host.getActiveResourcesInfo().length;
  }

  function sample(reason?: string): void {
    const at = now();
    const usage = memoryUsage();
    const elapsedMs = Math.max(0, at - startedAt);
    const sinceLastMs = Math.max(1, at - lastSampleAt);
    const deltaMegabytes = (usage.heapUsed - lastHeapUsed) / MEGABYTE;
    lastHeapUsed = usage.heapUsed;
    lastSampleAt = at;

    // Alarms are logged before the detail line so the last one survives even if
    // the process dies between the two writes.
    while (nextAlarm < alarms.length && usage.heapUsed >= (alarms[nextAlarm] ?? Infinity)) {
      const threshold = alarms[nextAlarm] ?? Infinity;
      nextAlarm += 1;
      log(
        `${LINE_PREFIX} ALARM heap=${megabytes(usage.heapUsed)}MB`
        + ` threshold=${megabytes(threshold)}MB up=${duration(elapsedMs)}m`,
      );
    }

    const fields = [
      `${LINE_PREFIX}${reason === undefined ? "" : ` ${reason}`}`,
      `up=${duration(elapsedMs)}m`,
      `heap=${megabytes(usage.heapUsed)}MB/${megabytes(heapStatistics().heap_size_limit)}MB`,
      `d=${deltaMegabytes >= 0 ? "+" : ""}${deltaMegabytes.toFixed(1)}MB/${Math.round(sinceLastMs / 1000)}s`,
      `rss=${megabytes(usage.rss)}MB`,
      `ext=${megabytes(usage.external)}MB`,
      `buf=${megabytes(usage.arrayBuffers)}MB`,
    ];
    const resources = activeResourceCount();
    if (resources !== undefined) fields.push(`res=${resources}`);
    const spaces = spaceSummary();
    if (spaces.length > 0) fields.push(`spaces(${spaces})`);
    const gaugesLine = gaugeSummary();
    if (gaugesLine.length > 0) fields.push(`| ${gaugesLine}`);
    log(fields.join(" "));
  }

  return {
    /** Registers a counter read on every tick; safe before or after start(). */
    track(gauge: MemoryGauge): void {
      gauges.push(gauge);
    },

    /** Logs the header (pid, heap ceiling, gauges) and arms the timer. */
    start(): void {
      if (timer !== null) return;
      const alarmText = alarms.length === 0
        ? "none"
        : `${alarms.map((bytes) => Math.round(bytes / MEGABYTE)).join(",")}MB`;
      // Arm before logging so the header states what will actually land on disk.
      const snapshotState = options.armHeapSnapshot !== undefined
        ? (() => {
            try {
              options.armHeapSnapshot(heapSnapshotNearLimit);
              return `armed:${heapSnapshotNearLimit}`;
            } catch (error) {
              return `failed:${error instanceof Error ? error.message : String(error)}`;
            }
          })()
        : armHeapSnapshotWriter(heapSnapshotNearLimit);
      log(
        `${LINE_PREFIX} probe start pid=${process.pid} node=${process.version}`
        + ` interval=${intervalMs}ms`
        + ` heapLimit=${megabytes(heapStatistics().heap_size_limit)}MB`
        + ` alarms=${alarmText}`
        + ` snapshot=${snapshotState}`
        + ` cwd=${process.cwd()}`
        + ` gauges=${gauges.map((gauge) => gauge.name).join(",") || "none"}`,
      );
      if (intervalMs <= 0) return;
      timer = setInterval(() => sample(), intervalMs);
      // A diagnostic timer must never be the reason this host stays alive.
      timer.unref?.();
    },

    /** Reads every gauge and logs one line; exposed for tests and ad-hoc use. */
    sample,

    /** Stops the timer and logs the closing sample so teardown is visible. */
    dispose(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (stopped) return;
      stopped = true;
      sample("final");
    },
  };
}

export type MemoryProbe = ReturnType<typeof createMemoryProbe>;

export interface SizeWatchOptions {
  /** Marker label, e.g. "llm.sse"; it lands in the log line verbatim. */
  label: string;
  /** First reported magnitude; each crossing doubles the next threshold. */
  stepChars?: number;
  log?: (line: string) => void;
}

/**
 * Reports one buffer's size at doubling magnitudes (64k, 128k, 256k, …).
 *
 * The heap gauge alone cannot say *which* buffer exploded: the last crash
 * reached 4GB while every sampled store stayed flat, so the growth lived and
 * died inside a single request. A watch per call site costs one comparison per
 * delta and still leaves a trail of exactly where a runaway buffer was, even
 * if the process dies before the next tick.
 */
export function createSizeWatch(options: SizeWatchOptions) {
  const log = options.log ?? defaultLog;
  const enabled = () => options.log !== undefined || diagnosticProbesEnabled();
  const step = options.stepChars ?? 65_536;
  let next = step;
  let peak = 0;
  return {
    /** Notes the current size; logs only when it crosses the next magnitude. */
    report(chars: number, detail?: string): void {
      if (!enabled()) return;
      if (chars > peak) peak = chars;
      if (chars < next) return;
      while (next <= chars) next *= 2;
      const suffix = detail === undefined || detail.length === 0 ? "" : ` ${detail}`;
      log(`${LINE_PREFIX} big ${options.label} chars=${Math.round(chars)}${suffix}`);
    },
    /** Largest size seen so far, for a caller that wants to log a summary. */
    get peakChars(): number {
      return peak;
    },
  };
}

export type SizeWatch = ReturnType<typeof createSizeWatch>;

export interface StepTracerOptions {
  log?: (line: string) => void;
  /** A step taking at least this long also logs a matching `exit`. */
  slowMs?: number;
  now?: () => number;
}

/**
 * Enter/exit markers for one request path, aimed at the failure the heap gauge
 * and the size watches could not localize: the host went from a flat ~86MB heap
 * to the 4GB ceiling while the main thread never returned, so nothing that
 * needs the event loop can report where it was.
 *
 * The `enter` line is written *before* the work starts, so a step that never
 * finishes leaves exactly one dangling `enter` as the last line in the log —
 * that is the whole point. `exit` is written only for a step that took
 * `slowMs` or more, which keeps a healthy path at one line per step.
 * These markers are disabled unless diagnostic probes are explicitly enabled.
 */
export function createStepTracer(options: StepTracerOptions = {}) {
  const log = options.log ?? defaultLog;
  const enabled = () => options.log !== undefined || diagnosticProbesEnabled();
  const slowMs = options.slowMs ?? 1_000;
  const now = options.now ?? (() => Date.now());
  let nextId = 0;
  return {
    /** Logs `step enter`; the returned function logs a slow `step exit`. */
    start(name: string, detail?: string): () => void {
      if (!enabled()) return () => undefined;
      const id = nextId++;
      const suffix = detail === undefined || detail.length === 0 ? "" : ` ${detail}`;
      log(`${LINE_PREFIX} step enter #${id} ${name}${suffix}`);
      const startedAt = now();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const elapsed = now() - startedAt;
        if (elapsed < slowMs) return;
        log(`${LINE_PREFIX} step exit #${id} ${name}${suffix} ms=${elapsed}`);
      };
    },
  };
}

export type StepTracer = ReturnType<typeof createStepTracer>;
