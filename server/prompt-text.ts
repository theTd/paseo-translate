/**
 * Shared prompt-text handling for both translate providers: serialized
 * attachments must survive verbatim, and flattened slash commands keep their
 * command word so only the free-text remainder is translated.
 */

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
    return typeof (parsed as { mimeType?: unknown }).mimeType === "string";
  } catch {
    return false;
  }
}

/**
 * Translates one user-language fragment. Slash-command prompts reach the wire
 * as `/name args` text; the command word must survive verbatim and only the
 * free-text remainder is translated.
 */
export async function translatePromptFragment(
  text: string,
  translate: (text: string) => Promise<string>,
): Promise<string> {
  if (text.trim().length === 0) return text;
  if (isSerializedAttachment(text)) return text;
  if (!text.startsWith("/")) return translate(text);
  const match = /^(\S+\s*)([\s\S]*)$/.exec(text);
  if (match === null || match[2].trim().length === 0) return text;
  return `${match[1]}${await translate(match[2])}`;
}

/**
 * Reverse of {@link translatePromptFragment} for history replay: maps one
 * agent-language block back to the exact user-language fragment recorded at
 * prompt time. `lookup` resolves a single translated fragment (args or whole
 * text) to its original, or undefined on a miss. Slash prefixes, serialized
 * attachments, and blank/arg-less commands pass through untouched; a missed
 * lookup keeps the translated block so the caller can fall back to a
 * back-translation or keep it as-is.
 */
export function restorePromptFragment(
  translated: string,
  lookup: (translatedFragment: string) => string | undefined,
): string {
  if (translated.trim().length === 0) return translated;
  if (isSerializedAttachment(translated)) return translated;
  if (!translated.startsWith("/")) return lookup(translated) ?? translated;
  const match = /^(\S+\s*)([\s\S]*)$/.exec(translated);
  if (match === null || match[2].trim().length === 0) return translated;
  const restored = lookup(match[2]);
  return restored === undefined ? translated : `${match[1]}${restored}`;
}
