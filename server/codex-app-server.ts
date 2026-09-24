/**
 * JSON-RPC stdio transport for `codex app-server`, simplified from Paseo's
 * native Codex adapter (`app-server-transport.ts`). No pino: errors go to
 * stderr like the rest of this plugin's server code.
 */

import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 120_000;
const STDERR_BUFFER_LIMIT = 8_192;
const SHUTDOWN_GRACE_MS = 2_000;
const SHUTDOWN_FORCE_MS = 1_000;

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: string | number | undefined,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

export interface CodexStdioProcess {
  pid?: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type CodexRequestHandler = (params: unknown, requestId: number) => unknown;
export type CodexNotificationHandler = (method: string, params: unknown) => void;
export type CodexTerminationHandler = (error: Error) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export interface CodexClientLike {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  setNotificationHandler(handler: CodexNotificationHandler): void;
  setRequestHandler(method: string, handler: CodexRequestHandler): void;
  setUnexpectedTerminationHandler(handler: CodexTerminationHandler): void;
  dispose(): Promise<void>;
}

/**
 * Resolves the `codex` executable from PATH so the provider drives the
 * user's own CLI install (and login), matching the native Paseo adapter.
 * Name priority wins over PATH order: a native `codex.exe` later on PATH
 * beats a `codex.cmd` shim earlier on it.
 */
export function scanPathForCodex(pathValue: string, platform: string): string | null {
  const isWindows = platform === "win32";
  const names = isWindows ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"];
  const delimiter = isWindows ? ";" : ":";
  const directories = pathValue.split(delimiter);
  for (const name of names) {
    for (const directory of directories) {
      if (directory.length === 0) continue;
      const candidate = path.join(directory, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep scanning; a directory named codex is not an executable.
      }
    }
  }
  return null;
}

let cachedPathCodex: string | null | undefined;

export function resolvePathCodex(): string | null {
  if (cachedPathCodex === undefined) {
    cachedPathCodex = scanPathForCodex(process.env.PATH ?? "", process.platform);
  }
  return cachedPathCodex;
}

/** Test seam: clears the PATH scan cache. */
export function resetPathCodexCache(): void {
  cachedPathCodex = undefined;
}

export interface SpawnCodexOptions {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexClientFactoryOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Windows launch shape, matching Paseo's spawnProcess: `.cmd`/`.bat` shims
 * and extensionless names (`codex` on PATH) need `cmd /c`; a native `.exe`
 * (including an absolute path) can be spawned directly.
 */
export function resolveCodexSpawnInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  const copied = [...args];
  if (platform !== "win32") return { command, args: copied };
  const extension = path.extname(command);
  const hasSeparator = command.includes("/") || command.includes("\\");
  const needsShell =
    /\.(cmd|bat)$/i.test(command) || (extension.length === 0 && !hasSeparator);
  if (!needsShell) return { command, args: copied };
  return { command: "cmd.exe", args: ["/c", command, ...copied] };
}

/**
 * Windows cmd-wrapped Codex leaves a grandchild after SIGTERM on cmd.exe.
 * `taskkill /t` matches Paseo's tree-kill on that path; POSIX keeps signals.
 */
export function processTreeKillInvocation(
  pid: number,
  platform: NodeJS.Platform,
): { command: string; args: string[] } | null {
  if (platform !== "win32") return null;
  return { command: "taskkill", args: ["/pid", String(pid), "/t", "/f"] };
}

/**
 * Spawns `codex app-server`. npm's Windows shims are `.cmd` scripts and
 * cannot be spawned without a shell, so those route through `cmd /c`.
 */
export function spawnCodexAppServer(options: SpawnCodexOptions): ChildProcessWithoutNullStreams {
  const invocation = resolveCodexSpawnInvocation(options.command, ["app-server"], process.platform);
  const env = { ...process.env, ...options.env };
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  const child = spawn(invocation.command, invocation.args, spawnOptions);
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error("Codex app-server child process did not expose stdio pipes");
  }
  return child as ChildProcessWithoutNullStreams;
}

export class CodexAppServerClient implements CodexClientLike {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, CodexRequestHandler>();
  private notificationHandler: CodexNotificationHandler | null = null;
  private unexpectedTerminationHandler: CodexTerminationHandler | null = null;
  private nextId = 1;
  private disposed = false;
  private stderrBuffer = "";

  constructor(private readonly child: CodexStdioProcess) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      void this.handleLine(line).catch((error) => {
        console.warn(
          `[translate-codex] Failed to handle Codex app-server stdout line: ${describeError(error)}`,
        );
      });
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    child.on("error", (err) => {
      console.error(`[translate-codex] Codex app-server child process error: ${err.message}`);
      this.handleUnexpectedTermination(err);
    });
    child.on("exit", (code, signal) => {
      const message =
        code === 0 && !signal
          ? "Codex app-server exited"
          : `Codex app-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}`;
      this.handleUnexpectedTermination(new Error(`${message}\n${this.stderrBuffer}`.trim()));
    });
  }

  setUnexpectedTerminationHandler(handler: CodexTerminationHandler): void {
    this.unexpectedTerminationHandler = handler;
  }

  setNotificationHandler(handler: CodexNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: CodexRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writePayload({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.write({ method, params });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unexpectedTerminationHandler = null;
    this.rl.close();
    this.rejectPending(new Error("Codex app-server client is closed"));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const exited = waitForExit(this.child);
    this.terminateChild();
    const graceful = await Promise.race([
      exited.then(() => "exited" as const),
      sleep(SHUTDOWN_GRACE_MS).then(() => "timeout" as const),
    ]);
    if (graceful === "timeout") {
      this.terminateChild(true);
      const forced = await Promise.race([
        exited.then(() => "exited" as const),
        sleep(SHUTDOWN_FORCE_MS).then(() => "timeout" as const),
      ]);
      if (forced === "timeout") {
        throw new Error("Codex app-server did not report exit after SIGKILL");
      }
    }
  }

  private handleUnexpectedTermination(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rl.close();
    this.rejectPending(error);
    const handler = this.unexpectedTerminationHandler;
    this.unexpectedTerminationHandler = null;
    if (!handler) return;
    try {
      handler(error);
    } catch (handlerError) {
      console.warn(
        `[translate-codex] Codex app-server termination handler threw: ${describeError(handlerError)}`,
      );
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminateChild(force = false): void {
    const pid = this.child.pid;
    const tree = typeof pid === "number" ? processTreeKillInvocation(pid, process.platform) : null;
    if (tree !== null) {
      spawn(tree.command, tree.args, { windowsHide: true, stdio: "ignore" });
      return;
    }
    this.child.kill(force ? "SIGKILL" : "SIGTERM");
  }

  private writePayload(payload: unknown): void {
    if (!this.child.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private write(payload: unknown): void {
    try {
      this.writePayload(payload);
    } catch (error) {
      console.warn(`[translate-codex] Failed to write Codex app-server JSON-RPC: ${describeError(error)}`);
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      console.warn(`[translate-codex] Ignoring non-JSON Codex app-server stdout line`);
      return;
    }
    if (!isRecord(raw)) return;

    if (typeof raw.id === "number" && typeof raw.method === "string") {
      const handler = this.requestHandlers.get(raw.method);
      if (handler === undefined) {
        // Native Codex adapter ACKs unknown inbound methods with an empty
        // result so experimental RPCs (elicitation, terminal interaction)
        // do not fail the turn.
        this.write({ id: raw.id, result: {} });
        return;
      }
      try {
        const result = await handler(raw.params, raw.id);
        this.write({ id: raw.id, result: result ?? {} });
      } catch (error) {
        this.write({ id: raw.id, error: { message: describeError(error) } });
      }
      return;
    }

    if (typeof raw.id === "number" && (raw.result !== undefined || raw.error !== undefined)) {
      const pending = this.pending.get(raw.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(raw.id);
      if (isRecord(raw.error)) {
        pending.reject(
          new CodexAppServerRpcError(
            typeof raw.error.message === "string" ? raw.error.message : "Unknown error",
            typeof raw.error.code === "string" || typeof raw.error.code === "number"
              ? raw.error.code
              : undefined,
            raw.error.data,
          ),
        );
        return;
      }
      pending.resolve(raw.result);
      return;
    }

    if (typeof raw.method === "string") {
      this.notificationHandler?.(raw.method, raw.params);
    }
  }
}

function waitForExit(child: CodexStdioProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const CODEX_NON_ORIGINATING_CLIENT_INFO = {
  name: "codex_app_server_daemon",
  title: "Codex App Server Daemon",
  version: "0.0.0",
} as const;

export function buildCodexInitializeParams(): {
  clientInfo: { name: string; title: string; version: string };
  capabilities: { experimentalApi: true };
} {
  return {
    clientInfo: CODEX_NON_ORIGINATING_CLIENT_INFO,
    capabilities: {
      experimentalApi: true,
    },
  };
}
