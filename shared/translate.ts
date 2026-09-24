import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Provider id registered by this plugin's server entry. */
export const TRANSLATE_PROVIDER_ID = "translate-acp";
export const TRANSLATE_PROVIDER_LABEL = "Translate (ACP)";

/** Direct Claude Code provider (claude-agent-sdk stream-json, no ACP layer). */
export const TRANSLATE_CLAUDE_PROVIDER_ID = "translate-claude";
export const TRANSLATE_CLAUDE_PROVIDER_LABEL = "Translate (Claude Code)";

/** Direct Codex provider (codex app-server JSON-RPC, no ACP layer). */
export const TRANSLATE_CODEX_PROVIDER_ID = "translate-codex";
export const TRANSLATE_CODEX_PROVIDER_LABEL = "Translate (Codex)";

/** Provider ids owned by this plugin; the timeline renderer gates on these. */
export const TRANSLATE_PROVIDER_IDS = [
  TRANSLATE_PROVIDER_ID,
  TRANSLATE_CLAUDE_PROVIDER_ID,
  TRANSLATE_CODEX_PROVIDER_ID,
] as const;

/** Timeline plugin item kind produced by the client transformer. */
export const TRANSLATED_MESSAGE_KIND = "translated-message";
export const TRANSLATED_MESSAGE_VERSION = 1;

/**
 * Timeline plugin item kind for translated reasoning (thinking) blocks.
 * Separate from the assistant-message kind so the renderer can keep the
 * muted reasoning look instead of styling thoughts as replies. Same data
 * shape, same translation RPCs — only the presentation differs.
 */
export const TRANSLATED_REASONING_KIND = "translated-reasoning";
export const TRANSLATED_REASONING_VERSION = 1;

/** Hard cap on translated text so one giant message cannot stall a prompt turn. */
export const TRANSLATION_TEXT_LIMIT = 100_000;
/**
 * Cache capacity shared by the in-memory image and the persisted JSONL file
 * (entries, not bytes — a translation is at most TRANSLATION_TEXT_LIMIT
 * chars). Large enough that reopening old sessions is served entirely from
 * cache; the file is compacted back to this bound on load, and mid-session
 * once appends far exceed it.
 */
export const TRANSLATION_CACHE_CAPACITY = 10_000;

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
    /**
     * Reasoning effort sent with each translation request (OpenAI-compatible).
     * "default" omits the parameter; "none" sends reasoning_effort "none" to
     * turn thinking off where the endpoint supports it.
     */
    translationReasoningEffort: z
      .enum(["default", "none", "minimal", "low", "medium", "high"])
      .default("default"),
    /**
     * Custom system prompt for the translation model; empty string uses the
     * built-in default. `{source}` and `{target}` placeholders resolve per
     * request (see resolveTranslationSystemPrompt).
     */
    translationSystemPrompt: z.string().default(""),
    userLanguage: z.string().trim().min(1).default("en"),
    agentLanguage: z.string().trim().min(1).default("de"),
    innerAgentCommand: z.array(z.string().trim().min(1)).default([]),
    innerAgentEnv: z.record(z.string(), z.string()).default({}),
    /** Optional Claude Code executable path for the direct provider (Windows .cmd escape hatch). */
    claudeExecutablePath: z.string().trim().default(""),
    /** Optional Codex CLI executable path for the direct provider (Windows .cmd escape hatch). */
    codexExecutablePath: z.string().trim().default(""),
    translatePrompts: z.boolean().default(true),
    translateResponses: z.boolean().default(true),
    translateAllTimelines: z.boolean().default(false),
    /**
     * Translate reasoning (thinking) blocks for display, like replies.
     * Off by default: thinking blocks are often long, so translating them
     * doubles endpoint spend on auxiliary text. Requires `translateResponses`
     * (the server display path shares that gate).
     */
    translateReasoning: z.boolean().default(false),
    translationTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
    /**
     * Language of this plugin's own client screens and hints. "system"
     * follows the device locale via Intl (the host does not expose its app
     * language to plugins); any other value pins one of the host's locales.
     */
    uiLanguage: z
      .enum(["system", "ar", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"])
      .default("system"),
  }),
});

export type TranslateSettingsValues = z.output<typeof translateSettings.schema>;

/** Throws a user-actionable error when required settings have not been filled in. */
export function assertConfigured(values: TranslateSettingsValues): void {
  const missing: string[] = [];
  if (values.endpointBaseUrl.length === 0) missing.push("endpoint base URL");
  if (values.endpointModel.length === 0) missing.push("endpoint model");
  if (missing.length > 0) {
    throw new Error(
      `Translate plugin is not configured yet (missing ${missing.join(", ")}). Open the Translate settings screen before creating agents.`,
    );
  }
}

/** The ACP provider additionally needs its inner agent command. */
export function assertAcpConfigured(values: TranslateSettingsValues): void {
  if (values.innerAgentCommand.length === 0) {
    throw new Error(
      "Translate (ACP) needs an inner agent command. Pick a daemon provider or enter one in the Translate settings screen.",
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

/**
 * Streaming translation jobs. The client opens a job, polls it for partial
 * text, and renders each poll. RPC is unary, so progress travels as repeated
 * `poll` reads of the server's accumulated stream — never as pushed chunks.
 * Any unknown job (evicted, or lost to a daemon restart) reads as an error
 * so the client falls back to the unary `translate.text` call.
 */
export const translateStreamStartRpc = defineRpc({
  name: "translate.stream.start",
  input: z.object({
    text: z.string().min(1),
    direction: translateDirectionSchema,
  }),
  output: z.object({
    jobId: z.string(),
  }),
});

export const translateStreamPollRpc = defineRpc({
  name: "translate.stream.poll",
  input: z.object({
    jobId: z.string().min(1),
  }),
  output: z.object({
    text: z.string(),
    done: z.boolean(),
  }),
});

/**
 * Launch commands of agent CLIs with a verified ACP stdio mode. A CLI's ACP
 * capability is independent of how Paseo's built-in provider talks to it
 * (e.g. omp/opencode are integrated through their native RPC but also ship
 * `acp` subcommands). The protocol snapshot deliberately does not expose
 * custom providers' configured commands; those resolve through the config
 * face, everything else falls back to manual entry.
 */
export const KNOWN_ACP_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  copilot: ["copilot", "--acp"],
  cursor: ["cursor-agent", "acp"],
  omp: ["omp", "acp"],
  opencode: ["opencode", "acp"],
};

/**
 * Adapter presets for agent CLIs without a native ACP mode. `npx` shims are
 * `.cmd` scripts on Windows and cannot be spawned without a shell, so the
 * Windows variant routes through `cmd /c`.
 */
export const ACP_ADAPTER_PRESETS: readonly {
  id: string;
  label: string;
  command: readonly string[];
  windowsCommand: readonly string[];
}[] = [
  {
    id: "adapter:claude-code",
    label: "Claude Code (ACP adapter)",
    command: ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.31.4"],
    windowsCommand: ["cmd", "/c", "npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.31.4"],
  },
  {
    id: "adapter:codex",
    label: "Codex (ACP adapter)",
    command: ["npx", "--yes", "@zed-industries/codex-acp@0.12.0"],
    windowsCommand: ["cmd", "/c", "npx", "--yes", "@zed-industries/codex-acp@0.12.0"],
  },
];

export function adapterCommand(
  preset: (typeof ACP_ADAPTER_PRESETS)[number],
  platform: NodeJS.Platform,
): readonly string[] {
  return platform === "win32" ? preset.windowsCommand : preset.command;
}

export function knownAcpCommand(providerId: string): readonly string[] | null {
  // Object.hasOwn guards prototype keys like "__proto__" from leaking
  // Object.prototype through the record lookup.
  return Object.hasOwn(KNOWN_ACP_COMMANDS, providerId) ? KNOWN_ACP_COMMANDS[providerId] : null;
}

export const translateProvidersRpc = defineRpc({
  name: "translate.providers.list",
  input: z.object({}),
  output: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        status: z.enum(["ready", "loading", "error", "unavailable"]),
        /** Resolved ACP launch command, or null for manual entry. */
        command: z.array(z.string()).nullable(),
        /**
         * How the ACP capability was determined: verified command, adapter
         * preset, or unknown (the CLI may still ship an ACP mode the picker
         * cannot know about — manual entry applies).
         */
        acp: z.enum(["known", "adapter", "unknown"]),
      }),
    ),
  }),
});
export type TranslateProviderOption = z.output<
  typeof translateProvidersRpc.output
>["providers"][number];

/** Data shape the client transformer emits and the renderer validates. */
export const translatedMessageDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
  messageId: z.string().nullable(),
});
export type TranslatedMessageData = z.output<typeof translatedMessageDataSchema>;

/**
 * Data shape for translated reasoning items. Identical to the message shape
 * (reasoning items carry no messageId, so it stays null); kept as a separate
 * schema so the two kinds can evolve independently.
 */
export const translatedReasoningDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
  messageId: z.string().nullable(),
});
export type TranslatedReasoningData = z.output<typeof translatedReasoningDataSchema>;

/**
 * Matches one Markdown image whose target is a data URI
 * (`![alt](data:<mime>;base64,<payload>)`). Base64 has no `)` in its
 * alphabet, so the first `)` always ends the target.
 */
const DATA_URI_IMAGE_PATTERN = /!\[[^\]]*\]\(data:[^)]*\)/g;

/**
 * True when a timeline text carries nothing translatable beyond embedded
 * data-URI images (tool screenshots persisted before the provider stopped
 * emitting base64, or foreign providers' equivalents). Sending such texts to
 * the translation endpoint burns quota on base64 soup while the translated
 * Markdown view cannot render images anyway, so the renderer keeps the
 * original instead. Pure for unit tests. Mixed text-plus-image stays
 * eligible (fail open, matching previous behavior).
 */
export function isDataUriImageOnlyText(text: string): boolean {
  if (text.trim().length === 0) return false;
  return text.replace(DATA_URI_IMAGE_PATTERN, "").trim().length === 0;
}

/**
 * Recognizes markdown rendered for a materialized provider image, mirroring
 * the daemon's own recognizer (`isProviderImageMarkdown`): the source is a
 * content-hashed file in a `paseo-attachments[-*]` dir. Matching the full
 * `<64-hex>.<ext>` shape (not just a leading `![`) keeps user-authored
 * image markdown and remote URLs translatable. The host app renders these
 * natively (preview, lightbox), so the timeline transformer passes them
 * through untouched instead of replacing them with the translated view.
 */
const PROVIDER_IMAGE_MARKDOWN_PATTERN =
  /^!\[[^\]]*\]\([^)]*paseo-attachments(?:-[^/\\\)]+)?[/\\]+(?:[^/\\\)]+[/\\]+)?[0-9a-f]{64}\.[a-z0-9]+\)/;

export function isProviderImageMarkdown(text: string): boolean {
  return PROVIDER_IMAGE_MARKDOWN_PATTERN.test(text);
}

/**
 * Display eligibility for one reasoning block. Pure so the gating matrix is
 * unit-testable: only `complete` blocks translate (streaming shows the
 * original), empty texts would fail the RPC's min(1) contract, the pair is
 * null before settings load, `translateReasoning` is the opt-in switch
 * (default off) ANDed with the shared `translateResponses` display gate,
 * and the provider scope matches replies (own provider or all timelines).
 */
export function isReasoningTranslationEligible(input: {
  phase: "streaming" | "complete";
  textLength: number;
  languagePair: string | null;
  translateReasoning: boolean;
  translateResponses: boolean;
  ownedByTranslateProvider: boolean;
  translateAllTimelines: boolean;
}): boolean {
  return (
    input.phase === "complete" &&
    input.textLength > 0 &&
    input.languagePair !== null &&
    input.translateReasoning &&
    input.translateResponses &&
    (input.ownedByTranslateProvider || input.translateAllTimelines)
  );
}

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

/**
 * Effective system prompt for translation requests: the custom template when
 * set, otherwise the built-in default. `{source}` and `{target}` in a custom
 * template resolve to the current language pair, so one template serves both
 * directions (user→agent and agent→user flip the pair).
 */
export function resolveTranslationSystemPrompt(template: string, pair: LanguagePair): string {
  const custom = template.trim();
  if (custom.length === 0) return translationSystemPrompt(pair);
  return custom.replaceAll("{source}", pair.source).replaceAll("{target}", pair.target);
}
