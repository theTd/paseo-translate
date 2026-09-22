import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Provider id registered by this plugin's server entry. */
export const TRANSLATE_PROVIDER_ID = "translate-acp";
export const TRANSLATE_PROVIDER_LABEL = "Translate (ACP)";

/** Timeline plugin item kind produced by the client transformer. */
export const TRANSLATED_MESSAGE_KIND = "translated-message";
export const TRANSLATED_MESSAGE_VERSION = 1;

/** Hard cap on translated text so one giant message cannot stall a prompt turn. */
export const TRANSLATION_TEXT_LIMIT = 100_000;
export const TRANSLATION_CACHE_CAPACITY = 500;

export const translateDirectionSchema = z.enum(["user-to-agent", "agent-to-user"]);
export type TranslateDirection = z.output<typeof translateDirectionSchema>;

/**
 * Settings live on the host and survive plugin reloads. Every field has a
 * default so a fresh install parses as `ready` and the settings form opens;
 * `assertConfigured` enforces the fail-closed contract at use time instead
 * (an unset endpoint or inner agent command fails the provider connect with a
 * clear error rather than forwarding untranslated text).
 */
export const translateSettings = defineSettings({
  id: "translate",
  scope: "host",
  version: 1,
  schema: z.object({
    endpointBaseUrl: z.string().trim().default(""),
    endpointApiKey: z.string().default(""),
    endpointModel: z.string().trim().default(""),
    userLanguage: z.string().trim().min(1).default("en"),
    agentLanguage: z.string().trim().min(1).default("de"),
    innerAgentCommand: z.array(z.string().trim().min(1)).default([]),
    innerAgentEnv: z.record(z.string(), z.string()).default({}),
    translatePrompts: z.boolean().default(true),
    translateResponses: z.boolean().default(true),
    translateAllTimelines: z.boolean().default(false),
    translationTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  }),
});

export type TranslateSettingsValues = z.output<typeof translateSettings.schema>;

/** Throws a user-actionable error when required settings have not been filled in. */
export function assertConfigured(values: TranslateSettingsValues): void {
  const missing: string[] = [];
  if (values.endpointBaseUrl.length === 0) missing.push("endpoint base URL");
  if (values.endpointModel.length === 0) missing.push("endpoint model");
  if (values.innerAgentCommand.length === 0) missing.push("inner agent command");
  if (missing.length > 0) {
    throw new Error(
      `Translate plugin is not configured yet (missing ${missing.join(", ")}). Open the Translate settings screen before creating agents.`,
    );
  }
}

export const translateTextRpc = defineRpc({
  name: "translate.text",
  input: z.object({
    text: z.string().min(1),
    direction: translateDirectionSchema,
  }),
  output: z.object({
    text: z.string(),
  }),
});

/** Data shape the client transformer emits and the renderer validates. */
export const translatedMessageDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
  messageId: z.string().nullable(),
});
export type TranslatedMessageData = z.output<typeof translatedMessageDataSchema>;

export interface LanguagePair {
  source: string;
  target: string;
}

export function resolveLanguagePair(
  values: TranslateSettingsValues,
  direction: TranslateDirection,
): LanguagePair {
  return direction === "user-to-agent"
    ? { source: values.userLanguage, target: values.agentLanguage }
    : { source: values.agentLanguage, target: values.userLanguage };
}

export function translationSystemPrompt(pair: LanguagePair): string {
  return [
    "You are a translation engine.",
    `Translate the user's text faithfully from ${pair.source} to ${pair.target}.`,
    "Preserve Markdown structure, code blocks, inline code, URLs, and command syntax exactly as given.",
    "Output ONLY the translation, with no preamble, quotes, or explanations.",
  ].join(" ");
}
