import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
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
 * language; both languages render as plain text in a plugin-owned bubble.
 * The job uses the same slash-command remainder split as the fail-closed
 * prompt path, so a cache-hot turn is a cache hit.
 *
 * Subagent timelines, foreign providers, matching language pairs, and
 * Translate prompts off keep the original. Failures leave
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
  const { retryNonce, retry } = useRetryNonce();

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
    enabled: eligible,
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
  const attemptRunning = eligible && !stream.done && stream.error === undefined;
  useReconnectAutoRetry({ attemptRunning, autoRetryable, onRetry: retry });

  const styles = useMemo(
    () => ({
      muted: { color: props.theme.colors.foregroundMuted },
      toggle: { color: props.theme.colors.accent, marginTop: 4, paddingVertical: 2 },
      body: { color: props.theme.colors.foreground },
      row: { alignItems: "flex-end" as const, marginVertical: 8 },
      bubble: {
        maxWidth: "100%" as const,
        minWidth: 0,
        padding: 16,
        borderRadius: 8,
        borderTopRightRadius: 4,
        backgroundColor: props.theme.colors.surface2,
      },
      translation: { color: props.theme.colors.foregroundMuted, marginTop: 8 },
    }),
    [props.theme],
  );

  const translatedText =
    parts !== null && hasVisibleTranslation(stream.text)
      ? `${parts.prefix}${stream.text}`
      : data.text;
  const showTranslation = eligible && hasVisibleTranslation(stream.text) &&
    translatedText.trim() !== data.text.trim();

  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <Text selectable style={styles.body}>
          {data.text}
        </Text>
        {showTranslation ? (
          <Text selectable style={styles.translation}>{translatedText}</Text>
        ) : null}
        {eligible && !hasVisibleTranslation(stream.text) && stream.error === undefined && !stream.done ? (
          <Text style={styles.muted}>{t("translating")}</Text>
        ) : null}
        {eligible && stream.error !== undefined ? (
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
              onPress={retry}
            >
              <Text style={styles.toggle}>{t("retryTranslation")}</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}
