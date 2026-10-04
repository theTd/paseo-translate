/**
 * Ask-question adaptation for the translate providers.
 *
 * Paseo surfaces an agent's clarifying questions as a `question` permission
 * (`QuestionFormCard` in the app): `input.questions[]` carries
 * `header/question/options[{label,description}]/multiSelect`, and the user's
 * answer comes back as `updatedInput.answers` keyed by question header with
 * either a free-text value or joined option labels.
 *
 * Claude's `AskUserQuestion` tool is this shape: its answer keys must match
 * the full question text, not the header. This module ports the native
 * provider's normalization (see `agent.ts` in Paseo's Claude provider) and
 * adds the translation layer both providers need:
 *
 * - agent → user: question/header/option strings are translated for display
 *   before the permission is emitted. Fail soft: translation failure keeps
 *   the original text so the turn is never broken by a display problem.
 * - user → agent: answer values are translated back before they reach the
 *   model. Fail closed: translation failure denies the request instead of
 *   leaking user-language text to the agent.
 */

import { isDataUriImageOnlyText } from "../shared/translate";

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** True when this tool call carries Paseo's question permission payload. */
export function isAskUserQuestionRequest(toolName: string, input: unknown): boolean {
  return (
    toolName === ASK_USER_QUESTION_TOOL && isRecord(input) && Array.isArray(input.questions)
  );
}

/**
 * Ports `normalizeClaudeAskUserQuestionRequestInput`: Claude's schema says
 * "Other" is host-provided, while Paseo's question UI reads `allowOther` for
 * the freeform answer path. Returns a copy; the input is never mutated.
 */
export function normalizeQuestionRequestInput(input: RecordLike): RecordLike {
  if (!Array.isArray(input.questions)) return input;
  return {
    ...input,
    questions: (input.questions as unknown[]).map((item) => {
      if (!isRecord(item)) return item;
      return { ...item, allowOther: true };
    }),
  };
}

/**
 * Ports `stripClaudeAskUserQuestionUiMetadata`: drops the UI-only `allowOther`
 * flag before the input travels back to Claude. Returns a copy.
 */
export function stripQuestionUiMetadata(input: RecordLike): RecordLike {
  if (!Array.isArray(input.questions)) return input;
  return {
    ...input,
    questions: (input.questions as unknown[]).map((item) => {
      if (!isRecord(item) || !("allowOther" in item)) return item;
      const copy: RecordLike = { ...item };
      delete copy.allowOther;
      return copy;
    }),
  };
}

/**
 * Ports `buildClaudeQuestionPermissionSummary`: notification-friendly
 * title/description derived from the (already translated) questions so push
 * and permission surfaces never render raw JSON.
 */
export function summarizeQuestions(input: RecordLike): { title?: string; description?: string } {
  if (!Array.isArray(input.questions)) return {};
  const first = (input.questions as unknown[]).find(isRecord);
  const title = first !== undefined ? readNonEmptyString(first.question) : null;
  if (title === null) return {};
  const rawOptions = isRecord(first) ? first.options : undefined;
  const labels = Array.isArray(rawOptions)
    ? rawOptions
        .map((option) => {
          if (typeof option === "string") return option.trim();
          return isRecord(option) && typeof option.label === "string"
            ? option.label.trim()
            : "";
        })
        .filter((label) => label.length > 0)
    : [];
  return labels.length > 0 ? { title, description: labels.join(" / ") } : { title };
}

function isTranslatable(value: unknown): value is string {
  // Data-URI image texts carry no language: translating them burns endpoint
  // quota on base64 soup (see isDataUriImageOnlyText).
  return (
    typeof value === "string" && value.trim().length > 0 && !isDataUriImageOnlyText(value)
  );
}

/**
 * Host check: Paseo renders `question` permissions with its own
 * `QuestionFormCard` — the plugin client API only offers timeline
 * transformers/renderers, no permission-card hook — so an原文/译文 toggle
 * cannot be injected. Both languages are embedded in the one emitted string:
 * translation first (what the user reads), original second (for verifying
 * exact terms). Identical texts collapse to one line.
 */

/** Short single-line fields (header, option labels): `译文 (原文)`. */
function bilingualInline(translated: string, original: string): string {
  if (translated.trim() === original.trim()) return translated;
  return `${translated} (${original})`;
}
/**
 * Translates one question item's display strings (question, header, option
 * labels/descriptions) into the user language. Structure, keys, and flags
 * (`multiSelect`, `allowOther`, …) pass through untouched. Rejects when any
 * translation fails; the caller decides whether to degrade (display path) or
 * block (answer path).
 */
async function translateQuestionItem(
  item: unknown,
  translate: (text: string) => Promise<string>,
): Promise<unknown> {
  if (!isRecord(item)) return item;
  const copy: RecordLike = { ...item };
  if (isTranslatable(item.question)) {
    const original = item.question as string;
    const translated = await translate(original);
    if (translated.trim().length === 0) {
      copy.question = original;
    } else if (translated.trim() === original.trim()) {
      copy.question = translated;
    } else {
      copy.question = `${translated}\n${original}`;
    }
  }
  if (isTranslatable(item.header)) {
    const original = item.header as string;
    const translated = await translate(original);
    copy.header = translated.trim().length > 0 ? bilingualInline(translated, original) : original;
  }
  if (Array.isArray(item.options)) {
    const options: unknown[] = [];
    for (const option of item.options as unknown[]) {
      // String options carry a bare label; translate it like a record label.
      if (typeof option === "string") {
        if (!isTranslatable(option)) {
          options.push(option);
          continue;
        }
        const translated = await translate(option);
        options.push(translated.trim().length > 0 ? bilingualInline(translated, option) : option);
        continue;
      }
      if (!isRecord(option)) {
        options.push(option);
        continue;
      }
      const optionCopy: RecordLike = { ...option };
      if (isTranslatable(option.label)) {
        const original = option.label as string;
        const translated = await translate(original);
        optionCopy.label =
          translated.trim().length > 0 ? bilingualInline(translated, original) : original;
      }
      if (isTranslatable(option.description)) {
        const original = option.description as string;
        const translated = await translate(original);
        if (translated.trim().length === 0) {
          optionCopy.description = original;
        } else if (translated.trim() === original.trim()) {
          optionCopy.description = translated;
        } else {
          optionCopy.description = `${translated}\n${original}`;
        }
      }
      options.push(optionCopy);
    }
    copy.options = options;
  }
  return copy;
}

/**
 * Agent → user: translates every question in the list for display. Returns a
 * new list; the input is never mutated.
 */
export async function translateQuestionsForDisplay(
  questions: unknown[],
  translate: (text: string) => Promise<string>,
): Promise<unknown[]> {
  const translated: unknown[] = [];
  for (const item of questions) {
    translated.push(await translateQuestionItem(item, translate));
  }
  return translated;
}

function readAnswers(updatedInput: unknown): RecordLike | null {
  if (!isRecord(updatedInput)) return null;
  const answers = updatedInput.answers;
  return isRecord(answers) ? answers : null;
}

/**
 * User → agent: remaps header-keyed answers back to Claude's question-text
 * keys and translates each string value into the agent language.
 *
 * Key lookup order: translated header, translated question text, then the
 * original header/question text (covers drifted clients echoing the
 * agent-language payload, e.g. after a degraded display round trip). A key
 * matching nothing passes through under its original key so no answer is
 * silently dropped; such keys only occur off-contract, since the app always
 * answers with the headers this provider emitted. Header collisions resolve
 * first-wins: the answers record cannot express colliding keys anyway, and
 * the native provider conflates them the same way.
 *
 * Display strings are bilingual (`译文 (原文)` / translation-then-original),
 * so option-label answers map back to the original label without an endpoint
 * round trip: translating a bilingual label would garble it. Only unmatched
 * values (free-text answers) go through the endpoint. A comma-joined value
 * whose every piece hits the map (multi-select joined labels) resolves
 * piece-wise; otherwise the whole value is translated as free text.
 *
 * Non-string values (numbers, booleans) are language-neutral and pass
 * through untranslated. Empty strings stay empty without an endpoint round
 * trip. Rejects when any translation fails so the caller can deny the
 * request instead of leaking user-language text.
 */
export async function resolveQuestionAnswers(
  translatedQuestions: unknown[],
  originalQuestions: unknown[],
  updatedInput: unknown,
  translate: (text: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const answers = readAnswers(updatedInput);
  if (answers === null) return {};
  const headerToQuestion = new Map<string, string>();
  const questionToQuestion = new Map<string, string>();
  const displayedLabelToOriginal = new Map<string, string>();
  const remember = (key: string | null, originalText: string, map: Map<string, string>): void => {
    if (key !== null && !map.has(key)) map.set(key, originalText);
  };
  const rememberLabel = (displayed: unknown, original: unknown): void => {
    const displayedText = readNonEmptyString(displayed);
    const originalText = readNonEmptyString(original);
    if (displayedText === null || originalText === null) return;
    if (!displayedLabelToOriginal.has(displayedText)) {
      displayedLabelToOriginal.set(displayedText, originalText);
    }
  };
  for (let index = 0; index < translatedQuestions.length; index += 1) {
    const translated = translatedQuestions[index];
    const original = originalQuestions[index];
    if (!isRecord(translated) || !isRecord(original)) continue;
    const originalText = readNonEmptyString(original.question);
    if (originalText === null) continue;
    remember(readNonEmptyString(translated.header), originalText, headerToQuestion);
    remember(readNonEmptyString(translated.question), originalText, questionToQuestion);
    // Fallback for clients answering with the agent-language payload.
    remember(readNonEmptyString(original.header), originalText, headerToQuestion);
    remember(originalText, originalText, questionToQuestion);
    if (!Array.isArray(translated.options) || !Array.isArray(original.options)) continue;
    const shownOptions = translated.options as unknown[];
    const sourceOptions = (original.options as unknown[]).slice(0, shownOptions.length);
    for (let optionIndex = 0; optionIndex < shownOptions.length; optionIndex += 1) {
      const shown = shownOptions[optionIndex];
      const source = sourceOptions[optionIndex];
      if (typeof shown === "string" || typeof source === "string") {
        rememberLabel(shown, source);
        continue;
      }
      if (!isRecord(shown) || !isRecord(source)) continue;
      rememberLabel(shown.label, source.label);
    }
  }
  const resolveValue = async (value: string): Promise<string> => {
    // Data URIs pass through verbatim like empty strings: they carry no
    // language, so translating them could only corrupt the payload.
    if (value.trim().length === 0 || isDataUriImageOnlyText(value)) return value;
    const exact = displayedLabelToOriginal.get(value);
    if (exact !== undefined) return exact;
    const pieces = value.split(",").map((part) => part.trim());
    if (
      pieces.length > 1 &&
      pieces.every((part) => part.length > 0 && displayedLabelToOriginal.has(part))
    ) {
      return pieces.map((part) => displayedLabelToOriginal.get(part) as string).join(", ");
    }
    return translate(value);
  };
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value !== "string") {
      resolved[headerToQuestion.get(key) ?? questionToQuestion.get(key) ?? key] = value;
      continue;
    }
    const questionText = headerToQuestion.get(key) ?? questionToQuestion.get(key) ?? key;
    resolved[questionText] = await resolveValue(value);
  }
  return resolved;
}
