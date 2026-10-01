import { useCallback, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import {
  useAgent,
  useSettings,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  TRANSLATE_PROVIDER_IDS,
  isUserPromptTranslationEligible,
  translateSettings,
  type TranslatedUserMessageData,
} from "../shared/translate";
import { promptTranslationParts } from "../shared/prompt-text";
import { hasVisibleTranslation } from "../shared/display-translation-chain";
import { classifyTranslationError } from "../shared/translation-retry";
import { useTranslate } from "./i18n";
import { useRetryNonce, useReconnectAutoRetry, useStreamingTranslation } from "./streaming-translation";

/**
 * Renders one user prompt. The canonical row keeps the user's original
 * language; this view defaults to that text as plain (not Markdown — user
 * prompts are not assistant prose). A Show translation button starts a
 * user-to-agent display job on demand so session-open fan-out does not
 * re-bill every prompt. The job uses the same slash-command remainder split
 * as the fail-closed prompt path, so a cache-hot turn is a cache hit.
 *
 * Subagent timelines, foreign providers, matching language pairs, and
 * Translate prompts off keep the original with no button. Failures leave
 * the original visible.
 */
export function TranslatedUserMessage(props: PluginTimelineItemProps<TranslatedUserMessageData>) {
  const data = props.item.data;
  const provider = useAgent(props.agentId, (agent) => agent.provider);
  const parentAgentId = useAgent(props.agentId, (agent) => agent.parentAgentId);
  const settings = useSettings(translateSettings);
  const { t } = useTranslate(
    settings.status === "ready" ? settings.values.uiLanguage : "system",
  );
  const [requested, setRequested] = useState(false);
  const [showOriginal, setShowOriginal] = useState(true);
  const { retryNonce, retry } = useRetryNonce();
  const requestTranslation = useCallback(() => {
    setRequested(true);
    setShowOriginal(false);
  }, []);
  const toggleOriginal = useCallback(() => {
    setShowOriginal((value) => !value);
  }, []);
  const retryTranslation = useCallback(() => {
    setShowOriginal(false);
    retry();
  }, [retry]);

  const languagePair =
    settings.status === "ready"
      ? `${settings.values.userLanguage}>${settings.values.agentLanguage}`
      : null;
  const ownedByTranslateProvider =
    provider !== null && (TRANSLATE_PROVIDER_IDS as readonly string[]).includes(provider);
  const eligible = isUserPromptTranslationEligible({
    text: data.text,
    translatePrompts: settings.status === "ready" && settings.values.translatePrompts,
    ownedByTranslateProvider,
    isRootAgent: parentAgentId === null,
    userLanguage: settings.status === "ready" ? settings.values.userLanguage : null,
    agentLanguage: settings.status === "ready" ? settings.values.agentLanguage : null,
  });
  const parts = promptTranslationParts(data.text);

  const stream = useStreamingTranslation({
    enabled: eligible && requested,
    text: parts?.body ?? data.text,
    direction: "user-to-agent",
    languagePair,
    sessionKey: props.agentId,
    translationTimeoutMs:
      settings.status === "ready" ? settings.values.translationTimeoutMs : undefined,
    emptyResultMessage: t("emptyTranslation"),
    retryNonce,
  });

  const autoRetryable =
    stream.error !== undefined && classifyTranslationError(stream.error) !== "fatal";
  const attemptRunning = eligible && requested && !stream.done && stream.error === undefined;
  useReconnectAutoRetry({ attemptRunning, autoRetryable, onRetry: retry });

  const styles = useMemo(
    () => ({
      muted: { color: props.theme.colors.foregroundMuted },
      toggle: { color: props.theme.colors.accent, marginTop: 4, paddingVertical: 2 },
      body: { color: props.theme.colors.foreground },
    }),
    [props.theme],
  );

  const translatedText =
    parts !== null && hasVisibleTranslation(stream.text)
      ? `${parts.prefix}${stream.text}`
      : data.text;
  const showTranslation = hasVisibleTranslation(stream.text) && !showOriginal;

  if (!eligible) {
    return (
      <Text selectable style={styles.body}>
        {data.text}
      </Text>
    );
  }

  return (
    <>
      <Text selectable style={styles.body}>
        {showTranslation ? translatedText : data.text}
      </Text>
      {requested && !hasVisibleTranslation(stream.text) && stream.error === undefined && !stream.done ? (
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
      {!requested ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("showTranslation")}
          onPress={requestTranslation}
        >
          <Text style={styles.toggle}>{t("showTranslation")}</Text>
        </Pressable>
      ) : null}
    </>
  );
}
