import { renameSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { writeDiagnostic } from "./memory-probe";

interface ProfilerSession {
  connect(): void;
  disconnect(): void;
  post(method: string, params?: unknown, callback?: (error: Error | null, result?: any) => void): void;
}

export interface CpuProfileRecorderOptions {
  file: string;
  intervalMs?: number;
  session?: ProfilerSession;
  log?: (line: string) => void;
}

export function createCpuProfileRecorder(options: CpuProfileRecorderOptions) {
  const session = options.session ?? new Session();
  const log = options.log ?? writeDiagnostic;
  const intervalMs = options.intervalMs ?? 30_000;
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;
  let stopped = false;

  async function flush(): Promise<void> {
    if (flushing || stopped) return;
    flushing = true;
    try {
      const profile = await new Promise<any>((resolve, reject) => {
        session.post("Profiler.stop", (error: Error | null, result?: any) => {
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
      log(`[translate] cpu profile written file=${options.file}`);
    } finally {
      if (!stopped) {
        session.post("Profiler.start", (error: Error | null) => {
          if (error) log(`[translate] cpu profile restart failed: ${error.message}`);
        });
      }
      flushing = false;
    }
  }

  return {
    start(): void {
      session.connect();
      session.post("Profiler.enable");
      session.post("Profiler.start");
      timer = setInterval(() => {
        void flush().catch((error: unknown) => {
          log(`[translate] cpu profile failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, intervalMs);
      timer.unref?.();
      log(`[translate] cpu profile active interval=${intervalMs}ms file=${options.file}`);
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
