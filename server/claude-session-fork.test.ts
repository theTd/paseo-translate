import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ClaudeForkCoordinator } from "./claude-fork-coordinator";
import { createClaudeSessionForkHandler } from "./claude-session-fork";
import { cloneClaudeSession } from "./claude-session-clone";
import { claudeProjectDir } from "./claude-project-dir";
import type { ClaudeSessionForkResult } from "../shared/claude-session-fork";

function forked(result: ClaudeSessionForkResult) {
  if (result.kind !== "forked") throw new Error(result.kind === "restart_required" ? result.message : result.kind);
  return result;
}

function daemonRequestTimeout(): Error {
  return new Error('Command failed: paseo import\n{"error":{"code":"DAEMON_REQUEST_TIMEOUT","message":"Timeout waiting for message (60000ms)"}}');
}

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "translate-claude-fork-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const configDir = path.join(root, "claude-config");
  const sourceSessionId = randomUUID();
  const project = claudeProjectDir(cwd, configDir);
  await mkdir(project, { recursive: true });
  const transcript = path.join(project, `${sourceSessionId}.jsonl`);
  await writeFile(transcript, JSON.stringify({ type: "user", sessionId: sourceSessionId, uuid: randomUUID(),
    message: { role: "user", content: "Original" } }) + "\n");
  const source = { id: randomUUID(), provider: "translate-claude", cwd, archivedAt: null,
    title: "Original session", persistence: { sessionId: `plugin:${JSON.stringify({ version: 1, data: { claudeSessionId: sourceSessionId } })}` } };
  const state = {
    target: undefined as undefined | { id: string; provider: string; cwd: string; title: string;
      workspaceId: string; labels: Record<string, string>; persistence: { sessionId: string } },
    failImportAfterRegistration: false,
    failRename: false,
    corruptTitle: false,
    wrongDaemon: false,
    busy: false,
    sourceSessionIdOverride: undefined as string | undefined,
  };
  const coordinator = new ClaudeForkCoordinator();
  const prepare = vi.fn(async () => {
    if (state.busy) throw new Error("Background tasks are running");
    return { claudeSessionId: state.sourceSessionIdOverride ?? sourceSessionId, configDir,
      config: { cwd, env: { CUSTOM_ENV: "keep", PASEO_AGENT_ID: source.id, PASEO_AGENT_CWD: cwd,
        PASEO_TRANSLATE_AGENT_ID: source.id }, systemPrompt: "Keep the source instructions", mcpServers: {}, model: "claude-sonnet-4-6", mode: "acceptEdits",
        settings: { fast_mode: true }, persist: true } };
  });
  coordinator.register(source.id, prepare);
  const list = vi.fn(async () => ({ entries: state.target ? [{ agent: state.target }] : [],
    pageInfo: { nextCursor: null, hasMore: false } }));
  const context = { paseo: { agents: {
    ref: (id: string) => ({ refresh: async () => {
      const agent = id === source.id ? source : state.target?.id === id ? state.target : null;
      return agent ? { agent } : null;
    } }), list,
  } } } as unknown as PluginHandlerContext;
  const cli = vi.fn(async (args: string[]) => {
    if (args[0] === "agent" && args[1] === "inspect") {
      return JSON.stringify({ Id: state.wrongDaemon ? randomUUID() : source.id, Provider: source.provider, Cwd: cwd });
    }
    if (args[0] === "import") {
      const persistence = JSON.parse(args[1].slice("plugin:".length)) as { data: { claudeSessionId: string; forkConfig: { model: string } } };
      expect(persistence.data.forkConfig.model).toBe("claude-sonnet-4-6");
      state.target = { id: randomUUID(), provider: source.provider, cwd, title: "Original", workspaceId: randomUUID(),
        labels: { "translate.claude-fork-operation": args[args.indexOf("--label") + 1].split("=")[1] },
        persistence: { sessionId: args[1] } };
      if (state.failImportAfterRegistration) {
        state.failImportAfterRegistration = false;
        throw new Error("CLI connection lost after registration");
      }
      return JSON.stringify({ agentId: state.target.id, provider: source.provider, cwd });
    }
    if (args[0] === "agent" && args[1] === "update") {
      if (state.failRename) { state.failRename = false; throw new Error("Rename temporarily failed"); }
      if (!state.target || args[2] !== state.target.id) throw new Error("Unexpected rename target");
      const title = args[args.indexOf("--name") + 1];
      state.target.title = state.corruptTitle ? title.replaceAll("(", "^^(").replaceAll(")", "^^)") : title;
      return "{}";
    }
    throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
  });
  const clone = vi.fn(cloneClaudeSession);
  const deps = { coordinator, directory: path.join(root, "operations"), cli, clone };
  const request = { agentId: source.id, operationId: randomUUID() };
  return { source, root, project, transcript, state, prepare, context, cli, clone, deps, request };
}

describe("Translate Claude fork operation", () => {
  it("copies once, imports under the translation provider, and persists a distinct title", async () => {
    const f = await fixture();
    const before = await readFile(f.transcript);
    const handler = createClaudeSessionForkHandler(f.deps);
    const [first, second] = await Promise.all([handler(f.request, f.context), handler(f.request, f.context)]);
    if (first.kind !== "forked") throw new Error(first.kind === "restart_required" ? first.message : first.kind);
    expect(second).toEqual(first);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
    expect(f.state.target?.title).toBe(`Original session (fork ${first.claudeSessionId.slice(0, 8)})`);
    expect(JSON.parse(f.state.target!.persistence.sessionId.slice("plugin:".length)).data.forkConfig)
      .toMatchObject({ systemPrompt: "Keep the source instructions", env: { CUSTOM_ENV: "keep" } });
    expect(JSON.parse(f.state.target!.persistence.sessionId.slice("plugin:".length)).data.forkConfig.env)
      .toEqual({ CUSTOM_ENV: "keep" });
    expect(await readFile(path.join(f.project, `${first.claudeSessionId}.jsonl`), "utf8")).toContain(f.state.target?.title);
    expect(await readFile(f.transcript)).toEqual(before);
    expect(f.source.title).toBe("Original session");
    expect(await createClaudeSessionForkHandler(f.deps)(f.request, f.context)).toEqual(first);
    expect(f.clone).toHaveBeenCalledTimes(1);
  });

  it("retries a failed rename after a handler restart without reimporting", async () => {
    const f = await fixture();
    f.state.failRename = true;
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow("Rename temporarily failed");
    const registeredId = f.state.target?.id;
    const result = forked(await createClaudeSessionForkHandler(f.deps)(f.request, f.context));
    expect(result.agentId).toBe(registeredId);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });

  it("repairs an already imported fork after title transport corruption without another copy", async () => {
    const f = await fixture();
    f.state.corruptTitle = true;
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow("Fork title verification failed");
    const registeredId = f.state.target?.id;
    f.state.corruptTitle = false;
    const result = forked(await createClaudeSessionForkHandler(f.deps)(f.request, f.context));
    expect(result.agentId).toBe(registeredId);
    expect(f.state.target?.title).toBe(`Original session (fork ${result.claudeSessionId.slice(0, 8)})`);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });

  it("recovers an import that succeeded before the CLI connection failed", async () => {
    const f = await fixture();
    f.state.failImportAfterRegistration = true;
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow("connection lost");
    const registeredId = f.state.target?.id;
    expect(forked(await createClaudeSessionForkHandler(f.deps)(f.request, f.context)).agentId).toBe(registeredId);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });

  it("keeps a timed-out import in progress and recovers its late registration without resubmitting", async () => {
    const f = await fixture();
    const original = f.cli.getMockImplementation()!;
    let importArgs: string[] | undefined;
    let submitted: () => void = () => {};
    const submission = new Promise<void>((resolve) => { submitted = resolve; });
    f.cli.mockImplementation(async (args: string[]) => {
      if (args[0] !== "import") return original(args);
      importArgs = args;
      submitted();
      throw daemonRequestTimeout();
    });
    const deps = { ...f.deps, inProgressAfterMs: 10, importPollIntervalMs: 1, importRecoveryTimeoutMs: 2_000 };
    const handler = createClaudeSessionForkHandler(deps);
    const first = handler(f.request, f.context);
    await submission;
    await expect(first).resolves.toEqual({ kind: "in_progress" });
    await expect(handler({ ...f.request, operationId: randomUUID() }, f.context))
      .resolves.toEqual({ kind: "in_progress", operationId: f.request.operationId });
    expect(f.state.target).toBeUndefined();
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);

    // The daemon completes the original request after the CLI has disconnected.
    await original(importArgs!);
    const registeredId = f.state.target!.id;
    let result = await handler(f.request, f.context);
    for (let attempts = 0; result.kind === "in_progress" && attempts < 100; attempts++) {
      result = await handler(f.request, f.context);
    }
    expect(forked(result).agentId).toBe(registeredId);
    expect(f.state.target!.title).toContain("(fork ");
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
    const [journal] = (await readdir(f.deps.directory)).filter((name) => name.endsWith(".json"));
    const saved = JSON.parse(await readFile(path.join(f.deps.directory, journal), "utf8"));
    expect(saved.agentId).toBe(registeredId);
    expect(saved.importStartedAt).toBeUndefined();
  });

  it("preserves an unconfirmed import after its recovery budget expires without submitting it again", async () => {
    const f = await fixture();
    const original = f.cli.getMockImplementation()!;
    let importArgs: string[] | undefined;
    f.cli.mockImplementation(async (args: string[]) => {
      if (args[0] !== "import") return original(args);
      importArgs = args;
      throw daemonRequestTimeout();
    });
    const deps = { ...f.deps, importPollIntervalMs: 1, importRecoveryTimeoutMs: 30 };
    const handler = createClaudeSessionForkHandler(deps);
    await expect(handler(f.request, f.context)).rejects.toThrow("Retry this operation");
    await expect(createClaudeSessionForkHandler(deps)(f.request, f.context)).rejects.toThrow("Retry this operation");
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);

    await original(importArgs!);
    const result = forked(await createClaudeSessionForkHandler(deps)(f.request, f.context));
    expect(result.agentId).toBe(f.state.target!.id);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });

  it("returns the durable operation key to attached attempts before an unconfirmed import fails", async () => {
    const f = await fixture();
    const original = f.cli.getMockImplementation()!;
    let importArgs: string[] | undefined;
    let submitted: () => void = () => {};
    const submission = new Promise<void>((resolve) => { submitted = resolve; });
    f.cli.mockImplementation(async (args: string[]) => {
      if (args[0] !== "import") return original(args);
      importArgs = args;
      submitted();
      throw daemonRequestTimeout();
    });
    const deps = { ...f.deps, importPollIntervalMs: 1, importRecoveryTimeoutMs: 40 };
    const handler = createClaudeSessionForkHandler(deps);
    const failure = expect(handler(f.request, f.context)).rejects.toThrow("Retry this operation");
    await submission;
    const attached = await handler({ ...f.request, operationId: randomUUID() }, f.context);
    expect(attached).toEqual({ kind: "in_progress", operationId: f.request.operationId });
    if (attached.kind !== "in_progress" || !attached.operationId) throw new Error("Missing retry key");
    const retry = { ...f.request, operationId: attached.operationId };
    await failure;
    await expect(createClaudeSessionForkHandler(deps)(retry, f.context)).rejects.toThrow("Retry this operation");
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);

    await original(importArgs!);
    expect(forked(await createClaudeSessionForkHandler(deps)(retry, f.context)).agentId).toBe(f.state.target!.id);
    expect(f.clone).toHaveBeenCalledTimes(1);
  });

  it("recovers a verified copy published before the operation journal was updated", async () => {
    const f = await fixture();
    f.clone.mockImplementationOnce(async (input) => {
      await cloneClaudeSession(input);
      throw new Error("Stopped after copy publication");
    });
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow("Stopped after copy");
    const result = forked(await createClaudeSessionForkHandler(f.deps)(f.request, f.context));
    expect(result.agentId).toBe(f.state.target?.id);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });

  it("rejects a corrupted recovery manifest before importing an incomplete copy", async () => {
    const f = await fixture();
    f.clone.mockImplementationOnce(async (input) => {
      await cloneClaudeSession(input);
      const manifest = path.join(f.project, `${input.newSessionId}.clone.json`);
      const saved = JSON.parse(await readFile(manifest, "utf8")) as { files: unknown[] };
      saved.files = [];
      await writeFile(manifest, JSON.stringify(saved));
      throw new Error("Stopped after copy publication");
    });
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow("Stopped after copy");
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow();
    expect(f.cli.mock.calls.some(([args]) => args[0] === "import")).toBe(false);
    expect(f.clone).toHaveBeenCalledTimes(1);
  });

  it("offers a fresh operation after a failed copy and source rewind without reusing the stale key", async () => {
    const f = await fixture();
    f.clone.mockRejectedValueOnce(new Error("Copy temporarily failed"));
    const handler = createClaudeSessionForkHandler(f.deps);
    await expect(handler(f.request, f.context)).rejects.toThrow("Copy temporarily failed");
    const rewoundId = randomUUID();
    f.state.sourceSessionIdOverride = rewoundId;
    await writeFile(path.join(f.project, `${rewoundId}.jsonl`), JSON.stringify({ type: "user", sessionId: rewoundId,
      uuid: randomUUID(), message: { role: "user", content: "Rewound source" } }) + "\n");
    expect(await handler(f.request, f.context)).toMatchObject({ kind: "restart_required" });
    expect(f.clone).toHaveBeenCalledTimes(1);
    const result = forked(await handler({ ...f.request, operationId: randomUUID() }, f.context));
    expect(await readFile(path.join(f.project, `${result.claudeSessionId}.jsonl`), "utf8")).toContain("Rewound source");
    expect(f.clone).toHaveBeenCalledTimes(2);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });

  it("rejects a mismatched daemon before creating any copy", async () => {
    const f = await fixture();
    f.state.wrongDaemon = true;
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow("different daemon");
    expect(f.clone).not.toHaveBeenCalled();
    expect((await readdir(f.project)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("rejects active background work instead of canceling it", async () => {
    const f = await fixture();
    f.state.busy = true;
    await expect(createClaudeSessionForkHandler(f.deps)(f.request, f.context)).rejects.toThrow("Background tasks");
    expect(f.clone).not.toHaveBeenCalled();
  });

  it("reports in progress while a long import runs, then finishes on the next call", async () => {
    const f = await fixture();
    const original = f.cli.getMockImplementation()!;
    let openImport: () => void = () => {};
    const importGate = new Promise<void>((resolve) => { openImport = resolve; });
    f.cli.mockImplementation(async (args: string[]) => {
      if (args[0] === "import") await importGate;
      return original(args);
    });
    const handler = createClaudeSessionForkHandler({ ...f.deps, inProgressAfterMs: 10 });
    await expect(handler(f.request, f.context)).resolves.toEqual({ kind: "in_progress" });
    openImport();
    let settled = await handler(f.request, f.context);
    for (let attempts = 0; settled.kind === "in_progress" && attempts < 100; attempts++) {
      settled = await handler(f.request, f.context);
    }
    const result = forked(settled);
    expect(result.agentId).toBe(f.state.target?.id);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });

  it("lets a restarted operation attach to the fork already in flight", async () => {
    const f = await fixture();
    const original = f.cli.getMockImplementation()!;
    let openImport: () => void = () => {};
    const importGate = new Promise<void>((resolve) => { openImport = resolve; });
    f.cli.mockImplementation(async (args: string[]) => {
      if (args[0] === "import") await importGate;
      return original(args);
    });
    const handler = createClaudeSessionForkHandler({ ...f.deps, inProgressAfterMs: 10 });
    await expect(handler(f.request, f.context)).resolves.toEqual({ kind: "in_progress" });
    await expect(handler({ ...f.request, operationId: randomUUID() }, f.context))
      .resolves.toEqual({ kind: "in_progress", operationId: f.request.operationId });
    openImport();
    let settled = await handler(f.request, f.context);
    for (let attempts = 0; settled.kind === "in_progress" && attempts < 100; attempts++) {
      settled = await handler(f.request, f.context);
    }
    const result = forked(settled);
    expect(result.agentId).toBe(f.state.target?.id);
    expect(f.clone).toHaveBeenCalledTimes(1);
    expect(f.cli.mock.calls.filter(([args]) => args[0] === "import")).toHaveLength(1);
  });
});
