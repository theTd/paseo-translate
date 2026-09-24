/**
 * Static manifest of known Claude models, mirroring the host app's claude
 * model manifest (packages/server/.../claude/model-manifest.ts). The SDK's
 * `supportedModels()` probe does not expose context windows or fast-mode
 * support, so the ring denominator and the Fast toggle consult this table.
 * Older CLIs that list models absent from this table simply get no initial
 * denominator until the first `modelUsage` arrives.
 */
export interface ClaudeManifestModel {
  id: string;
  aliases?: readonly string[];
  label: string;
  description: string;
  contextWindowMaxTokens?: number;
  supportsFastMode?: boolean;
}

export const CLAUDE_MODEL_MANIFEST: readonly ClaudeManifestModel[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    description: "Opus 5 · Latest release",
    contextWindowMaxTokens: 1_000_000,
    supportsFastMode: true,
  },
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    description: "Fable 5.1 · Most powerful model",
    contextWindowMaxTokens: 1_000_000,
  },
  {
    id: "claude-fable-5",
    aliases: ["claude-fable-5[1m]"],
    label: "Fable 5",
    description: "Fable 5 · Previous release",
    contextWindowMaxTokens: 1_000_000,
  },
  {
    id: "claude-opus-4-8[1m]",
    label: "Opus 4.8 1M",
    description: "Opus 4.8 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "Opus 4.8 · Previous release",
    contextWindowMaxTokens: 200_000,
    supportsFastMode: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    description: "Sonnet 5 · Best for everyday tasks",
    contextWindowMaxTokens: 200_000,
  },
  {
    id: "claude-sonnet-5[1m]",
    label: "Sonnet 5 1M",
    description: "Sonnet 5 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 1M",
    description: "Opus 4.7 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Opus 4.7 · Previous release",
    contextWindowMaxTokens: 200_000,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-6[1m]",
    label: "Opus 4.6 1M",
    description: "Opus 4.6 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    description: "Opus 4.6 · Most capable for complex work",
    contextWindowMaxTokens: 200_000,
    supportsFastMode: true,
  },
  {
    id: "claude-sonnet-4-6[1m]",
    label: "Sonnet 4.6 1M",
    description: "Sonnet 4.6 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Sonnet 4.6 · Best for everyday tasks",
    contextWindowMaxTokens: 200_000,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Haiku 4.5 · Fastest for quick answers",
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