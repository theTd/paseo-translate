import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import {
  isProviderImageMarkdown,
  TRANSLATED_MESSAGE_KIND,
  TRANSLATED_MESSAGE_VERSION,
  TRANSLATED_REASONING_KIND,
  TRANSLATED_REASONING_VERSION,
} from "../shared/translate";

/**
 * Passthrough mapping from a canonical assistant message to the plugin item
 * the renderer owns. The canonical row keeps the agent's original text; only
 * the rendered projection can show a translation.
 *
 * Materialized provider images (`![Image](file://…paseo-attachments…/…)`)
 * return undefined so the host renders them natively with its image
 * pipeline: the translated Markdown view has no image support, and there is
 * no prose worth translating in a lone image reference.
 */
export function transformAssistantMessage(input: {
  item: { text: string; messageId?: string };
  phase: "streaming" | "complete";
}): PluginTimelineTransformResult | undefined {
  if (isProviderImageMarkdown(input.item.text)) return undefined;
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

/**
 * Same passthrough for a canonical reasoning (thinking) block. Reasoning
 * items carry no messageId; the emitted kind stays separate from assistant
 * messages so the renderer can keep the muted reasoning presentation.
 */
export function transformReasoningMessage(input: {
  item: { text: string };
  phase: "streaming" | "complete";
}): PluginTimelineTransformResult {
  return {
    items: [
      {
        type: "plugin",
        kind: TRANSLATED_REASONING_KIND,
        version: TRANSLATED_REASONING_VERSION,
        data: {
          text: input.item.text,
          phase: input.phase,
          messageId: null,
        },
      },
    ],
  };
}
