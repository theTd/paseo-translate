import { randomUUID } from "node:crypto";
import {
  translationItemClose,
  translationItemOpen,
  wrapTranslationInput,
} from "../shared/translate";

/**
 * Display-path coalesce window. Timeline items from one session open fire
 * `translate.stream.start` independently; jobs that land in this window for
 * the same session+direction share one endpoint call. A lone live reply
 * still takes the single-item streaming path after the window.
 */
export const STREAM_COALESCE_DELAY_MS = 80;

/** Most source texts packed into one endpoint call. */
export const TRANSLATE_BATCH_MAX_ITEMS = 40;

/**
 * Most source characters packed into one call (under TRANSLATION_TEXT_LIMIT
 * so the tagged payload plus session context stays in one completion).
 */
export const TRANSLATE_BATCH_MAX_CHARS = 80_000;

export function pickBatchNonce(texts: readonly string[]): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const nonce = randomUUID().replace(/-/g, "");
    if (texts.every((text) => !text.includes(nonce))) return nonce;
  }
  throw new Error("Could not allocate a translation-batch nonce");
}

export function wrapTranslationBatch(texts: readonly string[], nonce: string): string {
  const items = texts.map((text, index) => {
    return `${translationItemOpen(nonce, index)}\n${text}\n${translationItemClose(nonce, index)}`;
  });
  return wrapTranslationInput(items.join("\n"));
}

/**
 * Pulls `count` tagged items out of a model response. Extra prose around
 * the tags is ignored; missing/empty items return null so the caller can
 * fall back to per-item translation.
 */
export function parseTranslationBatch(
  output: string,
  count: number,
  nonce: string,
): string[] | null {
  if (count < 1) return [];
  const results: string[] = [];
  let searchFrom = 0;
  for (let index = 0; index < count; index += 1) {
    const open = translationItemOpen(nonce, index);
    const close = translationItemClose(nonce, index);
    const start = output.indexOf(open, searchFrom);
    if (start < 0) return null;
    const contentStart = start + open.length;
    const end = output.indexOf(close, contentStart);
    if (end < 0) return null;
    let item = output.slice(contentStart, end);
    if (item.startsWith("\n")) item = item.slice(1);
    if (item.endsWith("\n")) item = item.slice(0, -1);
    if (item.trim().length === 0) return null;
    results.push(item);
    searchFrom = end + close.length;
  }
  return results;
}

/**
 * Greedy packs in input order. A single text longer than `maxChars` still
 * gets its own pack of one — the per-text TRANSLATION_TEXT_LIMIT already
 * refused anything that cannot be a standalone call.
 */
export function packTranslationBatches(
  texts: readonly string[],
  options?: { maxItems?: number; maxChars?: number },
): string[][] {
  const maxItems = options?.maxItems ?? TRANSLATE_BATCH_MAX_ITEMS;
  const maxChars = options?.maxChars ?? TRANSLATE_BATCH_MAX_CHARS;
  const packs: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (
      current.length > 0 &&
      (current.length >= maxItems || chars + text.length > maxChars)
    ) {
      packs.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length > 0) packs.push(current);
  return packs;
}
