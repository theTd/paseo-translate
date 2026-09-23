import {
  DISPLAY_BUSY_RETRY_BASE_MS,
  DISPLAY_MAX_POLL_TICK_MS,
  DISPLAY_POLL_INTERVAL_MS,
  DISPLAY_RETRY_BASE_MS,
  DISPLAY_RETRY_CAP_MS,
  DISPLAY_STREAM_MAX_ATTEMPTS,
  DISPLAY_UNARY_MAX_ATTEMPTS,
  classifyTranslationError,
  displayStreamIdleTimeoutMs,
  retryDelayMs,
} from "./translation-retry";

/**
 * Framework-free orchestration of one message's display translation.
 *
 * Extracted from the client hook so the attempt chain — retries, fatal
 * fast-fail, stream idle timeout, and success propagation — is unit testable
 * without a DOM. The hook stays a thin adapter: it binds the RPCs, maps the
 * outcome onto component state, and owns cancellation.
 */

export interface DisplayTranslationRpcs {
  /** Opens a server stream job; resolves with its id. */
  startStream(): Promise<string>;
  /** Reads one poll of accumulated server-side stream text. */
  pollStream(jobId: string): Promise<{ text: string; done: boolean }>;
  /** Single non-streaming translation attempt. */
  translateUnary(): Promise<string>;
}

export interface DisplayTranslationCallbacks {
  /** Receives every partial stream text (also called with unary results). */
  onPartial(text: string): void;
  /** Cancellable sleep; resolves false when the caller aborted the wait. */
  sleep(ms: number): Promise<boolean>;
  /** Clock, injectable for deterministic tests. */
  now(): number;
  /** True once the caller no longer cares about the outcome. */
  isCancelled(): boolean;
  /** Randomness source for retry jitter, injectable for tests. */
  random(): number;
}

export interface DisplayTranslationOptions {
  /**
   * Awake time a stream job may go without new text before the attempt is
   * given up; see `displayStreamIdleTimeoutMs`. Defaults to the value for
   * the default endpoint timeout.
   */
  idleTimeoutMs?: number;
}

export type DisplayTranslationOutcome =
  | { status: "translated"; text: string }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" };

class ChainCancelled {}

function jitteredDelayMs(kind: "busy" | "retryable", attempt: number, random: number): number {
  const base = kind === "busy" ? DISPLAY_BUSY_RETRY_BASE_MS : DISPLAY_RETRY_BASE_MS;
  const delay = retryDelayMs(attempt, base, DISPLAY_RETRY_CAP_MS);
  // ±25% jitter so a reopened long session's messages do not retry in lockstep.
  return Math.round(delay * (0.75 + random * 0.5));
}

/**
 * Runs stream attempts (fresh job per attempt) with exponential backoff,
 * then a retried unary fallback. Resolves `cancelled` as soon as the caller
 * flags it; resolves `failed` with the last error once attempts are spent.
 * There is no total time limit: attempts are bounded by count, and a
 * stream attempt ends only when its job stops producing text (idle
 * timeout). A unary success after exhausted stream attempts resolves
 * `translated` — it must never fall through to the failure branch.
 */
export async function runDisplayTranslationChain(
  rpcs: DisplayTranslationRpcs,
  callbacks: DisplayTranslationCallbacks,
  options: DisplayTranslationOptions = {},
): Promise<DisplayTranslationOutcome> {
  const idleTimeoutMs = options.idleTimeoutMs ?? displayStreamIdleTimeoutMs(undefined);
  let lastError: unknown = new Error("Translation failed");

  async function poll(jobId: string): Promise<string> {
    let idleMs = 0;
    let lastTickAt = callbacks.now();
    let lastText: string | undefined;
    for (;;) {
      if (callbacks.isCancelled()) throw new ChainCancelled();
      // Always read the job before judging it: after a device sleep the
      // job has often finished server-side, and that result must win over
      // any timeout. Unknown job (daemon restart, eviction) or a
      // server-side endpoint failure captured into the job rejects here so
      // the caller retries from a fresh job.
      const result = await rpcs.pollStream(jobId);
      if (callbacks.isCancelled()) throw new ChainCancelled();
      callbacks.onPartial(result.text);
      if (result.done) return result.text;
      const tickAt = callbacks.now();
      if (result.text !== lastText) {
        // New text means the job is healthy, however long it has run.
        idleMs = 0;
        lastText = result.text;
      } else {
        // Bill awake time only: a clock jump from a sleep or a frozen
        // background tab is clamped to one normal pass.
        idleMs += Math.min(Math.max(0, tickAt - lastTickAt), DISPLAY_MAX_POLL_TICK_MS);
      }
      lastTickAt = tickAt;
      if (idleMs >= idleTimeoutMs) throw new Error("Translation stalled: no new text");
      if (!(await callbacks.sleep(DISPLAY_POLL_INTERVAL_MS))) throw new ChainCancelled();
    }
  }

  try {
    for (let attempt = 1; attempt <= DISPLAY_STREAM_MAX_ATTEMPTS; attempt++) {
      try {
        const jobId = await rpcs.startStream();
        const text = await poll(jobId);
        return { status: "translated", text };
      } catch (attemptError) {
        if (attemptError instanceof ChainCancelled || callbacks.isCancelled()) {
          return { status: "cancelled" };
        }
        lastError = attemptError;
        const kind = classifyTranslationError(attemptError);
        if (kind === "fatal" || attempt >= DISPLAY_STREAM_MAX_ATTEMPTS) break;
        if (!(await callbacks.sleep(jitteredDelayMs(kind, attempt, callbacks.random())))) {
          return { status: "cancelled" };
        }
      }
    }

    // A fatal stream failure (oversized text, unconfigured endpoint) fails
    // identically on the unary path, so skip straight to the failure below.
    if (classifyTranslationError(lastError) !== "fatal") {
      for (let attempt = 1; attempt <= DISPLAY_UNARY_MAX_ATTEMPTS; attempt++) {
        try {
          const text = await rpcs.translateUnary();
          if (callbacks.isCancelled()) return { status: "cancelled" };
          callbacks.onPartial(text);
          return { status: "translated", text };
        } catch (fallbackError) {
          if (fallbackError instanceof ChainCancelled || callbacks.isCancelled()) {
            return { status: "cancelled" };
          }
          lastError = fallbackError;
          const kind = classifyTranslationError(fallbackError);
          if (attempt >= DISPLAY_UNARY_MAX_ATTEMPTS || kind === "fatal") break;
          if (!(await callbacks.sleep(jitteredDelayMs(kind, attempt, callbacks.random())))) {
            return { status: "cancelled" };
          }
        }
      }
    }
  } catch (unexpected) {
    if (unexpected instanceof ChainCancelled || callbacks.isCancelled()) {
      return { status: "cancelled" };
    }
    lastError = unexpected;
  }
  if (callbacks.isCancelled()) return { status: "cancelled" };
  return { status: "failed", error: lastError };
}
