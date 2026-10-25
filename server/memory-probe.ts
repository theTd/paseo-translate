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
 * Overrides, so a rebuild is not needed to retune an investigation:
 *   TRANSLATE_MEMORY_PROBE_MS        tick interval; 0 keeps only the header
 *   TRANSLATE_MEMORY_PROBE_ALARM_MB  comma-separated heapUsed alarm thresholds
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
  log?: (line: string) => void;
  memoryUsage?: () => NodeJS.MemoryUsage;
  now?: () => number;
  heapStatistics?: () => v8.HeapInfo;
  heapSpaces?: () => readonly v8.HeapSpaceInfo[];
}

const MEGABYTE = 1024 * 1024;
const DEFAULT_INTERVAL_MS = 60_000;
/** Default alarms sit under the ~4 GB default old-space ceiling this host hit. */
const DEFAULT_ALARM_STEPS_MB = [1_024, 2_048, 3_072, 3_584] as const;
const LINE_PREFIX = "[translate] mem";

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
  return options;
}

export function createMemoryProbe(options: MemoryProbeOptions = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? ((line: string) => { console.log(line); });
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  const now = options.now ?? (() => Date.now());
  const heapStatistics = options.heapStatistics ?? (() => v8.getHeapStatistics());
  const heapSpaces = options.heapSpaces ?? (() => v8.getHeapSpaceStatistics());
  const alarms = [...(options.alarmBytes ?? DEFAULT_ALARM_STEPS_MB.map((mb) => mb * MEGABYTE))]
    .sort((left, right) => left - right);

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
      log(
        `${LINE_PREFIX} probe start pid=${process.pid} node=${process.version}`
        + ` interval=${intervalMs}ms`
        + ` heapLimit=${megabytes(heapStatistics().heap_size_limit)}MB`
        + ` alarms=${alarmText}`
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
