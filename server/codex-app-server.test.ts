import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerClient,
  processTreeKillInvocation,
  resolveCodexSpawnInvocation,
  scanPathForCodex,
  type CodexStdioProcess,
} from "./codex-app-server";

function createFakeProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child: CodexStdioProcess = {
    stdin,
    stdout,
    stderr,
    kill() {
      emitter.emit("exit", 0, null);
      return true;
    },
    on(event, listener) {
      emitter.on(event, listener);
      return child;
    },
  };
  return { child, stdin, stdout, stderr, emitter };
}

describe("Codex Windows spawn invocation", () => {
  it("routes shims and extensionless names through cmd /c", () => {
    expect(resolveCodexSpawnInvocation("codex", ["app-server"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "codex", "app-server"],
    });
    expect(
      resolveCodexSpawnInvocation("C:\\npm\\codex.cmd", ["app-server"], "win32"),
    ).toEqual({
      command: "cmd.exe",
      args: ["/c", "C:\\npm\\codex.cmd", "app-server"],
    });
    expect(
      resolveCodexSpawnInvocation("C:\\bin\\codex.exe", ["app-server"], "win32"),
    ).toEqual({
      command: "C:\\bin\\codex.exe",
      args: ["app-server"],
    });
    expect(resolveCodexSpawnInvocation("codex", ["app-server"], "linux")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("uses taskkill /t on Windows process trees", () => {
    expect(processTreeKillInvocation(4242, "win32")).toEqual({
      command: "taskkill",
      args: ["/pid", "4242", "/t", "/f"],
    });
    expect(processTreeKillInvocation(4242, "linux")).toBeNull();
  });
});

describe("PATH codex resolution", () => {
  it("prefers native executables over shell shims", async () => {
    const shimDir = await mkdtemp(path.join(os.tmpdir(), "codex-shim-"));
    const exeDir = await mkdtemp(path.join(os.tmpdir(), "codex-exe-"));
    await writeFile(path.join(shimDir, "codex.cmd"), "");
    await writeFile(path.join(exeDir, "codex.exe"), "");
    try {
      expect(scanPathForCodex(`Z:\\missing;${shimDir};${exeDir}`, "win32")).toBe(
        path.join(exeDir, "codex.exe"),
      );
      expect(scanPathForCodex(`Z:\\missing;${shimDir}`, "win32")).toBe(
        path.join(shimDir, "codex.cmd"),
      );
      expect(scanPathForCodex(`Z:\\missing;${exeDir}`, "linux")).toBeNull();
    } finally {
      await rm(shimDir, { recursive: true, force: true });
      await rm(exeDir, { recursive: true, force: true });
    }
  });
});

describe("Codex app-server transport", () => {
  it("round-trips JSON-RPC requests, notifications, and inbound server requests", async () => {
    const fake = createFakeProcess();
    const inbound: string[] = [];
    fake.stdin.on("data", (chunk: Buffer) => inbound.push(chunk.toString()));
    const client = new CodexAppServerClient(fake.child);
    const notifications: Array<{ method: string; params: unknown }> = [];
    client.setNotificationHandler((method, params) => notifications.push({ method, params }));
    client.setRequestHandler("item/commandExecution/requestApproval", (params) => ({
      decision: "accept",
      echoed: params,
    }));

    const pending = client.request("initialize", { clientInfo: { name: "test" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inbound.join("")).toContain('"method":"initialize"');
    fake.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await expect(pending).resolves.toEqual({ ok: true });

    client.notify("initialized", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inbound.join("")).toContain('"method":"initialized"');

    fake.stdout.write(
      `${JSON.stringify({ method: "turn/started", params: { turnId: "t1" } })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications).toEqual([{ method: "turn/started", params: { turnId: "t1" } }]);

    fake.stdout.write(
      `${JSON.stringify({
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: { command: "ls" },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inbound.join("")).toContain('"decision":"accept"');

    await client.dispose();
  });

  it("rejects pending requests when the child exits", async () => {
    const fake = createFakeProcess();
    const client = new CodexAppServerClient(fake.child);
    const pending = client.request("model/list", {});
    fake.emitter.emit("exit", 17, null);
    await expect(pending).rejects.toThrow("Codex app-server exited");
  });

  it("ACKs unknown inbound methods with an empty result", async () => {
    const fake = createFakeProcess();
    const inbound: string[] = [];
    fake.stdin.on("data", (chunk: Buffer) => inbound.push(chunk.toString()));
    const client = new CodexAppServerClient(fake.child);
    fake.stdout.write(
      `${JSON.stringify({ id: 7, method: "mcpServer/elicitation/request", params: {} })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inbound.join("")).toContain('"id":7');
    expect(inbound.join("")).toContain('"result":{}');
    expect(inbound.join("")).not.toContain('"error"');
    await client.dispose();
  });

  it("fails a request immediately when stdin is not writable", async () => {
    const fake = createFakeProcess();
    const client = new CodexAppServerClient(fake.child);
    fake.stdin.end();
    await expect(client.request("initialize", {})).rejects.toThrow("stdin is not writable");
  });
});
