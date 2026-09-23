import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRANSLATION_CACHE_CAPACITY } from "../shared/translate";

/**
 * Translation cache store: plain key-value with least-recently-used eviction.
 * Two flavors share this interface — a memory-only store (tests, fallback)
 * and a JSONL-backed persistent store that survives daemon restarts and
 * plugin updates, so reopening a session never re-bills the endpoint.
 */
export interface TranslationCacheStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface TranslationCacheStoreOptions {
  /** Upper bound on kept entries; defaults to TRANSLATION_CACHE_CAPACITY. */
  maxEntries?: number;
}

interface CacheRecord {
  k: string;
  v: string;
}

const CACHE_FILE_NAME = "cache.jsonl";

export function createMemoryTranslationCacheStore(
  options?: TranslationCacheStoreOptions,
): TranslationCacheStore {
  const maxEntries = options?.maxEntries ?? TRANSLATION_CACHE_CAPACITY;
  const entries = new Map<string, string>();
  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      refreshRecency(entries, key, value);
      return value;
    },
    set(key, value) {
      refreshRecency(entries, key, value);
      evictOldestIfNeeded(entries, maxEntries);
    },
  };
}

/**
 * Disk-backed store: the JSONL file is the source of truth across process
 * lifetimes, mirrored into an in-memory LRU at construction. Every newly
 * translated entry is appended (one line per endpoint call); once appends
 * far exceed the cap, the file is rewritten down to the live entries so it
 * never grows without bound inside one process lifetime. Reads never touch
 * the disk after load, so LRU recency lives in memory only — after a
 * restart, retention order is first-append order, trading a rare re-bill
 * for zero per-read I/O. Any filesystem failure degrades to memory-only —
 * a broken cache must never break or delay translation itself.
 */
export function createPersistentTranslationCacheStore(
  options: TranslationCacheStoreOptions & { directory: string },
): TranslationCacheStore {
  const maxEntries = options.maxEntries ?? TRANSLATION_CACHE_CAPACITY;
  const entries = new Map<string, string>();
  const file = path.join(options.directory, CACHE_FILE_NAME);
  let persist = true;
  let appends = 0;

  const warnDisabled = (cause: unknown) => {
    console.warn(
      `[translate] disk cache unavailable (${describeCause(cause)}); continuing in memory`,
    );
  };

  const rewrite = () => {
    const lines = [...entries].map((entry) => JSON.stringify({ k: entry[0], v: entry[1] }));
    writeFileSync(`${file}.tmp`, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
    renameSync(`${file}.tmp`, file);
  };

  try {
    mkdirSync(options.directory, { recursive: true });
    // A missing file is the normal first-run state, not a persistence failure.
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      raw = "";
    }
    let lines = 0;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      lines += 1;
      const record = parseRecord(line);
      if (record) entries.set(record.k, record.v);
    }
    evictOldestIfNeeded(entries, maxEntries);
    // Duplicate appends (an entry retranslated after a runtime eviction),
    // corrupt trailing lines, and cap-dropped entries leave stale lines on
    // disk; compact once at load so the file matches the in-memory image.
    if (lines > entries.size) rewrite();
  } catch (error) {
    persist = false;
    warnDisabled(error);
  }

  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      refreshRecency(entries, key, value);
      return value;
    },
    set(key, value) {
      refreshRecency(entries, key, value);
      evictOldestIfNeeded(entries, maxEntries);
      if (!persist) return;
      try {
        appendFileSync(file, `${JSON.stringify({ k: key, v: value })}\n`, "utf8");
        appends += 1;
        if (appends > maxEntries * 2) {
          rewrite();
          appends = 0;
        }
      } catch (error) {
        persist = false;
        warnDisabled(error);
      }
    },
  };
}

/**
 * Default cache location: `<paseo home>/plugin-data/translate`. Mirrors the
 * daemon's own home resolution (`$PASEO_HOME`, else `~/.paseo`): the plugin
 * child inherits the daemon's environment, so managed daemons (CLI, desktop)
 * expose PASEO_HOME, and standalone daemons fall back to the same default
 * the daemon itself uses. Deliberate divergence: a blank PASEO_HOME falls
 * back to the default home rather than the daemon's cwd fall-through for
 * empty input — safer anchor for a cache path.
 */
export function defaultTranslationCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaseoHome(env), "plugin-data", "translate");
}

function resolvePaseoHome(env: NodeJS.ProcessEnv): string {
  const raw = env.PASEO_HOME?.trim();
  if (raw === undefined || raw === "") return path.join(os.homedir(), ".paseo");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function parseRecord(line: string): CacheRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<CacheRecord>;
    if (typeof parsed.k === "string" && typeof parsed.v === "string") {
      return { k: parsed.k, v: parsed.v };
    }
    return null;
  } catch {
    // A partial trailing line after a crash mid-append; skipped, then
    // compacted away by the load-time rewrite.
    return null;
  }
}

function refreshRecency(entries: Map<string, string>, key: string, value: string): void {
  entries.delete(key);
  entries.set(key, value);
}

function evictOldestIfNeeded(entries: Map<string, string>, maxEntries: number): void {
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
