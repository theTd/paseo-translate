import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { describeFinishedTool, describeRunningTool } from "./claude-tool-details";
import { ClaudeMessageStream } from "./claude-message-stream";
import { ClaudeToolStream } from "./claude-tool-stream";
import { readClaudeWorkflowResultFile } from "./claude-workflow-output";
import { findClaudeModel } from "./claude-model-manifest";

/**
 * Live Task-protocol tracker for the Translate (Claude Code) provider.
 *
 * Ports the declaration rules of Paseo's native Claude provider
 * (`subagents/live-source.ts`, verified against Claude Code 2.1.x):
 *
 * - Only `task_started` declares a child, and only for Task-tool subagents
 *   (`task_type` `local_agent`) and workflows (`local_workflow`). Backgrounded
 *   shells (`local_bash`) and `skip_transcript` housekeeping never enter the
 *   track, even though they share the same `tool_use_id` shape.
 * - A frame for a task that was never declared is dropped: attributing it
 *   would create a nameless row that never finishes.
 * - Task ids are session-scoped. A resumed task re-announced with a new
 *   `tool_use_id` is an alias for the first id, which stays canonical.
 * - Nested ownership comes from the launching sidechain: a `tool_use` block
 *   emitted inside a sidechain records that sidechain as the direct owner of
 *   the id, and the following `task_started` inherits it.
 * - Cancelling a turn terminalizes foreground children but keeps the routing
 *   table: a backgrounded child settles after the interrupt and still needs
 *   its descriptor. A lost process fails every running child instead.
 *
 * Plugin transport differs from the native one: instead of
 * `provider_subagent` stream events, children are real provider sessions
 * announced with `session.opened` (`parentSessionId` + `toolCallId`,
 * `restoration: "parent"`). The daemon then owns the track rows, nesting,
 * and read-only timeline panes, exactly like `plugin-examples/provider-direct`
 * (`publishChild`). Child timelines stay in the agent language; the shared
 * client renderer translates them on display.
 */

type SubagentStatus = "running" | "completed" | "failed" | "canceled";

interface TaskStartedShape {
  task_id: string;
  tool_use_id?: unknown;
  description?: unknown;
  subagent_type?: unknown;
  task_type?: unknown;
  workflow_name?: unknown;
  prompt?: unknown;
  skip_transcript?: unknown;
  is_backgrounded?: unknown;
}

interface TaskUpdatedShape {
  task_id: string;
  patch?: { status?: unknown; is_backgrounded?: unknown };
}

interface TaskNotificationShape {
  task_id: string;
  status?: unknown;
  usage?: { total_tokens?: unknown };
  output_file?: unknown;
}

interface TaskProgressShape {
  task_id: string;
  usage?: { total_tokens?: unknown };
}

interface ChildState {
  providerId: string;
  canonicalId: string;
  title: string;
  turnId: string;
  turnOpen: boolean;
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
  messages: ClaudeMessageStream;
  toolStream: ClaudeToolStream;
  model?: string;
  effort?: string;
  totalTokens?: number;
  lastPresentation?: string;
}

const SUBAGENT_TASK_TYPE = "local_agent";
const WORKFLOW_TASK_TYPE = "local_workflow";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isProviderSubagentTask(message: TaskStartedShape): boolean {
  if (typeof message.task_type === "string" && message.task_type.length > 0) {
    return message.task_type === SUBAGENT_TASK_TYPE || message.task_type === WORKFLOW_TASK_TYPE;
  }
  return readString(message.subagent_type) !== undefined;
}

function isWorkflowTask(message: TaskStartedShape): boolean {
  if (message.task_type === WORKFLOW_TASK_TYPE) return true;
  return readString(message.workflow_name) !== undefined;
}

function mapTaskStatus(status: unknown): SubagentStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "canceled";
    default:
      return undefined;
  }
}

function readTotalTokens(usage: { total_tokens?: unknown } | undefined): number | undefined {
  if (!usage || typeof usage.total_tokens !== "number" || usage.total_tokens <= 0) return undefined;
  return Math.round(usage.total_tokens);
}

/**
 * Degraded rendering of one child timeline item into its parent timeline,
 * shared by the live tracker fallback and the replay path. Child prompts
 * arrive as `user_message`, which would read as the user's own words in the
 * parent timeline, so they are revoiced as assistant messages with the child
 * title; every other item type keeps its shape and id (SDK ids are unique
 * per Claude session, so no collision with root items).
 */
export function flattenSubagentItemForParent(
  title: string,
  item: ProviderTimelineItem,
): ProviderTimelineItem {
  if (item.type !== "user_message") return item;
  return {
    type: "assistant_message",
    id: item.id,
    text: `[${title}] ${item.text}`,
  };
}

export class ClaudeSubagentTracker {
  /** task_id -> canonical subagent (first Task tool_use) id. */
  private readonly subagentIdByTaskId = new Map<string, string>();
  /** Every announced tool id -> canonical id (resume aliases included). */
  private readonly canonicalIdByToolUseId = new Map<string, string>();
  /** Tool calls made inside a sidechain -> owning child canonical id. */
  private readonly ownerCanonicalByToolUseId = new Map<string, string>();
  /** Non-subagent tasks (e.g. local_bash) -> emitting sidechain canonical id. */
  private readonly ownerCanonicalByTaskId = new Map<string, string>();
  /** Parent Task tool input by tool_use id (for titles). */
  private readonly taskInputs = new Map<string, Record<string, unknown>>();
  private readonly declaredIds = new Set<string>();
  private readonly workflowTaskIds = new Set<string>();
  private readonly lastWorkflowResultByTaskId = new Map<string, string>();
  private readonly backgroundedIds = new Set<string>();
  private readonly children = new Map<string, ChildState>();
  private readonly lastStatusById = new Map<string, SubagentStatus>();
  private readonly runningTaskIds = new Map<string, boolean>();
  private backgroundTaskIds: Set<string> | null = null;

  constructor(
    private readonly rootSessionId: string,
    private readonly cwd: string,
    private readonly emit: (event: ProviderEvent) => void,
    /**
     * Whether the negotiated connection caps include `session.subsession`.
     * False degrades every child to flat parent-timeline rendering (see
     * emitChildEvent): opening a child session would make the daemon kill
     * the whole provider connection.
     */
    private readonly supportsSubsessions: boolean,
  ) {}

  reset(): void {
    this.resetProcessTasks();
    this.subagentIdByTaskId.clear();
    this.canonicalIdByToolUseId.clear();
    this.ownerCanonicalByToolUseId.clear();
    this.ownerCanonicalByTaskId.clear();
    this.taskInputs.clear();
    this.declaredIds.clear();
    this.workflowTaskIds.clear();
    this.lastWorkflowResultByTaskId.clear();
    this.backgroundedIds.clear();
    this.children.clear();
    this.lastStatusById.clear();
  }

  /** Record a `tool_use` block from a root (non-sidechain) assistant message. */
  noteRootToolUse(toolUseId: string, name: string, input: unknown): void {
    if ((name === "Task" || name === "Agent") && typeof input === "object" && input !== null) {
      this.taskInputs.set(toolUseId, input as Record<string, unknown>);
    }
  }

  /**
   * Emits one child-scoped event. With `session.subsession` negotiated this
   * is a passthrough; without it every child session event is dropped (a
   * child `session.opened` would make the daemon fail the whole provider
   * connection) and timeline items fall back to flat parent rendering.
   */
  private emitChildEvent(child: ChildState, event: ProviderEvent): void {
    if (this.supportsSubsessions) {
      this.emit(event);
      return;
    }
    if (event.type !== "timeline.item") return;
    this.emit({
      type: "timeline.item",
      sessionId: this.rootSessionId,
      item: flattenSubagentItemForParent(child.title, event.item),
    });
  }

  /**
   * Entry point for every SDK message that is NOT a root assistant/user
   * message or turn result. Returns true when the message was a task-protocol
   * announcement (the caller then skips its own handling).
   */
  observeSystemMessage(message: SDKMessage): boolean {
    if (message.type !== "system") return false;
    if (message.subtype === "background_tasks_changed") {
      this.backgroundTaskIds = new Set(message.tasks.map((task) => task.task_id));
      return true;
    }
    const task = message as unknown as { task_id?: string; is_backgrounded?: boolean; status?: unknown;
      patch?: { status?: unknown; is_backgrounded?: boolean } };
    if (task.task_id) {
      if (message.subtype === "task_started") this.runningTaskIds.set(task.task_id, task.is_backgrounded === true);
      else if (message.subtype === "task_notification" || message.subtype === "task_updated") {
        const backgrounded = task.patch?.is_backgrounded ?? this.runningTaskIds.get(task.task_id) ?? false;
        const status = mapTaskStatus(task.patch?.status ?? task.status);
        if (status === "running" || (status === undefined && this.runningTaskIds.has(task.task_id))) this.runningTaskIds.set(task.task_id, backgrounded);
        else if (status) this.runningTaskIds.delete(task.task_id);
      }
    }
    switch (message.subtype) {
      case "task_started":
        this.observeTaskStarted(message as unknown as TaskStartedShape);
        return true;
      case "task_updated":
        this.observeTaskUpdated(message as unknown as TaskUpdatedShape);
        return true;
      case "task_notification":
        this.observeTaskNotification(message as unknown as TaskNotificationShape);
        return true;
      case "task_progress":
        this.observeTaskProgress(message as unknown as TaskProgressShape);
        return true;
      default:
        return false;
    }
  }

  /** Includes background Bash tasks that deliberately have no subagent track row. */
  hasRunningTasks(): boolean {
    return Boolean(this.backgroundTaskIds?.size) ||
      [...this.runningTaskIds.values()].some((backgrounded) => !backgrounded || this.backgroundTaskIds === null) ||
      [...this.children.values()].some((child) => child.turnOpen &&
        (!this.backgroundedIds.has(child.canonicalId) || this.backgroundTaskIds === null));
  }

  /** Background membership is per CLI process, independent of historical task declarations. */
  resetProcessTasks(): void {
    this.runningTaskIds.clear();
    this.backgroundTaskIds = null;
  }

  /** Intentional query teardown ends its live work, not the retained task history. */
  finishProcessTasks(): void {
    for (const child of this.children.values()) {
      if (!child.turnOpen) continue;
      // Membership absence cannot distinguish success, failure, or kill. Preserve actual
      // terminal bookends; otherwise report the query teardown without inventing success.
      this.closeChildTurn(child, "canceled");
    }
    this.resetProcessTasks();
  }

  /**
   * Route a sidechain frame (`parent_tool_use_id` set) to its owning child
   * timeline. Frames for undeclared tasks are dropped by design (see above).
   */
  handleSidechainMessage(message: SDKMessage, parentToolUseId: string): void {
    const canonical = this.canonicalIdByToolUseId.get(parentToolUseId);
    const child =
      (canonical !== undefined ? this.children.get(canonical) : undefined) ??
      (this.ownerCanonicalByToolUseId.get(parentToolUseId) !== undefined
        ? this.children.get(this.ownerCanonicalByToolUseId.get(parentToolUseId) as string)
        : undefined);
    if (!child) return;
    for (const item of child.toolStream.observe(message, child.toolNames, child.toolInputs)) {
      if (item.type === "tool_call") this.ownerCanonicalByToolUseId.set(item.callId, child.canonicalId);
      this.emitChildEvent(child, { type: "timeline.item", sessionId: child.providerId, item });
    }
    for (const item of child.messages.observe(message)) {
      this.emitChildEvent(child, { type: "timeline.item", sessionId: child.providerId, item });
    }
    if (message.type === "assistant") {
      if (typeof message.message.model === "string" && message.message.model) {
        child.model = message.message.model;
        this.publishPresentation(child);
      }
      this.handleSidechainAssistant(child, message);
    } else if (message.type === "user") {
      this.handleSidechainUser(child, message);
    }
  }

  /** Terminalize foreground children on turn cancel; backgrounded survive. */
  cancelRunningForegroundTasks(): void {
    for (const [id, child] of this.children) {
      if (this.backgroundedIds.has(id) || !child.turnOpen) continue;
      for (const [taskId, canonicalId] of this.subagentIdByTaskId) {
        if (canonicalId === id) this.runningTaskIds.delete(taskId);
      }
      this.closeChildTurn(child, "canceled");
    }
  }

  /** A lost process fails every child with an open turn. */
  failRunningTasks(): void {
    this.resetProcessTasks();
    for (const child of this.children.values()) {
      if (!child.turnOpen) continue;
      this.closeChildTurn(child, "failed", "Claude session ended");
    }
  }

  private childProviderId(canonicalId: string): string {
    return `subagent:${this.rootSessionId}:${canonicalId}`;
  }

  /** Observation-only SDK hooks report effective effort, including model downgrades. */
  observeHook(input: unknown): void {
    if (typeof input !== "object" || input === null) return;
    const hook = input as { agent_id?: unknown; effort?: { level?: unknown } };
    if (typeof hook.agent_id !== "string" || typeof hook.effort?.level !== "string") return;
    const id = this.subagentIdByTaskId.get(hook.agent_id);
    const child = id ? this.children.get(id) : undefined;
    if (!child || child.effort === hook.effort.level) return;
    child.effort = hook.effort.level;
    this.publishPresentation(child);
  }

  private publishPresentation(child: ChildState, includeUsage = false): void {
    const parts = [child.title];
    if (child.model) parts.push(findClaudeModel(child.model)?.label ?? child.model);
    if (child.effort) parts.push(child.effort === "xhigh" ? "Extra High" : child.effort[0].toUpperCase() + child.effort.slice(1));
    if (includeUsage && child.totalTokens) parts.push(`${child.totalTokens.toLocaleString("en-US")} tokens`);
    const text = parts.join(" · ");
    if (parts.length === 1 || text === child.lastPresentation) return;
    child.lastPresentation = text;
    // Protocol v1 has no mutable child subtitle event. Expose the same facts
    // through the child's supported timeline, with live tokens in session.usage.
    this.emitChildEvent(child, { type: "timeline.item", sessionId: child.providerId,
      item: { type: "notification", id: `${child.canonicalId}:metadata:${text}`, level: "info", message: text } });
  }

  private observeTaskStarted(message: TaskStartedShape): void {
    const id = readString(message.tool_use_id);
    const ownerCanonical = id !== undefined ? this.ownerCanonicalByToolUseId.get(id) : undefined;
    if (ownerCanonical !== undefined) this.ownerCanonicalByTaskId.set(message.task_id, ownerCanonical);
    if (id === undefined || message.skip_transcript === true || !isProviderSubagentTask(message)) {
      return;
    }
    const existingId = this.subagentIdByTaskId.get(message.task_id);
    const backgroundedId = existingId ?? id;
    if (message.is_backgrounded === true) this.backgroundedIds.add(backgroundedId);
    else if (message.is_backgrounded === false) this.backgroundedIds.delete(backgroundedId);
    if (existingId !== undefined) {
      this.canonicalIdByToolUseId.set(id, existingId);
      const child = this.children.get(existingId);
      if (!child) return;
      this.lastStatusById.set(existingId, "running");
      this.lastWorkflowResultByTaskId.delete(message.task_id);
      child.messages.clear();
      if (!child.turnOpen) {
        child.turnId = randomUUID();
        child.turnOpen = true;
        this.emitChildEvent(child, {
          type: "session.turn",
          sessionId: child.providerId,
          turnId: child.turnId,
          state: "started",
        });
      }
      const prompt = this.workflowTaskIds.has(message.task_id) ? readString(message.description) : readString(message.prompt);
      if (prompt !== undefined) {
        this.emitChildEvent(child, {
          type: "timeline.item",
          sessionId: child.providerId,
          item: { type: "user_message", id: randomUUID(), text: prompt },
        });
      }
      return;
    }

    const workflow = isWorkflowTask(message);
    this.subagentIdByTaskId.set(message.task_id, id);
    this.canonicalIdByToolUseId.set(id, id);
    this.declaredIds.add(id);
    if (workflow) this.workflowTaskIds.add(message.task_id);
    if (message.is_backgrounded === true) this.backgroundedIds.add(id);

    const parentProviderId =
      ownerCanonical !== undefined
        ? (this.children.get(ownerCanonical)?.providerId ?? this.rootSessionId)
        : this.rootSessionId;
    const providerId = this.childProviderId(id);
    const input = this.taskInputs.get(id);
    const title = workflow
      ? "Workflow"
      : (readString(input?.["name"]) ?? readString(message.subagent_type) ?? "Subagent");
    const description = readString(message.description);
    const turnId = randomUUID();
    const child: ChildState = {
      providerId,
      canonicalId: id,
      title,
      turnId,
      turnOpen: true,
      toolNames: new Map(),
      toolInputs: new Map(),
      messages: new ClaudeMessageStream(), toolStream: new ClaudeToolStream(),
    };
    this.children.set(id, child);
    this.lastStatusById.set(id, "running");
    this.emitChildEvent(child, {
      type: "session.opened",
      sessionId: providerId,
      parentSessionId: parentProviderId,
      toolCallId: id,
      // Nested children look at this session's caps for session.subsession.
      capabilities: ["session.subsession"],
      restoration: "parent",
      title,
      ...(description !== undefined ? { description } : {}),
      cwd: this.cwd,
    });
    this.emitChildEvent(child, { type: "session.turn", sessionId: providerId, turnId, state: "started" });
    // Open the child timeline with the task it was actually given. A
    // workflow's prompt is its script source, so open with the summary.
    const prompt = workflow ? description : readString(message.prompt);
    if (prompt !== undefined) {
      this.emitChildEvent(child, {
        type: "timeline.item",
        sessionId: providerId,
        item: { type: "user_message", id: randomUUID(), text: prompt },
      });
    }
  }

  private observeTaskUpdated(message: TaskUpdatedShape): void {
    const id = this.subagentIdByTaskId.get(message.task_id);
    if (id !== undefined && typeof message.patch?.is_backgrounded === "boolean") {
      if (message.patch.is_backgrounded) this.backgroundedIds.add(id);
      else this.backgroundedIds.delete(id);
    }
    this.applyStatus(message.task_id, message.patch?.status);
  }

  private observeTaskNotification(message: TaskNotificationShape): void {
    if (this.workflowTaskIds.has(message.task_id)) {
      const id = this.subagentIdByTaskId.get(message.task_id);
      const child = id ? this.children.get(id) : undefined;
      const outputFile = readString(message.output_file);
      const result = outputFile ? readClaudeWorkflowResultFile(outputFile) : undefined;
      if (child && result && this.lastWorkflowResultByTaskId.get(message.task_id) !== result) {
        this.lastWorkflowResultByTaskId.set(message.task_id, result);
        this.emitChildEvent(child, { type: "timeline.item", sessionId: child.providerId,
          item: { type: "assistant_message", id: `${message.task_id}:result:${child.turnId}`, text: result } });
      }
    }
    const totalTokens = readTotalTokens(message.usage);
    if (totalTokens !== undefined) {
      const id = this.subagentIdByTaskId.get(message.task_id);
      const child = id !== undefined ? this.children.get(id) : undefined;
      if (child !== undefined) {
        child.totalTokens = totalTokens;
        this.emitChildEvent(child, {
          type: "session.usage",
          sessionId: child.providerId,
          turnId: child.turnId,
          usage: { contextWindowUsedTokens: totalTokens },
        });
      }
    }
    this.applyStatus(message.task_id, message.status);
  }

  private observeTaskProgress(message: TaskProgressShape): void {
    const totalTokens = readTotalTokens(message.usage);
    if (totalTokens === undefined) return;
    const id = this.subagentIdByTaskId.get(message.task_id);
    const child = id !== undefined ? this.children.get(id) : undefined;
    if (child === undefined) return;
    child.totalTokens = totalTokens;
    this.emitChildEvent(child, {
      type: "session.usage",
      sessionId: child.providerId,
      turnId: child.turnId,
      usage: { contextWindowUsedTokens: totalTokens },
    });
  }

  private applyStatus(taskId: string, rawStatus: unknown): void {
    const id = this.subagentIdByTaskId.get(taskId);
    const child = id !== undefined ? this.children.get(id) : undefined;
    if (id === undefined || child === undefined) return;
    const status = mapTaskStatus(rawStatus);
    if (status === undefined || this.lastStatusById.get(id) === status) return;
    this.lastStatusById.set(id, status);
    if (status === "running") {
      if (!child.turnOpen) {
        child.turnId = randomUUID();
        child.turnOpen = true;
        this.emitChildEvent(child, {
          type: "session.turn",
          sessionId: child.providerId,
          turnId: child.turnId,
          state: "started",
        });
      }
      return;
    }
    this.closeChildTurn(child, status);
  }

  private closeChildTurn(child: ChildState, status: "completed" | "failed" | "canceled", error?: string): void {
    if (!child.turnOpen) return;
    this.publishPresentation(child, true);
    for (const [id, name] of child.toolNames) {
      this.emitChildEvent(child, { type: "timeline.item", sessionId: child.providerId,
        item: { type: "tool_call", id, callId: id, name, status: "canceled", error: null,
          detail: describeFinishedTool(name, child.toolInputs.get(id), "Child turn ended") } });
    }
    child.toolNames.clear();
    child.toolInputs.clear();
    child.turnOpen = false;
    this.emitChildEvent(child, {
      type: "session.turn",
      sessionId: child.providerId,
      turnId: child.turnId,
      state: status,
      ...(error !== undefined ? { error: { message: error } } : {}),
    });
  }

  private handleSidechainAssistant(child: ChildState, message: SDKMessage): void {
    const assistant = message as unknown as {
      uuid?: unknown;
      message?: { content?: unknown; id?: unknown };
    };
    const content = assistant.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as { type?: unknown; id?: unknown; text?: unknown; thinking?: unknown };
      if (record.type === "tool_use" || record.type === "mcp_tool_use" || record.type === "server_tool_use") {
        const use = block as { id?: unknown; name?: unknown; input?: unknown };
        if (typeof use.id !== "string" || typeof use.name !== "string") continue;
        if ((use.name === "Task" || use.name === "Agent") && typeof use.input === "object" && use.input !== null) {
          this.taskInputs.set(use.id, use.input as Record<string, unknown>);
        }
        child.toolNames.set(use.id, use.name);
        child.toolInputs.set(use.id, use.input);
        this.ownerCanonicalByToolUseId.set(use.id, child.canonicalId);
        const detail: ProviderToolCallDetail = describeRunningTool(use.name, use.input);
        const item: ProviderTimelineItem = {
          type: "tool_call",
          id: use.id,
          callId: use.id,
          name: use.name,
          status: "running",
          error: null,
          detail,
        };
        this.emitChildEvent(child, { type: "timeline.item", sessionId: child.providerId, item });
      }
    }
  }

  private handleSidechainUser(child: ChildState, message: SDKMessage): void {
    const user = message as unknown as { message?: { content?: unknown } };
    const content = user.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as { type?: unknown };
      if (record.type !== "tool_result") continue;
      const result = block as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      if (typeof result.tool_use_id !== "string") continue;
      const name = child.toolNames.get(result.tool_use_id) ?? "tool";
      const output = flattenBlockContent(result.content);
      const detail = describeFinishedTool(name, child.toolInputs.get(result.tool_use_id), output);
      const item: ProviderTimelineItem = {
        type: "tool_call",
        id: result.tool_use_id,
        callId: result.tool_use_id,
        name,
        ...(result.is_error === true
          ? { status: "failed" as const, error: output ?? "Tool failed" }
          : { status: "completed" as const, error: null }),
        detail,
      };
      this.emitChildEvent(child, { type: "timeline.item", sessionId: child.providerId, item });
      child.toolNames.delete(result.tool_use_id);
      child.toolInputs.delete(result.tool_use_id);
    }
  }
}

function flattenBlockContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
