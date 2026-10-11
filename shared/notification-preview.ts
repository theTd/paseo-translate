import { z } from "zod";

export const NOTIFICATION_PREVIEW_PREFIX = "translate-notification-preview:";
export const NOTIFICATION_BOUNDARY_KIND = "notification-preview-boundary";
export const notificationBoundarySchema = z.object({});

// Independent of the interface locale: notifications follow the user's conversation language.
const fallbackMessages: Record<string, { finished: string; permission: string }> = {
  en: {
    finished: "Finished working. Translation unavailable.",
    permission: "Permission requested. Translation unavailable.",
  },
  zh: { finished: "工作已完成，翻译暂不可用。", permission: "需要授权，翻译暂不可用。" },
  ja: {
    finished: "作業が完了しました。翻訳を利用できません。",
    permission: "許可が必要です。翻訳を利用できません。",
  },
  ko: {
    finished: "작업이 완료되었습니다. 번역을 사용할 수 없습니다.",
    permission: "권한이 필요합니다. 번역을 사용할 수 없습니다.",
  },
  fr: {
    finished: "Travail terminé. Traduction indisponible.",
    permission: "Autorisation demandée. Traduction indisponible.",
  },
  es: {
    finished: "Trabajo finalizado. Traducción no disponible.",
    permission: "Se requiere permiso. Traducción no disponible.",
  },
  pt: {
    finished: "Trabalho concluído. Tradução indisponível.",
    permission: "Permissão solicitada. Tradução indisponível.",
  },
  ru: {
    finished: "Работа завершена. Перевод недоступен.",
    permission: "Требуется разрешение. Перевод недоступен.",
  },
  ar: { finished: "اكتمل العمل. الترجمة غير متاحة.", permission: "مطلوب إذن. الترجمة غير متاحة." },
  de: {
    finished: "Arbeit abgeschlossen. Übersetzung nicht verfügbar.",
    permission: "Berechtigung erforderlich. Übersetzung nicht verfügbar.",
  },
};

const languageNames: Record<string, string> = {
  english: "en",
  chinese: "zh",
  mandarin: "zh",
  japanese: "ja",
  korean: "ko",
  french: "fr",
  spanish: "es",
  portuguese: "pt",
  russian: "ru",
  arabic: "ar",
  german: "de",
};

export function notificationFallback(language: string, reason: "finished" | "permission"): string {
  const normalized = language.trim().toLowerCase();
  const base = languageNames[normalized] ?? normalized.split(/[-_]/)[0];
  // Unknown languages use a language-neutral preview, never the untranslated source.
  return fallbackMessages[base]?.[reason] ?? "...";
}

export function isNotificationPreview(messageId: string | undefined): boolean {
  return messageId?.startsWith(NOTIFICATION_PREVIEW_PREFIX) === true;
}
