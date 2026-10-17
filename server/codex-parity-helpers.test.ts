import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexItemStream } from "./codex-item-stream";
import { threadItemToTimeline, threadItemTimelineEntries } from "./codex-items";
import { normalizeCodexOutputSchema } from "./codex-output-schema";
import { codexCustomPrompts, expandCodexCustomPrompt } from "./codex-commands";
import { readCodexHistory, settleCodexReplayActivities, readCodexSessionWindow } from "./codex-history";
import { replayTimelineEvent, normalizeReplayTimestamp } from "./provider-replay-timestamps";
import { codexSandboxPolicy } from "./codex-session-settings";

describe("Codex parity helpers", () => {
  it.each(["declined", "denied", "rejected", "error"])("terminalizes %s tools", (status) => {
    expect(threadItemToTimeline({ id: "cmd", type: "command_execution", command: "test", status })).toMatchObject({ type: "tool_call", status: "failed" });
  });

  it("streams command output, terminal interaction, and legacy completion", () => {
    const stream = new CodexItemStream();
    stream.observe("codex/event/exec_command_begin", { msg: { call_id: "exec", command: ["bash", "-lc", "echo hello"] } });
    const output = stream.observe("codex/event/exec_command_output_delta", { msg: { call_id: "exec", chunk: Buffer.from("hello\n").toString("base64") } });
    expect(output[0]).toMatchObject({ status: "running", detail: { type: "shell", command: "echo hello", output: "hello\n" } });
    const terminal = stream.observe("item/commandExecution/terminalInteraction", { itemId: "exec", processId: "42", stdin: "yes\n" });
    expect(terminal[0]).toMatchObject({ name: "write_stdin", status: "completed", detail: { command: "yes\n" } });
    const done = stream.observe("codex/event/exec_command_end", { msg: { call_id: "exec", exit_code: 0 } });
    expect(done[0]).toMatchObject({ status: "completed", detail: { output: "hello\n", command: "echo hello" } });
    expect(stream.observe("item/commandExecution/outputDelta", { itemId: "exec", delta: "late" })).toEqual([]);
  });

  it("merges final text with streamed snapshots and settles incomplete tools", () => {
    const stream = new CodexItemStream();
    stream.observe("item/agentMessage/delta", { itemId: "a", delta: "part" });
    expect(stream.observe("item/completed", { item: { id: "a", type: "agentMessage", text: "partial" } })[0]).toMatchObject({ text: "partial" });
    expect(stream.observe("item/completed", { item: { id: "a", type: "agentMessage", text: "partial" } })).toEqual([]);
    stream.observe("item/started", { item: { id: "cmd", type: "commandExecution", command: "work" } });
    expect(stream.settle("canceled", "Stopped")[0]).toMatchObject({ status: "canceled" });
  });

  it("materializes generated and MCP images without exposing base64 in text", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cGZkAAAAASUVORK5CYII=";
    expect(threadItemToTimeline({ id: "image", type: "imageGeneration", result: data, status: "completed" })).toMatchObject({ type: "assistant_message", text: expect.stringContaining("![Image](file:") });
    const entries = threadItemTimelineEntries({ id: "mcp", type: "mcpToolCall", tool: "screenshot", status: "completed", result: { content: [{ type: "image", mimeType: "image/png", data }] } });
    expect(entries).toHaveLength(2); expect(JSON.stringify(entries)).not.toContain(data);
    const dynamic = threadItemTimelineEntries({ id: "dynamic", type: "dynamicToolCall", tool: "screenshot", status: "completed", contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${data}` }] });
    expect(dynamic).toHaveLength(2); expect(JSON.stringify(dynamic)).not.toContain(data); expect(JSON.stringify(dynamic)).not.toContain("base64");
    expect(threadItemToTimeline({ id: "view", type: "imageView", path: "relative/image.png" }, { cwd: path.join(os.tmpdir(), "project") })).toMatchObject({ text: expect.stringContaining("/project/relative/image.png") });
    expect(threadItemToTimeline({ id: "bad", type: "imageGeneration", result: "not valid base64!" })).toBeNull();
  });

  it("normalizes nested structured schemas and rejects permissive objects", () => {
    const schema = { type: "object", properties: { nested: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } } } };
    expect(normalizeCodexOutputSchema(schema)).toMatchObject({ required: ["nested"], additionalProperties: false, properties: { nested: { items: { required: ["label"], additionalProperties: false } } } });
    expect(schema).not.toHaveProperty("required");
    expect(() => normalizeCodexOutputSchema({ type: "object", additionalProperties: true })).toThrow("additionalProperties");
    expect(() => normalizeCodexOutputSchema({ type: "array" })).toThrow("root object");
  });

  it("preserves sandbox defaults while applying configured overrides", () => {
    expect(codexSandboxPolicy("workspace-write", { networkAccess: true, writableRoots: ["/resolved"], excludeTmpdirEnvVar: true }, { network_access: false })).toEqual({ type: "workspaceWrite", networkAccess: false, writableRoots: ["/resolved"], excludeSlashTmp: false, excludeTmpdirEnvVar: true });
  });

  it("discovers custom prompts and expands named, quoted, positional and literal arguments once", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-prompts-test-"));
    try {
      await mkdir(path.join(home, "prompts"));
      await writeFile(path.join(home, "prompts", "review.md"), '---\ndescription: "Review a patch"\nargument-hint: TARGET=...\n---\n$TARGET | $1 | $$ | $ARGUMENTS', "utf8");
      expect(await codexCustomPrompts(home)).toEqual([{ name: "prompts:review", description: "Review a patch", argumentHint: "TARGET=..." }]);
      expect(await expandCodexCustomPrompt(home, "prompts:review", 'TARGET="some file $1" "first value"')).toBe('some file $1 | first value | $ | TARGET="some file $1" "first value"');
      await expect(expandCodexCustomPrompt(home, "prompts:../escape", "")).rejects.toThrow("Invalid custom prompt");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});


it.each(["notification-first", "item-first"])("pairs compaction completion channels: %s", (order) => {
  const stream = new CodexItemStream();
  expect(stream.observe("item/started", { item: { type: "contextCompaction", id: "c" } }))
    .toEqual([{ type: "compaction", id: "c", status: "loading", trigger: "auto" }]);
  const calls = order === "notification-first" ? ["thread/compacted", "item/completed"] : ["item/completed", "thread/compacted"];
  const entries = calls.flatMap((method) => stream.observe(method, { item: { type: "contextCompaction", id: "c" } }));
  expect(entries).toEqual([{ type: "compaction", id: "c", status: "completed", trigger: "auto" }]);
  expect(stream.finishCompactions()).toEqual([]);
});

it("closes incomplete compaction cards on terminal turns and cancels failed manual attribution", () => {
  const stream = new CodexItemStream();
  const cancel = stream.expectManualCompaction();
  cancel();
  stream.observe("item/started", { item: { type: "contextCompaction", id: "c" } });
  expect(stream.finishCompactions()).toEqual([{ type: "compaction", id: "c", status: "completed", trigger: "auto" }]);
  expect(stream.observe("thread/compacted", {})).toEqual([]);
  expect(stream.observe("item/completed", { item: { type: "contextCompaction", id: "c" } })).toEqual([]);
});

it("handles legacy notification-only compaction", () => {
  const stream = new CodexItemStream();
  stream.expectManualCompaction();
  expect(stream.observe("codex/event/context_compacted", { msg: {} })).toEqual([
    { type: "compaction", id: "compaction-1", status: "completed", trigger: "manual" },
  ]);
  expect(stream.observe("item/completed", { item: { type: "contextCompaction", id: "later-id" } })).toEqual([]);
});

it("normalizes replay time on the event and falls through malformed timestamps", () => {
  expect(normalizeReplayTimestamp("invalid", 1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
  expect(normalizeReplayTimestamp(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  expect(replayTimelineEvent("s", { type: "assistant_message", id: "a", text: "Reply", timestamp: "2023-11-14T22:13:20Z" }))
    .toEqual({ type: "timeline.item", sessionId: "s", item: { type: "assistant_message", id: "a", text: "Reply" }, timestamp: "2023-11-14T22:13:20.000Z" });
});

it("settles replayed activity without mutating input or duplicating a resumed child", () => {
  const turns = [{ id: "t", items: [
    { id: "start", type: "sub_agent_activity", agentThreadId: "child", kind: "started" },
    { id: "talk", type: "subAgentActivity", agentThreadId: "child", kind: "interacted" },
    { id: "stop", type: "subAgentActivity", agentThreadId: "child", kind: "interrupted" },
  ] }];
  const result = settleCodexReplayActivities(turns);
  expect(result[0].items).toEqual([{ id: "start", type: "sub_agent_activity", agentThreadId: "child", kind: "interrupted", status: "canceled" }]);
  expect(turns[0].items).toHaveLength(3);
  expect(turns[0].items[0]).not.toHaveProperty("status");
});

it("retains paginated item-envelope timestamps", async () => {
  const client = { async request(method: string) {
    if (method === "thread/read") return { thread: { historyMode: "paginated" } };
    if (method === "thread/turns/list") return { data: [{ id: "turn" }] };
    return { data: [{ createdAt: 1_700_000_000, item: { id: "a", type: "agentMessage", text: "reply" } }] };
  } };
  const history = await readCodexHistory(client, "thread");
  expect(history.turns[0].items).toEqual([{ id: "a", type: "agentMessage", text: "reply", timestamp: "2023-11-14T22:13:20.000Z" }]);
});

it("stops session-list cursor cycles without duplicate entries", async () => {
  let requests = 0;
  const client = { async request() { requests++; return { data: [{ id: "same" }], nextCursor: "cycle" }; } };
  expect(await readCodexSessionWindow(client, 150)).toEqual([{ id: "same" }]);
  expect(requests).toBe(2);
});
