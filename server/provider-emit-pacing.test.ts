import { describe, expect, it } from "vitest";
import {
  BACKLOG_LOW_WATER,
  BACKLOG_MAX_WAIT_MS,
  BACKLOG_POLL_MS,
  createEmitPacer,
  EMIT_BATCH_SIZE,
  pendingIpcWrites,
  UNMEASURED_PAUSE_MS,
  type EmitPacerOptions,
} from "./provider-emit-pacing";

/** A pacer on a fake clock: sleeping advances time, and every wait is recorded. */
function fakePacer(backlog: () => number | undefined, overrides: Partial<EmitPacerOptions> = {}) {
  let time = 0;
  const sleeps: number[] = [];
  let turns = 0;
  const pacer = createEmitPacer({
    pendingWrites: backlog,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    yieldTurn: async () => { turns += 1; },
    now: () => time,
    ...overrides,
  });
  return { pacer, sleeps, turns: () => turns, elapsed: () => time };
}

async function emitTimes(pacer: { afterEmit(): Promise<void> }, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await pacer.afterEmit();
}

describe("emit pacing", () => {
  it("does not wait inside a batch", async () => {
    let checks = 0;
    const fake = fakePacer(() => { checks += 1; return 0; });
    await emitTimes(fake.pacer, EMIT_BATCH_SIZE - 1);
    expect(checks).toBe(0);
    expect(fake.turns()).toBe(0);
    expect(fake.sleeps).toEqual([]);
  });

  it("hands the loop one turn per batch when the pipe keeps up", async () => {
    const fake = fakePacer(() => 0);
    await emitTimes(fake.pacer, EMIT_BATCH_SIZE * 3);
    expect(fake.turns()).toBe(3);
    expect(fake.sleeps).toEqual([]);
  });

  it("waits for a backlog to drain below the low-water mark", async () => {
    const backlog = [BACKLOG_LOW_WATER + 500, BACKLOG_LOW_WATER + 100, BACKLOG_LOW_WATER];
    const fake = fakePacer(() => backlog.shift() ?? 0);
    await emitTimes(fake.pacer, EMIT_BATCH_SIZE);
    expect(fake.sleeps).toEqual([BACKLOG_POLL_MS, BACKLOG_POLL_MS]);
    expect(backlog).toEqual([]);
  });

  it("stops waiting once the emitter should stop", async () => {
    let stop = false;
    let checks = 0;
    const fake = fakePacer(() => {
      checks += 1;
      if (checks === 3) stop = true;
      return BACKLOG_LOW_WATER + 1;
    }, { shouldStop: () => stop });
    await emitTimes(fake.pacer, EMIT_BATCH_SIZE);
    expect(checks).toBe(3);
  });

  it("gives up on a backlog that never drains after the maximum wait", async () => {
    const fake = fakePacer(() => BACKLOG_LOW_WATER * 10);
    await emitTimes(fake.pacer, EMIT_BATCH_SIZE);
    expect(fake.elapsed()).toBe(BACKLOG_MAX_WAIT_MS);
    // The next batch waits again rather than flooding.
    await emitTimes(fake.pacer, EMIT_BATCH_SIZE);
    expect(fake.elapsed()).toBe(BACKLOG_MAX_WAIT_MS * 2);
  });

  it("pauses briefly per batch where the backlog cannot be measured", async () => {
    const fake = fakePacer(() => undefined);
    await emitTimes(fake.pacer, EMIT_BATCH_SIZE * 2);
    expect(fake.sleeps).toEqual([UNMEASURED_PAUSE_MS, UNMEASURED_PAUSE_MS]);
  });

  it("measures the backlog on this runtime", () => {
    const pending = pendingIpcWrites();
    expect(typeof pending).toBe("number");
    expect(pending).toBeGreaterThanOrEqual(0);
  });

  it("paces with the real timers and resource probe", async () => {
    const pacer = createEmitPacer();
    await emitTimes(pacer, EMIT_BATCH_SIZE * 2);
  });
});
