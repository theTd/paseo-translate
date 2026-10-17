import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

export type ReplayedTimelineItem = ProviderTimelineItem & { timestamp?: string };

/** The protocol places time on the event, outside its canonical timeline item. */
export function replayTimelineEvent(sessionId: string, source: ReplayedTimelineItem): Extract<ProviderEvent, { type: "timeline.item" }> {
  const { timestamp, ...item } = source;
  const time = normalizeReplayTimestamp(timestamp);
  return { type: "timeline.item", sessionId, item, ...(time ? { timestamp: time } : {}) };
}

/** Native providers accept ISO timestamps and epoch seconds or milliseconds. */
export function normalizeReplayTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    const milliseconds = typeof value === "number"
      ? (Math.abs(value) < 1e12 ? value * 1000 : value)
      : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
    if (!Number.isFinite(milliseconds)) continue;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return undefined;
}

export function codexReplayTimestamp(item: Record<string, unknown>, turn: Record<string, unknown>, user: boolean): string | undefined {
  const itemTime = normalizeReplayTimestamp(item.timestamp, item.createdAt, item.created_at);
  const start = normalizeReplayTimestamp(turn.startedAt, turn.started_at);
  const end = normalizeReplayTimestamp(turn.completedAt, turn.completed_at);
  return itemTime ?? (user ? start ?? end : end ?? start);
}
