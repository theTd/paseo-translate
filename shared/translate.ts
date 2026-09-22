import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Provider id registered by this plugin's server entry. */
export const TRANSLATE_PROVIDER_ID = "translate-acp";
export const TRANSLATE_PROVIDER_LABEL = "Translate (ACP)";

/** Direct Claude Code provider (claude-agent-sdk stream-json, no ACP layer). */
export const TRANSLATE_CLAUDE_PROVIDER_ID = "translate-claude";
export const TRANSLATE_CLAUDE_PROVIDER_LABEL = "Translate (Claude Code)";

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
    /** Optional Claude Code executable path for the direct provider (Windows .cmd escape hatch). */
    claudeExecutablePath: z.string().trim().default(""),
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
