import { useCallback, useEffect, useMemo, useState } from "react";
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

/** Delay between stream polls; each poll is a cheap in-memory read. */
const STREAM_POLL_INTERVAL_MS = 200;

interface StreamingTranslation {
  /** Latest translated text (partial while streaming); undefined until first bytes. */
  text: string | undefined;
  done: boolean;
  error: unknown;
}

/**
 * Stream-first translation with unary fallback. Opens a server stream job
 * and polls it for partial text; any job failure (evicted job, daemon
 * restart mid-stream, old daemon without the stream RPCs) falls back to the
 * single `translate.text` call, whose own failure surfaces as an error hint.
 */
function useStreamingTranslation(input: {
  enabled: boolean;
  text: string;
  languagePair: string | null;
}): StreamingTranslation {
  const startStream = useRpc(translateStreamStartRpc);
  const pollStream = useRpc(translateStreamPollRpc);
  const translate = useRpc(translateTextRpc);
  const [partial, setPartial] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    if (!input.enabled || input.languagePair === null) {
      setPartial(undefined);
      setDone(false);
      setError(undefined);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setPartial(undefined);
    setDone(false);
    setError(undefined);

    async function fallbackUnary(): Promise<void> {
      try {
        const result = await translate({ text: input.text, direction: "agent-to-user" });
        if (cancelled) return;
        setPartial(result.text);
        setDone(true);
      } catch (fallbackError) {
        if (!cancelled) setError(fallbackError);
      }
    }

    async function poll(jobId: string): Promise<void> {
      if (cancelled) return;
      let result: { text: string; done: boolean };
      try {
        result = await pollStream({ jobId });
      } catch {
        // Unknown job (evicted, daemon restarted): re-translate unary,
        // which is cache-hot for a job that already finished server-side.
        await fallbackUnary();
        return;
      }
      if (cancelled) return;
      setPartial(result.text);
      if (result.done) {
        setDone(true);
        return;
      }
      timer = setTimeout(() => void poll(jobId), STREAM_POLL_INTERVAL_MS);
    }

    async function start(): Promise<void> {
      let jobId: string;
      try {
        ({ jobId } = await startStream({ text: input.text, direction: "agent-to-user" }));
      } catch {
        await fallbackUnary();
        return;
      }
      await poll(jobId);
    }

    void start();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // The language pair is a dependency: editing settings retranslates
    // instead of showing stale results from the previous pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.enabled, input.text, input.languagePair]);

  return { text: partial, done, error };
}

/**
 * Renders one assistant message. While the turn streams, the agent's original
 * text is shown untouched. Once the phase is `complete`, the plugin item is
 * re-rendered with the full text and a streaming translation starts,
 * rendering progressively; the canonical row always keeps the original, so
 * this stays a display-only projection.
 */
export function TranslatedMessage(props: PluginTimelineItemProps<TranslatedMessageData>) {
  const data = props.item.data;
  const provider = useAgent(props.agentId, (agent) => agent.provider);
  const settings = useSettings(translateSettings);
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

  const stream = useStreamingTranslation({ enabled: eligible, text: data.text, languagePair });

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

  const showTranslation = stream.text !== undefined && !showOriginal;
  return (
    <>
      {renderMarkdown(showTranslation ? (stream.text as string) : data.text)}
      {stream.text === undefined && stream.error === undefined ? (
        <Text style={styles.muted}>Translating…</Text>
      ) : null}
      {stream.error !== undefined ? (
        <Text style={styles.muted} accessibilityRole="alert">
          Translation unavailable: {stream.error instanceof Error ? stream.error.message : "failed"}
        </Text>
      ) : null}
      {stream.done && stream.text !== undefined ? (
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
