/**
 * Paces bulk provider emits against the plugin host's IPC send backlog.
 *
 * The Paseo plugin host forwards every provider event with a bare
 * `process.send` (no backpressure), and the daemon reads that one pipe in
 * order. A history replay that emits tens of thousands of events in one loop
 * queues them all at once: each unsent message pins its serialized buffer, and
 * every RPC reply the plugin sends meanwhile waits behind the whole queue,
 * past the daemon's 30 s RPC timeout. That is how reopening a large forked
 * session froze the app.
 *
 * Each unsent IPC message is one `SimpleWriteWrap` request in
 * `process.getActiveResourcesInfo()` (checked on Node 24 and 26), so a bulk
 * emitter can wait for that count to fall before it sends the next batch.
 */

/** Emits sent between two backlog checks. */
export const EMIT_BATCH_SIZE = 100;
/** Unsent writes tolerated before the next batch; leaves room for unrelated writes. */
export const BACKLOG_LOW_WATER = 200;
/** Poll interval while waiting for the daemon to drain the pipe. */
export const BACKLOG_POLL_MS = 10;
/** A batch never waits longer than this: a stalled reader slows the replay, never stops it. */
export const BACKLOG_MAX_WAIT_MS = 10_000;
/** Pause between batches where the backlog cannot be measured. */
export const UNMEASURED_PAUSE_MS = 20;

const PENDING_WRITE_TYPE = "SimpleWriteWrap";

/** Counts unsent stream writes, or `undefined` where the runtime cannot tell. */
export function pendingIpcWrites(): number | undefined {
  const host = process as { getActiveResourcesInfo?: () => unknown[] };
  if (typeof host.getActiveResourcesInfo !== "function") return undefined;
  let pending = 0;
  for (const type of host.getActiveResourcesInfo()) if (type === PENDING_WRITE_TYPE) pending += 1;
  return pending;
}

export interface EmitPacerOptions {
  /** Ends any wait early, e.g. once the session closed. */
  shouldStop?: () => boolean;
  pendingWrites?: () => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  /** One macrotask turn; a timer would cost up to a 15 ms tick per batch on Windows. */
  yieldTurn?: () => Promise<void>;
  now?: () => number;
}

export interface EmitPacer {
  /** Call after every emit; waits only at batch boundaries. */
  afterEmit(): Promise<void>;
}

export function createEmitPacer(options: EmitPacerOptions = {}): EmitPacer {
  const shouldStop = options.shouldStop ?? (() => false);
  const pendingWrites = options.pendingWrites ?? pendingIpcWrites;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const yieldTurn = options.yieldTurn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const now = options.now ?? Date.now;
  let sinceCheck = 0;
  return {
    async afterEmit() {
      sinceCheck += 1;
      if (sinceCheck < EMIT_BATCH_SIZE) return;
      sinceCheck = 0;
      // Every batch boundary hands the loop a turn, so RPCs interleave with the batches.
      await yieldTurn();
      const deadline = now() + BACKLOG_MAX_WAIT_MS;
      for (;;) {
        if (shouldStop()) return;
        const pending = pendingWrites();
        if (pending === undefined) {
          await sleep(UNMEASURED_PAUSE_MS);
          return;
        }
        if (pending <= BACKLOG_LOW_WATER || now() >= deadline) return;
        await sleep(BACKLOG_POLL_MS);
      }
    },
  };
}
