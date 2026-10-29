import { LlmRequestCanceledError } from "./llm-client";
import { createStepTracer } from "./memory-probe";

const step = createStepTracer();

/**
 * Single-flight registry for endpoint translations, keyed by the translation
 * cache key.
 *
 * The cache only helps once a translation has finished. Several paths ask
 * for the same key while it is still running: the fail-closed prompt path
 * and the user-message display job start together on every send, the
 * notification preview and the reply renderer overlap while the turn
 * completion waits for the preview, two clients (desktop + phone) render the
 * same agent, a virtualized row remounts, and a client retries after its
 * own idle timeout while the server is still streaming. Without a shared
 * in-flight entry each of them bills a separate request, and for prompts the
 * display could even show a different translation than the agent received.
 *
 * One registry instance is shared by every translator in the plugin process
 * (like the cache store). Waiters may carry an AbortSignal: a waiter that
 * aborts leaves immediately, and once the last waiter has left (and no
 * waiter without a signal ever joined) the upstream request is aborted and
 * the entry is dropped so a later request starts fresh.
 */
export interface InflightWaitOptions {
  /** Full accumulated text so far: replayed on join, then on every update. */
  onProgress?: (text: string) => void;
  /** Leaves the wait early; see the registry doc for upstream abort rules. */
  signal?: AbortSignal;
}

export interface InflightProducerContext {
  /** Aborted once every waiter has left; pass it to the endpoint request. */
  signal: AbortSignal;
  /** Publishes the full accumulated text so far to every waiter. */
  progress(text: string): void;
}

export interface TranslationInflightRegistry {
  /** True while a translation for `key` is running. */
  has(key: string): boolean;
  /** Waits for the running translation of `key`; undefined when none runs. */
  join(key: string, options?: InflightWaitOptions): Promise<string> | undefined;
  /**
   * Starts `produce` for `key` and waits for it as the first waiter. The
   * caller must have checked `has(key)` in the same synchronous stretch;
   * starting a key twice is a programming error.
   */
  start(
    key: string,
    produce: (context: InflightProducerContext) => Promise<string>,
    options?: InflightWaitOptions,
  ): Promise<string>;
  /** Live jobs and the text they currently hold, read by the memory probe. */
  stats(): TranslationInflightStats;
}

/** Type alias so it stays assignable to the memory probe's gauge value. */
export type TranslationInflightStats = {
  entries: number;
  /** Characters buffered by in-progress translations (streamed partials). */
  partialChars: number;
};

interface InflightEntry {
  partial: string;
  listeners: Set<(text: string) => void>;
  done: Promise<string>;
  waiters: number;
  /** A waiter without a signal can never leave, so the upstream must finish. */
  pinned: boolean;
  controller: AbortController;
}

export function createTranslationInflightRegistry(): TranslationInflightRegistry {
  const entries = new Map<string, InflightEntry>();

  function wait(key: string, entry: InflightEntry, options?: InflightWaitOptions): Promise<string> {
    const signal = options?.signal;
    const onProgress = options?.onProgress;
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new LlmRequestCanceledError());
        return;
      }
      if (signal === undefined) entry.pinned = true;
      entry.waiters += 1;
      if (onProgress !== undefined) {
        if (entry.partial.length > 0) safeNotify(onProgress, entry.partial);
        entry.listeners.add(onProgress);
      }
      let settled = false;
      const leave = () => {
        settled = true;
        if (onProgress !== undefined) entry.listeners.delete(onProgress);
        signal?.removeEventListener("abort", onAbort);
        entry.waiters -= 1;
      };
      const onAbort = () => {
        if (settled) return;
        leave();
        reject(new LlmRequestCanceledError());
        if (entry.waiters === 0 && !entry.pinned) {
          // Nobody reads this translation anymore: stop billing it, and
          // let the next request for the key start a fresh one.
          if (entries.get(key) === entry) entries.delete(key);
          entry.controller.abort();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.done.then(
        (text) => {
          if (settled) return;
          leave();
          resolve(text);
        },
        (error: unknown) => {
          if (settled) return;
          leave();
          reject(error);
        },
      );
    });
  }

  return {
    has(key) {
      return entries.has(key);
    },
    join(key, options) {
      const entry = entries.get(key);
      return entry === undefined ? undefined : wait(key, entry, options);
    },
    start(key, produce, options) {
      if (entries.has(key)) throw new Error(`Invariant: translation already in flight for ${key}`);
      // A caller canceled before the start (e.g. while its job awaited setup)
      // would register an entry with no waiter left to abort it, so the
      // upstream would run and bill to completion for nobody.
      if (options?.signal?.aborted === true) return Promise.reject(new LlmRequestCanceledError());
      const controller = new AbortController();
      const entry: InflightEntry = {
        partial: "",
        listeners: new Set(),
        done: Promise.resolve(""),
        waiters: 0,
        pinned: false,
        controller,
      };
      entries.set(key, entry);
      entry.done = (async () =>
        produce({
          signal: controller.signal,
          progress(text) {
            const done = step.start("inflight.progress", `chars=${text.length} listeners=${entry.listeners.size}`);
            entry.partial = text;
            // Set iteration tolerates a waiter leaving mid-loop.
            for (const listener of entry.listeners) safeNotify(listener, text);
            done();
          },
        }))().finally(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      // Every waiter attaches its own handlers; this one only keeps a
      // rejection after all waiters left from surfacing as unhandled.
      entry.done.catch(() => undefined);
      return wait(key, entry, options);
    },
    stats() {
      let partialChars = 0;
      for (const entry of entries.values()) partialChars += entry.partial.length;
      return { entries: entries.size, partialChars };
    },
  };
}

function safeNotify(listener: (text: string) => void, text: string): void {
  try {
    listener(text);
  } catch {
    // A consumer's progress handler must not break the shared translation.
  }
}
