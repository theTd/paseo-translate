import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSubagentTracker } from "./claude-subagents";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

function tracker() { return new ClaudeSubagentTracker("root", "/project", () => {}, true); }
function started(taskId: string, background = false, hidden = false): SDKMessage {
  return { type: "system", subtype: "task_started", task_id: taskId, task_type: "local_agent",
    tool_use_id: `toolu_${taskId}`, is_backgrounded: background, skip_transcript: hidden } as unknown as SDKMessage;
}
function level(ids: string[]): SDKMessage {
  return { type: "system", subtype: "background_tasks_changed",
    tasks: ids.map((task_id) => ({ task_id, task_type: "local_bash", description: "Background work" })) } as unknown as SDKMessage;
}

describe("Claude fork readiness", () => {
  it("does not invent success from an empty level while preserving received terminal outcomes", () => {
    const events: ProviderEvent[] = [];
    const tasks = new ClaudeSubagentTracker("root", "/project", (event) => events.push(event), true);
    tasks.observeSystemMessage(started("pending-bookend", true));
    tasks.observeSystemMessage(level([]));
    tasks.finishProcessTasks();
    expect(events).toContainEqual(expect.objectContaining({ type: "session.turn", sessionId: "subagent:root:toolu_pending-bookend", state: "canceled" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "session.turn", sessionId: "subagent:root:toolu_pending-bookend", state: "completed" }));
    tasks.observeSystemMessage(started("failed-bookend", true));
    tasks.observeSystemMessage({ type: "system", subtype: "task_notification", task_id: "failed-bookend", status: "failed" } as unknown as SDKMessage);
    tasks.finishProcessTasks();
    expect(events.filter((event) => event.type === "session.turn" && event.sessionId === "subagent:root:toolu_failed-bookend").at(-1))
      .toMatchObject({ state: "failed" });
    expect(tasks.hasRunningTasks()).toBe(false);
  });

  it("becomes ready after foreground cancellation despite historical running status", () => {
    const tasks = tracker();
    tasks.observeSystemMessage(started("foreground"));
    expect(tasks.hasRunningTasks()).toBe(true);
    tasks.cancelRunningForegroundTasks();
    expect(tasks.hasRunningTasks()).toBe(false);
  });

  it("blocks on level-only tasks and uses replacement membership despite stale bookends", () => {
    const tasks = tracker();
    tasks.observeSystemMessage(level(["unannounced"]));
    expect(tasks.hasRunningTasks()).toBe(true);
    tasks.observeSystemMessage(level([]));
    expect(tasks.hasRunningTasks()).toBe(false);
    tasks.observeSystemMessage(started("background", true));
    // The level is authoritative even when an older bookend arrives afterward.
    expect(tasks.hasRunningTasks()).toBe(false);
    tasks.observeSystemMessage(level(["background"]));
    expect(tasks.hasRunningTasks()).toBe(true);
    tasks.observeSystemMessage(level([]));
    expect(tasks.hasRunningTasks()).toBe(false);
  });

  it("includes hidden work and releases all process-owned membership on process failure", () => {
    const tasks = tracker();
    tasks.observeSystemMessage(started("hidden", true, true));
    expect(tasks.hasRunningTasks()).toBe(true);
    tasks.observeSystemMessage(level(["hidden", "other"]));
    tasks.failRunningTasks();
    expect(tasks.hasRunningTasks()).toBe(false);
  });
});
