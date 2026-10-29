import { writeDiagnostic } from "./memory-probe";

export interface ProcessDiagnosticsOptions {
  log?: (line: string) => void;
  exit?: (code: number) => void;
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
}

export function installProcessDiagnostics(options: ProcessDiagnosticsOptions = {}): void {
  const log = options.log ?? writeDiagnostic;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  process.on("exit", (code) => {
    log(`[translate] process exit code=${code}`);
  });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    log(`[translate] fatal uncaughtException origin=${origin}\n${describeReason(error)}`);
  });
  process.on("unhandledRejection", (reason) => {
    log(`[translate] fatal unhandledRejection\n${describeReason(reason)}`);
    exit(1);
  });
  process.on("SIGTERM", () => {
    log("[translate] signal SIGTERM");
    exit(143);
  });
  process.on("SIGINT", () => {
    log("[translate] signal SIGINT");
    exit(130);
  });
}
