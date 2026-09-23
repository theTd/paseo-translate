import { createHash, randomUUID } from "node:crypto";
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
  translateStreamPollRpc,
  translateStreamStartRpc,
  translateTextRpc,
  type LanguagePair,
  type TranslateDirection,
  type TranslateSettingsValues,
} from "../shared/translate";
import { TRANSLATION_BUSY_MESSAGE } from "../shared/translation-retry";

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
  /**
   * Stream-first translation for display paths. Deltas arrive through
   * `onDelta`; the resolved value is the full text. When the endpoint
   * refuses the stream, one non-streaming attempt runs inside the same call
   * (no deltas fire then) instead of surfacing the stream error.
   */
  translateStream(
    text: string,
    direction: TranslateDirection,
    onDelta: (delta: string) => void,
  ): Promise<string>;
  /**
   * Exact original fragment for a previously translated user prompt, if the
   * reverse entry is still cached. Settings-independent (keyed by the
   * trimmed translated text only) so a reopened session restores its
   * originals even after endpoint or language settings changed. Returns
   * undefined on a miss; the caller keeps the translated text or falls back
   * to a back-translation.
   */
  restoreOriginalFragment(translatedFragment: string): string | undefined;
}

/**
 * Reverse-index key for user→agent translations. Deliberately NOT part of
 * the forward cache-key space (forward keys are JSON objects starting with
 * `{`), so the two namespaces share the store file and LRU budget without
 * colliding. Trimmed before hashing: replayed transcript blocks are trimmed
 * on read while the prompt-time fragment may carry surrounding whitespace.
 *
 * Known tradeoffs of sharing the store (see TRANSLATION_CACHE_CAPACITY):
 * every user→agent translation now occupies two entries, so the effective
 * forward capacity is roughly halved and the JSONL file grows twice as fast
 * (same compaction rules apply). Evicting a reverse entry only degrades to
 * the replay back-translation fallback — never to a wrong text.
 *
 * The trimmed key is many-to-one by design: distinct originals that happen
 * to translate to the same trimmed text share one entry (last-write-wins)
 * and replay may show another turn's original. Machine translation is not
 * injective, so per-turn disambiguation would need prompt-time ordering
 * metadata; the mistargeted text is still same-language and fail-soft, and
 * exact triple collisions are rare enough that the ordering-free key wins.
 */
const ORIGINAL_FRAGMENT_KEY_PREFIX = "user-original:v1:";

function originalFragmentKey(translatedFragment: string): string | null {
  const normalized = translatedFragment.trim();
  if (normalized.length === 0) return null;
  return `${ORIGINAL_FRAGMENT_KEY_PREFIX}${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

function rememberOriginalFragment(
  cache: TranslationCacheStore,
  translated: string,
  original: string,
): void {
  if (original.trim().length === 0) return;
  const key = originalFragmentKey(translated);
  if (key === null) return;
  cache.set(key, original);
}

/**
 * Cached translation service shared by the prompt path (fail closed, unary),
 * the timeline renderer path (display only, unary fallback), and the
 * streaming renderer path (display only, stream-first). Settings are re-read
 * per call so a settings save applies to the next translation without a
 * plugin reload.
 */
export function createTranslator(deps: TranslatorDeps): Translator {
  const cache = deps.cacheStore ?? createMemoryTranslationCacheStore();

  async function setup(
    text: string,
    direction: TranslateDirection,
  ): Promise<
    | { trivial: string }
    | { cached: string }
    | {
        key: string;
        client: ReturnType<typeof createLlmClient>;
        messages: readonly [
          { role: "system"; content: string },
          { role: "user"; content: string },
        ];
      }
  > {
    if (text.trim().length === 0) return { trivial: text } as const;
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
    if (cached !== undefined) return { cached } as const;
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
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ] as const;
    return { key, client, messages } as const;
  }

  return {
    async translate(text, direction) {
      const prepared = await setup(text, direction);
      if ("trivial" in prepared) return prepared.trivial;
      if ("cached" in prepared) {
        // A cache hit still records the reverse entry: entries translated
        // before the reverse index existed (or evicted from it while the
        // forward entry survived) become restorable on next use.
        if (direction === "user-to-agent") rememberOriginalFragment(cache, prepared.cached, text);
        return prepared.cached;
      }
      const translated = await prepared.client.complete([...prepared.messages]);
      cache.set(prepared.key, translated);
      if (direction === "user-to-agent") rememberOriginalFragment(cache, translated, text);
      return translated;
    },
    async translateStream(text, direction, onDelta) {
      const prepared = await setup(text, direction);
      if ("trivial" in prepared) return prepared.trivial;
      if ("cached" in prepared) {
        if (direction === "user-to-agent") rememberOriginalFragment(cache, prepared.cached, text);
        return prepared.cached;
      }
      try {
        const translated = await prepared.client.stream([...prepared.messages], onDelta);
        cache.set(prepared.key, translated);
        if (direction === "user-to-agent") rememberOriginalFragment(cache, translated, text);
        return translated;
      } catch {
        // The stream is an optimization, not a requirement: one ordinary
        // completion runs instead, so endpoints without SSE stay usable.
        const translated = await prepared.client.complete([...prepared.messages]);
        cache.set(prepared.key, translated);
        if (direction === "user-to-agent") rememberOriginalFragment(cache, translated, text);
        return translated;
      }
    },
    restoreOriginalFragment(translatedFragment) {
      const key = originalFragmentKey(translatedFragment);
      if (key === null) return undefined;
      return cache.get(key);
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

export type TranslateStreamStartInput = RpcInput<typeof translateStreamStartRpc>;
export type TranslateStreamPollInput = RpcInput<typeof translateStreamPollRpc>;

/** Jobs idle longer than this are reaped on the next start. */
const STREAM_JOB_TTL_MS = 5 * 60 * 1000;
/** Concurrent in-flight translations; beyond this start() fails fast. */
const MAX_ACTIVE_STREAM_JOBS = 20;

interface StreamJob {
  text: string;
  done: boolean;
  error?: string;
  updatedAt: number;
}

function describeJobError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Streaming translation jobs for the display path. One manager per plugin
 * process, shared by both stream RPC handlers registered in the entry.
 */
export function createTranslateStreamManager(deps: TranslatorDeps) {
  const translator = createTranslator(deps);
  const jobs = new Map<string, StreamJob>();

  function sweep(now: number): void {
    for (const [jobId, job] of jobs) {
      if (now - job.updatedAt > STREAM_JOB_TTL_MS) jobs.delete(jobId);
    }
  }

  async function run(job: StreamJob, text: string, direction: TranslateDirection): Promise<void> {
    try {
      // translateStream is stream-first with an internal non-stream
      // fallback, so whatever it resolves is the complete text.
      const full = await translator.translateStream(text, direction, (delta) => {
        job.text += delta;
        job.updatedAt = Date.now();
      });
      job.text = full;
      job.done = true;
    } catch (error) {
      job.error = describeJobError(error);
    } finally {
      job.updatedAt = Date.now();
    }
  }

  return {
    async start(input: TranslateStreamStartInput): Promise<{ jobId: string }> {
      const values = await deps.loadConfig();
      const jobId = randomUUID();
      if (!values.translateResponses) {
        // Parity with the unary handler: the renderer keeps the original.
        jobs.set(jobId, { text: input.text, done: true, updatedAt: Date.now() });
        return { jobId };
      }
      if (input.text.length > TRANSLATION_TEXT_LIMIT) {
        // Mirror the unary limit; the client falls back to the unary call,
        // which surfaces the same refusal as an error hint.
        throw new Error(
          `Refusing to translate ${input.text.length} characters (limit ${TRANSLATION_TEXT_LIMIT})`,
        );
      }
      sweep(Date.now());
      let active = 0;
      for (const job of jobs.values()) {
        if (!job.done && job.error === undefined) active += 1;
      }
      if (active >= MAX_ACTIVE_STREAM_JOBS) {
        throw new Error(TRANSLATION_BUSY_MESSAGE);
      }
      const job: StreamJob = { text: "", done: false, updatedAt: Date.now() };
      jobs.set(jobId, job);
      // Detached by design: progress is observed through poll(). run()
      // captures every failure into the job, and the trailing catch guards
      // against a future refactor leaking a rejection.
      void run(job, input.text, input.direction).catch((error: unknown) => {
        job.error = describeJobError(error);
        job.updatedAt = Date.now();
      });
      return { jobId };
    },

    async poll(input: TranslateStreamPollInput): Promise<{ text: string; done: boolean }> {
      const job = jobs.get(input.jobId);
      // Unknown covers evicted jobs and daemon restarts: the client falls
      // back to the unary call, which re-translates (cache-hot) instead.
      if (job === undefined) throw new Error("Unknown translation job");
      if (job.error !== undefined) {
        jobs.delete(input.jobId);
        throw new Error(job.error);
      }
      if (job.done) jobs.delete(input.jobId);
      return { text: job.text, done: job.done };
    },
  };
}

export type TranslateStreamManager = ReturnType<typeof createTranslateStreamManager>;

/** Plugin RPC handlers for streaming display translation (see shared). */
export function createTranslateStreamStartHandler(manager: TranslateStreamManager) {
  return async function handleStreamStart(input: TranslateStreamStartInput) {
    translateStreamStartRpc.input.parse(input);
    return manager.start(input);
  };
}

export function createTranslateStreamPollHandler(manager: TranslateStreamManager) {
  return async function handleStreamPoll(input: TranslateStreamPollInput) {
    translateStreamPollRpc.input.parse(input);
    return manager.poll(input);
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
