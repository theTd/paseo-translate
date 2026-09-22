import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { translateSettings } from "../shared/translate";

type ReadySettings = Extract<SettingsState<typeof translateSettings.schema>, { status: "ready" }>;

interface Draft {
  revision: string;
  endpointBaseUrl: string;
  endpointApiKey: string;
  endpointModel: string;
  userLanguage: string;
  agentLanguage: string;
  commandText: string;
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
    setFormResetCount((count) => count + 1);
  }, []);

  const save = useCallback(async () => {
    if (ready === null || active === null) return;
    const timeoutMs = Number.parseInt(active.timeoutText.trim(), 10);
    if (!Number.isFinite(timeoutMs)) {
      setDraftError("Translation timeout must be a whole number of milliseconds.");
      return;
    }
    const command = active.commandText
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    if (command.length === 0) {
      setDraftError("Inner agent command is required.");
      return;
    }
    const saved = await ready.save(
      {
        endpointBaseUrl: active.endpointBaseUrl,
        endpointApiKey: active.endpointApiKey,
        endpointModel: active.endpointModel,
        userLanguage: active.userLanguage,
        agentLanguage: active.agentLanguage,
        innerAgentCommand: command,
        innerAgentEnv: active.innerAgentEnv,
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
          hint="ACP-speaking command the provider spawns; arguments split on spaces"
          initialValue={active.commandText}
          onChangeText={changeCommand}
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
