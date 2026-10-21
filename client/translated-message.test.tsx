import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { translatedMessageDataSchema, type TranslatedMessageData } from "../shared/translate";
import { transformAssistantMessage } from "./transformer";
import { TranslatedMessage } from "./translated-message";

const state = vi.hoisted(() => ({
  status: "idle" as "idle" | "running" | null,
  streamIdle: false,
  translate: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof React>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({ Text: "Text", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: (_id: string, select: (agent: unknown) => unknown) =>
    select({ provider: "translate-codex", status: state.status }),
  useSettings: () => ({ status: "ready", values: {
    userLanguage: "de", agentLanguage: "en", uiLanguage: "en",
  } }),
}));
vi.mock("./display-translation-settle", async (original) => ({
  ...await original<typeof import("./display-translation-settle")>(),
  useStreamIdle: () => state.streamIdle,
}));
vi.mock("./markdown", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("./i18n", () => ({ useTranslate: () => ({ t: (key: string) => key }) }));
vi.mock("./streaming-translation", () => ({
  useRetryNonce: () => ({ retryNonce: 0, retry: vi.fn() }),
  useReconnectAutoRetry: vi.fn(),
  useStreamingTranslation: (input: unknown) => {
    state.translate(input);
    return { text: "Behoben in `src/app.ts`.", done: true, error: undefined };
  },
}));

const TEXT = "Fixed in `src/app.ts`.";

function render(phase: "streaming" | "complete") {
  const result = transformAssistantMessage({ item: { text: TEXT, messageId: "last" }, phase });
  expect(result?.items[0]).toBeDefined();
  return TranslatedMessage({
    agentId: "agent-1",
    item: { data: translatedMessageDataSchema.parse(result?.items[0].data) },
    theme: { colors: { foreground: "#fff", foregroundMuted: "#aaa", accent: "#0f0" } },
  } as PluginTimelineItemProps<TranslatedMessageData>);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.status = "idle";
  state.streamIdle = false;
  state.translate.mockClear();
});

describe("last assistant reply translation", () => {
  it.each([
    { phase: "complete" as const, status: "running" as const, streamIdle: false },
    { phase: "streaming" as const, status: "idle" as const, streamIdle: false },
    { phase: "streaming" as const, status: "running" as const, streamIdle: true },
    { phase: "streaming" as const, status: null, streamIdle: true },
  ])("translates a summary with a file path once settled: %j", ({ phase, status, streamIdle }) => {
    state.status = status;
    state.streamIdle = streamIdle;
    const result = render(phase);
    expect(state.translate).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true, text: TEXT, sessionKey: "agent-1", direction: "agent-to-user",
    }));
    expect(result.props.children[0].props.text).toBe("Behoben in `src/app.ts`.");
  });

  it("waits while the final reply is still growing", () => {
    state.status = "running";
    const result = render("streaming");
    expect(state.translate).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(result.props.text).toBe(TEXT);
  });
});
