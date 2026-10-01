/**
 * Shared prompt-text handling for both translate providers: serialized
 * attachments must survive verbatim, and flattened slash commands keep their
 * command word so only the free-text remainder is translated.
 */

import { isSerializedAttachment, promptTranslationParts } from "../shared/prompt-text";

export { isSerializedAttachment, promptTranslationParts } from "../shared/prompt-text";

/**
 * Translates one user-language fragment. Slash-command prompts reach the wire
 * as `/name args` text; the command word must survive verbatim and only the
 * free-text remainder is translated.
 */
export async function translatePromptFragment(
  text: string,
  translate: (text: string) => Promise<string>,
): Promise<string> {
  const parts = promptTranslationParts(text);
  if (parts === null) return text;
  return `${parts.prefix}${await translate(parts.body)}`;
}

/** Replayed rows can contain serialized attachment blocks joined with prose. */
export async function translatePromptDisplay(
  text: string,
  translate: (text: string, onDelta: (delta: string) => void) => Promise<string>,
  onPartial?: (text: string) => void,
): Promise<string> {
  const fragments: string[] = [];
  let prose: string[] = [];
  for (const line of text.split("\n")) {
    if (isSerializedAttachment(line.trim())) {
      if (prose.length > 0) fragments.push(prose.join("\n"));
      prose = [];
      fragments.push(line);
    } else {
      prose.push(line);
    }
  }
  if (prose.length > 0) fragments.push(prose.join("\n"));
  const translated: string[] = [];
  for (const fragment of fragments) {
    if (isSerializedAttachment(fragment.trim()) || fragment.trim().length === 0) {
      translated.push(fragment);
    } else {
      let partial = "";
      const result = await translate(fragment, (delta) => {
        partial += delta;
        onPartial?.([...translated, partial].join("\n"));
      });
      translated.push(result);
    }
    onPartial?.(translated.join("\n"));
  }
  return translated.join("\n");
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
  const prefix = match?.[1];
  const body = match?.[2];
  if (prefix === undefined || body === undefined || body.trim().length === 0) return translated;
  const restored = lookup(body);
  return restored === undefined ? translated : `${prefix}${restored}`;
}
