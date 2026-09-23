import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text } from "react-native";
import { MarkdownView } from "./markdown";
import {
  useAgent,
  useRpc,
  useSettings,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  TRANSLATE_PROVIDER_IDS,
  translateSettings,
  translateStreamPollRpc,
  translateStreamStartRpc,
  translateTextRpc,
  type TranslatedMessageData,
} from "../shared/translate";
import { runDisplayTranslationChain, hasVisibleTranslation } from "../shared/display-translation-chain";
import {
  classifyTranslationError,
  displayStreamIdleTimeoutMs,
} from "../shared/translation-retry";
import { useTranslate } from "./i18n";
import { useReconnectEpoch } from "./use-reconnect-epoch";

interface StreamingTranslationInput {
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

interface StreamingTranslation {
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
 */
function useStreamingTranslation(input: StreamingTranslationInput): StreamingTranslation {
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
 * Renders one assistant message. While the turn streams, the agent's original
 * text is shown untouched. Once the phase is `complete`, the plugin item is
 * re-rendered with the full text and a streaming translation starts,
 * rendering progressively once its first non-blank token arrives (until
 * then the original stays visible with a `Translating…` hint); the canonical
 * row always keeps the original, so this stays a display-only projection.
 */
export function TranslatedMessage(props: PluginTimelineItemProps<TranslatedMessageData>) {
  const data = props.item.data;
  const provider = useAgent(props.agentId, (agent) => agent.provider);
  const settings = useSettings(translateSettings);
  const { t } = useTranslate(
    settings.status === "ready" ? settings.values.uiLanguage : "system",
  );
  const [showOriginal, setShowOriginal] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const toggleOriginal = useCallback(() => {
    setShowOriginal((value) => !value);
  }, []);
  const retryTranslation = useCallback(() => {
    setShowOriginal(false);
    setRetryNonce((value) => value + 1);
  }, []);

  const languagePair =
    settings.status === "ready"
      ? `${settings.values.agentLanguage}>${settings.values.userLanguage}`
      : null;
  const translateAllTimelines =
    settings.status === "ready" && settings.values.translateAllTimelines;
  const ownedByTranslateProvider =
    provider !== null && (TRANSLATE_PROVIDER_IDS as readonly string[]).includes(provider);
  // Empty assistant texts would fail the RPC's min(1) contract for nothing.
  const eligible =
    data.phase === "complete" &&
    data.text.length > 0 &&
    languagePair !== null &&
    (ownedByTranslateProvider || translateAllTimelines);

  const stream = useStreamingTranslation({
    enabled: eligible,
    text: data.text,
    languagePair,
    translationTimeoutMs:
      settings.status === "ready" ? settings.values.translationTimeoutMs : undefined,
    emptyResultMessage: t("emptyTranslation"),
    retryNonce,
  });

  // Reconnect retry: a failure caused by a dropped connection (e.g. while
  // AFK) re-runs by itself once a host is back online or the app returns
  // to the foreground. Fatal failures (oversized text, unconfigured
  // endpoint) would fail the same way, so they wait for the manual button.
  const reconnectEpoch = useReconnectEpoch();
  const handledReconnectEpoch = useRef(reconnectEpoch);
  // A reconnect seen while an attempt is still running: that attempt may
  // yet fail from the outage it started in, so the retry is held for it.
  const reconnectDuringAttempt = useRef(false);
  const autoRetryable =
    stream.error !== undefined && classifyTranslationError(stream.error) !== "fatal";
  const attemptRunning = eligible && !stream.done && stream.error === undefined;
  useEffect(() => {
    if (reconnectEpoch === handledReconnectEpoch.current) return;
    handledReconnectEpoch.current = reconnectEpoch;
    if (autoRetryable) {
      setRetryNonce((value) => value + 1);
    } else if (attemptRunning) {
      reconnectDuringAttempt.current = true;
    }
    // Only a new reconnect should trigger this; the flags are read from
    // the render that saw the new epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectEpoch]);
  useEffect(() => {
    if (!reconnectDuringAttempt.current) return;
    if (autoRetryable) {
      reconnectDuringAttempt.current = false;
      setRetryNonce((value) => value + 1);
    } else if (!attemptRunning) {
      // Succeeded or became ineligible: nothing left to retry.
      reconnectDuringAttempt.current = false;
    }
  }, [autoRetryable, attemptRunning]);

  const styles = useMemo(
    () => ({
      muted: { color: props.theme.colors.foregroundMuted },
      toggle: { color: props.theme.colors.accent, marginTop: 4, paddingVertical: 2 },
      foreground: props.theme.colors.foreground,
      accent: props.theme.colors.accent,
    }),
    [props.theme],
  );

  const renderMarkdown = useCallback(
    (text: string) => (
      <MarkdownView
        text={text}
        colors={{ foreground: styles.foreground, accent: styles.accent }}
      />
    ),
    [styles.accent, styles.foreground],
  );

  if (!eligible) {
    return renderMarkdown(data.text);
  }

  const showTranslation = hasVisibleTranslation(stream.text) && !showOriginal;
  return (
    <>
      {renderMarkdown(showTranslation ? (stream.text as string) : data.text)}
      {!hasVisibleTranslation(stream.text) && stream.error === undefined && !stream.done ? (
        <Text style={styles.muted}>{t("translating")}</Text>
      ) : null}
      {stream.error !== undefined ? (
        <>
          <Text style={styles.muted} accessibilityRole="alert">
            {t("translationUnavailable", {
              error:
                stream.error instanceof Error ? stream.error.message : t("translationFailedWord"),
            })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("retryTranslation")}
            onPress={retryTranslation}
          >
            <Text style={styles.toggle}>{t("retryTranslation")}</Text>
          </Pressable>
        </>
      ) : null}
      {stream.done && hasVisibleTranslation(stream.text) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showTranslation ? t("showOriginal") : t("showTranslation")}
          onPress={toggleOriginal}
        >
          <Text style={styles.toggle}>
            {showTranslation ? t("showOriginal") : t("showTranslation")}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}
