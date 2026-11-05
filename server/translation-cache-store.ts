import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRANSLATION_CACHE_CAPACITY, TRANSLATION_CACHE_CHAR_CAPACITY } from "../shared/translate";

/**
 * Translation cache store: plain key-value with least-recently-used eviction.
 * Two flavors share this interface — a memory-only store (tests, fallback)
 * and a JSONL-backed persistent store that survives daemon restarts and
 * plugin updates, so reopening a session never re-bills the endpoint.
 */
export interface TranslationCacheStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  /** Retained size of the in-memory mirror, read by the memory probe. */
  stats(): TranslationCacheStats;
}

/**
 * Persistent flavor. The disk image loads in the background, so the store is
 * usable the moment the constructor returns: `get()` simply misses until the
 * image is in memory, while `set()` updates the mirror immediately and queues
 * the append. `ready()` is the startup gate: it resolves once the image is
 * loaded and the startup writes (the load-time compaction and any set made
 * during the load) have drained. `flush()` drains whatever the queue holds
 * when it is called. Neither ever rejects: a filesystem failure degrades the
 * store to memory-only by design, not as a caller error.
 */
export interface PersistentTranslationCacheStore extends TranslationCacheStore {
  ready(): Promise<void>;
  flush(): Promise<void>;
}

/**
 * A type alias rather than an interface on purpose: object-literal types carry
 * an implicit index signature, so this stays assignable to the memory probe's
 * `Record<string, number>` gauge value without a cast at the call site.
 */
export type TranslationCacheStats = {
  entries: number;
  /** Retained UTF-16 characters across every kept key and value. */
  chars: number;
};

export interface TranslationCacheStoreOptions {
  /** Upper bound on kept entries; defaults to TRANSLATION_CACHE_CAPACITY. */
  maxEntries?: number;
  /** Upper bound on retained key+value characters; defaults to TRANSLATION_CACHE_CHAR_CAPACITY. */
  maxChars?: number;
}

interface CacheRecord {
  k: string;
  v: string;
}

const CACHE_FILE_NAME = "cache.jsonl";

/**
 * Appends kept on disk between compactions, as a share of the entry cap. The
 * floor keeps small stores (the prompt-cache-key pins, 2 000 entries) from
 * rewriting their file every few hundred writes; a larger cache scales its
 * rewrite interval with its capacity.
 */
const COMPACTION_APPEND_RATIO = 0.2;
const COMPACTION_APPEND_FLOOR = 1_000;

/** Lines parsed between event-loop yields: a 46 MB image must not stall an RPC. */
const LOAD_LINES_PER_YIELD = 500;

/**
 * In-memory LRU shared by both flavors. Retained characters are tracked on
 * every write and eviction so `set()` never re-sums the whole map.
 */
interface LruEntries {
  readonly entries: Map<string, string>;
  get(key: string): string | undefined;
  /** Inserts or updates, refreshing recency; true when the value changed. */
  write(key: string, value: string): boolean;
  evict(maxEntries: number, maxChars: number): void;
  stats(): TranslationCacheStats;
}

function createLruEntries(): LruEntries {
  const entries = new Map<string, string>();
  let chars = 0;

  function write(key: string, value: string): boolean {
    const previous = entries.get(key);
    if (previous !== undefined) chars -= key.length + previous.length;
    // Delete first so an update moves the key to the most-recent end.
    entries.delete(key);
    entries.set(key, value);
    chars += key.length + value.length;
    return previous !== value;
  }

  function evict(maxEntries: number, maxChars: number): void {
    while (entries.size > maxEntries || chars > maxChars) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) return;
      const value = entries.get(oldest);
      entries.delete(oldest);
      if (value !== undefined) chars -= oldest.length + value.length;
    }
  }

  return {
    entries,
    get(key) {
      const value = entries.get(key);
      if (value !== undefined) write(key, value);
      return value;
    },
    write,
    evict,
    stats: () => ({ entries: entries.size, chars }),
  };
}

export function createMemoryTranslationCacheStore(
  options?: TranslationCacheStoreOptions,
): TranslationCacheStore {
  const maxEntries = options?.maxEntries ?? TRANSLATION_CACHE_CAPACITY;
  const maxChars = options?.maxChars ?? TRANSLATION_CACHE_CHAR_CAPACITY;
  const index = createLruEntries();
  return {
    get: (key) => index.get(key),
    set(key, value) {
      index.write(key, value);
      index.evict(maxEntries, maxChars);
    },
    stats: () => index.stats(),
  };
}

/**
 * Disk-backed store: the JSONL file is the source of truth across process
 * lifetimes, mirrored into an in-memory LRU. Every newly translated entry is
 * appended (one line per endpoint call); once appends pass
 * max(maxEntries * 0.2, 1000), the file is rewritten down to the live entries.
 * Neither the load nor the writes touch the caller's stack: `set()` mutates
 * memory and queues the line, one background writer serializes appends and
 * rewrites, and a slow disk therefore delays only the cache file, never an
 * RPC. Reads never touch the disk after load, so LRU recency lives in memory
 * only — after a restart, retention order is append order, trading a rare
 * re-bill for zero per-read I/O. Any filesystem failure degrades to
 * memory-only — a broken cache must never break or delay translation itself.
 */
export function createPersistentTranslationCacheStore(
  options: TranslationCacheStoreOptions & { directory: string },
): PersistentTranslationCacheStore {
  const maxEntries = options.maxEntries ?? TRANSLATION_CACHE_CAPACITY;
  const maxChars = options.maxChars ?? TRANSLATION_CACHE_CHAR_CAPACITY;
  const compactionLimit = Math.max(maxEntries * COMPACTION_APPEND_RATIO, COMPACTION_APPEND_FLOOR);
  const index = createLruEntries();
  const file = path.join(options.directory, CACHE_FILE_NAME);
  const tempFile = `${file}.tmp`;
  let persist = true;
  let loaded = false;
  /** Appends written since the last rewrite; crossing compactionLimit schedules one. */
  let appendsSinceCompaction = 0;
  let compactionRequested = false;
  /** Appends waiting for the single writer; set() only pushes to this array. */
  const pendingLines: string[] = [];
  /** Keys set while the image was loading: the fresh value wins over the file line. */
  const writtenDuringLoad = new Set<string>();
  let writeScheduled = false;
  let queueTail: Promise<void> = Promise.resolve();

  const disablePersistence = (cause: unknown): void => {
    if (!persist) return;
    persist = false;
    pendingLines.length = 0;
    compactionRequested = false;
    console.warn(
      `[translate] disk cache unavailable (${describeCause(cause)}); continuing in memory`,
    );
  };

  const rewrite = async (): Promise<void> => {
    const lines = [...index.entries].map(([key, value]) => JSON.stringify({ k: key, v: value }));
    await writeFile(tempFile, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
    await rename(tempFile, file);
  };

  /** One queued job drains appends in batches until nothing is pending. */
  const drainWrites = async (): Promise<void> => {
    while (pendingLines.length > 0 || compactionRequested) {
      if (compactionRequested) {
        compactionRequested = false;
        // The rewrite snapshots the live image, which already holds every
        // pending line; appending them too would duplicate the file.
        pendingLines.length = 0;
        await rewrite();
        appendsSinceCompaction = 0;
        continue;
      }
      const batch = pendingLines.splice(0);
      await appendFile(file, batch.join(""), "utf8");
      appendsSinceCompaction += batch.length;
      if (appendsSinceCompaction > compactionLimit) compactionRequested = true;
    }
  };

  const scheduleWrite = (): void => {
    if (!persist || !loaded || writeScheduled) return;
    writeScheduled = true;
    queueTail = queueTail
      .then(drainWrites)
      .catch((error: unknown) => disablePersistence(error))
      .finally(() => {
        writeScheduled = false;
        // A set that arrived after the drain's last check would otherwise sit
        // in pendingLines with no writer queued for it.
        if (persist && loaded && (pendingLines.length > 0 || compactionRequested)) {
          scheduleWrite();
        }
      });
  };

  const load = async (): Promise<void> => {
    try {
      await mkdir(options.directory, { recursive: true });
      // A missing file is the normal first-run state, not a persistence failure.
      let raw = "";
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      let lines = 0;
      for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        lines += 1;
        const record = parseRecord(line);
        // A value set during the load wins over the older persisted line;
        // untouched keys still take their line, and duplicate lines keep the last.
        if (record !== null && !writtenDuringLoad.has(record.k)) {
          index.write(record.k, record.v);
        }
        if (lines % LOAD_LINES_PER_YIELD === 0) await yieldToLoop();
      }
      // Sets made during the load are the newest entries, not the oldest, so a
      // full cache evicts stale loaded lines before them.
      for (const key of writtenDuringLoad) {
        const value = index.entries.get(key);
        if (value !== undefined) index.write(key, value);
      }
      index.evict(maxEntries, maxChars);
      // Duplicate appends (an entry retranslated after a runtime eviction),
      // corrupt trailing lines, and cap-dropped entries leave stale lines on
      // disk; compact once after the load so the file matches the image.
      if (lines > index.entries.size) compactionRequested = true;
    } catch (error) {
      disablePersistence(error);
    } finally {
      loaded = true;
      if (persist && (pendingLines.length > 0 || compactionRequested)) scheduleWrite();
    }
  };

  const startup = load();

  const flush = async (): Promise<void> => {
    await startup;
    while (persist && (writeScheduled || pendingLines.length > 0 || compactionRequested)) {
      scheduleWrite();
      await queueTail;
    }
  };

  return {
    get(key) {
      return index.get(key);
    },
    set(key, value) {
      // Rewriting an identical value (reverse-index refresh on every prompt
      // cache hit, replay re-registering prompt displays on every reopen)
      // only refreshes recency in memory, exactly like get(): appending it
      // would grow the file by one line per call for no information.
      const unchanged = !index.write(key, value);
      if (!loaded) writtenDuringLoad.add(key);
      index.evict(maxEntries, maxChars);
      if (!persist || unchanged) return;
      pendingLines.push(`${JSON.stringify({ k: key, v: value })}\n`);
      scheduleWrite();
    },
    stats() {
      return index.stats();
    },
    ready() {
      return startup.then(flush);
    },
    flush,
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

/** Yields to the event loop so parsing cannot stall a running RPC. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
