import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cloneClaudeSession } from "./claude-session-clone";

const fault = vi.hoisted(() => ({ target: "", source: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await fs.readFile(...args);
    if (String(args[0]) === fault.target) {
      fault.target = "";
      await fs.appendFile(fault.source, "\n");
    }
    return bytes;
  } };
});

const directories: string[] = [];
afterEach(async () => {
  fault.target = "";
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "translate-claude-clone-"));
  directories.push(root);
  const configDir = path.join(root, ".claude");
  const project = path.join(configDir, "projects", "fixture");
  const sourceId = randomUUID();
  const transcript = path.join(project, `${sourceId}.jsonl`);
  await mkdir(project, { recursive: true });
  const unrelated = randomUUID();
  const user = randomUUID();
  const assistant = randomUUID();
  const tool = "toolu_123456789abcdefg";
  const mcpTool = "mcptoolu_fixture123456";
  const serverTool = "srvtoolu_fixture123456";
  const child = "abc1234";
  const workflow = randomUUID();
  const nestedMessage = randomUUID();
  const records = [
    { type: "user", sessionId: sourceId, uuid: user, message: { role: "user", content: "你好" } },
    { type: "assistant", sessionId: sourceId, uuid: assistant, parentUuid: user,
      message: { role: "assistant", id: "msg_123456789abcdefg", content: [
        { type: "tool_use", id: tool, name: "Agent", input: { technical_uuid: unrelated } },
        { type: "mcp_tool_use", id: mcpTool, name: "remote", input: { technical_uuid: unrelated } },
        { type: "mcp_tool_result", tool_use_id: mcpTool, content: "MCP result" },
        { type: "server_tool_use", id: serverTool, name: "web_search", input: { technical_uuid: unrelated } },
        { type: "web_search_tool_result", tool_use_id: serverTool, content: [] },
      ] } },
    { type: "user", sessionId: sourceId, uuid: randomUUID(), parentUuid: assistant,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: `agentId: ${child}` }] },
      toolUseResult: { agentId: child } },
    { type: "system", sessionId: sourceId, subtype: "task_started", task_id: workflow, task_type: "local_workflow" },
  ];
  await writeFile(transcript, "\ufeff" + records.map((record) => JSON.stringify(record)).join("\r\n") + "\r\n");
  const agents = path.join(project, sourceId, "subagents");
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, `agent-${child}.jsonl`), JSON.stringify({ type: "assistant", uuid: randomUUID(),
    sessionId: sourceId, agentId: child, message: { role: "assistant", content: "Done" } }));
  await writeFile(path.join(agents, `agent-${child}.meta.json`), JSON.stringify({ agentId: child, toolUseId: tool }));
  const workflows = path.join(project, sourceId, "workflows");
  await mkdir(workflows);
  await writeFile(path.join(workflows, `${workflow}.json`), JSON.stringify({ runId: workflow, summary: "Workflow" }));
  const nested = path.join(agents, "workflows", workflow);
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "journal.jsonl"), JSON.stringify({ type: "assistant", uuid: nestedMessage,
    sessionId: sourceId, message: { role: "assistant", id: "msg_nested123456789", content: "Nested" } }));
  const backups = path.join(configDir, "file-history", sourceId);
  await mkdir(backups, { recursive: true });
  const backup = Buffer.from([0, 255, 128, 5]);
  await writeFile(path.join(backups, "backup"), backup);
  const env = path.join(configDir, "session-env", sourceId);
  await mkdir(env, { recursive: true });
  await writeFile(path.join(env, "state"), "fixture environment");
  return { root, configDir, project, sourceId, transcript, user, assistant, tool, mcpTool, serverTool, child, workflow,
    nestedMessage, unrelated, backup, original: await readFile(transcript) };
}

describe("complete Claude session cloning", () => {
  it("remaps parent/child/workflow identities, preserves unrelated UUIDs and backups, and titles only the copy", async () => {
    const source = await fixture();
    const copy = await cloneClaudeSession({ transcript: source.transcript, configDir: source.configDir, title: "你好 (fork)" });
    const mapping = copy.identifierMapping;
    for (const id of [source.sourceId, source.user, source.assistant, source.tool, source.mcpTool, source.serverTool, source.child, source.workflow, source.nestedMessage]) {
      expect(mapping[id]).toBeDefined();
      expect(mapping[id]).not.toBe(id);
    }
    expect(mapping[source.unrelated]).toBeUndefined();
    const copied = await readFile(copy.transcript, "utf8");
    expect(copied.startsWith("\ufeff")).toBe(true);
    expect(copied).toContain(source.unrelated);
    expect(copied).toContain("你好 (fork)");
    expect(copied).toContain(`"parentUuid":"${mapping[source.user]}"`);
    expect(mapping[source.mcpTool]).toMatch(/^mcptoolu_/);
    expect(mapping[source.serverTool]).toMatch(/^srvtoolu_/);
    expect(copied).toContain(`"tool_use_id":"${mapping[source.mcpTool]}"`);
    expect(copied).toContain(`"tool_use_id":"${mapping[source.serverTool]}"`);
    expect(copied).not.toContain(source.mcpTool);
    expect(copied).not.toContain(source.serverTool);
    const agents = path.join(source.project, copy.newSessionId, "subagents");
    expect(JSON.parse(await readFile(path.join(agents, `agent-${mapping[source.child]}.meta.json`), "utf8")))
      .toEqual({ agentId: mapping[source.child], toolUseId: mapping[source.tool] });
    expect(await readFile(path.join(agents, "workflows", mapping[source.workflow], "journal.jsonl"), "utf8"))
      .toContain(mapping[source.nestedMessage]);
    expect(JSON.parse(await readFile(path.join(source.project, copy.newSessionId, "workflows", `${mapping[source.workflow]}.json`), "utf8")))
      .toEqual({ runId: mapping[source.workflow], summary: "Workflow" });
    expect(await readFile(path.join(source.configDir, "file-history", copy.newSessionId, "backup"))).toEqual(source.backup);
    expect(await readFile(path.join(source.configDir, "session-env", copy.newSessionId, "state"), "utf8")).toBe("fixture environment");
    expect(await readFile(source.transcript)).toEqual(source.original);
  });

  it("rejects concurrent source changes and removes only its own outputs", async () => {
    const source = await fixture();
    const newSessionId = randomUUID();
    fault.target = path.join(source.project, `${newSessionId}.clone.json`);
    fault.source = source.transcript;
    await expect(cloneClaudeSession({ transcript: source.transcript, configDir: source.configDir, newSessionId }))
      .rejects.toThrow("changed while forking");
    expect((await readdir(source.project)).some((name) => name.includes(newSessionId))).toBe(false);
    expect(await readFile(path.join(source.configDir, "file-history", source.sourceId, "backup"))).toEqual(source.backup);
  });

  it("never overwrites a pre-existing destination", async () => {
    const source = await fixture();
    const newSessionId = randomUUID();
    const target = path.join(source.project, `${newSessionId}.jsonl`);
    await writeFile(target, "unrelated existing content");
    await expect(cloneClaudeSession({ transcript: source.transcript, configDir: source.configDir, newSessionId }))
      .rejects.toThrow("already exists");
    expect(await readFile(target, "utf8")).toBe("unrelated existing content");
    expect(await readFile(source.transcript)).toEqual(source.original);
  });

  it.each([
    ["transcript", false], ["transcript", true],
    ["subagent", false], ["subagent", true],
  ] as const)("preserves stored replacement characters in %s (escaped=%s)", async (location, escaped) => {
    const source = await fixture();
    const relative = path.join("subagents", `agent-${source.child}.jsonl`);
    const file = location === "transcript" ? source.transcript : path.join(source.project, source.sourceId, relative);
    const content = "Stored text: \ufffd 你好";
    const record = { type: "assistant", sessionId: source.sourceId, agentId: source.child,
      message: { role: "assistant", content } };
    const serialized = JSON.stringify(record);
    const bytes = Buffer.from(escaped ? serialized.replaceAll("\ufffd", "\\ufffd") : serialized, "utf8");
    await writeFile(file, bytes);

    const copy = await cloneClaudeSession({ transcript: source.transcript, configDir: source.configDir });
    const target = location === "transcript" ? copy.transcript
      : path.join(source.project, copy.newSessionId, "subagents", `agent-${copy.identifierMapping[source.child]}.jsonl`);
    const copied = await readFile(target, "utf8");
    expect(JSON.parse(copied)).toEqual({ ...record, sessionId: copy.newSessionId,
      agentId: copy.identifierMapping[source.child] });
    expect(copied).toContain(escaped ? "\\ufffd" : "\ufffd");
    expect(await readFile(file)).toEqual(bytes);
  });

  it.each([false, true])("preserves tool-output bytes while remapping identifiers (malformed UTF-8=%s)", async (malformed) => {
    const source = await fixture();
    const results = path.join(source.project, source.sourceId, "tool-results");
    await mkdir(results);
    const file = path.join(results, "result.txt");
    const prefix = Buffer.concat([Buffer.from("\ufeffSaved output: 你好 "),
      malformed ? Buffer.from([0xc2, 0x0a, 0xff]) : Buffer.from("§\n")]);
    const suffix = malformed ? Buffer.from([0xe2, 0x82]) : Buffer.from("\r\n");
    const unchanged = ` embedded: _${source.sourceId}_ x${source.child}x `;
    const original = Buffer.concat([prefix,
      Buffer.from(`${source.sourceId}\r\nagentId: ${source.child}\ntool: ${source.tool}${unchanged}`), suffix]);
    await writeFile(file, original);

    const copy = await cloneClaudeSession({ transcript: source.transcript, configDir: source.configDir });
    const expected = Buffer.concat([prefix,
      Buffer.from(`${copy.newSessionId}\r\nagentId: ${copy.identifierMapping[source.child]}\ntool: ${copy.identifierMapping[source.tool]}${unchanged}`), suffix]);
    expect(await readFile(path.join(source.project, copy.newSessionId, "tool-results", "result.txt"))).toEqual(expected);
    expect(await readFile(file)).toEqual(original);
    expect(await readFile(source.transcript)).toEqual(source.original);
  });

  it.each(["transcript", "subagent"])("rejects invalid UTF-8 in %s before publishing a copy", async (location) => {
    const source = await fixture();
    const file = location === "transcript" ? source.transcript
      : path.join(source.project, source.sourceId, "subagents", `agent-${source.child}.jsonl`);
    await writeFile(file, Buffer.from([255, 254, 253]));
    await expect(cloneClaudeSession({ transcript: source.transcript, configDir: source.configDir })).rejects.toThrow("UTF-8 reading failed");
    expect((await readdir(source.project)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("rejects linked companion storage", async () => {
    const source = await fixture();
    const target = path.join(source.project, source.sourceId, "linked");
    await symlink(source.root, target, "junction");
    await expect(cloneClaudeSession({ transcript: source.transcript, configDir: source.configDir })).rejects.toThrow("Linked session storage");
  });
});
