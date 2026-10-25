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
  BUILT_IN_TRANSLATION_PROMPT_TEMPLATE,
  resolveTranslationSystemPrompt,
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
  endpointProtocol: TranslateSettingsValues["endpointProtocol"];
  reasoningEffort: TranslateSettingsValues["translationReasoningEffort"];
  systemPrompt: string;
  domainContext: string;
  extraRules: string;
  userLanguage: string;
  agentLanguage: string;
  commandText: string;
  claudeExecutablePath: string;
  claudeConfigDir: string;
  codexExecutablePath: string;
  timeoutText: string;
  contextIdleText: string;
  contextMaxCharsText: string;
  translatePrompts: boolean;
  translateResponses: boolean;
  translateNotifications: boolean;
  translateReasoning: boolean;
  translateAllTimelines: boolean;
  translationContextEnabled: boolean;
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
    endpointProtocol: values.endpointProtocol,
    reasoningEffort: values.translationReasoningEffort,
    systemPrompt: values.translationSystemPrompt,
    domainContext: values.translationDomainContext,
    extraRules: values.translationExtraRules,
    userLanguage: values.userLanguage,
    agentLanguage: values.agentLanguage,
    commandText: values.innerAgentCommand.join(" "),
    claudeExecutablePath: values.claudeExecutablePath,
    claudeConfigDir: values.claudeConfigDir,
    codexExecutablePath: values.codexExecutablePath,
    timeoutText: String(values.translationTimeoutMs),
    contextIdleText: String(values.translationContextIdleMinutes),
    contextMaxCharsText: String(values.translationContextMaxChars),
    translatePrompts: values.translatePrompts,
    translateResponses: values.translateResponses,
    translateNotifications: values.translateNotifications,
    translateReasoning: values.translateReasoning,
    translateAllTimelines: values.translateAllTimelines,
    translationContextEnabled: values.translationContextEnabled,
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
  const promptPreviewStyle = useMemo(
    () => ({
      color: theme.colors.foregroundMuted,
      backgroundColor: theme.colors.surface2,
      borderRadius: 8,
      padding: 10,
      fontSize: 12,
      lineHeight: 18,
    }),
    [theme],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  // Bumped only when the displayed form must reset (discard or save); editing
  // alone must not remount the inputs or the focused field loses focus.
  const [formResetCount, setFormResetCount] = useState(0);
  const [pickedProvider, setPickedProvider] = useState("");
  const [pickerFillCount, setPickerFillCount] = useState(0);
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
        setPickerFillCount((count) => count + 1);
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
  const changeEndpointProtocol = useCallback(
    (endpointProtocol: Draft["endpointProtocol"]) => patch({ endpointProtocol }),
    [patch],
  );
  const changeReasoningEffort = useCallback(
    (reasoningEffort: Draft["reasoningEffort"]) => patch({ reasoningEffort: reasoningEffort }),
    [patch],
  );
  const changeSystemPrompt = useCallback((systemPrompt: string) => patch({ systemPrompt }), [patch]);
  const changeDomainContext = useCallback(
    (domainContext: string) => patch({ domainContext }),
    [patch],
  );
  const changeExtraRules = useCallback((extraRules: string) => patch({ extraRules }), [patch]);
  // The custom-prompt editor stays out of the way until asked for: most
  // users only need Additional rules, and a full replacement silently stops
  // following built-in prompt improvements.
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
  const togglePromptPreview = useCallback(() => setPromptPreviewOpen((open) => !open), []);
  const openCustomPrompt = useCallback(() => {
    setCustomPromptOpen(true);
    setDraft((current) => {
      const base = current ?? (readyRef.current === null ? null : draftFrom(readyRef.current));
      if (base === null || base.systemPrompt.trim().length > 0) return base;
      return { ...base, systemPrompt: BUILT_IN_TRANSLATION_PROMPT_TEMPLATE };
    });
  }, []);
  const revertToBuiltInPrompt = useCallback(() => {
    setCustomPromptOpen(false);
    patch({ systemPrompt: "" });
  }, [patch]);
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
  const changeClaudeConfigDir = useCallback(
    (claudeConfigDir: string) => patch({ claudeConfigDir }),
    [patch],
  );
  const changeCodexPath = useCallback(
    (codexExecutablePath: string) => patch({ codexExecutablePath }),
    [patch],
  );
  const changeTimeout = useCallback((timeoutText: string) => patch({ timeoutText }), [patch]);
  const changeContextIdle = useCallback(
    (contextIdleText: string) => patch({ contextIdleText }),
    [patch],
  );
  const changeContextMaxChars = useCallback(
    (contextMaxCharsText: string) => patch({ contextMaxCharsText }),
    [patch],
  );
  const toggleContext = useCallback(
    (translationContextEnabled: boolean) => patch({ translationContextEnabled }),
    [patch],
  );
  const togglePrompts = useCallback(
    (translatePrompts: boolean) => patch({ translatePrompts }),
    [patch],
  );
  const toggleResponses = useCallback(
    (translateResponses: boolean) => patch({ translateResponses }),
    [patch],
  );
  const toggleReasoning = useCallback(
    (translateReasoning: boolean) => patch({ translateReasoning }),
    [patch],
  );
  const toggleNotifications = useCallback(
    (translateNotifications: boolean) => patch({ translateNotifications }),
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
    setCustomPromptOpen(false);
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
    const contextIdleMinutes = Number.parseInt(active.contextIdleText.trim(), 10);
    if (!Number.isFinite(contextIdleMinutes)) {
      setDraftError(t("contextIdleNotANumber"));
      return;
    }
    const contextMaxChars = Number.parseInt(active.contextMaxCharsText.trim(), 10);
    if (!Number.isFinite(contextMaxChars)) {
      setDraftError(t("contextMaxCharsNotANumber"));
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
        endpointProtocol: active.endpointProtocol,
        translationReasoningEffort: active.reasoningEffort,
        // An unedited copy of the seeded built-in template resolves to the
        // same prompt, but saved verbatim it would stop following built-in
        // prompt updates; store it as "use the built-in prompt" instead.
        translationSystemPrompt:
          active.systemPrompt.trim() === BUILT_IN_TRANSLATION_PROMPT_TEMPLATE.trim()
            ? ""
            : active.systemPrompt,
        translationDomainContext: active.domainContext,
        translationExtraRules: active.extraRules,
        userLanguage: active.userLanguage,
        agentLanguage: active.agentLanguage,
        innerAgentCommand: command,
        innerAgentEnv: active.innerAgentEnv,
        claudeExecutablePath: active.claudeExecutablePath,
        claudeConfigDir: active.claudeConfigDir,
        codexExecutablePath: active.codexExecutablePath,
        translatePrompts: active.translatePrompts,
        translateResponses: active.translateResponses,
        translateNotifications: active.translateNotifications,
        translateReasoning: active.translateReasoning,
        translateAllTimelines: active.translateAllTimelines,
        translationContextEnabled: active.translationContextEnabled,
        translationContextIdleMinutes: contextIdleMinutes,
        translationContextMaxChars: contextMaxChars,
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
  const instructionsInfo = useMemo<ReactNode>(
    () => <Text style={mutedStyle}>{t("sectionInstructionsInfo")}</Text>,
    [mutedStyle, t],
  );
  const agentsInfo = useMemo<ReactNode>(
    () => <Text style={mutedStyle}>{t("sectionAgentsInfo")}</Text>,
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
  const customPromptVisible = customPromptOpen || active.systemPrompt.trim().length > 0;
  // Live preview of exactly what the model receives for replies, from the
  // draft (unsaved edits included) and the shared resolver the server uses.
  const effectivePrompt = resolveTranslationSystemPrompt(
    {
      translationSystemPrompt: active.systemPrompt,
      translationDomainContext: active.domainContext,
      translationExtraRules: active.extraRules,
    },
    // agent → you: the direction users read most.
    { source: active.agentLanguage.trim(), target: active.userLanguage.trim() },
  );

  return (
    <>
      <SettingsSection title={t("sectionLanguages")}>
        <SettingsCard key={`languages-${formKey}`}>
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
          <SettingsSelect
            label={t("uiLanguage")}
            hint={t("uiLanguageHint")}
            value={active.uiLanguage}
            options={uiLanguageOptions}
            disabled={settings.saving}
            onValueChange={changeUiLanguage}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("sectionEndpoint")}>
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
            label={t("endpointProtocol")}
            hint={t("endpointProtocolHint")}
            value={active.endpointProtocol}
            options={[
              { label: t("protocolResponses"), value: "responses" as const },
              { label: t("protocolChatCompletions"), value: "chat-completions" as const },
            ]}
            disabled={settings.saving}
            onValueChange={changeEndpointProtocol}
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
          <SettingsInput
            label={t("translationTimeout")}
            hint={t("translationTimeoutHint")}
            initialValue={active.timeoutText}
            onChangeText={changeTimeout}
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("sectionScope")} info={sectionInfo}>
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
            label={t("translateReasoning")}
            hint={t("translateReasoningHint")}
            value={active.translateReasoning}
            onValueChange={toggleReasoning}
            disabled={settings.saving}
          />
          <SettingsSwitch
            label={t("translateNotifications")}
            hint={t("translateNotificationsHint")}
            value={active.translateNotifications}
            onValueChange={toggleNotifications}
            disabled={settings.saving}
          />
          <SettingsSwitch
            label={t("translateAllTimelines")}
            hint={t("translateAllTimelinesHint")}
            value={active.translateAllTimelines}
            onValueChange={toggleAllTimelines}
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("sectionInstructions")} info={instructionsInfo}>
        <SettingsCard>
          <SettingsRow label={t("extraRules")} hint={t("extraRulesHint")}>
            <TextInput
              accessibilityLabel={t("extraRules")}
              value={active.extraRules}
              onChangeText={changeExtraRules}
              editable={!settings.saving}
              multiline
              placeholder={t("extraRulesPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={promptInputStyle}
            />
          </SettingsRow>
          <SettingsRow label={t("domainContext")} hint={t("domainContextHint")}>
            <TextInput
              accessibilityLabel={t("domainContext")}
              value={active.domainContext}
              onChangeText={changeDomainContext}
              editable={!settings.saving}
              multiline
              placeholder={t("domainContextPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={promptInputStyle}
            />
          </SettingsRow>
          <SettingsAction
            label={t("promptPreview")}
            hint={t("promptPreviewHint")}
            actionLabel={promptPreviewOpen ? t("hide") : t("show")}
            onPress={togglePromptPreview}
          />
          {promptPreviewOpen ? (
            <Text selectable style={promptPreviewStyle}>
              {effectivePrompt}
            </Text>
          ) : null}
          {customPromptVisible ? (
            <>
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
              <SettingsAction
                label={t("useBuiltInPrompt")}
                hint={t("useBuiltInPromptHint")}
                actionLabel={t("revert")}
                disabled={settings.saving}
                onPress={revertToBuiltInPrompt}
              />
            </>
          ) : (
            <SettingsAction
              label={t("customizePrompt")}
              hint={t("customizePromptHint")}
              actionLabel={t("customize")}
              disabled={settings.saving}
              onPress={openCustomPrompt}
            />
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("sectionContext")}>
        <SettingsCard key={`context-${formKey}`}>
          <SettingsSwitch
            label={t("translationContext")}
            hint={t("translationContextHint")}
            value={active.translationContextEnabled}
            onValueChange={toggleContext}
            disabled={settings.saving}
          />
          {active.translationContextEnabled ? (
            <>
              <SettingsInput
                label={t("contextIdleMinutes")}
                hint={t("contextIdleHint")}
                initialValue={active.contextIdleText}
                onChangeText={changeContextIdle}
                disabled={settings.saving}
              />
              <SettingsInput
                label={t("contextMaxChars")}
                hint={t("contextMaxCharsHint")}
                initialValue={active.contextMaxCharsText}
                onChangeText={changeContextMaxChars}
                disabled={settings.saving}
              />
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("sectionAgents")} info={agentsInfo}>
        <SettingsCard key={`agents-${formKey}`}>
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
          {/* Uncontrolled input: remount when the picker fills the command,
              or the field would keep showing (and re-saving) the old text. */}
          <SettingsInput
            key={`command-${pickerFillCount}`}
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
            label={t("claudeConfigDir")}
            hint={t("claudeConfigDirHint")}
            initialValue={active.claudeConfigDir}
            onChangeText={changeClaudeConfigDir}
            disabled={settings.saving}
          />
          <SettingsInput
            label={t("codexExecutable")}
            hint={t("codexExecutableHint")}
            initialValue={active.codexExecutablePath}
            onChangeText={changeCodexPath}
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>

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
    </>
  );
}
