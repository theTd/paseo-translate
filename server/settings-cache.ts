import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import type { ZodType } from "zod";

/**
 * Fallback lifetime of a cached settings snapshot.
 *
 * The host re-reads the settings JSON from disk and re-validates it with zod on
 * every `read()`, and serializes those reads behind one queue. That disk read
 * goes through libuv's small thread pool, so under I/O pressure a 1 ms RPC that
 * only needs one setting can wait behind unrelated fs work until the daemon
 * times it out. Keep the last snapshot in memory instead:
 *
 * - the first caller reads, and concurrent first callers share that one read;
 * - the host subscription replaces the snapshot on every in-process change;
 * - a snapshot older than this TTL is still served immediately and refreshed in
 *   the background, so an edit made outside this process is eventually picked
 *   up without ever blocking a caller that already has a value;
 * - a failed read is not cached, so the next caller tries again.
 */
export const SETTINGS_CACHE_TTL_MS = 30_000;

export interface CachedSettingsReaderOptions {
  /** Fallback lifetime of a snapshot; tests shorten it instead of waiting. */
  ttlMs?: number;
  /** Clock used for the TTL check; tests move it forward. */
  now?: () => number;
}

export interface CachedSettingsReader<Schema extends ZodType> {
  /** Last known settings state; see the module doc for how fresh it is. */
  read(): Promise<PluginSettingsState<Schema>>;
  /** Stops the host subscription; call once from the plugin cleanup. */
  dispose(): void;
}

export function createCachedSettingsReader<Schema extends ZodType>(
  settings: PluginSettings<Schema>,
  options: CachedSettingsReaderOptions = {},
): CachedSettingsReader<Schema> {
  const ttlMs = options.ttlMs ?? SETTINGS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let snapshot: { state: PluginSettingsState<Schema>; at: number } | undefined;
  let inflight: Promise<PluginSettingsState<Schema>> | undefined;
  // Bumped whenever newer state lands, so a read that started earlier cannot
  // overwrite a subscription update that arrived while it ran.
  let generation = 0;

  const unsubscribe = settings.subscribe((state) => {
    generation += 1;
    snapshot = { state, at: now() };
  });

  function load(): Promise<PluginSettingsState<Schema>> {
    if (inflight !== undefined) return inflight;
    const startedGeneration = generation;
    const pending = settings.read();
    inflight = pending;
    // Release the in-flight slot before any caller continuation runs, so a
    // failed read is retried rather than replayed from the cache.
    void pending.then(
      (state) => {
        if (inflight === pending) inflight = undefined;
        if (generation !== startedGeneration) return;
        generation += 1;
        snapshot = { state, at: now() };
      },
      () => {
        if (inflight === pending) inflight = undefined;
        // A failed read is not cached: the next caller starts a new one.
      },
    );
    return pending;
  }

  function refresh(): void {
    void load().catch(() => {
      // The caller already got the stale snapshot; the next read retries.
    });
  }

  return {
    read() {
      if (snapshot === undefined) return load();
      if (now() - snapshot.at >= ttlMs) refresh();
      return Promise.resolve(snapshot.state);
    },
    dispose() {
      unsubscribe();
    },
  };
}
