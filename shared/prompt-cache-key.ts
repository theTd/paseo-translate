import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Manual `prompt_cache_key` control for a translation transcript.
 *
 * The translation request prefix (system prompt + replayed turns + memory) is
 * byte-stable across turns of one session, so OpenAI-compatible endpoints
 * that implement prompt caching route it into one cache only while the key
 * stays the same. The plugin derives a key per session scope automatically;
 * this RPC lets a user pin, rotate (regenerate), or drop it without restarting
 * the session — the escape hatch for a gateway whose cache is stuck on a stale
 * prefix, or for steering several sessions onto one shared prefix.
 *
 * The key is opaque to the plugin: whatever the user pins is sent verbatim as
 * the request's `prompt_cache_key`, so it can be a meaningful label (a
 * project name) rather than a hash.
 */

/** Upper bound on a manual key; endpoint limits sit far above any label. */
export const PROMPT_CACHE_KEY_MAX_LENGTH = 128;
/**
 * Characters a key may carry. OpenAI's own keys are printable ASCII; anything
 * outside this set risks a 400 from a strict gateway, so it is refused here
 * instead of failing a later prompt translation.
 */
const PROMPT_CACHE_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export const promptCacheKeyValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROMPT_CACHE_KEY_MAX_LENGTH)
  .regex(PROMPT_CACHE_KEY_PATTERN, "Use letters, digits, '.', '_', ':' or '-'");

/** Store key prefix, kept out of the translation-cache key space (see cacheKey). */
export const PROMPT_CACHE_KEY_STORE_PREFIX = "prompt-cache-key:v1:";

/** Persisted override for one transcript scope, or undefined for automatic. */
export function readPromptCacheKeyOverride(
  store: { get(key: string): string | undefined } | undefined,
  scopeKey: string,
): string | undefined {
  if (store === undefined) return undefined;
  const stored = store.get(PROMPT_CACHE_KEY_STORE_PREFIX + scopeKey);
  return stored !== undefined && PROMPT_CACHE_KEY_PATTERN.test(stored) ? stored : undefined;
}

/** Writes (or clears, with an empty value) the override for one scope. */
export function writePromptCacheKeyOverride(
  store: { set(key: string, value: string): void } | undefined,
  scopeKey: string,
  value: string,
): void {
  if (store === undefined) return;
  const trimmed = value.trim();
  // Clearing persists an empty entry rather than deleting: the store has no
  // delete, and an empty value keeps an explicit "automatic" marker that the
  // read path ignores.
  store.set(PROMPT_CACHE_KEY_STORE_PREFIX + scopeKey, trimmed);
}

export const promptCacheKeyStatusRpc = defineRpc({
  name: "translate.prompt-cache-key.get",
  input: z.object({ sessionKey: z.string().min(1) }),
  output: z.object({
    /** Key sent with this session's next translation request. */
    key: z.string(),
    /** True when the key came from the stored override, false when derived. */
    pinned: z.boolean(),
    /** The automatic key this session would use without an override. */
    derived: z.string(),
  }),
});

export const promptCacheKeySetRpc = defineRpc({
  name: "translate.prompt-cache-key.set",
  input: z.object({
    sessionKey: z.string().min(1),
    /**
     * Key to pin, `"derive"` to hand control back to the plugin, or
     * `"regenerate"` to store a fresh random key (a new cache namespace
     * without changing the session's transcript).
     */
    action: z.union([
      z.literal("derive"),
      z.literal("regenerate"),
      z.object({ key: promptCacheKeyValueSchema }),
    ]),
  }),
  output: z.object({
    key: z.string(),
    pinned: z.boolean(),
    derived: z.string(),
  }),
});