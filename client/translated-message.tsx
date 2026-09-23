import { useCallback, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import Markdown from "react-native-markdown-display";
import { useQuery } from "@tanstack/react-query";
import {
  useAgent,
  useRpc,
  useSettings,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import {
  TRANSLATE_PROVIDER_IDS,
  translateSettings,
  translateTextRpc,
  type TranslatedMessageData,
} from "../shared/translate";

/**
 * Renders one assistant message. While the turn streams, the agent's original
 * text is shown untouched. Once the phase is `complete`, the plugin item is
 * re-rendered with the full text and translation starts; the canonical row
 * always keeps the original, so this stays a display-only projection.
 */
export function TranslatedMessage(props: PluginTimelineItemProps<TranslatedMessageData>) {
  const data = props.item.data;
  const provider = useAgent(props.agentId, (agent) => agent.provider);
  const settings = useSettings(translateSettings);
  const translate = useRpc(translateTextRpc);
  const [showOriginal, setShowOriginal] = useState(false);
  const toggleOriginal = useCallback(() => {
    setShowOriginal((value) => !value);
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

  const query = useQuery({
    // The language pair is part of the key: editing settings retranslates
    // instead of showing stale results from the previous pair.
    queryKey: ["translate", "agent-to-user", languagePair, data.text],
    queryFn: () => translate({ text: data.text, direction: "agent-to-user" }),
    enabled: eligible,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const styles = useMemo(
    () => ({
      muted: { color: props.theme.colors.foregroundMuted },
      toggle: { color: props.theme.colors.accent, marginTop: 4, paddingVertical: 2 },
      markdown: {
        body: { color: props.theme.colors.foreground },
        link: { color: props.theme.colors.accent },
      },
    }),
    [props.theme],
  );

  const renderMarkdown = useCallback(
    (text: string) => <Markdown style={styles.markdown}>{text}</Markdown>,
    [styles.markdown],
  );

  if (!eligible) {
    return renderMarkdown(data.text);
  }

  const translated = query.data?.text;
  const showTranslation = translated !== undefined && !showOriginal;
  return (
    <>
      {renderMarkdown(showTranslation ? (translated as string) : data.text)}
      {query.isPending ? <Text style={styles.muted}>Translating…</Text> : null}
      {query.isError ? (
        <Text style={styles.muted} accessibilityRole="alert">
          Translation unavailable: {query.error instanceof Error ? query.error.message : "failed"}
        </Text>
      ) : null}
      {translated !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showTranslation ? "Show original text" : "Show translation"}
          onPress={toggleOriginal}
        >
          <Text style={styles.toggle}>
            {showTranslation ? "Show original" : "Show translation"}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}
