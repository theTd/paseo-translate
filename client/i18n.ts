import { useMemo } from "react";

/**
 * Plugin-owned UI strings.
 *
 * The Paseo plugin SDK does not expose the host app's locale or its i18next
 * instance to plugins (the client bundle only receives react, react-native,
 * zod, TanStack Query and the `@getpaseo/plugin/*` modules; bundling our own
 * react-i18next copy would create a detached context that never sees the
 * host's `I18nextProvider`). So this plugin ships its own dictionary aligned
 * with the host's nine locales (see `packages/app/src/i18n/locales.ts`) and
 * detects the device locale dependency-free via `Intl`.
 *
 * Server-side error text stays English: the daemon is headless and has no
 * locale concept; only client-rendered strings go through this table.
 */

/** Locales the host app supports; the plugin mirrors the same set. */
export const PLUGIN_LOCALES = [
  "ar",
  "en",
  "es",
  "fr",
  "ja",
  "ko",
  "pt-BR",
  "ru",
  "zh-CN",
] as const;
export type PluginLocale = (typeof PLUGIN_LOCALES)[number];

/** Value of the plugin's own "Interface language" setting. */
export type UiLanguageSetting = "system" | PluginLocale;

export const DEFAULT_PLUGIN_LOCALE: PluginLocale = "en";

/** Native display names for the language picker (same as the host app). */
export const PLUGIN_LOCALE_NATIVE_NAMES: Record<PluginLocale, string> = {
  ar: "العربية",
  en: "English",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  "pt-BR": "Português brasileiro",
  ru: "Русский",
  "zh-CN": "简体中文",
};

const REGIONAL_LOCALES: Readonly<Record<string, PluginLocale>> = {
  ar: "ar",
  en: "en",
  es: "es",
  fr: "fr",
  ja: "ja",
  ko: "ko",
  ru: "ru",
};

/**
 * Maps system locale tags (e.g. `Intl.DateTimeFormat().resolvedOptions()`
 * `.locale`) to a supported locale. Mirrors the host's
 * `resolveSupportedLocale` so the plugin agrees with the app language on the
 * same device; unsupported tags fall back to English.
 */
export function resolvePluginLocaleFromTags(tags: readonly string[]): PluginLocale {
  for (const tag of tags) {
    const normalized = tag.toLowerCase();
    const base = normalized.split("-", 1)[0] ?? "";
    const regional = REGIONAL_LOCALES[base];
    if (regional) return regional;
    if (normalized === "pt" || normalized === "pt-br") return "pt-BR";
    if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-hans")) {
      return "zh-CN";
    }
  }
  return DEFAULT_PLUGIN_LOCALE;
}

/** Best-effort device locale without any import; never throws. */
export function detectSystemLocale(): PluginLocale {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof locale === "string" && locale.length > 0) {
      return resolvePluginLocaleFromTags([locale]);
    }
  } catch {
    // Intl missing or broken: fall through to the default.
  }
  return DEFAULT_PLUGIN_LOCALE;
}

/** Effective UI locale for a stored setting value. */
export function resolveUiLocale(setting: UiLanguageSetting): PluginLocale {
  return setting === "system" ? detectSystemLocale() : setting;
}

/** Reactive wrapper; re-resolves only when the stored setting changes. */
export function usePluginLocale(setting: UiLanguageSetting): PluginLocale {
  return useMemo(() => resolveUiLocale(setting), [setting]);
}

const en = {
  settingsTitle: "Translate",
  settingsInfo:
    "Prompts are translated before they reach the agent. Replies are translated in the app after each stream completes.",
  loadingSettings: "Loading settings…",
  settingsUnavailable: "Settings are unavailable.",
  retry: "Retry",
  reload: "Reload",
  resetDefaults: "Restore default settings",
  reset: "Reset",
  loadingProviders: "Loading daemon providers…",
  providersLoadError: "Could not load providers: {error}",
  providersLoadFailed: "failed",
  innerAgentPicker: "Inner agent (pick a daemon provider)",
  innerAgentPickerHint: "ACP providers fill the command from the daemon configuration automatically",
  pickerAdapterNote: "Filled the adapter command for {label} (npx downloads it on first use).",
  pickerKnownNote: "Filled the command for {label}.",
  pickerUnknownNote:
    "Cannot confirm whether '{label}' ships an ACP mode. If its CLI has one (like `omp acp` or `opencode acp`), enter that command manually below.",
  refreshProviders: "Refresh the daemon provider list",
  refresh: "Refresh",
  endpointUrl: "Endpoint base URL",
  endpointUrlHint: "OpenAI-compatible host, e.g. https://api.openai.com/v1",
  apiKey: "API key",
  apiKeyHint: "Optional for local endpoints",
  model: "Model",
  reasoningEffort: "Reasoning effort",
  reasoningEffortHint:
    "Thinking depth for translation requests; Default sends no parameter, None turns thinking off",
  effortDefault: "Default",
  effortNone: "None",
  effortMinimal: "Minimal",
  effortLow: "Low",
  effortMedium: "Medium",
  effortHigh: "High",
  systemPrompt: "Translation system prompt",
  systemPromptHint:
    "Custom instructions for the translation model. Empty uses the built-in default. {source} and {target} insert the language pair; editing this re-translates cached text.",
  systemPromptPlaceholder: "Empty = built-in default prompt",
  userLanguage: "Your language",
  userLanguageHint: "Language you write and read, e.g. en",
  agentLanguage: "Agent language",
  agentLanguageHint: "Language the agent reasons in, e.g. de",
  innerAgentCommand: "Inner agent command",
  innerAgentCommandHint:
    "ACP-speaking command for the Translate (ACP) provider; filled automatically by the picker above",
  claudeExecutable: "Claude Code executable",
  claudeExecutableHint:
    "Optional full path for the direct Translate (Claude Code) provider; leave empty to resolve from PATH",
  codexExecutable: "Codex executable",
  codexExecutableHint:
    "Optional full path for the direct Translate (Codex) provider; leave empty to resolve from PATH",
  translationTimeout: "Translation timeout (ms)",
  timeoutNotANumber: "Translation timeout must be a whole number of milliseconds.",
  translatePrompts: "Translate prompts",
  translatePromptsHint: "Fail closed: a failed translation blocks the prompt",
  translateResponses: "Translate replies",
  translateResponsesHint: "After the stream completes, in the app only",
  translateReasoning: "Translate thinking",
  translateReasoningHint: "Off by default; thinking blocks are long, and Translate replies must be on",
  translateAllTimelines: "Translate every agent's timeline",
  translateAllTimelinesHint: "Off: only agents using the Translate provider",
  saveSettings: "Save translate settings",
  save: "Save",
  discardChanges: "Discard unsaved changes",
  discard: "Discard",
  uiLanguage: "Interface language",
  uiLanguageHint:
    "Language of this plugin's own screens and hints; System follows the device locale",
  uiLanguageSystem: "System",
  translating: "Translating…",
  translationUnavailable: "Translation unavailable: {error}",
  translationFailedWord: "failed",
  retryTranslation: "Retry translation",
  showOriginal: "Show original",
  showTranslation: "Show translation",
  emptyTranslation: "Translation returned no text",
};

export type PluginStringKey = keyof typeof en;

type PluginDictionary = Record<PluginStringKey, string>;

const zhCN: PluginDictionary = {
  settingsTitle: "翻译",
  settingsInfo: "提示词会在到达智能体之前被翻译；回复则在每轮流式输出完成后在应用内翻译。",
  loadingSettings: "正在加载设置…",
  settingsUnavailable: "设置不可用。",
  retry: "重试",
  reload: "重新加载",
  resetDefaults: "恢复默认设置",
  reset: "重置",
  loadingProviders: "正在加载 daemon 提供方…",
  providersLoadError: "无法加载提供方：{error}",
  providersLoadFailed: "失败",
  innerAgentPicker: "内部智能体（从 daemon 提供方中选择）",
  innerAgentPickerHint: "ACP 提供方会自动填入 daemon 配置中的命令",
  pickerAdapterNote: "已为 {label} 填入适配器命令（首次使用时 npx 会自动下载）。",
  pickerKnownNote: "已为 {label} 填入命令。",
  pickerUnknownNote:
    "无法确认“{label}”是否提供 ACP 模式。如果它的 CLI 有（如 `omp acp` 或 `opencode acp`），请在下方手动输入。",
  refreshProviders: "刷新 daemon 提供方列表",
  refresh: "刷新",
  endpointUrl: "接口地址",
  endpointUrlHint: "OpenAI 兼容的服务地址，例如 https://api.openai.com/v1",
  apiKey: "API Key",
  apiKeyHint: "本地服务可留空",
  model: "模型",
  reasoningEffort: "推理强度",
  reasoningEffortHint: "翻译请求的思考深度；Default 不发送该参数，None 会关闭思考",
  effortDefault: "默认",
  effortNone: "无",
  effortMinimal: "极低",
  effortLow: "低",
  effortMedium: "中",
  effortHigh: "高",
  systemPrompt: "翻译系统提示词",
  systemPromptHint:
    "给翻译模型的自定义指令。留空使用内置默认提示词。{source} 与 {target} 会被替换为当前语言对；修改后缓存的译文会重新翻译。",
  systemPromptPlaceholder: "留空 = 使用内置默认提示词",
  userLanguage: "你的语言",
  userLanguageHint: "你书写和阅读的语言，例如 zh-CN",
  agentLanguage: "智能体语言",
  agentLanguageHint: "智能体思考所用的语言，例如 en",
  innerAgentCommand: "内部智能体命令",
  innerAgentCommandHint: "Translate (ACP) 提供方使用的 ACP 命令；通过上方选择器自动填入",
  claudeExecutable: "Claude Code 可执行文件",
  claudeExecutableHint: "直连 Translate (Claude Code) 提供方可填完整路径；留空则从 PATH 解析",
  codexExecutable: "Codex 可执行文件",
  codexExecutableHint: "直连 Translate (Codex) 提供方可填完整路径；留空则从 PATH 解析",
  translationTimeout: "翻译超时（毫秒）",
  timeoutNotANumber: "翻译超时必须是整数毫秒。",
  translatePrompts: "翻译提示词",
  translatePromptsHint: "失败时阻断：翻译失败会阻止本次提示词发送",
  translateResponses: "翻译回复",
  translateResponsesHint: "在流式输出完成后，仅在应用内翻译显示",
  translateReasoning: "翻译思考过程",
  translateReasoningHint: "默认关闭；思考块通常很长，且需要同时开启“翻译回复”",
  translateAllTimelines: "翻译所有智能体的时间线",
  translateAllTimelinesHint: "关闭：仅翻译使用 Translate 提供方的智能体",
  saveSettings: "保存翻译设置",
  save: "保存",
  discardChanges: "放弃未保存的修改",
  discard: "放弃",
  uiLanguage: "界面语言",
  uiLanguageHint: "本插件自身界面与提示的语言；跟随系统即使用设备语言",
  uiLanguageSystem: "跟随系统",
  translating: "翻译中…",
  translationUnavailable: "翻译不可用：{error}",
  translationFailedWord: "失败",
  retryTranslation: "重试翻译",
  showOriginal: "显示原文",
  showTranslation: "显示译文",
  emptyTranslation: "翻译未返回文本",
};

const ja: PluginDictionary = {
  settingsTitle: "翻訳",
  settingsInfo: "プロンプトはエージェントに届く前に翻訳されます。返答はストリーム完了後にアプリ内で翻訳されます。",
  loadingSettings: "設定を読み込み中…",
  settingsUnavailable: "設定を利用できません。",
  retry: "再試行",
  reload: "再読み込み",
  resetDefaults: "既定の設定に戻す",
  reset: "リセット",
  loadingProviders: "デーモンのプロバイダーを読み込み中…",
  providersLoadError: "プロバイダーを読み込めませんでした: {error}",
  providersLoadFailed: "失敗",
  innerAgentPicker: "内部エージェント（デーモンのプロバイダーから選択）",
  innerAgentPickerHint: "ACP プロバイダーはデーモン設定からコマンドを自動入力します",
  pickerAdapterNote: "{label} のアダプターコマンドを入力しました（初回利用時に npx がダウンロードします）。",
  pickerKnownNote: "{label} のコマンドを入力しました。",
  pickerUnknownNote:
    "「{label}」に ACP モードがあるか確認できません。CLI にある場合（`omp acp` や `opencode acp` など）、下に手動で入力してください。",
  refreshProviders: "デーモンのプロバイダー一覧を更新",
  refresh: "更新",
  endpointUrl: "エンドポイント URL",
  endpointUrlHint: "OpenAI 互換のホスト（例: https://api.openai.com/v1）",
  apiKey: "API キー",
  apiKeyHint: "ローカルエンドポイントでは省略可",
  model: "モデル",
  reasoningEffort: "推論の深さ",
  reasoningEffortHint:
    "翻訳リクエストの思考深度。Default はパラメーターを送らず、None は思考をオフにします",
  effortDefault: "既定",
  effortNone: "なし",
  effortMinimal: "最小",
  effortLow: "低",
  effortMedium: "中",
  effortHigh: "高",
  systemPrompt: "翻訳システムプロンプト",
  systemPromptHint:
    "翻訳モデルへの追加指示。空欄で内蔵の既定を使用。{source} と {target} は言語ペアに置換されます。編集するとキャッシュ済み訳文は再翻訳されます。",
  systemPromptPlaceholder: "空欄 = 内蔵の既定プロンプト",
  userLanguage: "あなたの言語",
  userLanguageHint: "読み書きする言語（例: ja）",
  agentLanguage: "エージェントの言語",
  agentLanguageHint: "エージェントが思考する言語（例: en）",
  innerAgentCommand: "内部エージェントのコマンド",
  innerAgentCommandHint: "Translate (ACP) プロバイダー用の ACP コマンド。上の選択から自動入力されます",
  claudeExecutable: "Claude Code 実行ファイル",
  claudeExecutableHint: "Translate (Claude Code) 用の任意のフルパス。空欄で PATH から解決します",
  codexExecutable: "Codex 実行ファイル",
  codexExecutableHint: "Translate (Codex) 用の任意のフルパス。空欄で PATH から解決します",
  translationTimeout: "翻訳タイムアウト (ms)",
  timeoutNotANumber: "翻訳タイムアウトはミリ秒の整数で入力してください。",
  translatePrompts: "プロンプトを翻訳",
  translatePromptsHint: "失敗時は送信を中止します",
  translateResponses: "返答を翻訳",
  translateResponsesHint: "ストリーム完了後にアプリ内でのみ翻訳",
  translateReasoning: "思考内容を翻訳",
  translateReasoningHint: "既定でオフ。思考ブロックは長いため、返答の翻訳もオンにする必要があります",
  translateAllTimelines: "すべてのエージェントを翻訳",
  translateAllTimelinesHint: "オフ: Translate プロバイダーのエージェントのみ",
  saveSettings: "翻訳設定を保存",
  save: "保存",
  discardChanges: "未保存の変更を破棄",
  discard: "破棄",
  uiLanguage: "表示言語",
  uiLanguageHint: "このプラグインの画面とヒントの言語。システムは端末の言語に従います",
  uiLanguageSystem: "システム",
  translating: "翻訳中…",
  translationUnavailable: "翻訳を利用できません: {error}",
  translationFailedWord: "失敗",
  retryTranslation: "翻訳を再試行",
  showOriginal: "原文を表示",
  showTranslation: "訳文を表示",
  emptyTranslation: "翻訳結果が空でした",
};

const ko: PluginDictionary = {
  settingsTitle: "번역",
  settingsInfo: "프롬프트는 에이전트에 전달되기 전에 번역됩니다. 답변은 스트림이 끝난 뒤 앱에서 번역됩니다.",
  loadingSettings: "설정을 불러오는 중…",
  settingsUnavailable: "설정을 사용할 수 없습니다.",
  retry: "다시 시도",
  reload: "다시 로드",
  resetDefaults: "기본 설정으로 복원",
  reset: "초기화",
  loadingProviders: "데몬 프로바이더를 불러오는 중…",
  providersLoadError: "프로바이더를 불러오지 못했습니다: {error}",
  providersLoadFailed: "실패",
  innerAgentPicker: "내부 에이전트(데몬 프로바이더에서 선택)",
  innerAgentPickerHint: "ACP 프로바이더는 데몬 설정에서 명령을 자동으로 채웁니다",
  pickerAdapterNote: "{label} 어댑터 명령을 입력했습니다(첫 사용 시 npx가 다운로드합니다).",
  pickerKnownNote: "{label} 명령을 입력했습니다.",
  pickerUnknownNote:
    "'{label}'의 ACP 모드 제공 여부를 확인할 수 없습니다. CLI에 있다면(`omp acp`, `opencode acp` 등) 아래에 직접 입력하세요.",
  refreshProviders: "데몬 프로바이더 목록 새로고침",
  refresh: "새로고침",
  endpointUrl: "엔드포인트 URL",
  endpointUrlHint: "OpenAI 호환 호스트(예: https://api.openai.com/v1)",
  apiKey: "API 키",
  apiKeyHint: "로컬 엔드포인트에서는 생략 가능",
  model: "모델",
  reasoningEffort: "추론 깊이",
  reasoningEffortHint: "번역 요청의 사고 깊이. Default는 파라미터를 보내지 않고, None은 사고를 끕니다",
  effortDefault: "기본값",
  effortNone: "없음",
  effortMinimal: "최소",
  effortLow: "낮음",
  effortMedium: "중간",
  effortHigh: "높음",
  systemPrompt: "번역 시스템 프롬프트",
  systemPromptHint:
    "번역 모델에 대한 추가 지시. 비워 두면 내장 기본값을 사용합니다. {source}와 {target}은 언어 쌍으로 바뀝니다. 수정하면 캐시된 번역이 다시 번역됩니다.",
  systemPromptPlaceholder: "비워 두기 = 내장 기본 프롬프트",
  userLanguage: "사용 언어",
  userLanguageHint: "읽고 쓰는 언어(예: ko)",
  agentLanguage: "에이전트 언어",
  agentLanguageHint: "에이전트가 사고하는 언어(예: en)",
  innerAgentCommand: "내부 에이전트 명령",
  innerAgentCommandHint: "Translate (ACP) 프로바이더용 ACP 명령. 위 선택기에서 자동 입력됩니다",
  claudeExecutable: "Claude Code 실행 파일",
  claudeExecutableHint: "Translate (Claude Code)용 전체 경로(선택). 비워 두면 PATH에서 찾습니다",
  codexExecutable: "Codex 실행 파일",
  codexExecutableHint: "Translate (Codex)용 전체 경로(선택). 비워 두면 PATH에서 찾습니다",
  translationTimeout: "번역 제한 시간(ms)",
  timeoutNotANumber: "번역 제한 시간은 밀리초 단위 정수로 입력하세요.",
  translatePrompts: "프롬프트 번역",
  translatePromptsHint: "실패 시 차단: 번역 실패 시 프롬프트가 전송되지 않습니다",
  translateResponses: "답변 번역",
  translateResponsesHint: "스트림 완료 후 앱에서만 번역됩니다",
  translateReasoning: "사고 과정 번역",
  translateReasoningHint: "기본값 끄기: 사고 블록이 길며, 답변 번역도 켜야 합니다",
  translateAllTimelines: "모든 에이전트 타임라인 번역",
  translateAllTimelinesHint: "끄기: Translate 프로바이더 에이전트만 번역",
  saveSettings: "번역 설정 저장",
  save: "저장",
  discardChanges: "저장하지 않은 변경 버리기",
  discard: "버리기",
  uiLanguage: "인터페이스 언어",
  uiLanguageHint: "이 플러그인 화면과 안내의 언어. 시스템은 기기 언어를 따릅니다",
  uiLanguageSystem: "시스템",
  translating: "번역 중…",
  translationUnavailable: "번역을 사용할 수 없습니다: {error}",
  translationFailedWord: "실패",
  retryTranslation: "번역 다시 시도",
  showOriginal: "원문 보기",
  showTranslation: "번역 보기",
  emptyTranslation: "번역 결과가 비어 있습니다",
};

const fr: PluginDictionary = {
  settingsTitle: "Traduction",
  settingsInfo:
    "Les prompts sont traduits avant d'atteindre l'agent. Les réponses sont traduites dans l'app une fois le flux terminé.",
  loadingSettings: "Chargement des paramètres…",
  settingsUnavailable: "Paramètres indisponibles.",
  retry: "Réessayer",
  reload: "Recharger",
  resetDefaults: "Restaurer les paramètres par défaut",
  reset: "Réinitialiser",
  loadingProviders: "Chargement des fournisseurs du daemon…",
  providersLoadError: "Impossible de charger les fournisseurs : {error}",
  providersLoadFailed: "échec",
  innerAgentPicker: "Agent interne (choisir un fournisseur du daemon)",
  innerAgentPickerHint: "Les fournisseurs ACP remplissent la commande depuis la configuration du daemon",
  pickerAdapterNote:
    "Commande d'adaptateur renseignée pour {label} (npx la téléchargera à la première utilisation).",
  pickerKnownNote: "Commande renseignée pour {label}.",
  pickerUnknownNote:
    "Impossible de confirmer si « {label} » propose un mode ACP. Si sa CLI en a un (comme `omp acp` ou `opencode acp`), saisissez-le manuellement ci-dessous.",
  refreshProviders: "Actualiser la liste des fournisseurs du daemon",
  refresh: "Actualiser",
  endpointUrl: "URL de base",
  endpointUrlHint: "Hôte compatible OpenAI, ex. https://api.openai.com/v1",
  apiKey: "Clé API",
  apiKeyHint: "Facultatif pour les endpoints locaux",
  model: "Modèle",
  reasoningEffort: "Effort de raisonnement",
  reasoningEffortHint:
    "Profondeur de réflexion des requêtes ; Default n'envoie pas le paramètre, None désactive la réflexion",
  effortDefault: "Défaut",
  effortNone: "Aucun",
  effortMinimal: "Minimal",
  effortLow: "Faible",
  effortMedium: "Moyen",
  effortHigh: "Élevé",
  systemPrompt: "Prompt système de traduction",
  systemPromptHint:
    "Instructions personnalisées pour le modèle. Vide = prompt intégré. {source} et {target} désignent la paire de langues ; toute modification retraduit le cache.",
  systemPromptPlaceholder: "Vide = prompt intégré par défaut",
  userLanguage: "Votre langue",
  userLanguageHint: "Langue d'écriture et de lecture, ex. fr",
  agentLanguage: "Langue de l'agent",
  agentLanguageHint: "Langue de raisonnement de l'agent, ex. en",
  innerAgentCommand: "Commande de l'agent interne",
  innerAgentCommandHint:
    "Commande ACP pour le fournisseur Translate (ACP) ; remplie par le sélecteur ci-dessus",
  claudeExecutable: "Exécutable Claude Code",
  claudeExecutableHint:
    "Chemin complet facultatif pour Translate (Claude Code) ; vide = résolution via PATH",
  codexExecutable: "Exécutable Codex",
  codexExecutableHint:
    "Chemin complet facultatif pour Translate (Codex) ; vide = résolution via PATH",
  translationTimeout: "Délai de traduction (ms)",
  timeoutNotANumber: "Le délai de traduction doit être un nombre entier de millisecondes.",
  translatePrompts: "Traduire les prompts",
  translatePromptsHint: "Échec bloquant : une traduction ratée bloque le prompt",
  translateResponses: "Traduire les réponses",
  translateResponsesHint: "Après la fin du flux, dans l'app uniquement",
  translateReasoning: "Traduire les réflexions",
  translateReasoningHint: "Désactivé par défaut : les blocs sont longs, et Traduire les réponses doit être actif",
  translateAllTimelines: "Traduire toutes les timelines",
  translateAllTimelinesHint: "Désactivé : seuls les agents Translate",
  saveSettings: "Enregistrer les paramètres",
  save: "Enregistrer",
  discardChanges: "Abandonner les modifications",
  discard: "Abandonner",
  uiLanguage: "Langue de l'interface",
  uiLanguageHint: "Langue des écrans de ce plugin ; Système suit la langue de l'appareil",
  uiLanguageSystem: "Système",
  translating: "Traduction…",
  translationUnavailable: "Traduction indisponible : {error}",
  translationFailedWord: "échec",
  retryTranslation: "Réessayer la traduction",
  showOriginal: "Voir l'original",
  showTranslation: "Voir la traduction",
  emptyTranslation: "La traduction n'a renvoyé aucun texte",
};

const es: PluginDictionary = {
  settingsTitle: "Traducción",
  settingsInfo:
    "Los prompts se traducen antes de llegar al agente. Las respuestas se traducen en la app cuando termina el stream.",
  loadingSettings: "Cargando ajustes…",
  settingsUnavailable: "Ajustes no disponibles.",
  retry: "Reintentar",
  reload: "Recargar",
  resetDefaults: "Restaurar valores predeterminados",
  reset: "Restablecer",
  loadingProviders: "Cargando proveedores del daemon…",
  providersLoadError: "No se pudieron cargar los proveedores: {error}",
  providersLoadFailed: "fallo",
  innerAgentPicker: "Agente interno (elige un proveedor del daemon)",
  innerAgentPickerHint: "Los proveedores ACP rellenan el comando desde la configuración del daemon",
  pickerAdapterNote: "Comando adaptador rellenado para {label} (npx lo descargará en el primer uso).",
  pickerKnownNote: "Comando rellenado para {label}.",
  pickerUnknownNote:
    "No se puede confirmar si «{label}» tiene modo ACP. Si su CLI lo tiene (como `omp acp` u `opencode acp`), escríbelo manualmente abajo.",
  refreshProviders: "Actualizar la lista de proveedores del daemon",
  refresh: "Actualizar",
  endpointUrl: "URL base",
  endpointUrlHint: "Host compatible con OpenAI, p. ej. https://api.openai.com/v1",
  apiKey: "Clave API",
  apiKeyHint: "Opcional para endpoints locales",
  model: "Modelo",
  reasoningEffort: "Esfuerzo de razonamiento",
  reasoningEffortHint:
    "Profundidad de pensamiento; Default omite el parámetro, None desactiva el pensamiento",
  effortDefault: "Predeterminado",
  effortNone: "Ninguno",
  effortMinimal: "Mínimo",
  effortLow: "Bajo",
  effortMedium: "Medio",
  effortHigh: "Alto",
  systemPrompt: "Prompt de sistema de traducción",
  systemPromptHint:
    "Instrucciones personalizadas para el modelo. Vacío = prompt integrado. {source} y {target} indican el par de idiomas; editarlo retraduce la caché.",
  systemPromptPlaceholder: "Vacío = prompt integrado predeterminado",
  userLanguage: "Tu idioma",
  userLanguageHint: "Idioma de escritura y lectura, p. ej. es",
  agentLanguage: "Idioma del agente",
  agentLanguageHint: "Idioma de razonamiento del agente, p. ej. en",
  innerAgentCommand: "Comando del agente interno",
  innerAgentCommandHint:
    "Comando ACP para el proveedor Translate (ACP); se rellena con el selector superior",
  claudeExecutable: "Ejecutable de Claude Code",
  claudeExecutableHint:
    "Ruta completa opcional para Translate (Claude Code); vacío = resolver desde PATH",
  codexExecutable: "Ejecutable de Codex",
  codexExecutableHint:
    "Ruta completa opcional para Translate (Codex); vacío = resolver desde PATH",
  translationTimeout: "Tiempo límite (ms)",
  timeoutNotANumber: "El tiempo límite debe ser un número entero de milisegundos.",
  translatePrompts: "Traducir prompts",
  translatePromptsHint: "Bloqueo ante fallos: una traducción fallida bloquea el prompt",
  translateResponses: "Traducir respuestas",
  translateResponsesHint: "Tras completar el stream, solo en la app",
  translateReasoning: "Traducir el razonamiento",
  translateReasoningHint: "Desactivado por defecto: los bloques son largos y requiere Traducir respuestas",
  translateAllTimelines: "Traducir todas las timelines",
  translateAllTimelinesHint: "Desactivado: solo agentes con proveedor Translate",
  saveSettings: "Guardar ajustes",
  save: "Guardar",
  discardChanges: "Descartar cambios sin guardar",
  discard: "Descartar",
  uiLanguage: "Idioma de la interfaz",
  uiLanguageHint: "Idioma de las pantallas de este plugin; Sistema sigue el idioma del dispositivo",
  uiLanguageSystem: "Sistema",
  translating: "Traduciendo…",
  translationUnavailable: "Traducción no disponible: {error}",
  translationFailedWord: "fallo",
  retryTranslation: "Reintentar traducción",
  showOriginal: "Ver original",
  showTranslation: "Ver traducción",
  emptyTranslation: "La traducción no devolvió texto",
};

const ru: PluginDictionary = {
  settingsTitle: "Перевод",
  settingsInfo:
    "Запросы переводятся до того, как попадут к агенту. Ответы переводятся в приложении после завершения потока.",
  loadingSettings: "Загрузка настроек…",
  settingsUnavailable: "Настройки недоступны.",
  retry: "Повторить",
  reload: "Перезагрузить",
  resetDefaults: "Восстановить настройки по умолчанию",
  reset: "Сбросить",
  loadingProviders: "Загрузка провайдеров демона…",
  providersLoadError: "Не удалось загрузить провайдеры: {error}",
  providersLoadFailed: "ошибка",
  innerAgentPicker: "Внутренний агент (выберите провайдера демона)",
  innerAgentPickerHint: "ACP-провайдеры подставляют команду из конфигурации демона автоматически",
  pickerAdapterNote: "Подставлена команда адаптера для {label} (npx загрузит её при первом использовании).",
  pickerKnownNote: "Подставлена команда для {label}.",
  pickerUnknownNote:
    "Не удаётся подтвердить, есть ли у «{label}» режим ACP. Если в его CLI он есть (например, `omp acp` или `opencode acp`), введите команду вручную ниже.",
  refreshProviders: "Обновить список провайдеров демона",
  refresh: "Обновить",
  endpointUrl: "Базовый URL",
  endpointUrlHint: "OpenAI-совместимый хост, например https://api.openai.com/v1",
  apiKey: "API-ключ",
  apiKeyHint: "Необязательно для локальных эндпоинтов",
  model: "Модель",
  reasoningEffort: "Глубина рассуждений",
  reasoningEffortHint:
    "Глубина мышления для запросов; Default не отправляет параметр, None отключает мышление",
  effortDefault: "По умолчанию",
  effortNone: "Нет",
  effortMinimal: "Минимальная",
  effortLow: "Низкая",
  effortMedium: "Средняя",
  effortHigh: "Высокая",
  systemPrompt: "Системный промпт перевода",
  systemPromptHint:
    "Свои инструкции для модели перевода. Пусто — встроенный по умолчанию. {source} и {target} подставляют языковую пару; правка заново переводит кэш.",
  systemPromptPlaceholder: "Пусто = встроенный промпт по умолчанию",
  userLanguage: "Ваш язык",
  userLanguageHint: "Язык, на котором вы пишете и читаете, например ru",
  agentLanguage: "Язык агента",
  agentLanguageHint: "Язык, на котором рассуждает агент, например en",
  innerAgentCommand: "Команда внутреннего агента",
  innerAgentCommandHint: "ACP-команда для провайдера Translate (ACP); подставляется выбором выше",
  claudeExecutable: "Исполняемый файл Claude Code",
  claudeExecutableHint: "Необязательный полный путь для Translate (Claude Code); пусто — поиск в PATH",
  codexExecutable: "Исполняемый файл Codex",
  codexExecutableHint: "Необязательный полный путь для Translate (Codex); пусто — поиск в PATH",
  translationTimeout: "Таймаут перевода (мс)",
  timeoutNotANumber: "Таймаут перевода должен быть целым числом миллисекунд.",
  translatePrompts: "Переводить запросы",
  translatePromptsHint: "Строгий режим: неудачный перевод блокирует запрос",
  translateResponses: "Переводить ответы",
  translateResponsesHint: "После завершения потока, только в приложении",
  translateReasoning: "Переводить размышления",
  translateReasoningHint: "Выкл. по умолчанию: блоки длинные, требуется «Переводить ответы»",
  translateAllTimelines: "Переводить все таймлайны",
  translateAllTimelinesHint: "Выкл.: только агенты с провайдером Translate",
  saveSettings: "Сохранить настройки перевода",
  save: "Сохранить",
  discardChanges: "Отменить несохранённые изменения",
  discard: "Отменить",
  uiLanguage: "Язык интерфейса",
  uiLanguageHint: "Язык экранов этого плагина; «Система» — язык устройства",
  uiLanguageSystem: "Система",
  translating: "Перевод…",
  translationUnavailable: "Перевод недоступен: {error}",
  translationFailedWord: "ошибка",
  retryTranslation: "Повторить перевод",
  showOriginal: "Показать оригинал",
  showTranslation: "Показать перевод",
  emptyTranslation: "Перевод не вернул текст",
};

const ptBR: PluginDictionary = {
  settingsTitle: "Tradução",
  settingsInfo:
    "Os prompts são traduzidos antes de chegar ao agente. As respostas são traduzidas no app quando o stream termina.",
  loadingSettings: "Carregando configurações…",
  settingsUnavailable: "Configurações indisponíveis.",
  retry: "Tentar novamente",
  reload: "Recarregar",
  resetDefaults: "Restaurar padrões",
  reset: "Redefinir",
  loadingProviders: "Carregando provedores do daemon…",
  providersLoadError: "Não foi possível carregar os provedores: {error}",
  providersLoadFailed: "falha",
  innerAgentPicker: "Agente interno (escolha um provedor do daemon)",
  innerAgentPickerHint: "Provedores ACP preenchem o comando a partir da configuração do daemon",
  pickerAdapterNote: "Comando adaptador preenchido para {label} (o npx fará o download no primeiro uso).",
  pickerKnownNote: "Comando preenchido para {label}.",
  pickerUnknownNote:
    "Não é possível confirmar se «{label}» tem modo ACP. Se a CLI tiver (como `omp acp` ou `opencode acp`), digite o comando manualmente abaixo.",
  refreshProviders: "Atualizar a lista de provedores do daemon",
  refresh: "Atualizar",
  endpointUrl: "URL base",
  endpointUrlHint: "Host compatível com OpenAI, ex. https://api.openai.com/v1",
  apiKey: "Chave API",
  apiKeyHint: "Opcional para endpoints locais",
  model: "Modelo",
  reasoningEffort: "Esforço de raciocínio",
  reasoningEffortHint: "Profundidade de pensamento; Default omite o parâmetro, None desativa o raciocínio",
  effortDefault: "Padrão",
  effortNone: "Nenhum",
  effortMinimal: "Mínimo",
  effortLow: "Baixo",
  effortMedium: "Médio",
  effortHigh: "Alto",
  systemPrompt: "Prompt de sistema da tradução",
  systemPromptHint:
    "Instruções personalizadas para o modelo. Vazio = prompt integrado. {source} e {target} indicam o par de idiomas; editar retraduz o cache.",
  systemPromptPlaceholder: "Vazio = prompt integrado padrão",
  userLanguage: "Seu idioma",
  userLanguageHint: "Idioma de escrita e leitura, ex. pt-BR",
  agentLanguage: "Idioma do agente",
  agentLanguageHint: "Idioma de raciocínio do agente, ex. en",
  innerAgentCommand: "Comando do agente interno",
  innerAgentCommandHint: "Comando ACP para o provedor Translate (ACP); preenchido pelo seletor acima",
  claudeExecutable: "Executável do Claude Code",
  claudeExecutableHint:
    "Caminho completo opcional para o Translate (Claude Code); vazio = resolver via PATH",
  codexExecutable: "Executável do Codex",
  codexExecutableHint:
    "Caminho completo opcional para o Translate (Codex); vazio = resolver via PATH",
  translationTimeout: "Tempo limite (ms)",
  timeoutNotANumber: "O tempo limite deve ser um número inteiro de milissegundos.",
  translatePrompts: "Traduzir prompts",
  translatePromptsHint: "Falha bloqueia: uma tradução com falha bloqueia o prompt",
  translateResponses: "Traduzir respostas",
  translateResponsesHint: "Após concluir o stream, só no app",
  translateReasoning: "Traduzir raciocínio",
  translateReasoningHint: "Desligado por padrão: blocos longos; exige Traduzir respostas",
  translateAllTimelines: "Traduzir todas as timelines",
  translateAllTimelinesHint: "Desligado: só agentes com o provedor Translate",
  saveSettings: "Salvar configurações",
  save: "Salvar",
  discardChanges: "Descartar alterações não salvas",
  discard: "Descartar",
  uiLanguage: "Idioma da interface",
  uiLanguageHint: "Idioma das telas deste plugin; Sistema segue o idioma do dispositivo",
  uiLanguageSystem: "Sistema",
  translating: "Traduzindo…",
  translationUnavailable: "Tradução indisponível: {error}",
  translationFailedWord: "falha",
  retryTranslation: "Tentar traduzir de novo",
  showOriginal: "Ver original",
  showTranslation: "Ver tradução",
  emptyTranslation: "A tradução não retornou texto",
};

const ar: PluginDictionary = {
  settingsTitle: "الترجمة",
  settingsInfo: "تُترجم المطالبات قبل وصولها إلى الوكيل. تُترجم الردود داخل التطبيق بعد اكتمال البث.",
  loadingSettings: "جارٍ تحميل الإعدادات…",
  settingsUnavailable: "الإعدادات غير متاحة.",
  retry: "إعادة المحاولة",
  reload: "إعادة التحميل",
  resetDefaults: "استعادة الإعدادات الافتراضية",
  reset: "إعادة تعيين",
  loadingProviders: "جارٍ تحميل موفري الخدمة…",
  providersLoadError: "تعذّر تحميل موفري الخدمة: {error}",
  providersLoadFailed: "فشل",
  innerAgentPicker: "الوكيل الداخلي (اختر موفر خدمة)",
  innerAgentPickerHint: "يملأ موفرو ACP الأمر تلقائيًا من إعدادات الخادم",
  pickerAdapterNote: "تم إدخال أمر المحوّل لـ {label} (سيقوم npx بتنزيله عند أول استخدام).",
  pickerKnownNote: "تم إدخال الأمر لـ {label}.",
  pickerUnknownNote:
    "تعذّر التأكد مما إذا كان «{label}» يدعم وضع ACP. إذا كانت واجهته تدعمه (مثل `omp acp` أو `opencode acp`)، أدخل الأمر يدويًا أدناه.",
  refreshProviders: "تحديث قائمة موفري الخدمة",
  refresh: "تحديث",
  endpointUrl: "عنوان الأساس",
  endpointUrlHint: "مضيف متوافق مع OpenAI، مثل https://api.openai.com/v1",
  apiKey: "مفتاح API",
  apiKeyHint: "اختياري للنقاط المحلية",
  model: "النموذج",
  reasoningEffort: "عمق التفكير",
  reasoningEffortHint: "عمق التفكير لطلبات الترجمة؛ Default لا يرسل المعامل، وNone يوقف التفكير",
  effortDefault: "افتراضي",
  effortNone: "بدون",
  effortMinimal: "أدنى",
  effortLow: "منخفض",
  effortMedium: "متوسط",
  effortHigh: "مرتفع",
  systemPrompt: "موجه نظام الترجمة",
  systemPromptHint:
    "تعليمات مخصصة لنموذج الترجمة. الفراغ يستخدم المدمج. {source} و{target} يحددان الزوج اللغوي؛ التعديل يعيد ترجمة المخزن.",
  systemPromptPlaceholder: "الفراغ = الموجه المدمج الافتراضي",
  userLanguage: "لغتك",
  userLanguageHint: "لغة الكتابة والقراءة، مثل ar",
  agentLanguage: "لغة الوكيل",
  agentLanguageHint: "لغة تفكير الوكيل، مثل en",
  innerAgentCommand: "أمر الوكيل الداخلي",
  innerAgentCommandHint: "أمر ACP لموفر Translate (ACP)؛ يُملأ تلقائيًا من المنتقي أعلاه",
  claudeExecutable: "ملف Claude Code التنفيذي",
  claudeExecutableHint: "مسار كامل اختياري لموفر Translate (Claude Code)؛ الفراغ يعني الحل عبر PATH",
  codexExecutable: "ملف Codex التنفيذي",
  codexExecutableHint: "مسار كامل اختياري لموفر Translate (Codex)؛ الفراغ يعني الحل عبر PATH",
  translationTimeout: "مهلة الترجمة (ms)",
  timeoutNotANumber: "يجب أن تكون مهلة الترجمة عددًا صحيحًا بالملي ثانية.",
  translatePrompts: "ترجمة المطالبات",
  translatePromptsHint: "الفشل يمنع الإرسال: الترجمة الفاشلة تحظر المطالبة",
  translateResponses: "ترجمة الردود",
  translateResponsesHint: "بعد اكتمال البث، داخل التطبيق فقط",
  translateReasoning: "ترجمة التفكير",
  translateReasoningHint: "إيقاف افتراضيًا: الكتل طويلة، ويتطلب تفعيل ترجمة الردود",
  translateAllTimelines: "ترجمة كل الجداول الزمنية",
  translateAllTimelinesHint: "إيقاف: وكلاء موفر Translate فقط",
  saveSettings: "حفظ إعدادات الترجمة",
  save: "حفظ",
  discardChanges: "تجاهل التغييرات غير المحفوظة",
  discard: "تجاهل",
  uiLanguage: "لغة الواجهة",
  uiLanguageHint: "لغة شاشات هذه الإضافة؛ النظام يتبع لغة الجهاز",
  uiLanguageSystem: "النظام",
  translating: "جارٍ الترجمة…",
  translationUnavailable: "الترجمة غير متاحة: {error}",
  translationFailedWord: "فشل",
  retryTranslation: "إعادة محاولة الترجمة",
  showOriginal: "عرض الأصل",
  showTranslation: "عرض الترجمة",
  emptyTranslation: "لم تُرجع الترجمة أي نص",
};

const STRINGS: Record<PluginLocale, PluginDictionary> = {
  ar,
  en,
  es,
  fr,
  ja,
  ko,
  "pt-BR": ptBR,
  ru,
  "zh-CN": zhCN,
};

/** Every key the English table defines; all locales must carry the same set. */
export const PLUGIN_STRING_KEYS: readonly PluginStringKey[] = Object.keys(en).sort() as PluginStringKey[];

/** Raw key set of one locale table; used by the parity test. */
export function pluginLocaleKeys(locale: PluginLocale): readonly string[] {
  return Object.keys(STRINGS[locale]).sort();
}

export type TranslateVars = Record<string, string | number>;

/**
 * Looks up a UI string with English fallback. `{name}` placeholders are
 * filled from `vars`; unknown placeholders are left verbatim so hints that
 * document `{source}`/`{target}` survive without arguments.
 */
export function translate(
  locale: PluginLocale,
  key: PluginStringKey,
  vars?: TranslateVars,
): string {
  const table = STRINGS[locale] ?? STRINGS.en;
  const template = table[key] ?? STRINGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name]),
  );
}

/** Bound translator for the current settings value. */
export function useTranslate(setting: UiLanguageSetting): {
  locale: PluginLocale;
  t: (key: PluginStringKey, vars?: TranslateVars) => string;
} {
  const locale = usePluginLocale(setting);
  return useMemo(
    () => ({ locale, t: (key: PluginStringKey, vars?: TranslateVars) => translate(locale, key, vars) }),
    [locale],
  );
}
