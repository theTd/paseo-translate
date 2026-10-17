import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderModel } from "@getpaseo/plugin/server/provider";
import { CLAUDE_MODEL_MANIFEST, findClaudeModel } from "./claude-model-manifest";
import { resolveClaudeConfigDir } from "./claude-project-dir";

const MODEL_ENV_KEYS = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];

/** Discovery supplements the curated catalog; failure must not erase model choices. */
export async function completeClaudeCatalog(discovered: ProviderModel[], configDir = resolveClaudeConfigDir(), version?: string): Promise<ProviderModel[]> {
  const observed = new Set(discovered.map((model) => findClaudeModel(model.id)?.id ?? model.id));
  const models = new Map<string, ProviderModel>();
  models.set("default", { id: "default", label: "Claude (CLI default)", isDefault: true });
  for (const entry of CLAUDE_MODEL_MANIFEST) {
    if (version && entry.minimumClaudeCodeVersion && !supportsVersion(version, entry.minimumClaudeCodeVersion)) continue;
    if (entry.requiresDiscovery && !observed.has(entry.id)) continue;
    const levels = entry.effortLevels;
    const defaultThinkingOptionId = levels ? entry.defaultThinkingOption ?? "high" : undefined;
    const thinkingOptions = levels ? [
      ...(entry.supportsThinkingDisabled ? [{ id: "off", label: "Off" }] : []),
      ...levels.map((id) => ({ id, label: id === "xhigh" ? "Extra high" : id[0].toUpperCase() + id.slice(1),
        ...(id === defaultThinkingOptionId ? { isDefault: true } : {}) })),
      ...(levels.includes("xhigh") ? [{ id: "ultracode", label: "Ultra Code" }] : []),
    ] : undefined;
    models.set(entry.id, { id: entry.id, label: entry.label, description: entry.description,
      aliases: entry.aliases ? [...entry.aliases] : undefined,
      contextWindowMaxTokens: entry.contextWindowMaxTokens, thinkingOptions, defaultThinkingOptionId });
  }
  for (const model of discovered) {
    const known = findClaudeModel(model.id);
    if (version && known?.minimumClaudeCodeVersion && !supportsVersion(version, known.minimumClaudeCodeVersion)) continue;
    const curated = models.get(model.id) ?? (known ? models.get(known.id) : undefined);
    models.set(model.id, { ...curated, ...model, ...(curated?.thinkingOptions ? {
      thinkingOptions: curated.thinkingOptions, defaultThinkingOptionId: curated.defaultThinkingOptionId,
    } : {}) });
  }
  let settings: { model?: unknown; env?: Record<string, unknown> } | undefined;
  try { settings = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")); }
  catch { /* An absent or malformed settings file leaves the curated catalog available. */ }
  const configured = [settings?.model, ...MODEL_ENV_KEYS.map((key) => settings?.env?.[key])];
  for (const value of configured) {
    if (typeof value !== "string" || !value.trim() || models.has(value.trim())) continue;
    const id = value.trim();
    models.set(id, { id, label: id, description: "From Claude settings.json" });
  }
  return [...models.values()];
}

function supportsVersion(version: string, minimum: string): boolean {
  const parsed = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version);
  if (!parsed) return false;
  const actual = parsed.slice(1).map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}
