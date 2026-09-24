import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TranslatedMessage } from "./client/translated-message";
import { TranslatedReasoning } from "./client/translated-reasoning";
import { transformAssistantMessage, transformReasoningMessage } from "./client/transformer";
import { TranslateSettingsScreen } from "./client/settings-screen";
import { detectSystemLocale, translate } from "./client/i18n";
import {
  TRANSLATED_MESSAGE_KIND,
  TRANSLATED_MESSAGE_VERSION,
  TRANSLATED_REASONING_KIND,
  TRANSLATED_REASONING_VERSION,
  translatedMessageDataSchema,
  translatedReasoningDataSchema,
} from "./shared/translate";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "translate-assistant",
    query: { itemType: "assistant_message" },
    transform: transformAssistantMessage,
  });
  client.addTimelineTransformer({
    id: "translate-reasoning",
    query: { itemType: "reasoning" },
    transform: transformReasoningMessage,
  });
  client.addTimelineRenderer({
    kind: TRANSLATED_MESSAGE_KIND,
    version: TRANSLATED_MESSAGE_VERSION,
    schema: translatedMessageDataSchema,
    Component: TranslatedMessage,
  });
  client.addTimelineRenderer({
    kind: TRANSLATED_REASONING_KIND,
    version: TRANSLATED_REASONING_VERSION,
    schema: translatedReasoningDataSchema,
    Component: TranslatedReasoning,
  });
  client.addSettingsScreen({
    id: "translate",
    // Registration titles are static snapshots: the host keeps the string
    // as-is, so this reads the device locale once. The screen body itself
    // follows the stored interface-language setting reactively.
    title: translate(detectSystemLocale(), "settingsTitle"),
    icon: "Languages",
    Component: TranslateSettingsScreen,
  });
  return () => {};
}
