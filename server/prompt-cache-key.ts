import { createHash, randomUUID } from "node:crypto";
import {
  PROMPT_CACHE_KEY_MAX_LENGTH,
  PROMPT_CACHE_KEY_STORE_PREFIX,
  readPromptCacheKeyOverride,
  writePromptCacheKeyOverride,
} from "../shared/prompt-cache-key";
import type { TranslationCacheStore } from "./translation-cache-store";

/**
 * Resolves the `prompt_cache_key` one translation request should carry.
 *
 * Every request of one session replays the same prefix (system prompt, then
 * the turns committed so far), so a stable key per session scope is what lets
 * an endpoint's prompt cache hit at all. The derived key is a hash of the
 * scope: deterministic across daemon restarts, distinct between sessions, and
 * short enough for every gateway. A stored override wins over the derived key
 * so the key can be pinned or rotated by hand (see shared/prompt-cache-key).
 *
 * Overrides live in their own persistent store (created in index.server.ts),
 * not in the translation LRU. A pin is read on every request but written only
 * when the user changes it, so in the shared store it sank to the cold end
 * whenever translation traffic was heavy and was evicted silently — the pin
 * disappeared while the translation cache it was supposed to be independent
 * of stayed healthy. The store is still namespaced under
 * PROMPT_CACHE_KEY_STORE_PREFIX, so a pin is never part of a translation cache
 * key: rotating it moves future requests to a new cache namespace without
 * invalidating anything already translated.
 *
 * Pins written before the split sit in the translation store. The manager
 * therefore takes that store as `legacyStore` and migrates a surviving pin
 * into the dedicated store on the first resolve that needs it.
 */
export interface PromptCacheKeyManager {
  resolve(scopeKey: string): { key: string; pinned: boolean; derived: string };
  /**
   * `derive` clears the override, `regenerate` stores a fresh random key,
   * and a string pins exactly that key. Returns the new resolution.
   */
  configure(
    scopeKey: string,
    action: "derive" | "regenerate" | { key: string },
  ): { key: string; pinned: boolean; derived: string };
}

/** Prefix of the derived key; `tr` keeps endpoint logs readable. */
const DERIVED_PREFIX = "tr-";

/**
 * Derived key for one scope. 32 hex characters keep collisions negligible
 * while staying inside limits that count characters (OpenAI documents a
 * 64-character cap for `prompt_cache_key`).
 */
export function derivePromptCacheKey(scopeKey: string): string {
  return `${DERIVED_PREFIX}${createHash("sha256").update(scopeKey, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Store view that copies a pre-split override into the dedicated store the
 * first time it is read there. Only a missing entry falls back: an empty
 * value is the explicit "automatic" marker written by configure("derive"),
 * and treating it as missing would resurrect the old pin on every resolve.
 */
function withLegacyOverrides(
  store: TranslationCacheStore,
  legacyStore: TranslationCacheStore | undefined,
): TranslationCacheStore {
  if (legacyStore === undefined || legacyStore === store) return store;
  return {
    get(key) {
      const value = store.get(key);
      if (value !== undefined) return value;
      const legacy = legacyStore.get(key);
      if (legacy !== undefined) store.set(key, legacy);
      return legacy;
    },
    set(key, value) {
      store.set(key, value);
    },
    stats() {
      return store.stats();
    },
  };
}

export function createPromptCacheKeyManager(
  store: TranslationCacheStore | undefined,
  legacyStore?: TranslationCacheStore,
): PromptCacheKeyManager {
  const overrides =
    store === undefined ? undefined : withLegacyOverrides(store, legacyStore);

  function resolve(scopeKey: string): { key: string; pinned: boolean; derived: string } {
    const derived = derivePromptCacheKey(scopeKey);
    const pinned = readPromptCacheKeyOverride(overrides, scopeKey);
    return pinned === undefined
      ? { key: derived, pinned: false, derived }
      : { key: pinned, pinned: true, derived };
  }

  return {
    resolve,
    configure(scopeKey, action) {
      if (action === "derive") {
        writePromptCacheKeyOverride(overrides, scopeKey, "");
      } else if (action === "regenerate") {
        // `randomUUID` has dashes only; the value must pass the key schema.
        writePromptCacheKeyOverride(
          overrides,
          scopeKey,
          randomUUID().replace(/-/g, "").slice(0, 24),
        );
      } else {
        const key = action.key.trim();
        if (key.length === 0 || key.length > PROMPT_CACHE_KEY_MAX_LENGTH) {
          throw new Error(
            `A prompt cache key must be 1-${PROMPT_CACHE_KEY_MAX_LENGTH} characters`,
          );
        }
        writePromptCacheKeyOverride(overrides, scopeKey, key);
      }
      return resolve(scopeKey);
    },
  };
}

/** Store key prefix re-exported so the plugin entry seeds the same namespace. */
export { PROMPT_CACHE_KEY_STORE_PREFIX };
