import { useEffect, useRef, useState } from "react";
import { observeAgentList } from "./agent-list-observer";
import { Pressable, Text, View } from "react-native";
import { useAgent, useRpc, useSettings, type PluginButtonContentProps,
  type PluginButtonRegistration, type PluginClientContext, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { TRANSLATE_CLAUDE_PROVIDER_ID, translateSettings } from "../shared/translate";
import { forkClaudeSessionRpc } from "../shared/claude-session-fork";
import { detectSystemLocale, translate, useTranslate } from "./i18n";

function operationId(): string {
  // This is a retry key, not an authorization token. Native clients need no crypto polyfill.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (letter) => {
    const value = Math.floor(Math.random() * 16);
    return (letter === "x" ? value : (value & 3) | 8).toString(16);
  });
}

/** in_progress responses are polled: large copies and daemon imports run for minutes. */
const POLL_INTERVAL_MS = 3_000;
const POLL_LIMIT_MS = 10 * 60_000;

export function ForkConfirmation(props: PluginButtonContentProps & {
  sourceAgentId: string;
  getOperationId(): string;
  resumeOperation(operationId: string): void;
  startNewOperation(): void;
  onComplete(agentId: string): Promise<void>;
}) {
  const settings = useSettings(translateSettings);
  const { t } = useTranslate(settings.status === "ready" ? settings.values.uiLanguage : "system");
  const source = useAgent(props.sourceAgentId, (agent) => ({ title: agent.title, provider: agent.provider, cwd: agent.cwd }));
  const fork = useRpc(forkClaudeSessionRpc);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [restartRequired, setRestartRequired] = useState(false);
  const restart = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (restart.current) {
        props.startNewOperation();
        restart.current = false;
        setRestartRequired(false);
      }
      const startedAt = Date.now();
      let result = await fork({ agentId: props.sourceAgentId, operationId: props.getOperationId() });
      while (result.kind === "in_progress") {
        if (result.operationId) props.resumeOperation(result.operationId);
        if (Date.now() - startedAt >= POLL_LIMIT_MS) throw new Error(t("forkStillRunning"));
        const pollTick = new Promise<void>((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
        await pollTick;
        result = await fork({ agentId: props.sourceAgentId, operationId: props.getOperationId() });
      }
      if (result.kind === "restart_required") {
        restart.current = true;
        if (mounted.current) { setRestartRequired(true); setError(result.message); }
        else toast.error(result.message);
        return;
      }
      toast.show(t("forkCompleted"));
      await props.onComplete(result.agentId);
      if (mounted.current) props.close();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (mounted.current) setError(message);
      else toast.error(message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  const colors = props.theme.colors;
  return <View style={{ gap: 14 }}>
    <Text style={{ color: colors.foreground, fontWeight: "600" }}>{source?.title || t("forkSession")}</Text>
    <Text style={{ color: colors.foregroundMuted }}>{t("forkDescription")}</Text>
    <Text style={{ color: colors.foregroundMuted }}>{source?.cwd}</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
    {error && !restartRequired ? <Text style={{ color: colors.foregroundMuted }}>{t("forkNewAttemptHint")}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      <Pressable accessibilityRole="button" disabled={pending} onPress={props.close}
        style={{ padding: 12, borderRadius: 8, backgroundColor: colors.surface2 }}>
        <Text style={{ color: colors.foreground }}>{t("forkCancel")}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={pending || source?.provider !== TRANSLATE_CLAUDE_PROVIDER_ID}
        onPress={() => { void confirm(); }}
        style={{ padding: 12, borderRadius: 8, backgroundColor: colors.accent, opacity: pending ? 0.6 : 1 }}>
        <Text style={{ color: colors.accentForeground }}>{t(pending ? "forkBusy" : restartRequired ? "forkRestartConfirm" : error ? "retry" : "forkConfirm")}</Text>
      </Pressable>
      {error && !restartRequired ? <Pressable accessibilityRole="button" disabled={pending}
        onPress={() => { if (!inFlight.current) { restart.current = true; void confirm(); } }}
        style={{ padding: 12, borderRadius: 8, backgroundColor: colors.surface2 }}>
        <Text style={{ color: colors.foreground }}>{t("forkRestartConfirm")}</Text>
      </Pressable> : null}
    </View>
  </View>;
}

function ForkResult({ agentId, navigation, theme }: PluginAgentPanelProps) {
  useEffect(() => { navigation?.openAgent({ agentId }); }, [agentId, navigation]);
  const settings = useSettings(translateSettings);
  const { t } = useTranslate(settings.status === "ready" ? settings.values.uiLanguage : "system");
  const agent = useAgent(agentId, ({ title }) => title);
  return <View style={{ padding: 16, gap: 12 }}>
    <Text style={{ color: theme.colors.foreground }}>{agent || t("forkCompleted")}</Text>
    {navigation ? <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId })}>
      <Text style={{ color: theme.colors.accent }}>{t("openFork")}</Text>
    </Pressable> : null}
  </View>;
}

export function contributeClaudeSessionFork(client: PluginClientContext): () => void {
  const registrations = new Map<string, { workspaceId: string; button: PluginButtonRegistration }>();
  const operations = new Map<string, string>();
  let stopped = false;
  const locale = detectSystemLocale();
  const title = translate(locale, "forkSession");
  // The composer row is shared with the host's own pills and is narrow on
  // phones: one word plus the icon. The full title stays the tooltip,
  // accessibility label and sheet title. (The host requires a non-empty
  // label, so an icon-only pill is not an option.)
  const label = translate(locale, "forkPill");
  const removePanel = client.addWorkspacePanel({ id: "claude-fork-result", title,
    icon: "GitFork", context: "agent", Component: ForkResult });
  function remove(id: string) { registrations.get(id)?.button.remove(); registrations.delete(id); }
  function register(agent: { id: string; workspaceId?: string | null; provider: string; archivedAt?: string | null }) {
    if (stopped) return;
    if (agent.provider !== TRANSLATE_CLAUDE_PROVIDER_ID || !agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    if (registrations.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const sourceAgentId = agent.id;
    const workspaceId = agent.workspaceId;
    const Content = (props: PluginButtonContentProps) => <ForkConfirmation {...props} sourceAgentId={sourceAgentId}
      getOperationId={() => {
        const id = operations.get(sourceAgentId) ?? operationId();
        operations.set(sourceAgentId, id);
        return id;
      }}
      resumeOperation={(id) => { operations.set(sourceAgentId, id); }}
      startNewOperation={() => operations.delete(sourceAgentId)}
      onComplete={async (id) => {
        const result = await client.paseo.agents.ref(id).refresh();
        if (!result?.agent.workspaceId) throw new Error("The fork has no workspace to open");
        operations.delete(sourceAgentId);
        client.openPanel("claude-fork-result", { workspaceId: result.agent.workspaceId, agentId: id });
      }} />;
    const button = client.addComposerPill({ id: "fork-claude-session", workspaceId, agentId: sourceAgentId,
      button: { title, label, icon: "GitFork", behavior: { kind: "popover", Content } } });
    registrations.set(sourceAgentId, { workspaceId, button });
  }
  const stopObservation = observeAgentList(client, register, remove);
  return () => {
    stopped = true;
    stopObservation();
    for (const id of registrations.keys()) remove(id);
    operations.clear();
    removePanel();
  };
}
