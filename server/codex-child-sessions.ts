import { randomUUID } from "node:crypto";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CodexItemStream } from "./codex-item-stream";
import { isRecord, nonEmptyString, readTurnId, readTurnStatus, threadItemToTimeline, toCodexUsage, toObjectRecord } from "./codex-items";

export interface CodexChildSession {
  id: string;
  parentId: string;
  stream: CodexItemStream;
  turnId: string | null;
}

export interface CodexChildSessionOwner {
  id: string;
  threadId: string | null;
  config: { cwd: string };
  supportsSubsessions: boolean;
  children: Map<string, CodexChildSession>;
  childBuffer: Array<{ method: string; params: unknown }>;
}

interface CodexChildContext { emit(event: ProviderEvent): void }

export function registerChildThreads(session: CodexChildSessionOwner, parentThreadId: string | null, item: Record<string, unknown>, context: CodexChildContext): void {
  if (!session.supportsSubsessions || !parentThreadId) return;
  const states = toObjectRecord(item.agentsStates) ?? {};
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
  const ids = [...receivers, ...Object.keys(states), ...(typeof item.agentThreadId === "string" ? [item.agentThreadId] : [])];
  for (const threadId of ids) {
    if (typeof threadId !== "string" || threadId === session.threadId || threadId === parentThreadId) continue;
    const parentId = session.children.get(parentThreadId)?.id ?? session.id;
    if (!session.children.has(threadId)) {
      const child = { id: `${session.id}:codex:${threadId}`, parentId, stream: new CodexItemStream(session.config.cwd), turnId: null as string | null };
      session.children.set(threadId, child);
      const state = toObjectRecord(states[threadId]);
      context.emit({ type: "session.opened", sessionId: child.id, parentSessionId: parentId, toolCallId: String(item.id),
        capabilities: ["session.subsession"], restoration: "parent", cwd: session.config.cwd,
        title: nonEmptyString(state?.agentNickname) ?? nonEmptyString(item.agentNickname) ?? "Codex subagent" });
      context.emit({ type: "session.ready", sessionId: child.id });
      const buffered = session.childBuffer.filter((event) => toObjectRecord(event.params)?.threadId === threadId);
      session.childBuffer = session.childBuffer.filter((event) => toObjectRecord(event.params)?.threadId !== threadId);
      for (const event of buffered) routeChildNotification(session, threadId, event.method, event.params, context);
    }
    const child = session.children.get(threadId)!;
    const state = states[threadId];
    const status = typeof state === "string" ? state : toObjectRecord(state)?.status;
    if (child.turnId && ["completed", "errored", "failed", "shutdown"].includes(String(status))) {
      if (["errored", "failed", "shutdown"].includes(String(status))) for (const item of child.stream.settle(status === "shutdown" ? "canceled" : "failed", "Subagent ended")) context.emit({ type: "timeline.item", sessionId: child.id, item });
      context.emit({ type: "session.turn", sessionId: child.id, turnId: child.turnId, state: ["errored", "failed"].includes(String(status)) ? "failed" : "completed" });
      child.turnId = null;
    }
  }
}

export function routeChildNotification(session: CodexChildSessionOwner, threadId: string, method: string, params: unknown, context: CodexChildContext): void {
  if (!session.supportsSubsessions) return;
  const child = session.children.get(threadId);
  if (!child) {
    session.childBuffer.push({ method, params });
    if (session.childBuffer.length > 500) session.childBuffer.shift();
    return;
  }
  const record = toObjectRecord(params);
  if (method === "turn/started" || (method.startsWith("item/") && method !== "item/completed")) {
    if (!child.turnId) {
      child.turnId = readTurnId(params) ?? randomUUID();
      context.emit({ type: "session.turn", sessionId: child.id, turnId: child.turnId, state: "started" });
    }
  }
  if (method === "turn/completed") {
    const status = readTurnStatus(params);
    if (status.status === "failed" || status.status === "interrupted") for (const item of child.stream.settle(status.status === "failed" ? "failed" : "canceled", status.errorMessage ?? "Subagent turn ended")) context.emit({ type: "timeline.item", sessionId: child.id, item });
    if (child.turnId) context.emit({ type: "session.turn", sessionId: child.id, turnId: child.turnId,
      state: status.status === "failed" ? "failed" : status.status === "interrupted" ? "canceled" : "completed" });
    child.turnId = null;
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = toCodexUsage(record?.tokenUsage ?? record);
    if (usage) context.emit({ type: "session.usage", sessionId: child.id, usage });
    return;
  }
  if (isRecord(record?.item)) {
    registerChildThreads(session, threadId, record.item, context);
    if (record.item.type === "userMessage") {
      const mapped = threadItemToTimeline(record.item);
      if (mapped) context.emit({ type: "timeline.item", sessionId: child.id, item: mapped });
      return;
    }
  }
  for (const item of child.stream.observe(method, params)) context.emit({ type: "timeline.item", sessionId: child.id, item });
}

export function closeChildren(session: CodexChildSessionOwner, context: CodexChildContext): void {
  for (const child of [...session.children.values()].reverse()) {
    if (child.turnId) context.emit({ type: "session.turn", sessionId: child.id, turnId: child.turnId, state: "canceled" });
    context.emit({ type: "session.closed", sessionId: child.id });
  }
  session.children.clear();
  session.childBuffer = [];
}
