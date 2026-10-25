import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execCommand } from "@getpaseo/plugin/server";

/** A daemon response timeout leaves the daemon-side operation running. */
export function isPaseoCliRequestTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "DAEMON_REQUEST_TIMEOUT") return true;
  // execCommand includes the child's JSON stderr in its error message. The
  // process exit code alone cannot distinguish a timeout from a rejected import.
  return "message" in error && typeof error.message === "string" &&
    /"code"\s*:\s*"DAEMON_REQUEST_TIMEOUT"/.test(error.message);
}

/** Use the daemon's installed CLI through Node so Windows shims cannot alter argv. */
export function createPaseoCli(home: string, anchor = process.argv[1]) {
  let entry: string | undefined;
  return async (args: string[]): Promise<string> => {
    if (!anchor) throw new Error("Cannot locate the installed Paseo CLI without a daemon entrypoint");
    entry ??= createRequire(path.resolve(anchor)).resolve("@getpaseo/cli/dist/index.js");
    const result = await execCommand(process.execPath, [entry, ...args, "--home", home, "--json"], {
      shell: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      // Allow the CLI to reach its own daemon-response timeout. That timeout
      // does not cancel an import; the fork handler reconciles it by label.
      timeout: 180_000,
      maxBuffer: 2_000_000,
    });
    return result.stdout;
  };
}

export interface PaseoImportRequest {
  handle: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  labels: Record<string, string>;
}

/** The request travels in the environment: Windows argv quoting cannot carry this JSON. */
export const IMPORT_REQUEST_ENV = "PASEO_PLUGIN_IMPORT_REQUEST";

/**
 * Child-process body for {@link createPaseoImport}. It dials the daemon's own
 * client instead of the `paseo import` command, which has no workspace option.
 */
export const IMPORT_SCRIPT = `(async () => {
  const request = JSON.parse(process.env.${IMPORT_REQUEST_ENV});
  const { connectToDaemon } = await import(request.clientModule);
  const client = await connectToDaemon({ target: { kind: 'instance', home: request.home } });
  try {
    const agent = await client.importAgent({ provider: request.provider, sessionId: request.handle, cwd: request.cwd,
      labels: request.labels, ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}) });
    process.stdout.write(JSON.stringify({ agentId: agent.id, provider: agent.provider, cwd: agent.cwd, workspaceId: agent.workspaceId }));
  } finally {
    await client.close().catch(() => {});
  }
})().catch((error) => {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  process.stderr.write(JSON.stringify({ error: { code: (error && error.code) || 'IMPORT_FAILED', message: message } }));
  process.exitCode = 1;
});
`;

/**
 * Import through the daemon client so the fork keeps the source agent's
 * workspace. `paseo import` cannot pass one, and without it the daemon picks
 * the oldest workspace that shares the import cwd.
 */
export function createPaseoImport(home: string, anchor = process.argv[1]): (request: PaseoImportRequest) => Promise<string> {
  let clientModule: string | undefined;
  return async (request) => {
    if (!anchor) throw new Error("Cannot locate the installed Paseo CLI without a daemon entrypoint");
    clientModule ??= pathToFileURL(createRequire(path.resolve(anchor)).resolve("@getpaseo/cli/dist/utils/client.js")).href;
    const result = await execCommand(process.execPath, ["-e", IMPORT_SCRIPT], {
      shell: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1",
        [IMPORT_REQUEST_ENV]: JSON.stringify({ clientModule, home, ...request }) },
      // Let the daemon's own response timeout surface; it does not cancel an
      // import, and the fork handler reconciles that by label.
      timeout: 180_000,
      maxBuffer: 2_000_000,
    });
    return result.stdout;
  };
}
