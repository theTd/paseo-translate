import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryTranslationCacheStore,
  createPersistentTranslationCacheStore,
  defaultTranslationCacheDirectory,
} from "./translation-cache-store";

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

afterEach(() => {
  vi.restoreAllMocks();
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
});

describe("persistent translation cache store", () => {
  it("serves entries written by an earlier store instance from the same directory", () => {
    const directory = cacheDirectory();
    const first = createPersistentTranslationCacheStore({ directory });
    first.set("key-a", "value-a");
    first.set("key-b", "value-b");

    const second = createPersistentTranslationCacheStore({ directory });
    expect(second.get("key-a")).toBe("value-a");
    expect(second.get("key-b")).toBe("value-b");
  });

  it("keeps the last value for a duplicated key and compacts the file", () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    store.set("key", "one");
    // Simulate a re-append after a runtime eviction (same key, new value).
    appendFileSync(cacheFile(directory), `${JSON.stringify({ k: "key", v: "two" })}\n`, "utf8");

    const reloaded = createPersistentTranslationCacheStore({ directory });
    expect(reloaded.get("key")).toBe("two");
    // The duplicate line is compacted away on load.
    expect(readFileSync(cacheFile(directory), "utf8")).toBe(
      `${JSON.stringify({ k: "key", v: "two" })}\n`,
    );
  });

  it("tolerates a corrupt trailing line and rewrites it away", () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    store.set("key", "value");
    appendFileSync(cacheFile(directory), '{"k":"broken"', "utf8");

    const reloaded = createPersistentTranslationCacheStore({ directory });
    expect(reloaded.get("key")).toBe("value");
    expect(readFileSync(cacheFile(directory), "utf8")).toBe(
      `${JSON.stringify({ k: "key", v: "value" })}\n`,
    );
  });

  it("drops the oldest persisted entries beyond the cap and compacts the file", () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory, maxEntries: 2 });
    store.set("a", "A");
    store.set("b", "B");
    store.set("c", "C");
    // All three appends stay on disk until the next load compacts them.
    expect(readFileSync(cacheFile(directory), "utf8").split("\n").filter(Boolean)).toHaveLength(3);

    const reloaded = createPersistentTranslationCacheStore({ directory, maxEntries: 2 });
    expect(reloaded.get("a")).toBeUndefined();
    expect(reloaded.get("b")).toBe("B");
    expect(reloaded.get("c")).toBe("C");
    const lines = readFileSync(cacheFile(directory), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(JSON.stringify({ k: "b", v: "B" }));
    expect(lines[1]).toBe(JSON.stringify({ k: "c", v: "C" }));
  });

  it("compacts the file mid-session once appends far exceed the cap", () => {
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory, maxEntries: 1 });
    store.set("a", "A");
    store.set("b", "B");
    store.set("c", "C");
    // The third append crosses 2x the cap: the file is rewritten down to the
    // surviving entry instead of growing without bound until the next restart.
    expect(readFileSync(cacheFile(directory), "utf8")).toBe(
      `${JSON.stringify({ k: "c", v: "C" })}\n`,
    );
  });

  it("degrades to memory-only when the directory cannot be created", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A file blocking the directory path makes mkdirSync fail.
    const blocker = path.join(tempDirectory(), "blocker");
    writeFileSync(blocker, "", "utf8");

    const store = createPersistentTranslationCacheStore({
      directory: path.join(blocker, "cache"),
    });
    store.set("key", "value");
    expect(store.get("key")).toBe("value");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("degrades to memory-only when appends fail mid-session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const directory = cacheDirectory();
    const store = createPersistentTranslationCacheStore({ directory });
    store.set("key", "value");
    expect(store.get("key")).toBe("value");

    // Replace the cache file's parent with an unusable state: point the file
    // path at a directory so appendFileSync fails.
    rmSync(cacheFile(directory));
    mkdirSync(cacheFile(directory));
    store.set("another", "entry");
    expect(store.get("another")).toBe("entry"); // still served from memory
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
