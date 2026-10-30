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
 * The override lives in its own key namespace of the same store, so it is
 * persisted, evictable under the usual LRU rules, and never part of a
 * translation cache key (rotating it must not invalidate cached translations —
 * only future requests move to the new cache namespace).
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

export function createPromptCacheKeyManager(
  store: TranslationCacheStore | undefined,
): PromptCacheKeyManager {
  function resolve(scopeKey: string): { key: string; pinned: boolean; derived: string } {
    const derived = derivePromptCacheKey(scopeKey);
    const pinned = readPromptCacheKeyOverride(store, scopeKey);
    return pinned === undefined
      ? { key: derived, pinned: false, derived }
      : { key: pinned, pinned: true, derived };
  }

  return {
    resolve,
    configure(scopeKey, action) {
      if (action === "derive") {
        writePromptCacheKeyOverride(store, scopeKey, "");
      } else if (action === "regenerate") {
        // `randomUUID` has dashes only; the value must pass the key schema.
        writePromptCacheKeyOverride(
          store,
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
        writePromptCacheKeyOverride(store, scopeKey, key);
      }
      return resolve(scopeKey);
    },
  };
}

/** Store key prefix re-exported so the plugin entry seeds the same namespace. */
export { PROMPT_CACHE_KEY_STORE_PREFIX };