import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeCachePreferencesSchema, type ClaudeCachePreferences } from "../shared/claude-cache-compaction";

/** Preferences are authoritative configuration, never evictable translation-cache entries. */
export interface ClaudeCachePreferenceStore {
  get(agentId: string): ClaudeCachePreferences | undefined;
  set(agentId: string, preferences: ClaudeCachePreferences): void;
}

export function createClaudeCachePreferenceStore(directory: string): ClaudeCachePreferenceStore {
  const file = (agentId: string) => path.join(directory, createHash("sha256").update(agentId).digest("hex") + ".json");
  return {
    get(agentId) {
      try { return claudeCachePreferencesSchema.parse(JSON.parse(readFileSync(file(agentId), "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        // A damaged/unreadable preference must not resurrect an enabled creation default.
        console.warn("[translate-claude] Cache preferences unavailable; AFK compaction disabled", error);
        return claudeCachePreferencesSchema.parse({ enabled: false });
      }
    },
    set(agentId, preferences) {
      mkdirSync(directory, { recursive: true });
      const destination = file(agentId);
      const temporary = destination + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, JSON.stringify(claudeCachePreferencesSchema.parse(preferences)) + "\n", "utf8");
        renameSync(temporary, destination);
      } finally {
        try { unlinkSync(temporary); } catch { /* Renamed or never created. */ }
      }
    },
  };
}
