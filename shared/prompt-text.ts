/**
 * Shared prompt-text handling: serialized attachments must survive verbatim,
 * and flattened slash commands keep their command word so only the free-text
 * remainder is translated. Used by the fail-closed prompt path and by the
 * user-message display renderer (same split so the display job hits the
 * prompt-time cache key).
 */

export interface PromptTranslationParts {
  /** Verbatim prefix (`/cmd ` including trailing space, or empty). */
  prefix: string;
  /** Fragment the translator actually sees — the forward-cache key. */
  body: string;
}

export interface PromptTranslationFragment {
  original: string;
  translated: string;
}

/**
 * Detects text fragments that carry a serialized structured attachment. The
 * daemon flattens non-text attachments (forge issues, reviews, uploaded
 * files) into JSON text; translating that JSON would corrupt it, so the
 * fragment passes through verbatim. Free text inside such attachments is
 * documented as untranslated.
 */
export function isSerializedAttachment(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    return "mimeType" in parsed && typeof parsed.mimeType === "string";
  } catch {
    return false;
  }
}

/**
 * The translatable slice of one user-prompt fragment, or `null` when nothing
 * should be sent to the translator: blank text, serialized attachments, and
 * slash commands with no free-text remainder.
 */
export function promptTranslationParts(text: string): PromptTranslationParts | null {
  if (text.trim().length === 0) return null;
  if (isSerializedAttachment(text)) return null;
  if (!text.startsWith("/")) return { prefix: "", body: text };
  const match = /^(\S+\s*)([\s\S]*)$/.exec(text);
  const prefix = match?.[1];
  const body = match?.[2];
  if (prefix === undefined || body === undefined || body.trim().length === 0) return null;
  return { prefix, body };
}
