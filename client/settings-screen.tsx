import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, TextInput } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  translateProvidersRpc,
  translateSettings,
  type TranslateSettingsValues,
} from "../shared/translate";
import {
  PLUGIN_LOCALES,
  PLUGIN_LOCALE_NATIVE_NAMES,
  useTranslate,
  type UiLanguageSetting,
} from "./i18n";

type ReadySettings = Extract<SettingsState<typeof translateSettings.schema>, { status: "ready" }>;

interface Draft {
  revision: string;
  endpointBaseUrl: string;
  endpointApiKey: string;
  endpointModel: string;
  reasoningEffort: TranslateSettingsValues["translationReasoningEffort"];
  systemPrompt: string;
  userLanguage: string;
  agentLanguage: string;
  commandText: string;
  claudeExecutablePath: string;
  timeoutText: string;
  translatePrompts: boolean;
  translateResponses: boolean;
  translateAllTimelines: boolean;
  uiLanguage: UiLanguageSetting;
  innerAgentEnv: ReadySettings["values"]["innerAgentEnv"];
}

function draftFrom(settings: ReadySettings): Draft {
  const values = settings.values;
  return {
    revision: settings.revision,
    endpointBaseUrl: values.endpointBaseUrl,
    endpointApiKey: values.endpointApiKey,
    endpointModel: values.endpointModel,
    reasoningEffort: values.translationReasoningEffort,
    systemPrompt: values.translationSystemPrompt,
    userLanguage: values.userLanguage,
    agentLanguage: values.agentLanguage,
    commandText: values.innerAgentCommand.join(" "),
    claudeExecutablePath: values.claudeExecutablePath,
    timeoutText: String(values.translationTimeoutMs),
    translatePrompts: values.translatePrompts,
    translateResponses: values.translateResponses,
    translateAllTimelines: values.translateAllTimelines,
    uiLanguage: values.uiLanguage,
    innerAgentEnv: values.innerAgentEnv,
  };
}

export function TranslateSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(translateSettings);
  // Before the stored settings arrive, render in the device locale; once
  // ready, follow the stored interface-language choice.
  const { t } = useTranslate(
    settings.status === "ready" ? settings.values.uiLanguage : "system",
  );
  const mutedStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  // Multiline prompt editor: the form kit's SettingsInput is single-line, so
  // this row composes SettingsRow with a raw TextInput on theme tokens.
  const promptInputStyle = useMemo(
    () => ({
      color: theme.colors.foreground,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 10,
      minHeight: 72,
      textAlignVertical: "top" as const,
    }),
    [theme],
  );
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
            ? t("pickerAdapterNote", { label: option.label })
            : t("pickerKnownNote", { label: option.label }),
        );
        return;
      }
      setPickerNote(t("pickerUnknownNote", { label: option.label }));
    },
    [providersQuery.data, patch, t],
  );

  const changeBaseUrl = useCallback(
    (endpointBaseUrl: string) => patch({ endpointBaseUrl }),
    [patch],
  );
  const changeApiKey = useCallback((endpointApiKey: string) => patch({ endpointApiKey }), [patch]);
  const changeModel = useCallback((endpointModel: string) => patch({ endpointModel }), [patch]);
  const changeReasoningEffort = useCallback(
    (reasoningEffort: Draft["reasoningEffort"]) => patch({ reasoningEffort: reasoningEffort }),
    [patch],
  );
  const changeSystemPrompt = useCallback((systemPrompt: string) => patch({ systemPrompt }), [patch]);
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
  const changeUiLanguage = useCallback(
    (uiLanguage: UiLanguageSetting) => patch({ uiLanguage }),
    [patch],
  );
  const uiLanguageOptions = useMemo(
    () => [
      { label: t("uiLanguageSystem"), value: "system" as UiLanguageSetting },
      ...PLUGIN_LOCALES.map((locale) => ({
        label: PLUGIN_LOCALE_NATIVE_NAMES[locale],
        value: locale as UiLanguageSetting,
      })),
    ],
    [t],
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
      setDraftError(t("timeoutNotANumber"));
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
        translationReasoningEffort: active.reasoningEffort,
        translationSystemPrompt: active.systemPrompt,
        userLanguage: active.userLanguage,
        agentLanguage: active.agentLanguage,
        innerAgentCommand: command,
        innerAgentEnv: active.innerAgentEnv,
        claudeExecutablePath: active.claudeExecutablePath,
        translatePrompts: active.translatePrompts,
        translateResponses: active.translateResponses,
        translateAllTimelines: active.translateAllTimelines,
        uiLanguage: active.uiLanguage,
        translationTimeoutMs: timeoutMs,
      },
      active.revision,
    );
    if (saved) {
      discard();
      await ready.reload();
    }
  }, [ready, active, discard, t]);

  const sectionInfo = useMemo<ReactNode>(
    () => <Text style={mutedStyle}>{t("settingsInfo")}</Text>,
    [mutedStyle, t],
  );

  if (settings.status === "loading") {
    return <Text style={mutedStyle}>{t("loadingSettings")}</Text>;
  }
  if (ready === null || active === null) {
    return (
      <SettingsSection title={t("settingsTitle")}>
        <Text accessibilityRole="alert" style={mutedStyle}>
          {settings.status === "error" || settings.status === "invalid"
            ? settings.error
            : t("settingsUnavailable")}
        </Text>
        <SettingsAction label={t("retry")} actionLabel={t("reload")} onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label={t("resetDefaults")}
            actionLabel={t("reset")}
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
    <SettingsSection title={t("settingsTitle")} info={sectionInfo}>
      <SettingsCard>
        {providersQuery.isPending ? (
          <Text style={mutedStyle}>{t("loadingProviders")}</Text>
        ) : null}
        {providersQuery.isError ? (
          <Text style={mutedStyle} accessibilityRole="alert">
            {t("providersLoadError", {
              error:
                providersQuery.error instanceof Error
                  ? providersQuery.error.message
                  : t("providersLoadFailed"),
            })}
          </Text>
        ) : null}
        {providerOptions.length > 0 ? (
          <SettingsSelect
            label={t("innerAgentPicker")}
            hint={t("innerAgentPickerHint")}
            value={pickedProvider}
            options={providerOptions}
            disabled={settings.saving || providersQuery.isPending}
            onValueChange={pickProvider}
          />
        ) : null}
        {pickerNote !== null ? <Text style={mutedStyle}>{pickerNote}</Text> : null}
        <SettingsAction
          label={t("refreshProviders")}
          actionLabel={t("refresh")}
          disabled={providersQuery.isFetching}
          onPress={providersQuery.refetch}
        />
      </SettingsCard>
      <SettingsCard key={`endpoint-${formKey}`}>
        <SettingsInput
          label={t("endpointUrl")}
          hint={t("endpointUrlHint")}
          initialValue={active.endpointBaseUrl}
          onChangeText={changeBaseUrl}
          disabled={settings.saving}
        />
        <SettingsInput
          label={t("apiKey")}
          hint={t("apiKeyHint")}
          initialValue={active.endpointApiKey}
          onChangeText={changeApiKey}
          disabled={settings.saving}
          secureTextEntry
        />
        <SettingsInput
          label={t("model")}
          initialValue={active.endpointModel}
          onChangeText={changeModel}
          disabled={settings.saving}
        />
        <SettingsSelect
          label={t("reasoningEffort")}
          hint={t("reasoningEffortHint")}
          value={active.reasoningEffort}
          options={[
            { label: t("effortDefault"), value: "default" },
            { label: t("effortNone"), value: "none" },
            { label: t("effortMinimal"), value: "minimal" },
            { label: t("effortLow"), value: "low" },
            { label: t("effortMedium"), value: "medium" },
            { label: t("effortHigh"), value: "high" },
          ]}
          disabled={settings.saving}
          onValueChange={changeReasoningEffort}
        />
        <SettingsRow label={t("systemPrompt")} hint={t("systemPromptHint")}>
          <TextInput
            accessibilityLabel={t("systemPrompt")}
            value={active.systemPrompt}
            onChangeText={changeSystemPrompt}
            editable={!settings.saving}
            multiline
            placeholder={t("systemPromptPlaceholder")}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={promptInputStyle}
          />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard key={`agent-${formKey}`}>
        <SettingsInput
          label={t("userLanguage")}
          hint={t("userLanguageHint")}
          initialValue={active.userLanguage}
          onChangeText={changeUserLanguage}
          disabled={settings.saving}
        />
        <SettingsInput
          label={t("agentLanguage")}
          hint={t("agentLanguageHint")}
          initialValue={active.agentLanguage}
          onChangeText={changeAgentLanguage}
          disabled={settings.saving}
        />
        <SettingsInput
          label={t("innerAgentCommand")}
          hint={t("innerAgentCommandHint")}
          initialValue={active.commandText}
          onChangeText={changeCommand}
          disabled={settings.saving}
        />
        <SettingsInput
          label={t("claudeExecutable")}
          hint={t("claudeExecutableHint")}
          initialValue={active.claudeExecutablePath}
          onChangeText={changeClaudePath}
          disabled={settings.saving}
        />
        <SettingsInput
          label={t("translationTimeout")}
          initialValue={active.timeoutText}
          onChangeText={changeTimeout}
          disabled={settings.saving}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsSwitch
          label={t("translatePrompts")}
          hint={t("translatePromptsHint")}
          value={active.translatePrompts}
          onValueChange={togglePrompts}
          disabled={settings.saving}
        />
        <SettingsSwitch
          label={t("translateResponses")}
          hint={t("translateResponsesHint")}
          value={active.translateResponses}
          onValueChange={toggleResponses}
          disabled={settings.saving}
        />
        <SettingsSwitch
          label={t("translateAllTimelines")}
          hint={t("translateAllTimelinesHint")}
          value={active.translateAllTimelines}
          onValueChange={toggleAllTimelines}
          disabled={settings.saving}
        />
        <SettingsSelect
          label={t("uiLanguage")}
          hint={t("uiLanguageHint")}
          value={active.uiLanguage}
          options={uiLanguageOptions}
          disabled={settings.saving}
          onValueChange={changeUiLanguage}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsAction
          label={t("saveSettings")}
          actionLabel={t("save")}
          disabled={settings.saving}
          onPress={save}
          error={draftError ?? settings.saveError}
        />
        {draft !== null ? (
          <SettingsAction
            label={t("discardChanges")}
            actionLabel={t("discard")}
            disabled={settings.saving}
            onPress={discard}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
