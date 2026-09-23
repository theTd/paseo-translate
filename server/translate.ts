import { createHash } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import { createLlmClient } from "./llm-client";
import {
  createMemoryTranslationCacheStore,
  type TranslationCacheStore,
} from "./translation-cache-store";
import {
  TRANSLATION_TEXT_LIMIT,
  resolveLanguagePair,
  resolveTranslationSystemPrompt,
  translateTextRpc,
  type LanguagePair,
  type TranslateDirection,
  type TranslateSettingsValues,
} from "../shared/translate";

export interface TranslatorDeps {
  loadConfig(): Promise<TranslateSettingsValues>;
  fetchFn?: typeof fetch;
  /**
   * Cache store consulted before every endpoint call. Defaults to an
   * in-memory store so tests and unused paths stay hermetic; the plugin
   * entry injects one persistent store shared by every translator in the
   * process.
   */
  cacheStore?: TranslationCacheStore;
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
  const cache = deps.cacheStore ?? createMemoryTranslationCacheStore();
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
      const systemPrompt = resolveTranslationSystemPrompt(values.translationSystemPrompt, pair);
      // The key covers everything that changes the output: direction,
      // language pair, effective system prompt, endpoint (base URL + model,
      // so switching providers invalidates), reasoning effort, and text.
      // Editing settings invalidates old entries instead of serving stale
      // translations.
      const key = cacheKey({
        text,
        direction,
        pair,
        systemPrompt,
        endpointBaseUrl: values.endpointBaseUrl,
        endpointModel: values.endpointModel,
        reasoningEffort: values.translationReasoningEffort,
      });
      const cached = cache.get(key);
      // get() refreshes recency inside the store; a hit skips the endpoint.
      if (cached !== undefined) return cached;
      const client = createLlmClient(
        {
          baseUrl: values.endpointBaseUrl,
          apiKey: values.endpointApiKey,
          model: values.endpointModel,
          timeoutMs: values.translationTimeoutMs,
          reasoningEffort: values.translationReasoningEffort,
        },
        { fetchFn: deps.fetchFn },
      );
      const translated = await client.complete([
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ]);
      cache.set(key, translated);
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

interface CacheKeyInput {
  text: string;
  direction: TranslateDirection;
  pair: LanguagePair;
  systemPrompt: string;
  endpointBaseUrl: string;
  endpointModel: string;
  reasoningEffort: string;
}

/**
 * Opaque cache key. JSON encoding delimits every field, so pathological
 * language or model strings cannot collide across settings combinations;
 * long fields enter as sha-256 digests.
 */
function cacheKey(input: CacheKeyInput): string {
  return JSON.stringify({
    direction: input.direction,
    source: input.pair.source,
    target: input.pair.target,
    baseUrl: digest(input.endpointBaseUrl),
    model: digest(input.endpointModel),
    effort: input.reasoningEffort,
    prompt: digest(input.systemPrompt),
    text: digest(input.text),
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
