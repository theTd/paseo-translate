import { LlmRequestCanceledError } from "./llm-client";

export type TranslationLane = "prompt" | "display";

export interface TranslationSession {
  readonly sessionKey: string;
  readonly backend: string;
  readonly cacheEpoch: number;
  readonly promptCacheKey: string | undefined;
  readonly lastActivityAt: number;
  readonly configurationFingerprint: string | undefined;
  run<T>(lane: TranslationLane, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  bumpCacheEpoch(): void;
  ensureConfiguration(fingerprint: string): void;
  close(): void;
}

export interface TranslationSessionManager {
  getOrCreate(sessionKey: string): TranslationSession;
  run<T>(sessionKey: string, lane: TranslationLane, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  bumpCacheEpoch(sessionKey: string): TranslationSession;
  ensureConfiguration(sessionKey: string, fingerprint: string): TranslationSession;
  close(sessionKey?: string): void;
  sweep(): void;
  stats(): { sessions: number; queued: number; active: number };
}

export interface TranslationSessionManagerOptions {
  promptCacheKey?: (sessionKey: string, cacheEpoch: number) => string;
  backend?: string;
  now?: () => number;
  maxQueuedPerSession?: number;
  idleSessionMs?: number;
}

interface Job {
  lane: TranslationLane;
  task: (signal: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * One translation transcript boundary per main-agent session. Prompt work has
 * priority over display work that has not started, while every session still
 * has at most one endpoint task running. Sessions are independent, so this
 * queue is intentionally not global.
 */
export function createTranslationSessionManager(
  options: TranslationSessionManagerOptions = {},
): TranslationSessionManager {
  const now = options.now ?? (() => Date.now());
  const backend = options.backend ?? "http";
  const maxQueued = Math.max(1, options.maxQueuedPerSession ?? 128);
  const sessions = new Map<string, SessionState>();
  const idleSessionMs = Math.max(0, options.idleSessionMs ?? 24 * 60 * 60 * 1000);
  const sweepTimer = idleSessionMs > 0 ? setInterval(() => {
    const cutoff = now() - idleSessionMs;
    for (const [key, state] of sessions) {
      if (!state.running && state.queued === 0 && state.lastActivityAt > 0 && state.lastActivityAt <= cutoff) {
        state.close();
        sessions.delete(key);
      }
    }
  }, Math.min(idleSessionMs, 60 * 60 * 1000)) : undefined;
  sweepTimer?.unref?.();

  function stateFor(sessionKey: string): SessionState {
    let state = sessions.get(sessionKey);
    if (state !== undefined) return state;
    state = new SessionState(sessionKey, backend, now, options.promptCacheKey, maxQueued);
    sessions.set(sessionKey, state);
    return state;
  }

  return {
    getOrCreate: stateFor,
    run(sessionKey, lane, task, signal) {
      return stateFor(sessionKey).run(lane, task, signal);
    },
    bumpCacheEpoch(sessionKey) {
      const state = stateFor(sessionKey);
      state.bumpCacheEpoch();
      return state;
    },
    ensureConfiguration(sessionKey, fingerprint) {
      const state = stateFor(sessionKey);
      state.ensureConfiguration(fingerprint);
      return state;
    },
    close(sessionKey) {
      if (sessionKey === undefined) {
        for (const state of sessions.values()) state.close();
        sessions.clear();
        if (sweepTimer !== undefined) clearInterval(sweepTimer);
        return;
      }
      sessions.get(sessionKey)?.close();
      sessions.delete(sessionKey);
    },
    sweep() {
      const cutoff = now() - idleSessionMs;
      for (const [key, state] of sessions) {
        if (!state.running && state.queued === 0 && state.lastActivityAt > 0 && state.lastActivityAt <= cutoff) {
          state.close();
          sessions.delete(key);
        }
      }
    },
    stats() {
      let queued = 0;
      let active = 0;
      for (const state of sessions.values()) {
        queued += state.queued;
        active += state.running ? 1 : 0;
      }
      return { sessions: sessions.size, queued, active };
    },
  };
}

class SessionState implements TranslationSession {
  readonly sessionKey: string;
  readonly backend: string;
  private epoch = 0;
  private fingerprint: string | undefined;
  private lastActivity = 0;
  private runningJob = false;
  private closed = false;
  private readonly promptQueue: Job[] = [];
  private readonly displayQueue: Job[] = [];

  constructor(
    sessionKey: string,
    backend: string,
    private readonly now: () => number,
    private readonly cacheKeyFactory: ((sessionKey: string, cacheEpoch: number) => string) | undefined,
    private readonly maxQueued: number,
  ) {
    this.sessionKey = sessionKey;
    this.backend = backend;
  }

  get cacheEpoch(): number { return this.epoch; }
  get promptCacheKey(): string | undefined {
    return this.cacheKeyFactory?.(this.sessionKey, this.epoch);
  }
  get lastActivityAt(): number { return this.lastActivity; }
  get configurationFingerprint(): string | undefined { return this.fingerprint; }
  get queued(): number { return this.promptQueue.length + this.displayQueue.length; }
  get running(): boolean { return this.runningJob; }

  run<T>(lane: TranslationLane, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`Translation session is closed: ${this.sessionKey}`));
    if (signal?.aborted) return Promise.reject(new LlmRequestCanceledError());
    if (this.queued >= this.maxQueued) return Promise.reject(new Error("Translation session queue is full"));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { lane, task: task as (signal: AbortSignal) => Promise<unknown>, signal, resolve: resolve as (value: unknown) => void, reject };
      (lane === "prompt" ? this.promptQueue : this.displayQueue).push(job);
      this.pump();
    });
  }

  bumpCacheEpoch(): void { this.epoch += 1; }

  ensureConfiguration(fingerprint: string): void {
    if (this.fingerprint === undefined) {
      this.fingerprint = fingerprint;
      return;
    }
    if (this.fingerprint !== fingerprint) {
      this.fingerprint = fingerprint;
      this.bumpCacheEpoch();
    }
  }

  close(): void {
    this.closed = true;
    const error = new Error(`Translation session is closed: ${this.sessionKey}`);
    for (const queue of [this.promptQueue, this.displayQueue]) {
      while (queue.length > 0) queue.shift()?.reject(error);
    }
  }

  private pump(): void {
    if (this.runningJob || this.closed) return;
    const job = this.promptQueue.shift() ?? this.displayQueue.shift();
    if (job === undefined) return;
    if (job.signal?.aborted) {
      job.reject(new LlmRequestCanceledError());
      this.pump();
      return;
    }
    this.runningJob = true;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    job.signal?.addEventListener("abort", onAbort, { once: true });
    void job.task(controller.signal).then(job.resolve, job.reject).finally(() => {
      job.signal?.removeEventListener("abort", onAbort);
      this.runningJob = false;
      this.lastActivity = this.now();
      this.pump();
    });
  }
}
