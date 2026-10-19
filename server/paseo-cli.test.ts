import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPaseoCli, isPaseoCliRequestTimeout } from "./paseo-cli";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("installed Paseo CLI argv transport", () => {
  it("preserves titles, JSON handles and paths through a real process without shell interpretation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo cli argv "));
    roots.push(root);
    const cliDirectory = path.join(root, "node_modules", "@getpaseo", "cli", "dist");
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(path.join(cliDirectory, "index.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    const home = path.join(root, "home (test) & cache");
    const args = ["agent", "update", "id", "--name", '中文 原标题 (fork 1234) & | < > ^ ! %PATH% "quoted"',
      'plugin:{"version":1,"data":{"configDir":"C:\\\\Users\\\\test (user)"}}'];
    const cli = createPaseoCli(home, path.join(root, "daemon.js"));
    expect(JSON.parse(await cli(args))).toEqual([...args, "--home", home, "--json"]);
  });

  it("fails before invoking a command when the daemon's CLI package is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-cli-missing-"));
    roots.push(root);
    await expect(createPaseoCli(root, path.join(root, "daemon.js"))(["--version"]))
      .rejects.toThrow("@getpaseo/cli/dist/index.js");
  });

  it("recognizes the CLI's JSON daemon timeout in a real failed process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-cli-timeout-"));
    roots.push(root);
    const cliDirectory = path.join(root, "node_modules", "@getpaseo", "cli", "dist");
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(path.join(cliDirectory, "index.js"),
      'console.error(JSON.stringify({ error: { code: "DAEMON_REQUEST_TIMEOUT", message: "Timeout waiting for message (60000ms)" } })); process.exitCode = 1;');
    const cli = createPaseoCli(root, path.join(root, "daemon.js"));
    const failure = await cli(["import", "handle"]).catch((error: unknown) => error);
    expect(isPaseoCliRequestTimeout(failure)).toBe(true);
    expect(isPaseoCliRequestTimeout({ code: "DAEMON_REQUEST_TIMEOUT" })).toBe(true);
    expect(isPaseoCliRequestTimeout(new Error("Import rejected"))).toBe(false);
    expect(isPaseoCliRequestTimeout(new Error('Command failed: {"code":"AGENT_IMPORT_FAILED"}'))).toBe(false);
    expect(isPaseoCliRequestTimeout(null)).toBe(false);
  });
});
