import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeCachePreferenceStore } from "./claude-cache-preferences";
import { claudeCachePreferencesSchema } from "../shared/claude-cache-compaction";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary() { const directory = mkdtempSync(path.join(os.tmpdir(), "claude-cache-test-")); directories.push(directory); return directory; }

describe("Claude AFK preference persistence", () => {
  it("preserves an off override across reloads, independently of creation defaults", () => {
    const directory = temporary();
    const preferences = claudeCachePreferencesSchema.parse({ enabled: false, thresholdTokens: 450_000 });
    createClaudeCachePreferenceStore(directory).set("agent", preferences);
    expect(createClaudeCachePreferenceStore(directory).get("agent")).toEqual(preferences);
  });

  it("hashes agent identities instead of treating them as file paths", () => {
    const directory = temporary(); const store = createClaudeCachePreferenceStore(directory);
    store.set("../../other", claudeCachePreferencesSchema.parse({}));
    expect(readdirSync(directory)).toHaveLength(1);
    expect(readdirSync(directory)[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it("fails closed if a previously saved override becomes unreadable", () => {
    const directory = temporary(); const store = createClaudeCachePreferenceStore(directory);
    store.set("agent", claudeCachePreferencesSchema.parse({ enabled: true }));
    writeFileSync(path.join(directory, readdirSync(directory)[0]), "broken", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(store.get("agent")?.enabled).toBe(false);
    warn.mockRestore();
  });

  it("reports a write failure instead of claiming the override was saved", () => {
    const directory = temporary(); const file = path.join(directory, "not-a-directory"); writeFileSync(file, "x");
    expect(() => createClaudeCachePreferenceStore(file).set("agent", claudeCachePreferencesSchema.parse({}))).toThrow();
  });
});
