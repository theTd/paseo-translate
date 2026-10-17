import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { ClaudeSubagentTracker } from "./claude-subagents";
import { parseClaudeWorkflowResult } from "./claude-workflow-output";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const remove of cleanup.splice(0)) remove(); });
function started(backgrounded: boolean, taskType = "local_agent"): SDKMessage {
  return { type: "system", subtype: "task_started", task_id: "task", tool_use_id: "tool",
    task_type: taskType, subagent_type: "Explore", is_backgrounded: backgrounded, description: "Investigate" } as unknown as SDKMessage;
}
function finished(extra = {}): SDKMessage {
  return { type: "system", subtype: "task_notification", task_id: "task", status: "completed", ...extra } as unknown as SDKMessage;
}
function harness() {
  const events: ProviderEvent[] = [];
  const tracker = new ClaudeSubagentTracker("root", "E:/repo", (event) => events.push(event), true);
  return { tracker, events };
}

describe("Claude child parity", () => {
  it("closes a resumed child twice and preserves its new background membership", () => {
    const { tracker, events } = harness();
    tracker.observeSystemMessage(started(false));
    tracker.observeSystemMessage(finished());
    tracker.observeSystemMessage(started(true));
    tracker.cancelRunningForegroundTasks();
    expect(events.filter((event) => event.type === "session.turn").map((event) => event.state)).toEqual(["started", "completed", "started"]);
    tracker.observeSystemMessage(finished());
    expect(events.filter((event) => event.type === "session.turn").map((event) => event.state)).toEqual(["started", "completed", "started", "completed"]);
  });

  it("uses Agent names and reports observed model, effort, usage and child text", () => {
    const { tracker, events } = harness();
    tracker.noteRootToolUse("tool", "Agent", { name: "Writer" });
    tracker.observeSystemMessage(started(true));
    expect(events[0]).toMatchObject({ type: "session.opened", title: "Writer" });
    tracker.handleSidechainMessage({ type: "assistant", uuid: "reply", parent_tool_use_id: "tool",
      message: { model: "claude-sonnet-5", content: [{ type: "text", text: "Working" }] } } as unknown as SDKMessage, "tool");
    tracker.observeHook({ agent_id: "task", effort: { level: "high" } });
    tracker.observeSystemMessage(finished({ usage: { total_tokens: 12345 } }));
    expect(events.some((event) => event.type === "timeline.item" && event.item.type === "assistant_message" && event.item.text === "Working")).toBe(true);
    expect(events.some((event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.message.includes("Sonnet 5 · High · 12,345 tokens"))).toBe(true);
  });

  it("reads workflow result text once from a bounded output file", () => {
    const { tracker, events } = harness();
    const directory = mkdtempSync(join(tmpdir(), "claude-workflow-test-"));
    const output = join(directory, "task.output");
    cleanup.push(() => { unlinkSync(output); rmdirSync(directory); });
    writeFileSync(output, JSON.stringify({ result: { answer: "Workflow finished" } }), "utf8");
    tracker.observeSystemMessage(started(true, "local_workflow"));
    tracker.observeSystemMessage(finished({ output_file: output }));
    tracker.observeSystemMessage(finished({ output_file: output }));
    expect(events.filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message" && event.item.text === "Workflow finished")).toHaveLength(1);
    expect(parseClaudeWorkflowResult("invalid JSON")).toBeUndefined();
    expect(parseClaudeWorkflowResult(" ".repeat(1024 * 1024 + 1))).toBeUndefined();
  });
});
