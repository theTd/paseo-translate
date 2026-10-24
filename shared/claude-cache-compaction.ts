import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CLAUDE_CACHE_OPTIONS_KEY = "translateClaudeCache";
export const claudeCachePreferencesSchema = z.object({
  enabled: z.boolean().default(false),
  thresholdTokens: z.number().int().min(1).max(10_000_000).default(200_000),
  leadSeconds: z.number().int().min(5).max(1800).default(300),
});
export type ClaudeCachePreferences = z.output<typeof claudeCachePreferencesSchema>;
export const claudeCacheSettings = defineSettings({
  id: "claude-cache", scope: "host", version: 1, schema: claudeCachePreferencesSchema,
});

export const claudeCacheSnapshotSchema = z.object({
  serverNow: z.number(),
  preferences: claudeCachePreferencesSchema,
  state: z.enum(["not-open", "unknown", "no-cache", "warm", "expired", "compacting", "compacted", "failed"]),
  reason: z.string(),
  contextTokens: z.number().nullable(),
  ttlSeconds: z.number().nullable(),
  expiresAt: z.number().nullable(),
  scheduledAt: z.number().nullable(),
});
export type ClaudeCacheSnapshot = z.output<typeof claudeCacheSnapshotSchema>;
export const claudeCacheStatusRpc = defineRpc({
  name: "claude-cache.status",
  input: z.object({ agentId: z.string().min(1) }), output: claudeCacheSnapshotSchema,
});
export const claudeCacheConfigureRpc = defineRpc({
  name: "claude-cache.configure",
  input: z.object({ agentId: z.string().min(1), preferences: claudeCachePreferencesSchema }),
  output: claudeCacheSnapshotSchema,
});

/** Uses server time plus elapsed client time; never infer a fresh TTL on reconnect. */
export function cacheCountdown(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "?";
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
