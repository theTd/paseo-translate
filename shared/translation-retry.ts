/**
 * Shared retry policy for the display translation path.
 *
 * Stays platform-agnostic (pure functions and string constants only) so
 * both the client renderer and unit tests can use it. The prompt path
 * (fail closed) intentionally does not retry; only the best-effort display
 * path consults this module.
 */

/** Server stream-manager refusal when too many jobs are in flight. */
export const TRANSLATION_BUSY_MESSAGE = "Translation is busy; try again in a moment";
/** Prefix of the server refusal for oversized texts (never retryable). */
export const TRANSLATION_LIMIT_REFUSAL_PREFIX = "Refusing to translate";
/**
 * Markers of configuration errors thrown by settings load/assert helpers
 * (see shared/translate.ts `assertConfigured` and the plugin entry
 * `loadConfig`). Retrying these is pointless until the user fixes settings.
 */
const NOT_CONFIGURED_MARKERS = [
  "Translate plugin settings are invalid",
  "Translate plugin is not configured",
] as const;

export type TranslationErrorKind = "busy" | "fatal" | "retryable";

/**
 * Classifies a translation RPC failure. `busy` gets a longer backoff so a
 * reopened long session does not retry-storm the 20-job server window;
 * `fatal` (oversized text, unconfigured endpoint) fails immediately;
 * everything else (unknown job, network, timeout, HTTP 5xx, malformed
 * responses) is treated as transient.
 */
export function classifyTranslationError(error: unknown): TranslationErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(TRANSLATION_BUSY_MESSAGE)) return "busy";
  if (
    message.startsWith(TRANSLATION_LIMIT_REFUSAL_PREFIX) ||
    NOT_CONFIGURED_MARKERS.some((marker) => message.includes(marker))
  ) {
    return "fatal";
  }
  return "retryable";
}

/** Delay between stream polls; each poll is a cheap in-memory read. */
export const DISPLAY_POLL_INTERVAL_MS = 200;
/** Stream job attempts (fresh job per attempt) before the unary fallback. */
export const DISPLAY_STREAM_MAX_ATTEMPTS = 3;
/** Unary fallback attempts once the stream attempts are exhausted. */
export const DISPLAY_UNARY_MAX_ATTEMPTS = 2;
/** Base backoff between attempts; doubles per attempt up to the cap. */
export const DISPLAY_RETRY_BASE_MS = 500;
/** Longer base backoff reserved for `busy` refusals. */
export const DISPLAY_BUSY_RETRY_BASE_MS = 2_000;
/** Upper bound of a single backoff step. */
export const DISPLAY_RETRY_CAP_MS = 2_000;
/** Fallback for `translationTimeoutMs` when the setting is unavailable. */
export const DISPLAY_DEFAULT_ENDPOINT_TIMEOUT_MS = 30_000;
/**
 * How long a live-head (`phase: "streaming"`) item may sit with unchanged
 * text before display translation treats it as settled. The host keeps the
 * current live item at `streaming` until a later timeline mutation (next
 * tool call, next user prompt) or `turn_completed` flushes it to history;
 * the last message of a turn often never gets that flush in time. 800ms is
 * well above the host's 60ms stream-coalesce window, so an active token
 * stream keeps resetting, while a finished last message starts translating
 * without waiting for the next prompt.
 */
export const DISPLAY_STREAM_SETTLE_MS = 800;
/** Slack on top of the server's own worst case for RPC and daemon latency. */
export const DISPLAY_STREAM_IDLE_MARGIN_MS = 15_000;
/**
 * Most awake time one poll pass may bill against the idle timeout. A pass
 * is one poll RPC plus a DISPLAY_POLL_INTERVAL_MS sleep, so anything longer
 * means the clock jumped: the device slept or the app was backgrounded and
 * its timers froze. Clamping keeps that jump from counting as idle time.
 */
export const DISPLAY_MAX_POLL_TICK_MS = 5_000;

/**
 * How long a stream job may go without new text before the client gives it
 * up. There is no cap on total time: a job whose text keeps growing is
 * healthy however long the translation takes. The server bounds a silent
 * job by itself: a stream call that never sends a delta times out after
 * `translationTimeoutMs`, then one plain completion runs under the same
 * timeout, so the worst silent stretch is 2 × timeout. The idle timeout
 * sits just above that, so it only fires when the job is truly stuck.
 */
export function displayStreamIdleTimeoutMs(translationTimeoutMs: number | undefined): number {
  const endpointTimeoutMs =
    typeof translationTimeoutMs === "number" &&
    Number.isFinite(translationTimeoutMs) &&
    translationTimeoutMs > 0
      ? translationTimeoutMs
      : DISPLAY_DEFAULT_ENDPOINT_TIMEOUT_MS;
  return 2 * endpointTimeoutMs + DISPLAY_STREAM_IDLE_MARGIN_MS;
}

/** Exponential backoff for 1-based attempt numbers, clamped to [base, cap]. */
export function retryDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const delay = baseMs * 2 ** (safeAttempt - 1);
  return Math.min(Math.max(delay, baseMs), capMs);
}
