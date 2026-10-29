import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHeapProfileRecorder } from "./heap-profile";

function fakeSession() {
  const calls: string[] = [];
  const samplingParams: unknown[] = [];
  return {
    calls,
    samplingParams,
    connect: () => calls.push("connect"),
    disconnect: () => calls.push("disconnect"),
    post(method: string, paramsOrCallback?: unknown, maybeCallback?: (error: Error | null, result?: unknown) => void) {
      calls.push(method);
      if (method === "HeapProfiler.startSampling") samplingParams.push(paramsOrCallback);
      const callback = typeof paramsOrCallback === "function"
        ? paramsOrCallback as (error: Error | null, result?: unknown) => void
        : maybeCallback;
      queueMicrotask(() => {
        callback?.(null, method === "HeapProfiler.stopSampling"
          ? { profile: { head: { callFrame: { functionName: "allocate" }, selfSize: 1024 } } }
          : undefined);
      });
    },
  };
}

describe("heap profile recorder", () => {
  it("writes allocation stacks and rotates profiles so a crash leaves the latest sample", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "translate-heap-profile-"));
    const file = path.join(directory, "current.heapprofile");
    const session = fakeSession();
    try {
      const recorder = createHeapProfileRecorder({
        file, session, intervalMs: 60_000, heapUsed: () => 0, log: () => undefined,
      });
      recorder.start();
      await recorder.flush();
      await recorder.flush();
      await recorder.dispose();

      const current = JSON.parse(readFileSync(file, "utf8")) as { head: { selfSize: number } };
      const previous = JSON.parse(readFileSync(`${file}.1`, "utf8")) as { head: { selfSize: number } };
      expect(current.head.selfSize).toBe(1024);
      expect(previous.head.selfSize).toBe(1024);
      expect(session.calls).toContain("HeapProfiler.enable");
      expect(session.calls.filter((call) => call === "HeapProfiler.startSampling").length).toBeGreaterThan(1);
      expect(session.samplingParams).toEqual(session.samplingParams.map(() => ({
        samplingInterval: 4_096, includeObjectsCollected: true,
      })));
      expect(session.calls.at(-1)).toBe("disconnect");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes one early heap snapshot instead of relying on the near-limit writer", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "translate-heap-snapshot-"));
    const file = path.join(directory, "current.heapprofile");
    const snapshots: string[] = [];
    const session = fakeSession();
    try {
      const recorder = createHeapProfileRecorder({
        file, session, intervalMs: 60_000, heapUsed: () => 128 * 1024 * 1024,
        writeSnapshot: (snapshot) => snapshots.push(snapshot), log: () => undefined,
      });
      recorder.start();
      await recorder.flush();
      await recorder.flush();
      await recorder.dispose();
      expect(snapshots).toEqual([`${file}.128mb.heapsnapshot`]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
