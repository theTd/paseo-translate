import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  translateStreamPollRpc,
  translateStreamStartRpc,
  translateTextRpc,
} from "../shared/translate";
import { runDisplayTranslationChain, hasVisibleTranslation } from "../shared/display-translation-chain";
import { displayStreamIdleTimeoutMs } from "../shared/translation-retry";
import { useReconnectEpoch } from "./use-reconnect-epoch";

export interface StreamingTranslationInput {
  enabled: boolean;
  text: string;
  languagePair: string | null;
  /**
   * The endpoint timeout setting; sizes the stream idle timeout. Read
   * when an attempt chain starts, so changing it does not retranslate.
   */
  translationTimeoutMs: number | undefined;
  /**
   * Message for the defensive empty-result failure, in the current UI
   * locale. Read when an attempt chain starts, like the timeout above.
   */
  emptyResultMessage: string;
  /**
   * Bumped by the manual "Retry translation" button and by the automatic
   * retry after a reconnect to re-run the effect.
   */
  retryNonce: number;
}

export interface StreamingTranslation {
  /** Latest translated text (partial while streaming); undefined until first bytes. */
  text: string | undefined;
  done: boolean;
  error: unknown;
}

/**
 * Stream-first translation with bounded retries and a unary fallback; see
 * shared/display-translation-chain.ts for the attempt policy. This hook is
 * only the React adapter: it binds the RPCs, maps the chain outcome onto
 * component state, and owns cancellation. A final failure discards any
 * partial stream so the original text stays, and surfaces an error hint
 * with a manual retry button that re-runs the whole chain via `retryNonce`.
 *
 * Shared by the assistant-message renderer and the reasoning renderer: both
 * translate `agent-to-user` display text with identical retry semantics and
 * differ only in presentation and eligibility gating.
 */
export function useStreamingTranslation(input: StreamingTranslationInput): StreamingTranslation {
  const startStream = useRpc(translateStreamStartRpc);
  const pollStream = useRpc(translateStreamPollRpc);
  const translate = useRpc(translateTextRpc);
  const [partial, setPartial] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const translationTimeoutMsRef = useRef(input.translationTimeoutMs);
  translationTimeoutMsRef.current = input.translationTimeoutMs;
  const emptyResultMessageRef = useRef(input.emptyResultMessage);
  emptyResultMessageRef.current = input.emptyResultMessage;

  useEffect(() => {
    if (!input.enabled || input.languagePair === null) {
      setPartial(undefined);
      setDone(false);
      setError(undefined);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;
    setPartial(undefined);
    setDone(false);
    setError(undefined);

    /**
     * Cancellable sleep: resolves false when the effect unmounts mid-wait
     * so no attempt chain is left parked on a cleared timer.
     */
    function sleep(ms: number): Promise<boolean> {
      return new Promise((resolve) => {
        wake = () => resolve(false);
        timer = setTimeout(() => {
          timer = null;
          wake = null;
          resolve(true);
        }, ms);
      });
    }

    async function run(): Promise<void> {
      const outcome = await runDisplayTranslationChain(
        {
          startStream: async () => {
            const { jobId } = await startStream({ text: input.text, direction: "agent-to-user" });
            return jobId;
          },
          pollStream: (jobId: string) => pollStream({ jobId }),
          translateUnary: async () => {
            const result = await translate({ text: input.text, direction: "agent-to-user" });
            return result.text;
          },
        },
        {
          onPartial: (text) => {
            // Drop pre-first-token polls ("" / whitespace-only) so `partial`
            // stays `undefined` and the original text remains visible with
            // the `Translating…` hint until real content arrives.
            if (!cancelled && hasVisibleTranslation(text)) setPartial(text);
          },
          sleep,
          now: () => Date.now(),
          isCancelled: () => cancelled,
          random: () => Math.random(),
        },
        { idleTimeoutMs: displayStreamIdleTimeoutMs(translationTimeoutMsRef.current) },
      );
      if (cancelled) return;
      if (outcome.status === "translated" && hasVisibleTranslation(outcome.text)) {
        setPartial(outcome.text);
        setDone(true);
      } else if (outcome.status === "failed") {
        setPartial(undefined);
        setError(outcome.error);
      } else if (outcome.status === "translated") {
        // Defensive: a blank final text (no visible token) must never
        // replace the original with an empty view; surface it as a
        // retryable failure instead so the original stays with an error hint.
        setPartial(undefined);
        setError(new Error(emptyResultMessageRef.current));
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      wake?.();
      wake = null;
    };
    // The language pair is a dependency: editing settings retranslates
    // instead of showing stale results from the previous pair. retryNonce
    // re-runs the whole attempt chain (manual button or reconnect retry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.enabled, input.text, input.languagePair, input.retryNonce]);

  return { text: partial, done, error };
}

/**
 * Manual retry nonce for a display-translation renderer. Bump `retry` from
 * the "Retry translation" button (the caller also resets its
 * `showOriginal` flag) to re-run the whole attempt chain.
 */
export function useRetryNonce(): { retryNonce: number; retry: () => void } {
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);
  return { retryNonce, retry };
}

/**
 * Reconnect retry: a failure caused by a dropped connection (e.g. while
 * AFK) re-runs by itself once a host is back online or the app returns to
 * the foreground. Fatal failures (oversized text, unconfigured endpoint)
 * would fail the same way, so they wait for the manual button — the caller
 * decides fatality through `autoRetryable` (see `classifyTranslationError`).
 */
export function useReconnectAutoRetry(input: {
  attemptRunning: boolean;
  autoRetryable: boolean;
  onRetry: () => void;
}): void {
  const reconnectEpoch = useReconnectEpoch();
  const handledReconnectEpoch = useRef(reconnectEpoch);
  // A reconnect seen while an attempt is still running: that attempt may
  // yet fail from the outage it started in, so the retry is held for it.
  const reconnectDuringAttempt = useRef(false);
  const onRetryRef = useRef(input.onRetry);
  onRetryRef.current = input.onRetry;

  useEffect(() => {
    if (reconnectEpoch === handledReconnectEpoch.current) return;
    handledReconnectEpoch.current = reconnectEpoch;
    if (input.autoRetryable) {
      onRetryRef.current();
    } else if (input.attemptRunning) {
      reconnectDuringAttempt.current = true;
    }
    // Only a new reconnect should trigger this; the flags are read from
    // the render that saw the new epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectEpoch]);
  useEffect(() => {
    if (!reconnectDuringAttempt.current) return;
    if (input.autoRetryable) {
      reconnectDuringAttempt.current = false;
      onRetryRef.current();
    } else if (!input.attemptRunning) {
      // Succeeded or became ineligible: nothing left to retry.
      reconnectDuringAttempt.current = false;
    }
  }, [input.autoRetryable, input.attemptRunning]);
}
