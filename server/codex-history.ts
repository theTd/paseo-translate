import type { CodexClientLike } from "./codex-app-server";
import { isRecord, normalizeCodexItemType, toObjectRecord } from "./codex-items";
import { normalizeReplayTimestamp } from "./provider-replay-timestamps";

export interface CodexHistory { mode: "legacy" | "paginated"; turns: Record<string, unknown>[] }

async function pages(client: Pick<CodexClientLike, "request">, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = toObjectRecord(await client.request(method, { ...params, cursor, limit: 100, sortDirection: "asc" }));
    if (!response || !Array.isArray(response.data)) throw new Error(`Invalid Codex ${method} response`);
    entries.push(...response.data.filter(isRecord));
    cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    if (cursor && seen.has(cursor)) throw new Error(`Repeated Codex ${method} cursor`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return entries;
}

export async function readCodexHistory(client: Pick<CodexClientLike, "request">, threadId: string): Promise<CodexHistory> {
  const metadata = toObjectRecord(await client.request("thread/read", { threadId, includeTurns: false }));
  const thread = toObjectRecord(metadata?.thread);
  if (!thread) throw new Error("Codex thread/read did not return a thread");
  if (thread.historyMode === "paginated") {
    const turns = await pages(client, "thread/turns/list", { threadId });
    for (const turn of turns) turn.items = (await pages(client, "thread/items/list", { threadId, turnId: turn.id })).map((entry) => {
      const item = toObjectRecord(entry.item);
      if (!item) return entry;
      const timestamp = normalizeReplayTimestamp(item.timestamp, item.createdAt, item.created_at, entry.timestamp, entry.createdAt, entry.created_at);
      return { ...item, ...(timestamp ? { timestamp } : {}) };
    });
    return { mode: "paginated", turns };
  }
  if (thread.historyMode !== undefined && thread.historyMode !== "legacy") throw new Error(`Unknown Codex history mode: ${String(thread.historyMode)}`);
  const legacy = toObjectRecord(await client.request("thread/read", { threadId, includeTurns: true }));
  const turns = toObjectRecord(legacy?.thread)?.turns;
  if (!Array.isArray(turns)) throw new Error("Codex thread/read did not return turns");
  return { mode: "legacy", turns: turns.filter(isRecord) };
}

/** Historical activity records describe completed parent calls, not live child state. */
export function settleCodexReplayActivities(turns: Record<string, unknown>[]): Record<string, unknown>[] {
  const activities = new Map<string, Record<string, unknown>>();
  return turns.map((turn) => ({ ...turn, items: (Array.isArray(turn.items) ? turn.items : []).flatMap((item) => {
    if (!isRecord(item) || normalizeCodexItemType(item.type) !== "subAgentActivity" ||
        typeof item.agentThreadId !== "string" || !["started", "interacted", "interrupted"].includes(String(item.kind))) return [item];
    const status = item.kind === "interrupted" ? "canceled" : "completed";
    const previous = activities.get(item.agentThreadId);
    if (previous) {
      previous.status = status;
      previous.kind = item.kind;
      if (typeof item.agentPath === "string") previous.agentPath = item.agentPath;
      return [];
    }
    const settled = { ...item, status };
    activities.set(item.agentThreadId, settled);
    return [settled];
  }) }));
}

/** Codex caps each page at 100; sort by recent activity and deduplicate moving rows. */
export async function readCodexSessionWindow(client: Pick<CodexClientLike, "request">, limit: number, cwd?: string): Promise<Record<string, unknown>[]> {
  const rows = new Map<string, Record<string, unknown>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (rows.size < limit) {
    const response = toObjectRecord(await client.request("thread/list", { limit: Math.min(limit - rows.size, 100),
      sortKey: "updated_at", ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) }));
    const before = rows.size;
    for (const entry of Array.isArray(response?.data) ? response.data : []) {
      if (isRecord(entry) && typeof entry.id === "string" && !rows.has(entry.id)) rows.set(entry.id, entry);
    }
    const next = typeof response?.nextCursor === "string" ? response.nextCursor : undefined;
    if (!next || rows.size === before || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  return [...rows.values()].slice(0, limit);
}
