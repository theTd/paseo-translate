import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginButtonContentProps, type PluginButtonIconProps,
  type PluginButtonRegistration, type PluginClientContext, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { cacheCountdown, claudeCacheConfigureRpc, claudeCachePreferencesSchema, claudeCacheSettings,
  claudeCacheStatusRpc, type ClaudeCachePreferences, type ClaudeCacheSnapshot } from "../shared/claude-cache-compaction";
import { TRANSLATE_CLAUDE_PROVIDER_ID, translateSettings } from "../shared/translate";
import { observeAgentList, type ObservedAgent } from "./agent-list-observer";
import { detectSystemLocale, useTranslate } from "./i18n";

const copy = {
  en: { title: "Claude cache", defaults: "Claude AFK defaults", enabled: "AFK auto-compaction",
    threshold: "Minimum context tokens", lead: "Seconds before cache expiry", save: "Save",
    defaultsHint: "These defaults apply to new Claude sessions only. Existing sessions keep their own settings.",
    sessionHint: "Compacts finished runs above the threshold while the cache is warm. Five-minute caches are excluded.",
    estimate: "Estimated cache remaining", usage: "Context tokens", loading: "Loading…", failed: "Unable to load cache status",
    saved: "Saved", invalid: "Enter a positive whole-number threshold and a lead between 5 and 1800 seconds.",
    unknown: "Unknown", expired: "Expired", compacting: "Compacting", compacted: "Compacted", noCache: "No cache observed", compactionFailed: "Compaction failed" },
  "zh-CN": { title: "Claude 缓存", defaults: "Claude 挂机压缩默认设置", enabled: "挂机自动压缩",
    threshold: "上下文 Token 阈值", lead: "缓存到期前提前秒数", save: "保存",
    defaultsHint: "仅对新建 Claude 会话生效，已有会话保留各自设置。",
    sessionHint: "仅在本轮及后台工作结束、上下文超过阈值且缓存仍有效时压缩。5 分钟缓存不参与自动压缩。",
    estimate: "缓存预计剩余时间", usage: "上下文 Token 数", loading: "加载中…", failed: "无法加载缓存状态",
    saved: "已保存", invalid: "阈值须为正整数，提前时间须为 5 至 1800 秒的整数。",
    unknown: "未知", expired: "已到期", compacting: "正在压缩", compacted: "已压缩", noCache: "未观测到缓存", compactionFailed: "压缩失败" },
};

function useCopy() {
  const settings = useSettings(translateSettings);
  const { locale } = useTranslate(settings.status === "ready" ? settings.values.uiLanguage : "system");
  return copy[locale === "zh-CN" ? "zh-CN" : "en"];
}

function useCacheStatus(agentId: string) {
  const read = useRpc(claudeCacheStatusRpc);
  return useQuery({ queryKey: ["claude-cache", agentId], queryFn: () => read({ agentId }),
    refetchInterval: 15_000, refetchIntervalInBackground: false, retry: 1 });
}

function useServerClock(snapshot: ClaudeCacheSnapshot | undefined): number {
  const clock = () => globalThis.performance?.now() ?? Date.now();
  const received = useMemo(() => ({ server: snapshot?.serverNow ?? Date.now(), local: clock() }), [snapshot]);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return received.server + Math.max(0, clock() - received.local);
}

function statusLabel(snapshot: ClaudeCacheSnapshot, now: number, strings: ReturnType<typeof useCopy>): string {
  if (snapshot.state === "compacting") return strings.compacting;
  if (snapshot.state === "compacted") return strings.compacted;
  if (snapshot.state === "no-cache") return strings.noCache;
  if (snapshot.state === "failed") return strings.compactionFailed;
  if (snapshot.expiresAt === null) return strings.unknown;
  if (snapshot.expiresAt <= now) return strings.expired;
  return `≈${cacheCountdown(snapshot.expiresAt, now)}`;
}

export function CachePreferencesForm({ value, saving, onSave }: {
  value: ClaudeCachePreferences; saving: boolean; onSave(value: ClaudeCachePreferences): Promise<boolean>;
}) {
  const strings = useCopy();
  const [enabled, setEnabled] = useState(value.enabled);
  const [threshold, setThreshold] = useState(String(value.thresholdTokens));
  const [lead, setLead] = useState(String(value.leadSeconds));
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  async function save() {
    if (pending.current) return;
    const parsed = claudeCachePreferencesSchema.safeParse({ enabled,
      thresholdTokens: Number(threshold), leadSeconds: Number(lead) });
    if (!parsed.success) { setMessage(strings.invalid); return; }
    pending.current = true;
    setMessage("");
    try { if (await onSave(parsed.data)) setMessage(strings.saved); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; }
  }
  return <SettingsCard>
    <SettingsSwitch label={strings.enabled} value={enabled} onValueChange={setEnabled} disabled={saving} />
    <SettingsInput label={strings.threshold} initialValue={threshold} onChangeText={setThreshold} disabled={saving} />
    <SettingsInput label={strings.lead} initialValue={lead} onChangeText={setLead} disabled={saving} />
    <SettingsAction label={strings.save} actionLabel={strings.save} onPress={() => { void save(); }} disabled={saving} />
    {message ? <Text accessibilityRole="alert">{message}</Text> : null}
  </SettingsCard>;
}

export function ClaudeCacheDefaultsScreen(_props: PluginSurfaceProps) {
  const settings = useSettings(claudeCacheSettings);
  const strings = useCopy();
  return <SettingsSection title={strings.defaults} info={<Text>{strings.defaultsHint}</Text>}>
    {settings.status === "ready" ? <CachePreferencesForm key={settings.revision} value={settings.values}
      saving={settings.saving} onSave={(value) => settings.save(value, settings.revision)} /> :
      <Text>{settings.status === "loading" ? strings.loading : settings.error}</Text>}
    {settings.saveError ? <Text accessibilityRole="alert">{settings.saveError}</Text> : null}
  </SettingsSection>;
}

function CachePopover(props: PluginButtonContentProps) {
  const strings = useCopy();
  const status = useCacheStatus(props.context === "agent" ? props.agentId : "");
  const configure = useRpc(claudeCacheConfigureRpc);
  const queries = useQueryClient();
  const [saving, setSaving] = useState(false);
  const now = useServerClock(status.data);
  if (!status.data) return <Text>{status.isError ? strings.failed : strings.loading}</Text>;
  const snapshot = status.data;
  const agentId = props.context === "agent" ? props.agentId : "";
  return <View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foreground }}>{strings.estimate}: {statusLabel(snapshot, now, strings)}</Text>
    <Text style={{ color: props.theme.colors.foreground }}>{strings.usage}: {snapshot.contextTokens ?? strings.unknown}</Text>
    <Text style={{ color: props.theme.colors.foregroundMuted }}>{snapshot.reason}</Text>
    <Text style={{ color: props.theme.colors.foregroundMuted }}>{strings.sessionHint}</Text>
    {snapshot.state !== "not-open" ? <CachePreferencesForm value={snapshot.preferences} saving={saving}
      onSave={async (preferences) => {
        setSaving(true);
        try {
          const result = await configure({ agentId, preferences });
          queries.setQueryData(["claude-cache", agentId], result);
          return true;
        } finally { setSaving(false); }
      }} /> : null}
  </View>;
}

/** Only mounted composer icons poll; all registered/history agents do not get timers. */
function CacheIcon(props: PluginButtonIconProps & { onLabel(label: string): void }) {
  const strings = useCopy();
  const status = useCacheStatus(props.context === "agent" ? props.agentId : "");
  const now = useServerClock(status.data);
  const label = `${strings.title} ${status.isError ? "?" : status.data ? statusLabel(status.data, now, strings) : "…"}`;
  useEffect(() => { props.onLabel(label); }, [label, props.onLabel]);
  return <Text style={{ color: props.color, fontSize: props.size }}>◷</Text>;
}

export function contributeClaudeCacheControls(client: PluginClientContext): () => void {
  const registrations = new Map<string, { workspaceId: string; button: PluginButtonRegistration }>();
  function remove(id: string) { registrations.get(id)?.button.remove(); registrations.delete(id); }
  const title = copy[detectSystemLocale() === "zh-CN" ? "zh-CN" : "en"].title;
  const stop = observeAgentList(client, (agent: ObservedAgent) => {
    if (agent.provider !== TRANSLATE_CLAUDE_PROVIDER_ID || !agent.workspaceId || agent.archivedAt) {
      remove(agent.id); return;
    }
    if (registrations.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    let button: PluginButtonRegistration | undefined;
    const onLabel = (label: string) => button?.update({ label });
    const Icon = (props: PluginButtonIconProps) => <CacheIcon {...props} onLabel={onLabel} />;
    button = client.addComposerPill({ id: "claude-cache", workspaceId: agent.workspaceId, agentId: agent.id,
      button: { title, label: `${title} ?`, icon: Icon, behavior: { kind: "popover", Content: CachePopover } } });
    registrations.set(agent.id, { workspaceId: agent.workspaceId, button });
  }, remove);
  return () => { stop(); for (const id of registrations.keys()) remove(id); };
}
