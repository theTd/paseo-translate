import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execCommand } from "@getpaseo/plugin/server";
import { IMPORT_REQUEST_ENV, IMPORT_SCRIPT, createPaseoCli, createPaseoImport, isPaseoCliRequestTimeout } from "./paseo-cli";

// Default to the real process wrapper; the import transport test stubs one call.
vi.mock("@getpaseo/plugin/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@getpaseo/plugin/server")>();
  return { ...actual, execCommand: vi.fn(actual.execCommand) };
});

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

describe("Paseo daemon import transport", () => {
  it("passes the import request through the environment and a file URL client module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-import-"));
    roots.push(root);
    const clientModule = path.join(root, "node_modules", "@getpaseo", "cli", "dist", "utils", "client.js");
    await mkdir(path.dirname(clientModule), { recursive: true });
    await writeFile(clientModule, "export {}");
    const home = path.join(root, "home (test) & cache");
    const request = { handle: 'plugin:{"data":"中文 & | < > ^ ! %PATH%"}', provider: "translate-claude",
      cwd: "C:\\work (x) & y", workspaceId: "workspace-1",
      labels: { "translate.claude-fork-operation": "operation-1" } };
    const exec = vi.mocked(execCommand);
    const before = exec.mock.calls.length;
    exec.mockResolvedValueOnce({ stdout: '{"agentId":"imported"}', stderr: "" });
    await expect(createPaseoImport(home, path.join(root, "daemon.js"))(request)).resolves.toBe('{"agentId":"imported"}');
    const [command, args, options] = exec.mock.calls[before];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["-e", IMPORT_SCRIPT]);
    expect(options?.shell).toBe(false);
    expect(options?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(JSON.parse(options!.env![IMPORT_REQUEST_ENV]!))
      .toEqual({ clientModule: pathToFileURL(clientModule).href, home, ...request });
  });

  it("runs the import script against a real client module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-import-script-"));
    roots.push(root);
    const record = path.join(root, "record.json");
    const clientModule = path.join(root, "fake-client.mjs");
    await writeFile(clientModule, `
import { writeFileSync } from "node:fs";
export async function connectToDaemon(options) {
  return {
    async importAgent(input) {
      writeFileSync(${JSON.stringify(record)}, JSON.stringify({ target: options.target, input }));
      return { id: 'agent-1', provider: input.provider, cwd: input.cwd, workspaceId: input.workspaceId };
    },
    async close() {},
  };
}
`);
    const payload = { clientModule: pathToFileURL(clientModule).href, home: path.join(root, "home"),
      handle: "plugin:handle", provider: "translate-claude", cwd: path.join(root, "project"),
      workspaceId: "workspace-2", labels: { "translate.claude-fork-operation": "operation-2" } };
    const stdout = execFileSync(process.execPath, ["-e", IMPORT_SCRIPT], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [IMPORT_REQUEST_ENV]: JSON.stringify(payload) },
      encoding: "utf8" });
    expect(JSON.parse(stdout)).toEqual({ agentId: "agent-1", provider: payload.provider, cwd: payload.cwd,
      workspaceId: payload.workspaceId });
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ target: { kind: "instance", home: payload.home },
      input: { provider: payload.provider, sessionId: payload.handle, cwd: payload.cwd,
        workspaceId: payload.workspaceId, labels: payload.labels } });
  });

  it("reports a daemon timeout with a nonzero exit for the recovery check", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-import-timeout-"));
    roots.push(root);
    const clientModule = path.join(root, "timeout-client.mjs");
    await writeFile(clientModule, `
export async function connectToDaemon() {
  return {
    async importAgent() {
      throw Object.assign(new Error('Timeout waiting for message (60000ms)'), { code: 'DAEMON_REQUEST_TIMEOUT' });
    },
    async close() {},
  };
}
`);
    const payload = { clientModule: pathToFileURL(clientModule).href, home: path.join(root, "home"),
      handle: "plugin:handle", provider: "translate-claude", cwd: path.join(root, "project"),
      labels: { "translate.claude-fork-operation": "operation-3" } };
    const failure = spawnSync(process.execPath, ["-e", IMPORT_SCRIPT], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [IMPORT_REQUEST_ENV]: JSON.stringify(payload) },
      encoding: "utf8" });
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain('"code":"DAEMON_REQUEST_TIMEOUT"');
    expect(isPaseoCliRequestTimeout(new Error(failure.stderr))).toBe(true);
  });
});
