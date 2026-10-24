import { createHash, randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import {
  completeStreamFirst,
  isTranslationCanceled,
  createLlmClient,
  type ChatMessage,
  type LlmClient,
} from "./llm-client";
import {
  createTranslationInflightRegistry,
  type InflightProducerContext,
  type InflightWaitOptions,
  type TranslationInflightRegistry,
} from "./translation-inflight";
import {
  createMemoryTranslationCacheStore,
  type TranslationCacheStore,
} from "./translation-cache-store";
import type { TranslationContextManager } from "./translation-context";
import {
  TRANSLATION_TEXT_LIMIT,
  displayTranslationDirectionEnabled,
  resolveLanguagePair,
  resolveTranslationBatchSystemPrompt,
  resolveTranslationSystemPrompt,
  translateStreamCancelRpc,
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
  isSerializedAttachment,
  promptTranslationParts,
  type PromptTranslationFragment,
} from "../shared/prompt-text";
import { translatePromptDisplay } from "./prompt-text";
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
  /**
   * Single-flight registry shared by every translator in the process (see
   * translation-inflight.ts). Absent means a private registry, which keeps
   * tests hermetic; the plugin entry injects one shared instance.
   */
  inflight?: TranslationInflightRegistry;
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
  /**
   * Caller cancellation for translate/translateStream. A canceled caller
   * leaves the shared translation; the endpoint request is aborted only
   * when no other caller still waits for the same text.
   */
  signal?: AbortSignal;
  /** Per-index cancellation for translateMany (same rules as `signal`). */
  signals?: readonly (AbortSignal | undefined)[];
}

export interface Translator {
  rememberPromptDisplay(fragments: readonly PromptTranslationFragment[], options?: TranslateCallOptions): Promise<void>;
  restorePromptDisplay(text: string, options?: TranslateCallOptions): Promise<string | undefined>;
  /** Uses the normal translation cache key; a miss never calls the endpoint. */
  getCachedTranslation(
    text: string,
    direction: TranslateDirection,
    options?: TranslateCallOptions,
  ): Promise<string | undefined>;
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
   * to a cached back-translation.
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
 * a cached replay back-translation or the persisted text.
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
  const inflight = deps.inflight ?? createTranslationInflightRegistry();

  type PreparedMiss = {
    key: string;
    client: LlmClient;
    prefixMessages: ChatMessage[];
    systemPrompt: string;
    userContent: string;
    /** Endpoint timeout; also bounds the fail-closed path's wait on a shared translation. */
    timeoutMs: number;
    recordContext?: { scopeKey: string };
  };
  type SetupResult = { trivial: string } | { cached: string } | PreparedMiss;
  type CacheLookup = { trivial: string } | {
    key: string;
    values: TranslateSettingsValues;
    systemPrompt: string;
    scopeKey: string | undefined;
  };

  async function prepareCacheLookup(
    text: string,
    direction: TranslateDirection,
    contextKey?: string,
  ): Promise<CacheLookup> {
    if (text.trim().length === 0) return { trivial: text } as const;
    if (text.length > TRANSLATION_TEXT_LIMIT) {
      throw new Error(
        `Refusing to translate ${text.length} characters (limit ${TRANSLATION_TEXT_LIMIT})`,
      );
    }
    const values = await deps.loadConfig();
    const pair = resolveLanguagePair(values, direction);
    const systemPrompt = resolveTranslationSystemPrompt(values, pair);
    const context = deps.context;
    const useContext =
      context !== undefined && contextKey !== undefined && values.translationContextEnabled;
    // The key covers everything that changes the output: direction,
    // language pair, effective system prompt, endpoint (base URL + model +
    // wire protocol, so switching providers invalidates), reasoning effort,
    // and text.
    // Editing settings invalidates old entries instead of serving stale
    // translations. On the context path the session's scope key joins the
    // key: a translation conditioned on one session's transcript must not
    // leak into another session's (or a standalone) request. The memory
    // digest deliberately stays OUT: compaction rewrites the memory, and a
    // memory-bearing key would invalidate every cached translation of that
    // session the moment it compacted — re-billing the whole session on its
    // next open. Turns stay out of the key too; within one session the first
    // rendering of a text wins, which itself serves consistency.
    const key = cacheKey({
      text,
      direction,
      pair,
      systemPrompt,
      endpointBaseUrl: values.endpointBaseUrl,
      endpointModel: values.endpointModel,
      endpointProtocol: values.endpointProtocol,
      reasoningEffort: values.translationReasoningEffort,
      ...(useContext ? { scopeKey: contextKey } : {}),
    });
    return { key, values, systemPrompt, scopeKey: useContext ? contextKey : undefined };
  }

  async function setup(
    text: string,
    direction: TranslateDirection,
    contextKey?: string,
  ): Promise<SetupResult> {
    const lookup = await prepareCacheLookup(text, direction, contextKey);
    if ("trivial" in lookup) return lookup;
    const { key, values, systemPrompt, scopeKey } = lookup;
    // The hard cap bounds active sessions that outpace the idle compaction
    // policy: past twice the configured size the oldest pairs drop out.
    const snapshot = scopeKey !== undefined
      ? deps.context?.snapshot(scopeKey, direction, {
          hardCapChars: values.translationContextMaxChars * 2,
        })
      : undefined;
    const cached = cache.get(key);
    // get() refreshes recency inside the store; a hit skips the endpoint.
    if (cached !== undefined) {
      // A cache hit is still translation activity: keep the idle clock from
      // judging a hot-cache session as idle and compacting it mid-flow.
      if (scopeKey !== undefined) deps.context?.touch(scopeKey);
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
      timeoutMs: values.translationTimeoutMs,
      ...(scopeKey !== undefined ? { recordContext: { scopeKey } } : {}),
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

  /** Endpoint work for one streamed miss; publishes progress, commits on success. */
  function streamProducer(
    prepared: PreparedMiss,
    source: string,
    direction: TranslateDirection,
  ): (context: InflightProducerContext) => Promise<string> {
    return async ({ signal, progress }) => {
      let accumulated = "";
      const translated = await completeStreamFirst(
        prepared.client,
        requestMessages(prepared),
        (delta) => {
          accumulated += delta;
          progress(accumulated);
        },
        { signal },
      );
      commitTranslation(prepared, source, translated, direction);
      return translated;
    };
  }

  /**
   * Endpoint work for one fail-closed miss: one bounded completion, no
   * stream attempt — nobody consumes deltas on that path, so stream-first
   * would only double the worst case past translationTimeoutMs and tax
   * SSE-refusing endpoints a refused request on every call.
   */
  function completeProducer(
    prepared: PreparedMiss,
    source: string,
    direction: TranslateDirection,
  ): (context: InflightProducerContext) => Promise<string> {
    return async ({ signal }) => {
      const translated = await prepared.client.complete(requestMessages(prepared), { signal });
      commitTranslation(prepared, source, translated, direction);
      return translated;
    };
  }

  /**
   * Joins the translation already running for this key, serves a result
   * committed since `setup` looked, or starts `produce`. Everything happens
   * in one synchronous stretch, so two callers can never both start the
   * same key (the registry check, cache re-check and start share no await).
   */
  function joinOrStart(
    prepared: PreparedMiss,
    produce: (context: InflightProducerContext) => Promise<string>,
    options: InflightWaitOptions,
  ): Promise<string> {
    const joined = inflight.join(prepared.key, options);
    if (joined !== undefined) return joined;
    const committed = cache.get(prepared.key);
    if (committed !== undefined) return Promise.resolve(committed);
    return inflight.start(prepared.key, produce, options);
  }

  /**
   * The fail-closed path joining a display translation of the same text
   * keeps its own hard bound: it waits at most `timeoutMs`, exactly as long
   * as its own completion could have taken, then fails closed. The shared
   * translation keeps running for its other waiters and lands in the cache.
   */
  async function joinBounded(
    joined: (signal: AbortSignal) => Promise<string> | undefined,
    timeoutMs: number,
    outer: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      return await joined(controller.signal);
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `Translation endpoint request failed after ${timeoutMs}ms (waiting for a running translation of the same text)`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * One tagged endpoint call for a pack of misses (display path only).
   * Commits and returns the per-item translations, or null when the answer
   * lost its item tags so the caller streams those items one by one.
   */
  async function runPackUpstream(
    packPrepared: readonly PreparedMiss[],
    packTexts: readonly string[],
    direction: TranslateDirection,
    signal: AbortSignal,
  ): Promise<string[] | null> {
    const first = packPrepared[0];
    if (first === undefined) throw new Error("Invariant: empty translation pack");
    const nonce = pickBatchNonce(packTexts);
    const values = await deps.loadConfig();
    const batchPrompt = resolveTranslationBatchSystemPrompt(
      values,
      resolveLanguagePair(values, direction),
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
    const output = await completeStreamFirst(first.client, messages, () => undefined, { signal });
    const parsed = parseTranslationBatch(output, packTexts.length, nonce);
    if (parsed === null) return null;
    parsed.forEach((translated, offset) => {
      const prepared = packPrepared[offset];
      const source = packTexts[offset];
      if (prepared !== undefined && source !== undefined) {
        commitTranslation(prepared, source, translated, direction);
      }
    });
    return parsed;
  }

  /** Converts registry progress (full text so far) into appended deltas. */
  function deltaForwarder(onDelta: (delta: string) => void): (text: string) => void {
    let sent = "";
    return (text) => {
      // A stream that failed over to a plain completion restarts its text;
      // the resolved value is authoritative, so non-prefix updates are skipped.
      if (!text.startsWith(sent)) return;
      const delta = text.slice(sent.length);
      sent = text;
      if (delta.length > 0) onDelta(delta);
    };
  }

  /**
   * Cache scope for one user→agent display translation: the session key when
   * the context path is active, undefined for standalone translations. The
   * memory digest deliberately stays out of the key (see cacheKey's
   * scopeKey): compaction rewrites the memory, so a memory-bearing key would
   * re-bill every prompt display of a compacted session on its next open.
   */
  function promptDisplayScope(
    values: TranslateSettingsValues,
    contextKey?: string,
  ): string | undefined {
    return deps.context !== undefined &&
      contextKey !== undefined &&
      values.translationContextEnabled
      ? contextKey
      : undefined;
  }

  return {
    async getCachedTranslation(text, direction, options) {
      const lookup = await prepareCacheLookup(text, direction, options?.contextKey);
      if ("trivial" in lookup) return lookup.trivial;
      return cache.get(lookup.key);
    },
    async rememberPromptDisplay(fragments, options) {
      const values = await deps.loadConfig();
      const scope = promptDisplayScope(values, options?.contextKey);
      // Live rows may omit attachment JSON that replayed rows retain.
      const prose = fragments.filter((fragment) => !isSerializedAttachment(fragment.original));
      const variants = prose.length === fragments.length ? [fragments] : [fragments, prose];
      for (const variant of variants) {
        const original = variant.map((fragment) => fragment.original).join("\n").trim();
        const translated = variant.map((fragment) => fragment.translated).join("\n").trim();
        const parts = promptTranslationParts(original);
        if (parts === null) continue;
        const display = translated.slice(parts.prefix.length);
        cache.set(promptDisplayKey(values, parts.body, scope), display);
        if (scope !== undefined) {
          // Scope-free mirror. The prompt path and the display path do not
          // always agree on a session identity: the ACP proxy keys by its
          // inner ACP session id (the connector cannot see the paseo agent
          // id), while the client display path keys by the agent id. Without
          // the mirror, an ACP prompt's own-scope entry is unreadable from
          // the display path and the prompt would be translated a second
          // time. Read only after this session's own entry misses (see
          // restorePromptDisplay), so per-session terminology still wins
          // whenever it is addressable.
          cache.set(promptDisplayKey(values, parts.body), display);
        }
      }
    },
    async restorePromptDisplay(text, options) {
      const values = await deps.loadConfig();
      const scope = promptDisplayScope(values, options?.contextKey);
      const own = cache.get(promptDisplayKey(values, text, scope));
      if (own !== undefined || scope === undefined) return own;
      return cache.get(promptDisplayKey(values, text));
    },
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
      // The user-message display job starts as soon as the prompt row
      // renders, concurrently with this fail-closed translation. Sharing the
      // in-flight request makes both see one result: the bubble shows
      // exactly what the agent received, billed once.
      // (The producer's commit records the reverse entry for every waiter.)
      if (inflight.has(prepared.key)) {
        const joined = await joinBounded(
          (signal) => inflight.join(prepared.key, { signal }),
          prepared.timeoutMs,
          options?.signal,
        );
        if (joined !== undefined) return joined;
      }
      // Still synchronous since setup: nothing can start this key meanwhile.
      return joinOrStart(prepared, completeProducer(prepared, text, direction), {
        signal: options?.signal,
      });
    },
    async translateStream(text, direction, onDelta, options) {
      const prepared = await setup(text, direction, options?.contextKey);
      if ("trivial" in prepared) return prepared.trivial;
      if ("cached" in prepared) {
        if (direction === "user-to-agent") rememberOriginalFragment(cache, prepared.cached, text);
        return prepared.cached;
      }
      return joinOrStart(prepared, streamProducer(prepared, text, direction), {
        onProgress: deltaForwarder(onDelta),
        signal: options?.signal,
      });
    },
    async translateMany(texts, direction, options) {
      const onItem = options?.onItem;
      const signals = options?.signals;
      if (texts.length === 0) return [];
      const preparedList: SetupResult[] = [];
      for (const text of texts) {
        preparedList.push(await setup(text, direction, options?.contextKey));
      }
      const results: string[] = texts.map(() => "");
      const finish = (index: number, text: string) => {
        results[index] = text;
        onItem?.(index, { text, done: true });
      };
      const progressFor = (index: number) => (text: string) => {
        onItem?.(index, { text, done: false });
      };

      // From here to the last join there is no await: classification, entry
      // creation and joins form one synchronous stretch, so an entry seen
      // as running cannot settle in between (see joinOrStart).
      //
      // Identical source texts are translated once, not once per
      // occurrence: the first miss of a key starts it ("fresh"), every
      // other occurrence — and every key some other caller is already
      // translating — joins the running entry ("followers").
      const fresh: number[] = [];
      const followers: number[] = [];
      const freshKeys = new Set<string>();
      const misses = new Map<number, PreparedMiss>();
      for (let index = 0; index < preparedList.length; index += 1) {
        const prepared = preparedList[index];
        const source = texts[index] ?? "";
        if (prepared === undefined) continue;
        if ("trivial" in prepared) {
          finish(index, prepared.trivial);
          continue;
        }
        if ("cached" in prepared) {
          if (direction === "user-to-agent") rememberOriginalFragment(cache, prepared.cached, source);
          finish(index, prepared.cached);
          continue;
        }
        const committed = cache.get(prepared.key);
        if (committed !== undefined) {
          finish(index, committed);
          continue;
        }
        misses.set(index, prepared);
        if (inflight.has(prepared.key) || freshKeys.has(prepared.key)) {
          followers.push(index);
        } else {
          freshKeys.add(prepared.key);
          fresh.push(index);
        }
      }

      const waits: Array<Promise<void>> = [];
      const track = (index: number, wait: Promise<string>) => {
        waits.push(wait.then((text) => finish(index, text)));
      };
      // Packs run one after another (a reopened long session must not fire
      // every batch at once); tag-less batch answers fall back to per-item
      // streams on their own sequential lane.
      const packLane = createSequentialLane();
      const fallbackLane = createSequentialLane();
      const packs = packTranslationBatches(fresh.map((index) => texts[index] ?? ""));
      let offset = 0;
      for (const pack of packs) {
        const packIndexes = fresh.slice(offset, offset + pack.length);
        offset += pack.length;
        if (packIndexes.length === 1) {
          // A lone miss streams, so the renderer shows progress.
          const index = packIndexes[0] as number;
          const prepared = misses.get(index) as PreparedMiss;
          const produce = streamProducer(prepared, texts[index] ?? "", direction);
          track(
            index,
            inflight.start(prepared.key, (context) => packLane(() => produce(context)), {
              onProgress: progressFor(index),
              signal: signals?.[index],
            }),
          );
          continue;
        }
        const packPrepared = packIndexes.map((index) => misses.get(index) as PreparedMiss);
        const packTexts = packIndexes.map((index) => texts[index] ?? "");
        // One tagged request for the whole pack. A single item leaving does
        // not abort it (the other items still want their translations); it
        // is aborted once every item's entry has been abandoned.
        const packAbort = new AbortController();
        let livePackItems = packIndexes.length;
        const leavePack = () => {
          livePackItems -= 1;
          if (livePackItems === 0) packAbort.abort();
        };
        const upstream = packLane(() =>
          runPackUpstream(packPrepared, packTexts, direction, packAbort.signal),
        );
        upstream.catch(() => undefined);
        packIndexes.forEach((index, position) => {
          const prepared = packPrepared[position] as PreparedMiss;
          const source = packTexts[position] ?? "";
          // A pre-aborted start never runs its producer (no entry is made).
          if (signals?.[index]?.aborted === true) leavePack();
          track(
            index,
            inflight.start(
              prepared.key,
              async (context) => {
                context.signal.addEventListener("abort", leavePack, { once: true });
                const parsed = await upstream;
                const translated = parsed?.[position];
                if (translated !== undefined) return translated;
                // The model dropped the item tags: this item streams alone.
                return fallbackLane(() => streamProducer(prepared, source, direction)(context));
              },
              { onProgress: progressFor(index), signal: signals?.[index] },
            ),
          );
        });
      }
      for (const index of followers) {
        const prepared = misses.get(index) as PreparedMiss;
        const joined = inflight.join(prepared.key, {
          onProgress: progressFor(index),
          signal: signals?.[index],
        });
        if (joined === undefined) {
          throw new Error("Invariant: a follower's translation is not in flight");
        }
        track(index, joined);
      }

      // Every item settles before the call does: a failure must not leave
      // sibling items unreported. Canceled items are not failures.
      const outcomes = await Promise.allSettled(waits);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected" && !isTranslationCanceled(outcome.reason)) {
          throw outcome.reason;
        }
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

/**
 * Runs tasks one after another in submission order; a failed task does not
 * block the ones queued behind it.
 */
function createSequentialLane(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export type TranslateHandlerInput = RpcInput<typeof translateTextRpc>;

/** Plugin RPC handler: used by the client renderer for display translation. */
export function createTranslateHandler(deps: TranslatorDeps) {
  const translator = createTranslator(deps);
  return async function handleTranslate(input: TranslateHandlerInput) {
    const values = await deps.loadConfig();
    if (!displayTranslationDirectionEnabled(values, input.direction)) {
      // Matching display switch off: the renderer keeps the original text.
      return { text: input.text };
    }
    const options = { contextKey: input.sessionKey };
    let text: string;
    if (input.direction === "user-to-agent") {
      text = await translator.restorePromptDisplay(input.text, options) ?? await translatePromptDisplay(
        input.text, (fragment) => translator.translate(fragment, input.direction, options),
      );
    } else {
      text = await translator.translate(input.text, input.direction, options);
    }
    return { text };
  };
}

export type TranslateStreamStartInput = RpcInput<typeof translateStreamStartRpc>;
export type TranslateStreamPollInput = RpcInput<typeof translateStreamPollRpc>;
export type TranslateStreamCancelInput = RpcInput<typeof translateStreamCancelRpc>;

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
  /** Aborted by `cancel`: the job leaves its (possibly shared) translation. */
  abort: AbortController;
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
 * process, shared by the stream RPC handlers registered in the entry.
 * Starts for the same session+direction that land inside `coalesceDelayMs`
 * share one tagged endpoint call; a lone job still streams. Jobs for a text
 * already being translated anywhere in the process join that translation
 * (see translation-inflight.ts) instead of starting another one.
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

  function fail(item: CoalesceItem, error: unknown): void {
    if (item.job.done || item.job.abort.signal.aborted) return;
    item.job.error = describeJobError(error);
    item.job.updatedAt = Date.now();
  }

  async function flush(
    queued: readonly CoalesceItem[],
    direction: TranslateDirection,
    contextKey?: string,
  ): Promise<void> {
    // Jobs canceled while they waited in the coalesce window never reach
    // the endpoint.
    const items = queued.filter((item) => !item.job.abort.signal.aborted);
    if (items.length === 0) return;
    if (direction === "user-to-agent") {
      // Prompt display translates fragment by fragment; one failed or
      // canceled prompt must not fail the others in the window.
      for (const item of items) {
        if (item.job.abort.signal.aborted) continue;
        try {
          item.job.text = await translatePromptDisplay(
            item.text,
            (fragment, onDelta) =>
              translator.translateStream(fragment, direction, onDelta, {
                contextKey,
                signal: item.job.abort.signal,
              }),
            (text) => {
              item.job.text = text;
              item.job.updatedAt = Date.now();
            },
          );
          item.job.done = true;
          item.job.updatedAt = Date.now();
        } catch (error) {
          if (!isTranslationCanceled(error)) fail(item, error);
        }
      }
      return;
    }
    try {
      await translator.translateMany(
        items.map((item) => item.text),
        direction,
        {
          contextKey,
          signals: items.map((item) => item.job.abort.signal),
          onItem: (index, update) => {
            const item = items[index];
            if (item === undefined) return;
            item.job.text = update.text;
            item.job.done = update.done;
            item.job.updatedAt = Date.now();
          },
        },
      );
    } catch (error) {
      for (const item of items) fail(item, error);
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
        for (const queued of batch) fail(queued, error);
      });
    }, coalesceDelayMs);
  }

  function newJob(text: string, done: boolean): StreamJob {
    return { text, done, updatedAt: Date.now(), abort: new AbortController() };
  }

  return {
    async start(input: TranslateStreamStartInput): Promise<{ jobId: string }> {
      const values = await deps.loadConfig();
      const jobId = randomUUID();
      if (!displayTranslationDirectionEnabled(values, input.direction)) {
        // Parity with the unary handler: the renderer keeps the original.
        jobs.set(jobId, newJob(input.text, true));
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
      if (input.direction === "user-to-agent") {
        const cached = await translator.restorePromptDisplay(input.text, { contextKey: input.sessionKey });
        if (cached !== undefined) {
          jobs.set(jobId, newJob(cached, true));
          return { jobId };
        }
      }
      let open = 0;
      for (const existing of jobs.values()) {
        if (!existing.done && existing.error === undefined) open += 1;
      }
      if (open >= MAX_PENDING_STREAM_JOBS) {
        throw new Error(TRANSLATION_BUSY_MESSAGE);
      }
      const job = newJob("", false);
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

    /**
     * Abandons a job whose text was superseded. The job leaves its shared
     * translation; the endpoint request stops only once nobody else waits
     * for it. Finished, failed and unknown jobs report `canceled: false`.
     */
    cancel(input: TranslateStreamCancelInput): { canceled: boolean } {
      const job = jobs.get(input.jobId);
      if (job === undefined) return { canceled: false };
      jobs.delete(input.jobId);
      if (job.done || job.error !== undefined) return { canceled: false };
      job.abort.abort();
      return { canceled: true };
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

export function createTranslateStreamCancelHandler(manager: TranslateStreamManager) {
  return async function handleStreamCancel(input: TranslateStreamCancelInput) {
    translateStreamCancelRpc.input.parse(input);
    return manager.cancel(input);
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
   * Session scope (agent id for the direct providers and the client display
   * path; the inner ACP session id for the ACP proxy) when the request runs
   * on the context path. Keeps one session's translations out of another
   * session's namespace. The compacted memory digest deliberately does NOT
   * join the key: compaction rewrites the memory mid-session's-life, and a
   * memory-bearing key would drop every cached translation of that session —
   * re-billing the whole conversation on its next open. undefined (field
   * omitted) keeps the standalone key shape compatible with cache files
   * written before transcripts existed.
   */
  scopeKey?: string;
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
    ...(input.scopeKey !== undefined ? { scope: input.scopeKey } : {}),
    text: digest(input.text),
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function promptDisplayKey(
  values: TranslateSettingsValues,
  text: string,
  scopeKey?: string,
): string {
  const pair = resolveLanguagePair(values, "user-to-agent");
  return `prompt-display:v1:${cacheKey({
    text,
    direction: "user-to-agent",
    pair,
    systemPrompt: resolveTranslationSystemPrompt(values, pair),
    endpointBaseUrl: values.endpointBaseUrl,
    endpointModel: values.endpointModel,
    endpointProtocol: values.endpointProtocol,
    reasoningEffort: values.translationReasoningEffort,
    scopeKey,
  })}`;
}
