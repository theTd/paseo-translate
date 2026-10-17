import type { ProviderModel } from "@getpaseo/plugin/server/provider";
import { isRecord, nonEmptyString, toObjectRecord } from "./codex-items";

export interface CodexServiceTier { id: string; name: string }
export interface CodexCollaborationMode { name: string; mode: string; settings: Record<string, unknown> }

export function codexServiceTiers(models: readonly ProviderModel[], model: string | null): CodexServiceTier[] {
  const selected = models.find((entry) => entry.id === model || entry.metadata?.model === model) ?? models.find((entry) => entry.isDefault);
  const tiers = selected?.metadata?.serviceTiers;
  return Array.isArray(tiers) ? tiers.flatMap((tier) => {
    if (!isRecord(tier) || typeof tier.id !== "string" || typeof tier.name !== "string") return [];
    return [{ id: tier.id, name: tier.name }];
  }) : [];
}

export function codexCollaborationModes(raw: unknown): CodexCollaborationMode[] {
  const data = toObjectRecord(raw)?.data;
  return Array.isArray(data) ? data.flatMap((entry) => {
    if (!isRecord(entry) || !nonEmptyString(entry.name)) return [];
    const settings = isRecord(entry.settings) ? entry.settings : entry;
    return [{ name: String(entry.name), mode: nonEmptyString(entry.mode) ?? (/plan|read/i.test(String(entry.name)) ? "plan" : "default"),
      settings: { ...(typeof settings.model === "string" ? { model: settings.model } : {}),
        ...(typeof settings.reasoning_effort === "string" ? { reasoning_effort: settings.reasoning_effort } : {}),
        developer_instructions: typeof settings.developer_instructions === "string" ? settings.developer_instructions : null } }];
  }) : [];
}

export function workspaceWriteSettings(raw: unknown): Record<string, unknown> {
  const record = toObjectRecord(raw) ?? {};
  const roots = record.writable_roots ?? record.writableRoots;
  return {
    networkAccess: (record.network_access ?? record.networkAccess) === true,
    writableRoots: Array.isArray(roots) ? roots.filter((root): root is string => typeof root === "string") : [],
    excludeSlashTmp: (record.exclude_slash_tmp ?? record.excludeSlashTmp) === true,
    excludeTmpdirEnvVar: (record.exclude_tmpdir_env_var ?? record.excludeTmpdirEnvVar) === true,
  };
}

export function codexSandboxPolicy(type: string, resolved: unknown, configured: unknown): Record<string, unknown> {
  const base = toObjectRecord(resolved) ?? {};
  if (type === "danger-full-access" || type === "dangerFullAccess") return base.type === "dangerFullAccess" ? { ...base } : { type: "dangerFullAccess" };
  if (type === "read-only" || type === "readOnly") return base.type === "readOnly" ? { ...base } : { type: "readOnly" };
  const overrides = toObjectRecord(configured) ?? {};
  // Normalize each spelling before merging so a configured snake-case field
  // overrides the equivalent camel-case field returned by resume.
  const preserved = base.type === "workspaceWrite" ? Object.fromEntries(Object.entries(base).filter(([key]) => !["network_access", "writable_roots", "exclude_slash_tmp", "exclude_tmpdir_env_var"].includes(key))) : {};
  return { ...preserved, type: "workspaceWrite", ...workspaceWriteSettings({
    network_access: overrides.network_access ?? overrides.networkAccess ?? base.network_access ?? base.networkAccess,
    writable_roots: overrides.writable_roots ?? overrides.writableRoots ?? base.writable_roots ?? base.writableRoots,
    exclude_slash_tmp: overrides.exclude_slash_tmp ?? overrides.excludeSlashTmp ?? base.exclude_slash_tmp ?? base.excludeSlashTmp,
    exclude_tmpdir_env_var: overrides.exclude_tmpdir_env_var ?? overrides.excludeTmpdirEnvVar ?? base.exclude_tmpdir_env_var ?? base.excludeTmpdirEnvVar,
  }) };
}
