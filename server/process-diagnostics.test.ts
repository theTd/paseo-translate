import { describe, expect, it, vi } from "vitest";
import { installProcessDiagnostics } from "./process-diagnostics";

type Handler = (...args: any[]) => void;

function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    handlers.set(String(event), listener as Handler);
    return process;
  });
  return handlers;
}

describe("process diagnostics", () => {
  it("records lifecycle exits, fatal errors and termination signals", () => {
    const handlers = captureHandlers();
    const lines: string[] = [];
    const exits: number[] = [];
    try {
      installProcessDiagnostics({
        log: (line) => lines.push(line),
        exit: (code) => exits.push(code),
      });

      handlers.get("exit")?.(0);
      handlers.get("uncaughtExceptionMonitor")?.(new Error("boom"), "uncaughtException");
      handlers.get("unhandledRejection")?.(new Error("rejected"));
      handlers.get("SIGTERM")?.();
      handlers.get("SIGINT")?.();

      expect(exits).toEqual([1, 143, 130]);
      const output = lines.join("\n");
      expect(output).toContain("[translate] process exit code=0");
      expect(output).toContain("fatal uncaughtException origin=uncaughtException");
      expect(output).toContain("boom");
      expect(output).toContain("fatal unhandledRejection");
      expect(output).toContain("rejected");
      expect(output).toContain("[translate] signal SIGTERM");
      expect(output).toContain("[translate] signal SIGINT");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
