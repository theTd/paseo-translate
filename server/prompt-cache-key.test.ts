import { describe, expect, it } from "vitest";
import { createMemoryTranslationCacheStore } from "./translation-cache-store";
import { createPromptCacheKeyManager, derivePromptCacheKey } from "./prompt-cache-key";
import {
  PROMPT_CACHE_KEY_STORE_PREFIX,
  promptCacheKeyValueSchema,
} from "../shared/prompt-cache-key";

describe("derivePromptCacheKey", () => {
  it("is stable per scope and distinct across scopes", () => {
    expect(derivePromptCacheKey("agent-a")).toBe(derivePromptCacheKey("agent-a"));
    expect(derivePromptCacheKey("agent-a")).not.toBe(derivePromptCacheKey("agent-b"));
    // Shape stays inside every gateway's accepted character set and length.
    expect(promptCacheKeyValueSchema.safeParse(derivePromptCacheKey("agent-a")).success).toBe(true);
  });
});

describe("createPromptCacheKeyManager", () => {
  it("derives a key per session when no override is stored", () => {
    const manager = createPromptCacheKeyManager(createMemoryTranslationCacheStore());
    const resolution = manager.resolve("agent-a");
    expect(resolution).toMatchObject({ key: derivePromptCacheKey("agent-a"), pinned: false });
    expect(resolution.derived).toBe(derivePromptCacheKey("agent-a"));
  });

  it("sends no key at all when no store is configured", () => {
    const manager = createPromptCacheKeyManager(undefined);
    // Resolution still works (callers read `.key`), but nothing persists and
    // nothing is ever pinned.
    expect(manager.resolve("agent-a").pinned).toBe(false);
    expect(manager.configure("agent-a", "regenerate").pinned).toBe(false);
  });

  it("pins, rotates, and hands control back to the derived key", () => {
    const store = createMemoryTranslationCacheStore();
    const manager = createPromptCacheKeyManager(store);

    const pinned = manager.configure("agent-a", { key: "project-x" });
    expect(pinned).toMatchObject({ key: "project-x", pinned: true });
    expect(store.get(PROMPT_CACHE_KEY_STORE_PREFIX + "agent-a")).toBe("project-x");

    const rotated = manager.configure("agent-a", "regenerate");
    expect(rotated.pinned).toBe(true);
    expect(rotated.key).not.toBe("project-x");
    expect(promptCacheKeyValueSchema.safeParse(rotated.key).success).toBe(true);
    // A rotation is a fresh namespace, not a new derived key.
    expect(rotated.key).not.toBe(rotated.derived);

    const derived = manager.configure("agent-a", "derive");
    expect(derived).toMatchObject({ key: derivePromptCacheKey("agent-a"), pinned: false });
  });

  it("scopes overrides per session and ignores an invalid stored value", () => {
    const store = createMemoryTranslationCacheStore();
    const manager = createPromptCacheKeyManager(store);
    manager.configure("agent-a", { key: "only-a" });
    expect(manager.resolve("agent-b").pinned).toBe(false);

    // A value written outside the schema (hand-edited cache file) must not
    // reach the wire.
    store.set(PROMPT_CACHE_KEY_STORE_PREFIX + "agent-c", "bad key with spaces");
    expect(manager.resolve("agent-c")).toMatchObject({
      key: derivePromptCacheKey("agent-c"),
      pinned: false,
    });
  });

  it("refuses an empty pinned key", () => {
    const manager = createPromptCacheKeyManager(createMemoryTranslationCacheStore());
    expect(() => manager.configure("agent-a", { key: "   " })).toThrow(/1-128 characters/);
  });
});