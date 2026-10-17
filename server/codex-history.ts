import type { CodexClientLike } from "./codex-app-server";
import { isRecord, toObjectRecord } from "./codex-items";

export interface CodexHistory { mode: "legacy" | "paginated"; turns: Record<string, unknown>[] }

async function pages(client: CodexClientLike, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
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

export async function readCodexHistory(client: CodexClientLike, threadId: string): Promise<CodexHistory> {
  const metadata = toObjectRecord(await client.request("thread/read", { threadId, includeTurns: false }));
  const thread = toObjectRecord(metadata?.thread);
  if (!thread) throw new Error("Codex thread/read did not return a thread");
  if (thread.historyMode === "paginated") {
    const turns = await pages(client, "thread/turns/list", { threadId });
    for (const turn of turns) turn.items = (await pages(client, "thread/items/list", { threadId, turnId: turn.id })).map((entry) => toObjectRecord(entry.item) ?? entry);
    return { mode: "paginated", turns };
  }
  if (thread.historyMode !== undefined && thread.historyMode !== "legacy") throw new Error(`Unknown Codex history mode: ${String(thread.historyMode)}`);
  const legacy = toObjectRecord(await client.request("thread/read", { threadId, includeTurns: true }));
  const turns = toObjectRecord(legacy?.thread)?.turns;
  if (!Array.isArray(turns)) throw new Error("Codex thread/read did not return turns");
  return { mode: "legacy", turns: turns.filter(isRecord) };
}
