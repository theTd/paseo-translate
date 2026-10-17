/** Curated capabilities and availability rules aligned with Paseo 0.11.2. */
type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeManifestModel {
  id: string;
  aliases?: readonly string[];
  label: string;
  description: string;
  minimumClaudeCodeVersion?: string;
  requiresDiscovery?: boolean;
  contextWindowMaxTokens?: number;
  effortLevels?: readonly ClaudeEffortLevel[];
  defaultThinkingOption?: ClaudeEffortLevel;
  supportsThinkingDisabled?: boolean;
  supportsFastMode?: boolean;
}

const CLAUDE_EFFORT_LEVELS = {
  standard: ["low", "medium", "high", "max"],
  xhigh: ["low", "medium", "high", "xhigh", "max"],
} as const satisfies Record<string, readonly ClaudeEffortLevel[]>;

export const CLAUDE_MODEL_MANIFEST: readonly ClaudeManifestModel[] = [
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    description: "Opus 5.5 · Latest release",
    minimumClaudeCodeVersion: "2.1.280",
    defaultThinkingOption: "medium",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    description: "Opus 5 · Previous release",
    minimumClaudeCodeVersion: "2.1.219",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-mythos-5-1",
    label: "Mythos 5.1",
    requiresDiscovery: true,
    description: "Mythos 5.1 · Requires verified access",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
  },
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    description: "Fable 5.1 · Most powerful model",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
  },
  {
    id: "claude-fable-5",
    aliases: ["claude-fable-5[1m]"],
    label: "Fable 5",
    description: "Fable 5 · Previous release",
    minimumClaudeCodeVersion: "2.1.169",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
  },
  {
    id: "claude-opus-4-8[1m]",
    label: "Opus 4.8 1M",
    description: "Opus 4.8 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "Opus 4.8 · Previous release",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    description: "Sonnet 5.5 · Best for everyday tasks",
    minimumClaudeCodeVersion: "2.1.284",
    defaultThinkingOption: "medium",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    description: "Sonnet 5 · Previous release",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-sonnet-5[1m]",
    label: "Sonnet 5 1M",
    description: "Sonnet 5 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 1M",
    description: "Opus 4.7 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Opus 4.7 · Previous release",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-6[1m]",
    label: "Opus 4.6 1M",
    description: "Opus 4.6 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    description: "Opus 4.6 · Most capable for complex work",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-sonnet-4-6[1m]",
    label: "Sonnet 4.6 1M",
    description: "Sonnet 4.6 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Sonnet 4.6 · Best for everyday tasks",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    description: "Haiku 5.5 · Fastest for quick answers",
    minimumClaudeCodeVersion: "2.1.293",
    defaultThinkingOption: "medium",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Haiku 4.5 · Previous release",
    contextWindowMaxTokens: 200_000,
  },
];

/** Matches a manifest row by id/alias; a trailing -YYYYMMDD date is stripped. */
export function findClaudeModel(modelId: string | null | undefined): ClaudeManifestModel | null {
  if (typeof modelId !== "string" || modelId.trim().length === 0) return null;
  const normalized = modelId.trim();
  for (const model of CLAUDE_MODEL_MANIFEST) {
    if (model.id === normalized) return model;
    if (model.aliases?.includes(normalized) === true) return model;
  }
  const withoutDate = /^(\S+)-\d{8}$/.exec(normalized);
  if (withoutDate !== null) return findClaudeModel(withoutDate[1]);
  return null;
}

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return findClaudeModel(modelId)?.supportsFastMode === true;
}