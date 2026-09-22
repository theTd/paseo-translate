import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TranslatedMessage } from "./client/translated-message";
import { transformAssistantMessage } from "./client/transformer";
import { TranslateSettingsScreen } from "./client/settings-screen";
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
    title: "Translate",
    icon: "Languages",
    Component: TranslateSettingsScreen,
  });
  return () => {};
}
