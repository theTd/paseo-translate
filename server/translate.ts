import { createHash } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import { createLlmClient } from "./llm-client";
import {
  TRANSLATION_CACHE_CAPACITY,
  TRANSLATION_TEXT_LIMIT,
  resolveLanguagePair,
  translateTextRpc,
  translationSystemPrompt,
  type TranslateDirection,
  type TranslateSettingsValues,
} from "../shared/translate";

export interface TranslatorDeps {
  loadConfig(): Promise<TranslateSettingsValues>;
  fetchFn?: typeof fetch;
  /** Test seam; defaults to TRANSLATION_CACHE_CAPACITY. */
  cacheCapacity?: number;
}

export interface Translator {
  translate(text: string, direction: TranslateDirection): Promise<string>;
}

/**
 * Cached translation service shared by the prompt path (fail closed) and the
 * timeline renderer path (display only). Settings are re-read per call so a
 * settings save applies to the next translation without a plugin reload.
 */
export function createTranslator(deps: TranslatorDeps): Translator {
  const capacity = deps.cacheCapacity ?? TRANSLATION_CACHE_CAPACITY;
  const cache = new Map<string, string>();
  return {
    async translate(text, direction) {
      if (text.trim().length === 0) return text;
      if (text.length > TRANSLATION_TEXT_LIMIT) {
        throw new Error(
          `Refusing to translate ${text.length} characters (limit ${TRANSLATION_TEXT_LIMIT})`,
        );
      }
      const values = await deps.loadConfig();
      const pair = resolveLanguagePair(values, direction);
      // The key covers everything that changes the output: direction,
      // language pair, model, and text. Editing settings invalidates old
      // entries instead of serving stale translations from another language.
      const key = cacheKey(text, direction, pair, values.endpointModel);
      const cached = cache.get(key);
      if (cached !== undefined) {
        // Refresh recency so the cache stays least-recently-used.
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const client = createLlmClient(
        {
          baseUrl: values.endpointBaseUrl,
          apiKey: values.endpointApiKey,
          model: values.endpointModel,
          timeoutMs: values.translationTimeoutMs,
        },
        { fetchFn: deps.fetchFn },
      );
      const translated = await client.complete([
        { role: "system", content: translationSystemPrompt(pair) },
        { role: "user", content: text },
      ]);
      cache.set(key, translated);
      if (cache.size > capacity) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return translated;
    },
  };
}

export type TranslateHandlerInput = RpcInput<typeof translateTextRpc>;

/** Plugin RPC handler: used by the client renderer for agent-to-user text. */
export function createTranslateHandler(deps: TranslatorDeps) {
  const translator = createTranslator(deps);
  return async function handleTranslate(input: TranslateHandlerInput) {
    const values = await deps.loadConfig();
    if (!values.translateResponses) {
      // Response translation disabled: the renderer keeps the original text.
      return { text: input.text };
    }
    const text = await translator.translate(input.text, input.direction);
    return { text };
  };
}

function cacheKey(
  text: string,
  direction: TranslateDirection,
  pair: { source: string; target: string },
  model: string,
): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `${direction}:${pair.source}>${pair.target}:${model}:${digest}`;
}
