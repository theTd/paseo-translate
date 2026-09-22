import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { translateProvidersRpc, translateSettings } from "../shared/translate";

type ReadySettings = Extract<SettingsState<typeof translateSettings.schema>, { status: "ready" }>;

interface Draft {
  revision: string;
  endpointBaseUrl: string;
  endpointApiKey: string;
  endpointModel: string;
  userLanguage: string;
  agentLanguage: string;
  commandText: string;
  claudeExecutablePath: string;
  timeoutText: string;
  translatePrompts: boolean;
  translateResponses: boolean;
  translateAllTimelines: boolean;
  innerAgentEnv: ReadySettings["values"]["innerAgentEnv"];
}

function draftFrom(settings: ReadySettings): Draft {
  const values = settings.values;
  return {
    revision: settings.revision,
    endpointBaseUrl: values.endpointBaseUrl,
    endpointApiKey: values.endpointApiKey,
    endpointModel: values.endpointModel,
    userLanguage: values.userLanguage,
    agentLanguage: values.agentLanguage,
    commandText: values.innerAgentCommand.join(" "),
    claudeExecutablePath: values.claudeExecutablePath,
    timeoutText: String(values.translationTimeoutMs),
    translatePrompts: values.translatePrompts,
    translateResponses: values.translateResponses,
    translateAllTimelines: values.translateAllTimelines,
    innerAgentEnv: values.innerAgentEnv,
  };
}

export function TranslateSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(translateSettings);
  const mutedStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  // Bumped only when the displayed form must reset (discard or save); editing
  // alone must not remount the inputs or the focused field loses focus.
  const [formResetCount, setFormResetCount] = useState(0);
  const [pickedProvider, setPickedProvider] = useState("");
  const [pickerNote, setPickerNote] = useState<string | null>(null);

  const listProviders = useRpc(translateProvidersRpc);
  const providersQuery = useQuery({
    queryKey: ["translate", "providers"],
    queryFn: () => listProviders({}),
    staleTime: 30_000,
    retry: 1,
  });
  const providerOptions = useMemo(
    () =>
      (providersQuery.data?.providers ?? []).map((provider) => ({
        label: `${provider.label} (${provider.status})`,
        value: provider.id,
      })),
    [providersQuery.data],
  );

  const ready = settings.status === "ready" ? settings : null;
  // Latest snapshot for starting a draft on the first edit after a reload.
  const readyRef = useRef<ReadySettings | null>(null);
  readyRef.current = ready;
  const active = draft ?? (ready === null ? null : draftFrom(ready));

  const patch = useCallback((changes: Partial<Draft>) => {
    setDraftError(null);
    setDraft((current) => {
      const base = current ?? (readyRef.current === null ? null : draftFrom(readyRef.current));
      return base === null ? null : { ...base, ...changes };
    });
  }, []);

  const pickProvider = useCallback(
    (id: string) => {
      setPickedProvider(id);
      const option = providersQuery.data?.providers.find((provider) => provider.id === id) ?? null;
      if (option === null) return;
      if (option.command !== null) {
        patch({ commandText: option.command.join(" ") });
        setPickerNote(
          option.acp === "adapter"
            ? `Filled the adapter command for ${option.label} (npx downloads it on first use).`
            : `Filled the command for ${option.label}.`,
        );
        return;
      }
      setPickerNote(
        `Cannot confirm whether '${option.label}' ships an ACP mode. If its CLI has one ` +
          "(like `omp acp` or `opencode acp`), enter that command manually below.",
      );
    },
    [providersQuery.data, patch],
  );

  const changeBaseUrl = useCallback(
    (endpointBaseUrl: string) => patch({ endpointBaseUrl }),
    [patch],
  );
  const changeApiKey = useCallback((endpointApiKey: string) => patch({ endpointApiKey }), [patch]);
  const changeModel = useCallback((endpointModel: string) => patch({ endpointModel }), [patch]);
  const changeUserLanguage = useCallback(
    (userLanguage: string) => patch({ userLanguage }),
    [patch],
  );
  const changeAgentLanguage = useCallback(
    (agentLanguage: string) => patch({ agentLanguage }),
    [patch],
  );
  const changeCommand = useCallback((commandText: string) => patch({ commandText }), [patch]);
  const changeClaudePath = useCallback(
    (claudeExecutablePath: string) => patch({ claudeExecutablePath }),
    [patch],
  );
  const changeTimeout = useCallback((timeoutText: string) => patch({ timeoutText }), [patch]);
  const togglePrompts = useCallback(
    (translatePrompts: boolean) => patch({ translatePrompts }),
    [patch],
  );
  const toggleResponses = useCallback(
    (translateResponses: boolean) => patch({ translateResponses }),
    [patch],
  );
  const toggleAllTimelines = useCallback(
    (translateAllTimelines: boolean) => patch({ translateAllTimelines }),
    [patch],
  );

  const discard = useCallback(() => {
    setDraft(null);
    setDraftError(null);
    setPickedProvider("");
    setPickerNote(null);
    setFormResetCount((count) => count + 1);
  }, []);

  const save = useCallback(async () => {
    if (ready === null || active === null) return;
    const timeoutMs = Number.parseInt(active.timeoutText.trim(), 10);
    if (!Number.isFinite(timeoutMs)) {
      setDraftError("Translation timeout must be a whole number of milliseconds.");
      return;
    }
    // The inner agent command stays optional: the direct Claude provider does
    // not use it, so only the translation endpoint is globally required.
    const command = active.commandText
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    const saved = await ready.save(
      {
        endpointBaseUrl: active.endpointBaseUrl,
        endpointApiKey: active.endpointApiKey,
        endpointModel: active.endpointModel,
        userLanguage: active.userLanguage,
        agentLanguage: active.agentLanguage,
        innerAgentCommand: command,
        innerAgentEnv: active.innerAgentEnv,
        claudeExecutablePath: active.claudeExecutablePath,
        translatePrompts: active.translatePrompts,
        translateResponses: active.translateResponses,
        translateAllTimelines: active.translateAllTimelines,
        translationTimeoutMs: timeoutMs,
      },
      active.revision,
    );
    if (saved) {
      discard();
      await ready.reload();
    }
  }, [ready, active, discard]);

  const sectionInfo = useMemo<ReactNode>(
    () => (
      <Text style={mutedStyle}>
        Prompts are translated before they reach the agent. Replies are translated in the app after
        each stream completes.
      </Text>
    ),
    [mutedStyle],
  );

  if (settings.status === "loading") {
    return <Text style={mutedStyle}>Loading settings…</Text>;
  }
  if (ready === null || active === null) {
    return (
      <SettingsSection title="Translate">
        <Text accessibilityRole="alert" style={mutedStyle}>
          {settings.status === "error" || settings.status === "invalid"
            ? settings.error
            : "Settings are unavailable."}
        </Text>
        <SettingsAction label="Retry" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }

  // Uncontrolled SettingsInputs re-read initialValue only on mount. The key
  // changes exclusively when a discard or save resets the displayed values,
  // so typing never remounts the focused input.
  const formKey = String(formResetCount);

  return (
    <SettingsSection title="Translate" info={sectionInfo}>
      <SettingsCard>
        {providersQuery.isPending ? (
          <Text style={mutedStyle}>Loading daemon providers…</Text>
        ) : null}
        {providersQuery.isError ? (
          <Text style={mutedStyle} accessibilityRole="alert">
            Could not load providers:{" "}
            {providersQuery.error instanceof Error ? providersQuery.error.message : "failed"}
          </Text>
        ) : null}
        {providerOptions.length > 0 ? (
          <SettingsSelect
            label="Inner agent (pick a daemon provider)"
            hint="ACP providers fill the command from the daemon configuration automatically"
            value={pickedProvider}
            options={providerOptions}
            disabled={settings.saving || providersQuery.isPending}
            onValueChange={pickProvider}
          />
        ) : null}
        {pickerNote !== null ? <Text style={mutedStyle}>{pickerNote}</Text> : null}
        <SettingsAction
          label="Refresh the daemon provider list"
          actionLabel="Refresh"
          disabled={providersQuery.isFetching}
          onPress={providersQuery.refetch}
        />
      </SettingsCard>
      <SettingsCard key={`endpoint-${formKey}`}>
        <SettingsInput
          label="Endpoint base URL"
          hint="OpenAI-compatible host, e.g. https://api.openai.com/v1"
          initialValue={active.endpointBaseUrl}
          onChangeText={changeBaseUrl}
          disabled={settings.saving}
        />
        <SettingsInput
          label="API key"
          hint="Optional for local endpoints"
          initialValue={active.endpointApiKey}
          onChangeText={changeApiKey}
          disabled={settings.saving}
          secureTextEntry
        />
        <SettingsInput
          label="Model"
          initialValue={active.endpointModel}
          onChangeText={changeModel}
          disabled={settings.saving}
        />
      </SettingsCard>
      <SettingsCard key={`agent-${formKey}`}>
        <SettingsInput
          label="Your language"
          hint="Language you write and read, e.g. en"
          initialValue={active.userLanguage}
          onChangeText={changeUserLanguage}
          disabled={settings.saving}
        />
        <SettingsInput
          label="Agent language"
          hint="Language the agent reasons in, e.g. de"
          initialValue={active.agentLanguage}
          onChangeText={changeAgentLanguage}
          disabled={settings.saving}
        />
        <SettingsInput
          label="Inner agent command"
          hint="ACP-speaking command for the Translate (ACP) provider; filled automatically by the picker above"
          initialValue={active.commandText}
          onChangeText={changeCommand}
          disabled={settings.saving}
        />
        <SettingsInput
          label="Claude Code executable"
          hint="Optional full path for the direct Translate (Claude Code) provider; leave empty to resolve from PATH"
          initialValue={active.claudeExecutablePath}
          onChangeText={changeClaudePath}
          disabled={settings.saving}
        />
        <SettingsInput
          label="Translation timeout (ms)"
          initialValue={active.timeoutText}
          onChangeText={changeTimeout}
          disabled={settings.saving}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsSwitch
          label="Translate prompts"
          hint="Fail closed: a failed translation blocks the prompt"
          value={active.translatePrompts}
          onValueChange={togglePrompts}
          disabled={settings.saving}
        />
        <SettingsSwitch
          label="Translate replies"
          hint="After the stream completes, in the app only"
          value={active.translateResponses}
          onValueChange={toggleResponses}
          disabled={settings.saving}
        />
        <SettingsSwitch
          label="Translate every agent's timeline"
          hint="Off: only agents using the Translate provider"
          value={active.translateAllTimelines}
          onValueChange={toggleAllTimelines}
          disabled={settings.saving}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsAction
          label="Save translate settings"
          actionLabel="Save"
          disabled={settings.saving}
          onPress={save}
          error={draftError ?? settings.saveError}
        />
        {draft !== null ? (
          <SettingsAction
            label="Discard unsaved changes"
            actionLabel="Discard"
            disabled={settings.saving}
            onPress={discard}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
