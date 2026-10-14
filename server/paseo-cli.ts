import { createRequire } from "node:module";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";

/** Use the daemon's installed CLI through Node so Windows shims cannot alter argv. */
export function createPaseoCli(home: string, anchor = process.argv[1]) {
  let entry: string | undefined;
  return async (args: string[]): Promise<string> => {
    if (!anchor) throw new Error("Cannot locate the installed Paseo CLI without a daemon entrypoint");
    entry ??= createRequire(path.resolve(anchor)).resolve("@getpaseo/cli/dist/index.js");
    const result = await execCommand(process.execPath, [entry, ...args, "--home", home, "--json"], {
      shell: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 25_000,
      maxBuffer: 2_000_000,
    });
    return result.stdout;
  };
}
