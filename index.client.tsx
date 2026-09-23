import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TranslatedMessage } from "./client/translated-message";
import { transformAssistantMessage } from "./client/transformer";
import { TranslateSettingsScreen } from "./client/settings-screen";
import { detectSystemLocale, translate } from "./client/i18n";
import {
  TRANSLATED_MESSAGE_KIND,
  TRANSLATED_MESSAGE_VERSION,
  translatedMessageDataSchema,
} from "./shared/translate";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "translate-assistant",
    query: { itemType: "assistant_message" },
    transform: transformAssistantMessage,
  });
  client.addTimelineRenderer({
    kind: TRANSLATED_MESSAGE_KIND,
    version: TRANSLATED_MESSAGE_VERSION,
    schema: translatedMessageDataSchema,
    Component: TranslatedMessage,
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
