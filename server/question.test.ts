import { describe, expect, it } from "vitest";
import {
  isAskUserQuestionRequest,
  normalizeQuestionRequestInput,
  resolveQuestionAnswers,
  stripQuestionUiMetadata,
  summarizeQuestions,
  translateQuestionsForDisplay,
} from "./question";

const colorQuestion = {
  header: "Farbe",
  question: "Welche Farbe?",
  options: [
    { label: "Blau", description: "Ruhig" },
    { label: "Grün", description: "Frisch" },
  ],
  multiSelect: false,
};

function de(text: string): Promise<string> {
  return Promise.resolve(`EN(${text})`);
}

describe("question helpers", () => {
  it("recognizes AskUserQuestion payloads only", () => {
    expect(isAskUserQuestionRequest("AskUserQuestion", { questions: [] })).toBe(true);
    expect(isAskUserQuestionRequest("AskUserQuestion", {})).toBe(false);
    expect(isAskUserQuestionRequest("Bash", { questions: [] })).toBe(false);
    expect(isAskUserQuestionRequest("AskUserQuestion", null)).toBe(false);
  });

  it("adds allowOther without mutating the input", () => {
    const input = { questions: [{ ...colorQuestion }] };
    const normalized = normalizeQuestionRequestInput(input);
    expect(normalized.questions).toMatchObject([{ allowOther: true }]);
    expect(input.questions[0]).not.toHaveProperty("allowOther");
  });

  it("strips the UI-only flag before the input returns to Claude", () => {
    const stripped = stripQuestionUiMetadata({
      questions: [{ ...colorQuestion, allowOther: true, multiSelect: false }],
    });
    const items = stripped.questions as Array<Record<string, unknown>>;
    expect(items).toMatchObject([{ multiSelect: false }]);
    expect(items[0]).not.toHaveProperty("allowOther");
  });

  it("summarizes the first question for notifications", () => {
    expect(summarizeQuestions({ questions: [colorQuestion] })).toEqual({
      title: "Welche Farbe?",
      description: "Blau / Grün",
    });
    expect(summarizeQuestions({ questions: [{ question: "Los?", header: "Go", options: [] }] })).toEqual({
      title: "Los?",
    });
    expect(summarizeQuestions({})).toEqual({});
  });

  it("translates display strings and keeps structure", async () => {
    const translated = await translateQuestionsForDisplay([colorQuestion], de);
    expect(translated).toEqual([
      {
        header: "EN(Farbe)",
        question: "EN(Welche Farbe?)",
        options: [
          { label: "EN(Blau)", description: "EN(Ruhig)" },
          { label: "EN(Grün)", description: "EN(Frisch)" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("maps translated-header answers back to question text and translates values", async () => {
    const translated = await translateQuestionsForDisplay([colorQuestion], de);
    const resolved = await resolveQuestionAnswers(
      translated,
      [colorQuestion],
      { answers: { "EN(Farbe)": "EN(Grün)" } },
      (text) => Promise.resolve(`DE(${text})`),
    );
    expect(resolved).toEqual({ "Welche Farbe?": "DE(EN(Grün))" });
  });

  it("falls back to translated question text keys and keeps empty values untranslated", async () => {
    const seen: string[] = [];
    const translated = await translateQuestionsForDisplay([colorQuestion], de);
    const resolved = await resolveQuestionAnswers(
      translated,
      [colorQuestion],
      { answers: { "EN(Welche Farbe?)": "  " } },
      (text) => {
        seen.push(text);
        return Promise.resolve(`DE(${text})`);
      },
    );
    expect(resolved).toEqual({ "Welche Farbe?": "  " });
    expect(seen).toEqual([]);
  });

  it("translates bare string options like record labels", async () => {
    const translated = await translateQuestionsForDisplay(
      [{ header: "Farbe", question: "Welche Farbe?", options: ["Blau", 7, null] }],
      de,
    );
    expect(translated).toEqual([
      { header: "EN(Farbe)", question: "EN(Welche Farbe?)", options: ["EN(Blau)", 7, null] },
    ]);
  });

  it("falls back to original-language keys from drifted clients", async () => {
    const translated = await translateQuestionsForDisplay([colorQuestion], de);
    const resolved = await resolveQuestionAnswers(
      translated,
      [colorQuestion],
      { answers: { Farbe: "Grün" } },
      (text) => Promise.resolve(`DE(${text})`),
    );
    expect(resolved).toEqual({ "Welche Farbe?": "DE(Grün)" });
  });

  it("passes non-string answers through and keeps unmapped keys verbatim", async () => {
    const translated = await translateQuestionsForDisplay([colorQuestion], de);
    const resolved = await resolveQuestionAnswers(
      translated,
      [colorQuestion],
      { answers: { "EN(Farbe)": 2, mystery: true } },
      () => Promise.reject(new Error("must not translate non-strings")),
    );
    expect(resolved).toEqual({ "Welche Farbe?": 2, mystery: true });
  });

  it("rejects when an answer translation fails so the caller denies", async () => {
    const translated = await translateQuestionsForDisplay([colorQuestion], de);
    await expect(
      resolveQuestionAnswers(translated, [colorQuestion], { answers: { "EN(Farbe)": "ja" } }, () =>
        Promise.reject(new Error("endpoint down")),
      ),
    ).rejects.toThrow("endpoint down");
  });
});
