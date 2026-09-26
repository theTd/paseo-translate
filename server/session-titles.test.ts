import { describe, expect, it } from "vitest";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { createMemoryTranslationCacheStore } from "./translation-cache-store";
import { createTranslator } from "./translate";
import { translateSessionTitlesForDisplay } from "./session-titles";
import type { TranslateSettingsValues } from "../shared/translate";

const values: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  translationReasoningEffort: "default" as const,
  translationSystemPrompt: "",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: [],
  innerAgentEnv: {},
  claudeExecutablePath: "",
  codexExecutablePath: "",
  translatePrompts: true,
  translateResponses: true,
  translateReasoning: false,
  translateAllTimelines: false,
  translationTimeoutMs: 5_000,
  uiLanguage: "system" as const,
};

function translatingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((message) => message.role === "user");
    const text = user?.content ?? "";
    if (text.includes("FAIL")) throw new Error("endpoint down");
    return new Response(JSON.stringify({ choices: [{ message: { content: `EN(${text})` } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

function session(title?: string): ProviderSessionSummary {
  return {
    persistence: { version: 1, data: { id: "s" } },
    cwd: "E:\\repo",
    ...(title !== undefined ? { title } : {}),
  };
}

describe("session title display translation", () => {
  it("restores the exact prompt-time original without an endpoint call", async () => {
    const cacheStore = createMemoryTranslationCacheStore();
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(),
      cacheStore,
    });
    await translator.translate("Hallo Welt", "user-to-agent");
    const sessions = await translateSessionTitlesForDisplay([session("EN(Hallo Welt)")], {
      loadValues: async () => ({ translateResponses: true }),
      translator,
    });
    expect(sessions).toMatchObject([{ title: "Hallo Welt" }]);
  });
  it("translates titles for display and keeps failures verbatim", async () => {
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(),
      cacheStore: createMemoryTranslationCacheStore(),
    });
    const sessions = await translateSessionTitlesForDisplay(
      [session("Welche Farbe?"), session("FAIL Farbe?")],
      { loadValues: async () => ({ translateResponses: true }), translator },
    );
    expect(sessions).toMatchObject([{ title: "EN(Welche Farbe?)" }, { title: "FAIL Farbe?" }]);
  });

  it("restores prompt-time originals even when response translation is disabled", async () => {
    let calls = 0;
    const cacheStore = createMemoryTranslationCacheStore();
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(),
      cacheStore,
    });
    await translator.translate("Hallo Welt", "user-to-agent");
    const disabled = createTranslator({
      loadConfig: async () => values,
      fetchFn: (async () => {
        calls += 1;
        throw new Error("must not be called");
      }) as typeof fetch,
      cacheStore,
    });
    const sessions = await translateSessionTitlesForDisplay(
      [session("EN(Hallo Welt)"), session("Welche Farbe?")],
      { loadValues: async () => ({ translateResponses: false }), translator: disabled },
    );
    // The cached original restores; the uncached title stays verbatim with
    // zero endpoint calls.
    expect(sessions).toMatchObject([{ title: "Hallo Welt" }, { title: "Welche Farbe?" }]);
    expect(calls).toBe(0);
  });

  it("keeps over-long titles verbatim without an endpoint call", async () => {
    let calls = 0;
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
        });
      }) as typeof fetch,
      cacheStore: createMemoryTranslationCacheStore(),
    });
    const long = `Titel ${"x".repeat(2_500)}`;
    const sessions = await translateSessionTitlesForDisplay([session(long)], {
      loadValues: async () => ({ translateResponses: true }),
      translator,
    });
    expect(sessions).toMatchObject([{ title: long }]);
    expect(calls).toBe(0);
  });

  it("skips same-language pairs without an endpoint call", async () => {
    let calls = 0;
    const translator = createTranslator({
      loadConfig: async () => ({ ...values, userLanguage: "de", agentLanguage: "de" }),
      fetchFn: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
        });
      }) as typeof fetch,
      cacheStore: createMemoryTranslationCacheStore(),
    });
    const sessions = await translateSessionTitlesForDisplay([session("Welche Farbe?")], {
      loadValues: async () => ({ translateResponses: true, userLanguage: "de", agentLanguage: "de" }),
      translator,
    });
    expect(sessions).toMatchObject([{ title: "Welche Farbe?" }]);
    expect(calls).toBe(0);
  });
});
