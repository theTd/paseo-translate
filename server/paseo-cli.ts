import { createRequire } from "node:module";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";

/** A daemon response timeout leaves the daemon-side operation running. */
export function isPaseoCliRequestTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "DAEMON_REQUEST_TIMEOUT") return true;
  // execCommand includes the CLI's JSON stderr in its error message. The
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
