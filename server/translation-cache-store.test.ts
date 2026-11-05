import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryTranslationCacheStore,
  createPersistentTranslationCacheStore,
  defaultTranslationCacheDirectory,
} from "./translation-cache-store";

/**
 * Records every write the store hands to the filesystem. The queue's batching
 * is only observable at that boundary: a test can count how many append calls
 * one turn of sets produced, and hold one append open to see the next batch
 * form behind it. The wrappers delegate to the real implementation so the
 * files under test are real files.
 */
const fsCalls = vi.hoisted(() => ({
  appendBatches: [] as string[],
  rewrites: [] as string[],
  holdAppend: undefined as Promise<void> | undefined,
  onAppendStarted: undefined as (() => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: (async (file: string, data: string, encoding: BufferEncoding) => {
      fsCalls.appendBatches.push(data);
      fsCalls.onAppendStarted?.();
      fsCalls.onAppendStarted = undefined;
      if (fsCalls.holdAppend !== undefined) await fsCalls.holdAppend;
      return actual.appendFile(file, data, encoding);
    }) as typeof actual.appendFile,
    writeFile: (async (file: string, data: string, encoding: BufferEncoding) => {
      fsCalls.rewrites.push(file);
      return actual.writeFile(file, data, encoding);
    }) as typeof actual.writeFile,
  };
});

const tempRoots: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "translate-cache-"));
  tempRoots.push(directory);
  return directory;
}

/** Cache subdirectory inside a fresh temp root (parent exists, cache dir does not). */
function cacheDirectory(): string {
  return path.join(tempDirectory(), "cache");
}

function cacheFile(directory: string): string {
  return path.join(directory, "cache.jsonl");
}

/** One persisted record, byte-identical to what the store appends (minus the newline). */
function jsonLine(key: string, value: string): string {
  return JSON.stringify({ k: key, v: value });
}

function fileLines(directory: string): string[] {
  return readFileSync(cacheFile(directory), "utf8").split("\n").filter(Boolean);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  fsCalls.appendBatches.length = 0;
  fsCalls.rewrites.length = 0;
  fsCalls.holdAppend = undefined;
  fsCalls.onAppendStarted = undefined;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("memory translation cache store", () => {
  it("evicts the least recently used entry when full", () => {
    const store = createMemoryTranslationCacheStore({ maxEntries: 2 });
    store.set("a", "A");
    store.set("b", "B");
    expect(store.get("a")).toBe("A"); // refresh "a" past "b"
    store.set("c", "C");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBe("A");
    expect(store.get("c")).toBe("C");
  });

  it("evicts the oldest entries when the character cap is crossed", () => {
    const store = createMemoryTranslationCacheStore({ maxEntries: 10, maxChars: 12 });
    store.set("a", "1234"); // 5 retained characters
    store.set("b", "5678"); // 10
    store.set("c", "90"); // 13 > 12, so "a" goes
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBe("5678");
    expect(store.get("c")).toBe("90");
    expect(store.stats()).toEqual({ entries: 2, chars: 8 });
  });

  it("counts keys toward the retained character total", () => {
    const store = createMemoryTranslationCacheStore();
    store.set("key", "value");
    expect(store.stats()).toEqual({ entries: 1, chars: 8 });
  });
});

describe("persistent translation cache store", () => {
  it("serves entries written by an earlier store instance from the same directory", async () => {
    const directory = cacheDirectory();
    const first = createPersistentTranslationCacheStore({ directory });
    await first.ready();
    first.set("key-a", "value-a");
    first.set("key-b", "value-b");
    await first.flush();

    const second = createPersistentTranslationCacheStore({ directory });
    await second.ready();
    await second.flush();
    expect(second.get("key-a")).toBe("value-a");
    expect(second.get("key-b")).toBe("value-b");
  });

  it("resolves ready after a set made during startup reaches the disk", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    // Synchronous, so the set lands before the background load finishes.
    store.set("key", "value");
    await store.ready();
    expect(fileLines(directory)).toEqual([jsonLine("key", "value")]);
  });

  it("appends entries to the file in set order", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    await store.ready();
    store.set("first", "1");
    store.set("second", "2");
    store.set("third", "3");
    await store.flush();
    expect(fileLines(directory)).toEqual([
      jsonLine("first", "1"),
      jsonLine("second", "2"),
      jsonLine("third", "3"),
    ]);
  });

  it("batches appends made in one turn into a single write", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    await store.ready();
    for (let index = 0; index < 25; index += 1) {
      store.set(`key-${index}`, `value-${index}`);
    }
    await store.flush();
    expect(fsCalls.appendBatches).toHaveLength(1);
    expect(fsCalls.appendBatches[0].split("\n").filter(Boolean)).toHaveLength(25);
    expect(fileLines(directory)).toHaveLength(25);
  });

  it("batches appends that arrive while a write is in flight into the next write", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    await store.ready();
    const gate = deferred();
    const started = deferred();
    fsCalls.holdAppend = gate.promise;
    fsCalls.onAppendStarted = started.resolve;

    store.set("a", "A");
    await started.promise; // the first append is now waiting inside the queue
    store.set("b", "B");
    store.set("c", "C");
    gate.resolve();
    await store.flush();

    expect(fsCalls.appendBatches).toEqual([
      `${jsonLine("a", "A")}\n`,
      `${jsonLine("b", "B")}\n${jsonLine("c", "C")}\n`,
    ]);
    expect(fileLines(directory)).toEqual([
      jsonLine("a", "A"),
      jsonLine("b", "B"),
      jsonLine("c", "C"),
    ]);
  });

  it("does not append a line when a key is rewritten with the same value", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    await store.ready();
    store.set("k", "v");
    store.set("k", "v");
    store.set("k", "v");
    await store.flush();
    expect(fileLines(directory)).toHaveLength(1);
    store.set("k", "w");
    await store.flush();
    expect(fileLines(directory)).toHaveLength(2);
    const reloaded = createPersistentTranslationCacheStore({ directory });
    await reloaded.ready();
    await reloaded.flush();
    expect(reloaded.get("k")).toBe("w");
  });

  it("keeps the last value for a duplicated key and compacts the file on load", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    await store.ready();
    store.set("key", "one");
    await store.flush();
    // Simulate a re-append after a runtime eviction (same key, new value).
    appendFileSync(cacheFile(directory), `${jsonLine("key", "two")}\n`);

    const reloaded = createPersistentTranslationCacheStore({ directory });
    await reloaded.ready();
    await reloaded.flush();
    expect(reloaded.get("key")).toBe("two");
    // The duplicate line is compacted away by the load-time rewrite.
    expect(readFileSync(cacheFile(directory), "utf8")).toBe(`${jsonLine("key", "two")}\n`);
  });

  it("tolerates a corrupt trailing line and rewrites it away", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    await store.ready();
    store.set("key", "value");
    await store.flush();
    appendFileSync(cacheFile(directory), '{"k":"broken"');

    const reloaded = createPersistentTranslationCacheStore({ directory });
    await reloaded.ready();
    await reloaded.flush();
    expect(reloaded.get("key")).toBe("value");
    expect(readFileSync(cacheFile(directory), "utf8")).toBe(`${jsonLine("key", "value")}\n`);
  });

  it("drops the oldest persisted entries beyond the cap and compacts the file", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory, maxEntries: 2 });
    await store.ready();
    store.set("a", "A");
    store.set("b", "B");
    store.set("c", "C");
    // All three appends stay on disk until the next load compacts them.
    await store.flush();
    expect(fileLines(directory)).toHaveLength(3);

    const reloaded = createPersistentTranslationCacheStore({ directory, maxEntries: 2 });
    await reloaded.ready();
    await reloaded.flush();
    expect(reloaded.get("a")).toBeUndefined();
    expect(reloaded.get("b")).toBe("B");
    expect(reloaded.get("c")).toBe("C");
    expect(fileLines(directory)).toEqual([jsonLine("b", "B"), jsonLine("c", "C")]);
  });

  it("drops persisted entries beyond the character cap on load", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory, maxChars: 20 });
    await store.ready();
    store.set("a", "aaaaaaaaa"); // 10 retained characters
    store.set("b", "bbbbbbbbb"); // 20
    store.set("c", "ccccccccc"); // 30 > 20, so the in-memory image drops "a"
    await store.flush();
    // The evicted entry's append is already on disk; the load compacts it away.
    expect(fileLines(directory)).toHaveLength(3);

    const reloaded = createPersistentTranslationCacheStore({ directory, maxChars: 20 });
    await reloaded.ready();
    await reloaded.flush();
    expect(reloaded.get("a")).toBeUndefined();
    expect(reloaded.get("b")).toBe("bbbbbbbbb");
    expect(reloaded.get("c")).toBe("ccccccccc");
    expect(reloaded.stats()).toEqual({ entries: 2, chars: 20 });
    expect(fileLines(directory)).toEqual([jsonLine("b", "bbbbbbbbb"), jsonLine("c", "ccccccccc")]);
  });

  it("lets a set made before the load finishes win over the persisted line", async () => {
    const directory = cacheDirectory();
    const first = createPersistentTranslationCacheStore({ directory });
    await first.ready();
    first.set("shared", "old");
    first.set("disk-only", "value");
    await first.flush();

    const second = createPersistentTranslationCacheStore({ directory });
    // Synchronous, so the constructor's background load cannot have finished.
    expect(second.get("disk-only")).toBeUndefined();
    second.set("shared", "new");
    await second.ready();
    expect(second.get("shared")).toBe("new");
    expect(second.get("disk-only")).toBe("value");
    await second.flush();

    const third = createPersistentTranslationCacheStore({ directory });
    await third.ready();
    await third.flush();
    expect(third.get("shared")).toBe("new");
  });

  it("compacts once appends pass the floor, rewriting to the live image", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory, maxEntries: 2 });
    await store.ready();
    for (let index = 0; index < 1000; index += 1) store.set("hot", `v${index}`);
    await store.flush();
    // 1 000 appends: the floor is reached but not crossed.
    expect(fileLines(directory)).toHaveLength(1000);
    expect(fsCalls.rewrites).toHaveLength(0);

    store.set("hot", "v1000");
    await store.flush();
    expect(fsCalls.rewrites).toHaveLength(1);
    expect(fileLines(directory)).toEqual([jsonLine("hot", "v1000")]);
  });

  it("scales the compaction interval with the entry cap", async () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory, maxEntries: 6000 });
    await store.ready();
    for (let index = 0; index < 1200; index += 1) store.set("hot", `v${index}`);
    await store.flush();
    // 6 000 * 0.2 = 1 200 is the trigger; a floor-only store would have
    // rewritten at append 1 001, so 1 200 live lines prove the ratio is used.
    expect(fileLines(directory)).toHaveLength(1200);
    expect(fsCalls.rewrites).toHaveLength(0);

    store.set("hot", "v1200");
    await store.flush();
    expect(fileLines(directory)).toEqual([jsonLine("hot", "v1200")]);
  });

  it("degrades to memory-only when the directory cannot be created", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A file blocking the directory path makes the async mkdir fail.
    const blocker = path.join(tempDirectory(), "blocker");
    writeFileSync(blocker, "", "utf8");

    const store = createPersistentTranslationCacheStore({
      directory: path.join(blocker, "cache"),
    });
    await store.ready();
    store.set("key", "value");
    expect(store.get("key")).toBe("value");
    await store.flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("degrades to memory-only when appends fail mid-session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    await store.ready();
    store.set("key", "value");
    await store.flush();
    expect(store.get("key")).toBe("value");

    // Replace the cache file's parent with an unusable state: point the file
    // path at a directory so appendFile fails.
    rmSync(cacheFile(directory));
    mkdirSync(cacheFile(directory));
    store.set("another", "entry");
    await store.flush();
    expect(store.get("another")).toBe("entry"); // still served from memory
    expect(warn).toHaveBeenCalledTimes(1);

    // Persistence stays off: later sets are memory-only and warn again never.
    store.set("third", "value");
    await store.flush();
    expect(store.get("third")).toBe("value");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("default translation cache directory", () => {
  it("mirrors the daemon's PASEO_HOME resolution", () => {
    const home = os.homedir();
    expect(defaultTranslationCacheDirectory({})).toBe(
      path.join(home, ".paseo", "plugin-data", "translate"),
    );
    expect(defaultTranslationCacheDirectory({ PASEO_HOME: "" })).toBe(
      path.join(home, ".paseo", "plugin-data", "translate"),
    );
    expect(defaultTranslationCacheDirectory({ PASEO_HOME: "   " })).toBe(
      path.join(home, ".paseo", "plugin-data", "translate"),
    );
    expect(defaultTranslationCacheDirectory({ PASEO_HOME: "~" })).toBe(
      path.join(home, "plugin-data", "translate"),
    );
    expect(defaultTranslationCacheDirectory({ PASEO_HOME: "~/sub" })).toBe(
      path.join(home, "sub", "plugin-data", "translate"),
    );
    expect(defaultTranslationCacheDirectory({ PASEO_HOME: "C:/cache-root" })).toBe(
      path.join(path.resolve("C:/cache-root"), "plugin-data", "translate"),
    );
  });
});
