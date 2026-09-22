import { describe, expect, it } from "vitest";
import { createTranslateHandler, createTranslator } from "./translate";
import {
  resolveLanguagePair,
  translationSystemPrompt,
  type TranslateSettingsValues,
} from "../shared/translate";

const values: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: ["agent"],
  innerAgentEnv: {},
  claudeExecutablePath: "",
  translatePrompts: true,
  translateResponses: true,
  translateAllTimelines: false,
  translationTimeoutMs: 5_000,
};

interface Captured {
  body: { messages: Array<{ role: string; content: string }> } | null;
}

function translatingFetch(calls: Captured[], map: (text: string) => string): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    calls.push({ body });
    const user = body.messages.find((message) => message.role === "user");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: map(user?.content ?? "") } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("translate service", () => {
  it("sends the language pair in the system prompt", async () => {
    const calls: Captured[] = [];
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(calls, (text) => `DE:${text}`),
    });
    await expect(translator.translate("Hello", "user-to-agent")).resolves.toBe("DE:Hello");
    expect(calls[0].body?.messages[0]).toEqual({
      role: "system",
      content: translationSystemPrompt({ source: "en", target: "de" }),
    });
    expect(calls[0].body?.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("reverses the pair for agent-to-user translations", () => {
    expect(resolveLanguagePair(values, "agent-to-user")).toEqual({ source: "de", target: "en" });
    expect(resolveLanguagePair(values, "user-to-agent")).toEqual({ source: "en", target: "de" });
    expect(translationSystemPrompt(resolveLanguagePair(values, "agent-to-user"))).toContain(
      "from de to en",
    );
  });

  it("caches per direction and text", async () => {
    const calls: Captured[] = [];
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
    });
    await translator.translate("Hello", "user-to-agent");
    await translator.translate("Hello", "user-to-agent");
    await translator.translate("Hello", "agent-to-user");
    expect(calls).toHaveLength(2);
  });

  it("keeps only the most recently used entries", async () => {
    const calls: Captured[] = [];
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
      cacheCapacity: 1,
    });
    await translator.translate("a", "user-to-agent");
    await translator.translate("b", "user-to-agent");
    await translator.translate("a", "user-to-agent");
    expect(calls).toHaveLength(3);
  });

  it("retranslates after the language pair or model changes", async () => {
    const calls: Captured[] = [];
    let current = values;
    const translator = createTranslator({
      loadConfig: async () => current,
      fetchFn: translatingFetch(calls, (text) => `T:${text}`),
    });
    await translator.translate("Hello", "user-to-agent");
    current = { ...values, agentLanguage: "fr" };
    await translator.translate("Hello", "user-to-agent");
    current = { ...values, endpointModel: "mt-v2" };
    await translator.translate("Hello", "user-to-agent");
    expect(calls).toHaveLength(3);
    expect(calls[1].body?.messages[0]?.content).toContain("from en to fr");
    expect(calls[2].body?.messages[0]?.content).toContain("from en to de");
  });

  it("passes blank fragments through without calling the endpoint", async () => {
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], () => ""),
    });
    await expect(translator.translate("   ", "user-to-agent")).resolves.toBe("   ");
  });

  it("refuses oversized fragments", async () => {
    const translator = createTranslator({
      loadConfig: async () => values,
      fetchFn: translatingFetch([], () => ""),
    });
    await expect(translator.translate("x".repeat(100_001), "user-to-agent")).rejects.toThrow(
      /Refusing to translate/,
    );
  });

  it("returns the original text when response translation is disabled", async () => {
    const handler = createTranslateHandler({
      loadConfig: async () => ({ ...values, translateResponses: false }),
      fetchFn: translatingFetch([], () => ""),
    });
    await expect(handler({ text: "Guten Tag", direction: "agent-to-user" })).resolves.toEqual({
      text: "Guten Tag",
    });
  });
});
