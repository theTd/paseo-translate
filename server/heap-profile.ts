import { renameSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import v8 from "node:v8";
import { writeDiagnostic } from "./memory-probe";

interface ProfilerSession {
  connect(): void;
  disconnect(): void;
  post(method: string, params?: unknown, callback?: (error: Error | null, result?: any) => void): void;
}

export interface HeapProfileRecorderOptions {
  file: string;
  intervalMs?: number;
  samplingInterval?: number;
  snapshotThresholdBytes?: number;
  heapUsed?: () => number;
  writeSnapshot?: (file: string) => void;
  session?: ProfilerSession;
  log?: (line: string) => void;
}

export function createHeapProfileRecorder(options: HeapProfileRecorderOptions) {
  const session = options.session ?? new Session();
  const log = options.log ?? writeDiagnostic;
  const intervalMs = options.intervalMs ?? 5_000;
  const heapUsed = options.heapUsed ?? (() => v8.getHeapStatistics().used_heap_size);
  const writeSnapshot = options.writeSnapshot ?? ((file: string) => v8.writeHeapSnapshot(file));
  const snapshotThresholdBytes = options.snapshotThresholdBytes ?? 128 * 1024 * 1024;
  const sampling = {
    samplingInterval: options.samplingInterval ?? 4_096,
    includeObjectsCollected: true,
  };
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let stopped = false;
  let snapshotWritten = false;

  async function flush(): Promise<void> {
    if (flushing || stopped) return;
    flushing = true;
    try {
      if (!snapshotWritten && heapUsed() >= snapshotThresholdBytes) {
        snapshotWritten = true;
        const file = `${options.file}.${Math.round(snapshotThresholdBytes / 1024 / 1024)}mb.heapsnapshot`;
        log(`[translate] early heap snapshot started file=${file}`);
        writeSnapshot(file);
        log(`[translate] early heap snapshot written file=${file}`);
      }
      const profile = await new Promise<any>((resolve, reject) => {
        session.post("HeapProfiler.stopSampling", (error: Error | null, result?: any) => {
          if (error) reject(error);
          else resolve(result?.profile);
        });
      });
      try {
        renameSync(options.file, `${options.file}.1`);
      } catch {
        // The first profile has no previous generation to rotate.
      }
      writeFileSync(options.file, JSON.stringify(profile));
      log(`[translate] heap profile written file=${options.file}`);
    } finally {
      if (!stopped) {
        session.post("HeapProfiler.startSampling", sampling, (error: Error | null) => {
          if (error) log(`[translate] heap profile restart failed: ${error.message}`);
        });
      }
      flushing = false;
    }
  }

  return {
    start(): void {
      session.connect();
      session.post("HeapProfiler.enable");
      session.post("HeapProfiler.startSampling", sampling);
      timer = setInterval(() => {
        void flush().catch((error: unknown) => {
          log(`[translate] heap profile failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, intervalMs);
      timer.unref?.();
      log(`[translate] heap profile active interval=${intervalMs}ms file=${options.file}`);
    },

    flush,

    async dispose(): Promise<void> {
      if (stopped) return;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await flush();
      stopped = true;
      session.disconnect();
    },
  };
}
