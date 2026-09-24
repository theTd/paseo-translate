import { useCallback, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import { MarkdownView } from "./markdown";
import {
  useAgent,
  useSettings,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  TRANSLATE_PROVIDER_IDS,
  isDataUriImageOnlyText,
  isDisplayTranslationSettled,
  translateSettings,
  type TranslatedMessageData,
} from "../shared/translate";
import { hasVisibleTranslation } from "../shared/display-translation-chain";
import { classifyTranslationError } from "../shared/translation-retry";
import { useTranslate } from "./i18n";
import { agentIsBusyForDisplay, useStreamIdle } from "./display-translation-settle";
import { useRetryNonce, useReconnectAutoRetry, useStreamingTranslation } from "./streaming-translation";

/**
 * Renders one assistant message. While the turn streams, the agent's original
 * text is shown untouched. Translation starts once the item is settled:
 * `phase === "complete"` (committed history), the agent snapshot is no
 * longer busy, or the live-head text has been unchanged for
 * `DISPLAY_STREAM_SETTLE_MS`. Those last two close the host gap where the
 * live-head item stays `streaming` until the next tool call or user prompt.
 * The job renders progressively once its first non-blank token arrives
 * (until then the original stays visible with a `Translating…` hint); the
 * canonical row always keeps the original, so this stays a display-only
 * projection.
 */
export function TranslatedMessage(props: PluginTimelineItemProps<TranslatedMessageData>) {
  const data = props.item.data;
  const provider = useAgent(props.agentId, (agent) => agent.provider);
  const agentStatus = useAgent(props.agentId, (agent) => agent.status);
  const streamIdle = useStreamIdle(data.text, data.phase);
  const settled = isDisplayTranslationSettled({
    phase: data.phase,
    agentIsBusy: agentIsBusyForDisplay(agentStatus),
    streamIdle,
  });
  const settings = useSettings(translateSettings);
  const { t } = useTranslate(
    settings.status === "ready" ? settings.values.uiLanguage : "system",
  );
  const [showOriginal, setShowOriginal] = useState(false);
  const { retryNonce, retry } = useRetryNonce();
  const toggleOriginal = useCallback(() => {
    setShowOriginal((value) => !value);
  }, []);
  const retryTranslation = useCallback(() => {
    setShowOriginal(false);
    retry();
  }, [retry]);

  const languagePair =
    settings.status === "ready"
      ? `${settings.values.agentLanguage}>${settings.values.userLanguage}`
      : null;
  const translateAllTimelines =
    settings.status === "ready" && settings.values.translateAllTimelines;
  const ownedByTranslateProvider =
    provider !== null && (TRANSLATE_PROVIDER_IDS as readonly string[]).includes(provider);
  // Empty assistant texts would fail the RPC's min(1) contract for nothing.
  // Data-URI image texts (tool screenshots from older timelines or foreign
  // providers) would burn endpoint quota on base64 soup the Markdown view
  // cannot render anyway, so they keep the original without a job.
  const eligible =
    settled &&
    data.text.length > 0 &&
    !isDataUriImageOnlyText(data.text) &&
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

  // Reconnect retry: non-fatal failures re-run by themselves once a host
  // is back online or the app returns to the foreground (see
  // useReconnectAutoRetry); fatal ones wait for the manual button.
  const autoRetryable =
    stream.error !== undefined && classifyTranslationError(stream.error) !== "fatal";
  const attemptRunning = eligible && !stream.done && stream.error === undefined;
  useReconnectAutoRetry({ attemptRunning, autoRetryable, onRetry: retry });

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
