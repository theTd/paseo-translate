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
  isReasoningTranslationEligible,
  translateSettings,
  type TranslatedReasoningData,
} from "../shared/translate";
import { hasVisibleTranslation } from "../shared/display-translation-chain";
import { classifyTranslationError } from "../shared/translation-retry";
import { useTranslate } from "./i18n";
import { agentIsBusyForDisplay, useStreamIdle } from "./display-translation-settle";
import {
  useRetryNonce,
  useReconnectAutoRetry,
  useStreamingTranslation,
} from "./streaming-translation";

/**
 * Renders one reasoning (thinking) block. Mirrors TranslatedMessage: while
 * the turn streams, the agent's original text is shown untouched in a muted
 * tone. Once the item is settled (`phase === "complete"`, the agent is no
 * longer busy, or the live-head text has stopped growing) and reasoning
 * translation is enabled, a streaming translation starts and renders
 * progressively; the canonical row always keeps the original, so this
 * stays a display-only projection.
 *
 * Differences from the message renderer: eligibility additionally requires
 * the `translateReasoning` setting (default off — thinking blocks are often
 * long, so translating them doubles endpoint spend on auxiliary text) plus
 * `translateResponses` (the server display path shares that gate), and both
 * original and translation render muted so thoughts never look like replies.
 */
export function TranslatedReasoning(props: PluginTimelineItemProps<TranslatedReasoningData>) {
  const data = props.item.data;
  const provider = useAgent(props.agentId, (agent) => agent.provider);
  const agentStatus = useAgent(props.agentId, (agent) => agent.status);
  const streamIdle = useStreamIdle(data.text, data.phase);
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
  const translateReasoning =
    settings.status === "ready" && settings.values.translateReasoning;
  const translateResponses = settings.status === "ready" && settings.values.translateResponses;
  const ownedByTranslateProvider =
    provider !== null && (TRANSLATE_PROVIDER_IDS as readonly string[]).includes(provider);
  // Empty thinking blocks would fail the RPC's min(1) contract for nothing.
  const eligible = isReasoningTranslationEligible({
    phase: data.phase,
    textLength: data.text.length,
    languagePair,
    translateReasoning,
    translateResponses,
    ownedByTranslateProvider,
    translateAllTimelines,
    agentIsBusy: agentIsBusyForDisplay(agentStatus),
    streamIdle,
  });

  const stream = useStreamingTranslation({
    enabled: eligible,
    text: data.text,
    languagePair,
    translationTimeoutMs:
      settings.status === "ready" ? settings.values.translationTimeoutMs : undefined,
    emptyResultMessage: t("emptyTranslation"),
    retryNonce,
  });

  const autoRetryable =
    stream.error !== undefined && classifyTranslationError(stream.error) !== "fatal";
  const attemptRunning = eligible && !stream.done && stream.error === undefined;
  useReconnectAutoRetry({ attemptRunning, autoRetryable, onRetry: retry });

  const styles = useMemo(
    () => ({
      muted: { color: props.theme.colors.foregroundMuted },
      toggle: { color: props.theme.colors.accent, marginTop: 4, paddingVertical: 2 },
      reasoning: props.theme.colors.foregroundMuted,
      accent: props.theme.colors.accent,
    }),
    [props.theme],
  );

  const renderMarkdown = useCallback(
    (text: string) => (
      <MarkdownView
        text={text}
        colors={{ foreground: styles.reasoning, accent: styles.accent }}
      />
    ),
    [styles.accent, styles.reasoning],
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
