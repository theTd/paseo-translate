import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import { TRANSLATED_MESSAGE_KIND, TRANSLATED_MESSAGE_VERSION } from "../shared/translate";

/**
 * Passthrough mapping from a canonical assistant message to the plugin item
 * the renderer owns. The canonical row keeps the agent's original text; only
 * the rendered projection can show a translation.
 */
export function transformAssistantMessage(input: {
  item: { text: string; messageId?: string };
  phase: "streaming" | "complete";
}): PluginTimelineTransformResult {
  return {
    items: [
      {
        type: "plugin",
        kind: TRANSLATED_MESSAGE_KIND,
        version: TRANSLATED_MESSAGE_VERSION,
        data: {
          text: input.item.text,
          phase: input.phase,
          messageId: input.item.messageId ?? null,
        },
      },
    ],
  };
}
