import type { ProviderMode } from "@getpaseo/plugin/server/provider";

const MODES: ProviderMode[] = [
  { id: "plan", label: "Plan Mode", description: "Analyze the codebase without executing tools or edits" },
  { id: "default", label: "Always Ask", description: "Prompts for permission the first time a tool is used" },
  { id: "acceptEdits", label: "Accept File Edits", description: "Automatically approves edit-focused tools without prompting" },
  { id: "auto", label: "Auto mode", description: "Uses a model classifier to review permission prompts automatically" },
  { id: "bypassPermissions", label: "Bypass", description: "Skip all permission prompts (use with caution)" },
];

function unavailableTransport(env: NodeJS.ProcessEnv): string | undefined {
  const enabled = (value: string | undefined) => value !== undefined &&
    !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
  if (enabled(env.CLAUDE_CODE_USE_BEDROCK)) return "Bedrock";
  if (enabled(env.CLAUDE_CODE_USE_VERTEX)) return "Vertex";
  return undefined;
}

export function claudeModeCatalog(env: NodeJS.ProcessEnv) {
  const unavailable = unavailableTransport(env);
  return { modes: unavailable ? MODES.filter((mode) => mode.id !== "auto") : MODES,
    defaultMode: unavailable ? "default" : "auto" };
}

export function assertClaudeMode(mode: string, env: NodeJS.ProcessEnv): void {
  if (!MODES.some((entry) => entry.id === mode)) throw new Error(`Unknown Claude mode: ${mode}`);
  const transport = unavailableTransport(env);
  if (mode === "auto" && transport) {
    throw new Error(`Claude Auto mode requires the Anthropic API and is not supported with ${transport}. Select another permission mode.`);
  }
}

export function isClaudeMode(mode: string): boolean { return MODES.some((entry) => entry.id === mode); }
