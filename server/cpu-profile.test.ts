import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCpuProfileRecorder } from "./cpu-profile";

function fakeSession() {
  const calls: string[] = [];
  return {
    calls,
    connect: () => calls.push("connect"),
    disconnect: () => calls.push("disconnect"),
    post(method: string, paramsOrCallback?: unknown, maybeCallback?: (error: Error | null, result?: unknown) => void) {
      calls.push(method);
      const callback = typeof paramsOrCallback === "function"
        ? paramsOrCallback as (error: Error | null, result?: unknown) => void
        : maybeCallback;
      queueMicrotask(() => {
        callback?.(null, method === "Profiler.stop"
          ? { profile: { nodes: [{ id: 1, callFrame: { functionName: "work" } }] } }
          : undefined);
      });
    },
  };
}

describe("CPU profile recorder", () => {
  it("writes and rotates profiles so a crash leaves the latest sample", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "translate-cpu-profile-"));
    const file = path.join(directory, "current.cpuprofile");
    const session = fakeSession();
    try {
      const recorder = createCpuProfileRecorder({ file, session, intervalMs: 60_000, log: () => undefined });
      recorder.start();
      await recorder.flush();
      await recorder.flush();
      await recorder.dispose();

      const current = JSON.parse(readFileSync(file, "utf8")) as { nodes: unknown[] };
      const previous = JSON.parse(readFileSync(`${file}.1`, "utf8")) as { nodes: unknown[] };
      expect(current.nodes).toHaveLength(1);
      expect(previous.nodes).toHaveLength(1);
      expect(session.calls).toContain("Profiler.enable");
      expect(session.calls.filter((call) => call === "Profiler.start").length).toBeGreaterThan(1);
      expect(session.calls.at(-1)).toBe("disconnect");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
