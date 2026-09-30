import { createHash, randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import { completeStreamFirst, createLlmClient, type ChatMessage, type LlmClient } from "./llm-client";
import {
  createMemoryTranslationCacheStore,
  type TranslationCacheStore,
} from "./translation-cache-store";
import type { TranslationContextManager } from "./translation-context";
import {
  TRANSLATION_TEXT_LIMIT,
  resolveLanguagePair,
  resolveTranslationBatchSystemPrompt,
  resolveTranslationSystemPrompt,
  translateStreamPollRpc,
  translateStreamStartRpc,
  translateTextRpc,
  wrapTranslationInput,
  type LanguagePair,
  type TranslateDirection,
  type TranslateSettingsValues,
} from "../shared/translate";
import { TRANSLATION_BUSY_MESSAGE } from "../shared/translation-retry";
import {
  STREAM_COALESCE_DELAY_MS,
  packTranslationBatches,
  parseTranslationBatch,
  pickBatchNonce,
  wrapTranslationBatch,
} from "./translate-batch";

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
  /**
   * Session translation transcripts (see translation-context.ts). Absent
   * means every translation is independent, which also keeps tests and
   * unused paths hermetic; the plugin entry injects one shared manager.
   */
  context?: TranslationContextManager;
}

/** Per-call options for translate/translateStream. */
export interface TranslateCallOptions {
  /**
   * Agent session the text belongs to. With translationContextEnabled, the
   * request is conditioned on that session's transcript and the result is
   * recorded into it; omitted means a standalone translation.
   */
  contextKey?: string;
  /**
   * Progress for one index of translateMany: cache hits fire once with
   * `done: true`; a lone miss streams deltas; a batch fires once per item
   * when that item's text is final.
   */
  onItem?: (index: number, update: { text: string; done: boolean }) => void;
}

export interface Translator {
  translate(
    text: string,
    direction: TranslateDirection,
    options?: TranslateCallOptions,
  ): Promise<string>;
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
    options?: TranslateCallOptions,
  ): Promise<string>;
  /**
   * Display-path helper: cache/trivial items resolve immediately; a single
   * miss streams; two or more misses share tagged endpoint calls (packed
   * by item/char caps). Parse failure falls back to per-item streaming.
   * Results stay cached under the single-item key.
   */
  translateMany(
    texts: readonly string[],
    direction: TranslateDirection,
    options?: TranslateCallOptions,
  ): Promise<string[]>;
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

  type PreparedMiss = {
    key: string;
    client: LlmClient;
    prefixMessages: ChatMessage[];
    systemPrompt: string;
    userContent: string;
    recordContext?: { scopeKey: string };
  };
  type SetupResult = { trivial: string } | { cached: string } | PreparedMiss;

  async function setup(
    text: string,
    direction: TranslateDirection,
    contextKey?: string,
  ): Promise<SetupResult> {
    if (text.trim().length === 0) return { trivial: text } as const;
    if (text.length > TRANSLATION_TEXT_LIMIT) {
      throw new Error(
        `Refusing to translate ${text.length} characters (limit ${TRANSLATION_TEXT_LIMIT})`,
      );
    }
    const values = await deps.loadConfig();
    const pair = resolveLanguagePair(values, direction);
    const systemPrompt = resolveTranslationSystemPrompt(
      values.translationSystemPrompt,
      pair,
      values.translationDomainContext,
    );
    const context = deps.context;
    const useContext =
      context !== undefined && contextKey !== undefined && values.translationContextEnabled;
    // The hard cap bounds active sessions that outpace the idle compaction
    // policy: past twice the configured size the oldest pairs drop out.
    const snapshot = useContext
      ? context.snapshot(contextKey, direction, {
          hardCapChars: values.translationContextMaxChars * 2,
        })
      : undefined;
    // The key covers everything that changes the output: direction,
    // language pair, effective system prompt, endpoint (base URL + model +
    // wire protocol, so switching providers invalidates), reasoning effort,
    // and text.
    // Editing settings invalidates old entries instead of serving stale
    // translations. On the context path the current memory digest joins the
    // key: a memory-conditioned result must not leak into standalone or
    // other-memory requests, and a compaction (memory changes) starts a new
    // cache epoch. Turns stay out of the key — within one memory epoch the
    // first rendering of a text wins, which itself serves consistency.
    const key = cacheKey({
      text,
      direction,
      pair,
      systemPrompt,
      endpointBaseUrl: values.endpointBaseUrl,
      endpointModel: values.endpointModel,
      endpointProtocol: values.endpointProtocol,
      reasoningEffort: values.translationReasoningEffort,
      contextMemory: snapshot?.memory,
    });
    const cached = cache.get(key);
    // get() refreshes recency inside the store; a hit skips the endpoint.
    if (cached !== undefined) {
      // A cache hit is still translation activity: keep the idle clock from
      // judging a hot-cache session as idle and compacting it mid-flow.
      if (useContext) context.touch(contextKey);
      return { cached } as const;
    }
    const client = createLlmClient(
      {
        baseUrl: values.endpointBaseUrl,
        apiKey: values.endpointApiKey,
        model: values.endpointModel,
        timeoutMs: values.translationTimeoutMs,
        reasoningEffort: values.translationReasoningEffort,
        protocol: values.endpointProtocol,
      },
      { fetchFn: deps.fetchFn },
    );
    const systemContent =
      snapshot !== undefined && snapshot.memory.length > 0
        ? `${systemPrompt}\n\nEstablished translation conventions for this session (apply consistently):\n${snapshot.memory}`
        : systemPrompt;
    const messages: ChatMessage[] = [{ role: "system", content: systemContent }];
    if (snapshot !== undefined) {
      for (const turn of snapshot.turns) {
        messages.push(
          { role: "user", content: turn.user },
          { role: "assistant", content: turn.assistant },
        );
      }
    }
    const userContent = wrapTranslationInput(text);
    return {
      key,
      client,
      prefixMessages: messages,
      systemPrompt,
      userContent,
      ...(useContext ? { recordContext: { scopeKey: contextKey } } : {}),
    } as const;
  }


  function requestMessages(prepared: {
    prefixMessages: ChatMessage[];
    userContent: string;
  }): ChatMessage[] {
    return [...prepared.prefixMessages, { role: "user", content: prepared.userContent }];
  }

  function commitTranslation(
    prepared: {
      key: string;
      userContent: string;
      recordContext?: { scopeKey: string };
    },
    source: string,
    translated: string,
    direction: TranslateDirection,
  ): void {
    cache.set(prepared.key, translated);
    if (direction === "user-to-agent") rememberOriginalFragment(cache, translated, source);
    if (prepared.recordContext !== undefined) {
      deps.context?.record(
        prepared.recordContext.scopeKey,
        direction,
        prepared.userContent,
        translated,
      );
    }
  }

  async function streamPrepared(
    prepared: PreparedMiss,
    source: string,
    direction: TranslateDirection,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const translated = await completeStreamFirst(
      prepared.client,
      requestMessages(prepared),
      onDelta,
    );
    commitTranslation(prepared, source, translated, direction);
    return translated;
  }

  return {
    async translate(text, direction, options) {
      const prepared = await setup(text, direction, options?.contextKey);
      if ("trivial" in prepared) return prepared.trivial;
      if ("cached" in prepared) {
        // A cache hit still records the reverse entry: entries translated
        // before the reverse index existed (or evicted from it while the
        // forward entry survived) become restorable on next use. The hit
        // deliberately does NOT append to the session transcript — the pair
        // either already sits in it or belongs to another session.
        if (direction === "user-to-agent") rememberOriginalFragment(cache, prepared.cached, text);
        return prepared.cached;
      }
      // One bounded completion, no stream attempt: nobody consumes deltas on
      // this fail-closed path, so stream-first would only double the worst
      // case past translationTimeoutMs and tax SSE-refusing endpoints a
      // refused request on every call.
      const translated = await prepared.client.complete(requestMessages(prepared));
      commitTranslation(prepared, text, translated, direction);
      return translated;
    },
    async translateStream(text, direction, onDelta, options) {
      const prepared = await setup(text, direction, options?.contextKey);
      if ("trivial" in prepared) return prepared.trivial;
      if ("cached" in prepared) {
        if (direction === "user-to-agent") rememberOriginalFragment(cache, prepared.cached, text);
        return prepared.cached;
      }
      return streamPrepared(prepared, text, direction, onDelta);
    },
    async translateMany(texts, direction, options) {
      const onItem = options?.onItem;
      if (texts.length === 0) return [];
      const preparedList: SetupResult[] = [];
      for (const text of texts) {
        preparedList.push(await setup(text, direction, options?.contextKey));
      }
      const results: string[] = texts.map(() => "");
      const pending: number[] = [];
      for (let index = 0; index < preparedList.length; index += 1) {
        const prepared = preparedList[index];
        const source = texts[index] ?? "";
        if (prepared === undefined) continue;
        if ("trivial" in prepared) {
          results[index] = prepared.trivial;
          onItem?.(index, { text: prepared.trivial, done: true });
          continue;
        }
        if ("cached" in prepared) {
          if (direction === "user-to-agent") {
            rememberOriginalFragment(cache, prepared.cached, source);
          }
          results[index] = prepared.cached;
          onItem?.(index, { text: prepared.cached, done: true });
          continue;
        }
        pending.push(index);
      }

      const streamOne = async (index: number): Promise<void> => {
        const prepared = preparedList[index];
        const source = texts[index];
        if (prepared === undefined || source === undefined || !("prefixMessages" in prepared)) {
          return;
        }
        let acc = "";
        const translated = await streamPrepared(prepared, source, direction, (delta) => {
          acc += delta;
          onItem?.(index, { text: acc, done: false });
        });
        results[index] = translated;
        onItem?.(index, { text: translated, done: true });
      };

      const runPack = async (packIndexes: readonly number[]): Promise<void> => {
        if (packIndexes.length <= 1) {
          const index = packIndexes[0];
          if (index !== undefined) await streamOne(index);
          return;
        }
        const packTexts: string[] = [];
        const packPrepared: Array<(typeof preparedList)[number] & { prefixMessages: ChatMessage[] }> =
          [];
        for (const index of packIndexes) {
          const text = texts[index];
          const prepared = preparedList[index];
          if (text === undefined || prepared === undefined || !("prefixMessages" in prepared)) {
            throw new Error("Invariant: batch pack item was not an endpoint miss");
          }
          packTexts.push(text);
          packPrepared.push(prepared);
        }
        const nonce = pickBatchNonce(packTexts);
        const values = await deps.loadConfig();
        const first = packPrepared[0];
        if (first === undefined || !("prefixMessages" in first) || !("systemPrompt" in first)) {
          throw new Error("Invariant: empty translation pack");
        }
        const pair = resolveLanguagePair(values, direction);
        const batchPrompt = resolveTranslationBatchSystemPrompt(
          values.translationSystemPrompt,
          pair,
          values.translationDomainContext,
        );
        const prefix = first.prefixMessages;
        const system = prefix[0];
        const withBatchSystem: ChatMessage[] =
          system !== undefined && system.role === "system"
            ? [
                {
                  role: "system",
                  content: system.content.startsWith(first.systemPrompt)
                    ? batchPrompt + system.content.slice(first.systemPrompt.length)
                    : batchPrompt,
                },
                ...prefix.slice(1),
              ]
            : [{ role: "system", content: batchPrompt }, ...prefix];
        const messages: ChatMessage[] = [
          ...withBatchSystem,
          { role: "user", content: wrapTranslationBatch(packTexts, nonce) },
        ];
        const output = await completeStreamFirst(first.client, messages, () => undefined);
        const parsed = parseTranslationBatch(output, packTexts.length, nonce);
        if (parsed === null) {
          for (const index of packIndexes) await streamOne(index);
          return;
        }
        for (let offset = 0; offset < packIndexes.length; offset += 1) {
          const index = packIndexes[offset];
          const translated = parsed[offset];
          const prepared = packPrepared[offset];
          const source = packTexts[offset];
          if (
            index === undefined ||
            translated === undefined ||
            prepared === undefined ||
            source === undefined ||
            !("key" in prepared)
          ) {
            continue;
          }
          commitTranslation(prepared, source, translated, direction);
          results[index] = translated;
          onItem?.(index, { text: translated, done: true });
        }
      };

      const pendingTexts = pending.map((index) => texts[index] ?? "");
      const packs = packTranslationBatches(pendingTexts);
      let offset = 0;
      for (const pack of packs) {
        const packIndexes = pending.slice(offset, offset + pack.length);
        offset += pack.length;
        await runPack(packIndexes);
      }
      return results;
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
    const text = await translator.translate(input.text, input.direction, {
      contextKey: input.sessionKey,
    });
    return { text };
  };
}

export type TranslateStreamStartInput = RpcInput<typeof translateStreamStartRpc>;
export type TranslateStreamPollInput = RpcInput<typeof translateStreamPollRpc>;

/** Jobs idle longer than this are reaped on the next start. */
const STREAM_JOB_TTL_MS = 5 * 60 * 1000;
/**
 * Pending + in-flight stream jobs (coalesced or running). A session open
 * parks many jobs behind one endpoint call, so this is a client-DoS bound
 * rather than an in-flight LLM cap.
 */
const MAX_PENDING_STREAM_JOBS = 200;

interface StreamJob {
  text: string;
  done: boolean;
  error?: string;
  updatedAt: number;
}

interface CoalesceItem {
  jobId: string;
  job: StreamJob;
  text: string;
}

interface CoalesceGroup {
  direction: TranslateDirection;
  contextKey?: string;
  items: CoalesceItem[];
  timer?: NodeJS.Timeout;
}

function describeJobError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Streaming translation jobs for the display path. One manager per plugin
 * process, shared by both stream RPC handlers registered in the entry.
 * Starts for the same session+direction that land inside `coalesceDelayMs`
 * share one tagged endpoint call; a lone job still streams.
 */
export function createTranslateStreamManager(
  deps: TranslatorDeps,
  options?: { coalesceDelayMs?: number },
) {
  const translator = createTranslator(deps);
  const jobs = new Map<string, StreamJob>();
  const groups = new Map<string, CoalesceGroup>();
  const coalesceDelayMs = options?.coalesceDelayMs ?? STREAM_COALESCE_DELAY_MS;

  function sweep(now: number): void {
    for (const [jobId, job] of jobs) {
      if (now - job.updatedAt > STREAM_JOB_TTL_MS) jobs.delete(jobId);
    }
  }

  async function flush(
    items: readonly CoalesceItem[],
    direction: TranslateDirection,
    contextKey?: string,
  ): Promise<void> {
    if (items.length === 0) return;
    try {
      await translator.translateMany(
        items.map((item) => item.text),
        direction,
        {
          contextKey,
          onItem: (index, update) => {
            const item = items[index];
            if (item === undefined) return;
            item.job.text = update.text;
            item.job.done = update.done;
            item.job.updatedAt = Date.now();
          },
        },
      );
      for (const item of items) {
        if (item.job.error !== undefined) continue;
        item.job.done = true;
        item.job.updatedAt = Date.now();
      }
    } catch (error) {
      const message = describeJobError(error);
      for (const item of items) {
        if (item.job.done) continue;
        item.job.error = message;
        item.job.updatedAt = Date.now();
      }
    }
  }

  function enqueue(
    item: CoalesceItem,
    direction: TranslateDirection,
    contextKey?: string,
  ): void {
    const key = `${direction}\0${contextKey ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { direction, contextKey, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
    if (group.timer !== undefined) return;
    group.timer = setTimeout(() => {
      const current = groups.get(key);
      if (current === undefined) return;
      groups.delete(key);
      current.timer = undefined;
      const batch = current.items;
      void flush(batch, current.direction, current.contextKey).catch((error: unknown) => {
        const message = describeJobError(error);
        for (const queued of batch) {
          if (queued.job.done) continue;
          queued.job.error = message;
          queued.job.updatedAt = Date.now();
        }
      });
    }, coalesceDelayMs);
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
      let open = 0;
      for (const existing of jobs.values()) {
        if (!existing.done && existing.error === undefined) open += 1;
      }
      if (open >= MAX_PENDING_STREAM_JOBS) {
        throw new Error(TRANSLATION_BUSY_MESSAGE);
      }
      const job: StreamJob = { text: "", done: false, updatedAt: Date.now() };
      jobs.set(jobId, job);
      enqueue({ jobId, job, text: input.text }, input.direction, input.sessionKey);
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

    dispose(): void {
      for (const group of groups.values()) {
        clearTimeout(group.timer);
      }
      groups.clear();
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
  endpointProtocol: string;
  reasoningEffort: string;
  /**
   * Compacted memory of the session transcript when the request runs on the
   * context path; undefined (field omitted) keeps the standalone key shape
   * compatible with cache files written before transcripts existed.
   */
  contextMemory?: string;
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
    protocol: input.endpointProtocol,
    effort: input.reasoningEffort,
    prompt: digest(input.systemPrompt),
    ...(input.contextMemory !== undefined ? { memory: digest(input.contextMemory) } : {}),
    text: digest(input.text),
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
