import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { isRecord, nonEmptyString, normalizeCodexItemType, threadItemTimelineEntries, toObjectRecord } from "./codex-items";

/** Older CLI events carry route and item data under msg with snake-case keys. */
export function normalizeCodexNotification(method: string, params: unknown): { method: string; params: unknown } {
  if (!method.startsWith("codex/event/")) return { method, params };
  const record = toObjectRecord(params) ?? {};
  const msg = toObjectRecord(record.msg) ?? {};
  const normalized = { ...record, threadId: record.threadId ?? record.thread_id ?? msg.threadId ?? msg.thread_id,
    turnId: record.turnId ?? record.turn_id ?? msg.turnId ?? msg.turn_id };
  if (method === "codex/event/item_started" || method === "codex/event/item_completed") return { method: method.endsWith("item_started") ? "item/started" : "item/completed", params: { ...normalized, item: msg.item } };
  if (method === "codex/event/task_complete" || method === "codex/event/turn_aborted") return { method: "turn/completed", params: { ...normalized, status: method.endsWith("turn_aborted") ? "interrupted" : "completed" } };
  if (method === "codex/event/context_compacted") return { method: "thread/compacted", params: normalized };
  return { method, params: normalized };
}

function decodeLegacyOutput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return value;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  return !decoded.includes("\uFFFD") && Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "") ? decoded : value;
}

/** One root or child thread owns its own absolute text/tool snapshots. */
export class CodexItemStream {
  constructor(private readonly cwd?: string) {}
  private readonly text = new Map<string, string>();
  private readonly reasoning = new Map<string, string>();
  private readonly plan = new Map<string, string>();
  private readonly tools = new Map<string, Record<string, unknown>>();
  private readonly completed = new Set<string>();
  private boundary = false;
  private readonly compactions = new Map<string, "auto" | "manual">();
  private readonly completedCompactions = new Set<string>();
  private readonly manualCompactions = new Set<symbol>();
  private compactionOrdinal = 0;
  private unpairedCompactionItems = 0;
  private unpairedCompactionNotifications = 0;

  clear(): void {
    this.text.clear(); this.reasoning.clear(); this.plan.clear(); this.tools.clear(); this.completed.clear(); this.boundary = false;
    this.compactions.clear(); this.completedCompactions.clear();
    this.unpairedCompactionItems = 0; this.unpairedCompactionNotifications = 0;
  }

  expectManualCompaction(): () => void {
    const token = Symbol();
    this.manualCompactions.add(token);
    return () => { this.manualCompactions.delete(token); };
  }

  private compactionTrigger(): "auto" | "manual" {
    const token = this.manualCompactions.values().next().value;
    if (token === undefined) return "auto";
    this.manualCompactions.delete(token);
    return "manual";
  }

  private completeCompaction(id: string): ProviderTimelineItem {
    const trigger = this.compactions.get(id) ?? this.compactionTrigger();
    this.compactions.delete(id);
    this.completedCompactions.add(id);
    return { type: "compaction", id, status: "completed", trigger };
  }

  finishCompactions(): ProviderTimelineItem[] {
    return [...this.compactions.keys()].map((id) => {
      this.unpairedCompactionItems += 1;
      return this.completeCompaction(id);
    });
  }

  observe(method: string, params: unknown): ProviderTimelineItem[] {
    ({ method, params } = normalizeCodexNotification(method, params));
    const record = toObjectRecord(params) ?? {};
    if (method === "thread/compacted") {
      if (this.unpairedCompactionItems > 0) { this.unpairedCompactionItems -= 1; return []; }
      const id = this.compactions.keys().next().value ?? `compaction-${++this.compactionOrdinal}`;
      this.unpairedCompactionNotifications += 1;
      return [this.completeCompaction(id)];
    }
    if (method === "item/plan/delta" && typeof record.itemId === "string" && typeof record.delta === "string") {
      const text = (this.plan.get(record.itemId) ?? "") + record.delta;
      this.plan.set(record.itemId, text);
      return threadItemTimelineEntries({ id: record.itemId, type: "plan", text }, this.cwd);
    }
    if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta" || method === "item/reasoning/delta") {
      const id = nonEmptyString(record.itemId);
      if (!id || typeof record.delta !== "string" || this.completed.has(id)) return [];
      const assistant = method === "item/agentMessage/delta";
      const buffer = assistant ? this.text : this.reasoning;
      const previous = buffer.get(id) ?? "";
      const text = previous + (assistant && !previous && this.boundary ? "\n\n---\n\n" : "") + record.delta;
      if (assistant) this.boundary = false;
      buffer.set(id, text);
      return assistant ? [{ type: "assistant_message", id, messageId: id, text }] : [{ type: "reasoning", id, text }];
    }
    const legacy = toObjectRecord(record.msg) ?? record;
    if (["codex/event/exec_command_begin", "codex/event/exec_command_end"].includes(method)) {
      const id = nonEmptyString(legacy.call_id);
      if (!id) return [];
      return this.observe(method.endsWith("_end") ? "item/completed" : "item/started", { item: {
        id, type: "commandExecution", command: legacy.command, cwd: legacy.cwd,
        aggregatedOutput: legacy.aggregated_output ?? legacy.aggregatedOutput ?? legacy.formatted_output ?? legacy.stdout ?? legacy.output,
        exitCode: legacy.exit_code ?? legacy.exitCode, status: method.endsWith("_end") ? (legacy.success === false || (legacy.exit_code ?? legacy.exitCode) ? "failed" : "completed") : "inProgress",
      } });
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta" || method === "codex/event/exec_command_output_delta") {
      const id = nonEmptyString(record.itemId) ?? nonEmptyString(legacy.call_id);
      const chunk = record.delta ?? record.chunk ?? legacy.chunk ?? legacy.delta;
      const delta = typeof chunk === "string" ? (method.startsWith("codex/event/") ? decodeLegacyOutput(chunk) : chunk) : "";
      if (!id || !delta || this.completed.has(id)) return [];
      const item = this.tools.get(id) ?? { id, type: method.includes("fileChange") ? "fileChange" : "commandExecution", command: "" };
      item.aggregatedOutput = String(item.aggregatedOutput ?? "") + delta;
      this.tools.set(id, item);
      const mapped = threadItemTimelineEntries(item, this.cwd);
      for (const entry of mapped) if (entry.type === "tool_call" && entry.detail.type === "plain_text") entry.detail.text = String(item.aggregatedOutput);
      return mapped;
    }
    if (method === "item/commandExecution/terminalInteraction" || method === "codex/event/terminal_interaction") {
      const id = nonEmptyString(record.itemId) ?? nonEmptyString(legacy.call_id);
      const stdin = record.stdin ?? legacy.stdin;
      return id ? [{ type: "tool_call", id: `${id}:stdin:${String(stdin)}`, callId: `${id}:stdin:${String(stdin)}`, name: "write_stdin", status: "completed", error: null,
        detail: { type: "shell", command: String(stdin ?? ""), output: `stdin to ${String(record.processId ?? legacy.process_id ?? id)}` } }] : [];
    }
    if (method === "codex/event/patch_apply_begin" || method === "codex/event/patch_apply_end") {
      return this.observe(method.endsWith("_end") ? "item/completed" : "item/started", { item: { id: legacy.call_id, type: "fileChange", changes: legacy.changes,
        status: method.endsWith("_end") ? (legacy.success === false ? "failed" : "completed") : "inProgress" } });
    }
    if (method !== "item/started" && method !== "item/completed") return [];
    if (!isRecord(record.item)) return [];
    const item = record.item;
    const id = nonEmptyString(item.id);
    const type = normalizeCodexItemType(item.type);
    const done = method === "item/completed";
    if (type === "contextCompaction") {
      const key = id ?? this.compactions.keys().next().value ?? `compaction-${++this.compactionOrdinal}`;
      if (done && this.unpairedCompactionNotifications > 0 && !this.compactions.has(key)) {
        this.unpairedCompactionNotifications -= 1;
        this.completedCompactions.add(key);
        return [];
      }
      if (this.completedCompactions.has(key)) return [];
      if (done) {
        this.unpairedCompactionItems += 1;
        return [this.completeCompaction(key)];
      }
      if (this.compactions.has(key)) return [];
      const trigger = this.compactionTrigger();
      this.compactions.set(key, trigger);
      return [{ type: "compaction", id: key, status: "loading", trigger }];
    }
    if (!id || this.completed.has(id)) return [];
    if (type === "agentMessage" || type === "reasoning") {
      if (item.delivery === "async") return [];
      const entries = threadItemTimelineEntries(item, this.cwd);
      const buffer = type === "agentMessage" ? this.text : this.reasoning;
      const changed = entries.filter((entry) => {
        if (entry.type !== "assistant_message" && entry.type !== "reasoning") return true;
        const previous = buffer.get(id) ?? "";
        const prefix = previous.startsWith("\n\n---\n\n") ? "\n\n---\n\n" : "";
        const body = previous.slice(prefix.length);
        entry.text = prefix + (entry.text.length >= body.length ? entry.text : body);
        if (entry.text === previous) return false;
        buffer.set(id, entry.text);
        return true;
      });
      if (done) { this.completed.add(id); if (type === "agentMessage") this.boundary = true; }
      return changed;
    }
    if (type === "userMessage") return [];
    const previous = this.tools.get(id);
    const merged = { ...previous, ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== null)), status: done ? item.status ?? "completed" : "inProgress" };
    this.tools.set(id, merged);
    if (done) this.completed.add(id);
    return threadItemTimelineEntries(merged, this.cwd);
  }

  settle(status: "failed" | "canceled", message: string): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = this.finishCompactions();
    for (const [id, tool] of this.tools) if (!this.completed.has(id)) {
      items.push(...threadItemTimelineEntries({ ...tool, status, ...(status === "failed" ? { error: { message } } : {}) }, this.cwd));
      this.completed.add(id);
    }
    return items;
  }
}
