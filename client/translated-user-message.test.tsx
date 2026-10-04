import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { TranslatedUserMessageData } from "../shared/translate";
import { TranslatedUserMessage } from "./translated-user-message";

const state = vi.hoisted(() => ({
  provider: "translate-codex",
  stream: { text: "Hello", done: true, error: undefined as Error | undefined },
  translate: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof React>(),
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: (_id: string, select: (agent: unknown) => unknown) =>
    select({ provider: state.provider, parentAgentId: null }),
  useSettings: () => ({ status: "ready", values: {
    translatePrompts: true, userLanguage: "de", agentLanguage: "en", uiLanguage: "en",
  } }),
}));
vi.mock("./i18n", () => ({ useTranslate: () => ({ t: (key: string) => key }) }));
vi.mock("./streaming-translation", () => ({
  useRetryNonce: () => ({ retryNonce: 0, retry: vi.fn() }),
  useReconnectAutoRetry: vi.fn(),
  useStreamingTranslation: (input: unknown) => {
    state.translate(input);
    return state.stream;
  },
}));

function render(text = "Hallo") {
  return TranslatedUserMessage({
    agentId: "agent-1",
    item: { data: { text, phase: "complete", messageId: "u-1" } },
    theme: { colors: { foreground: "#fff", foregroundMuted: "#aaa", accent: "#0f0", surface2: "#333" } },
  } as PluginTimelineItemProps<TranslatedUserMessageData>);
}

function texts(node: React.ReactNode): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return texts(node.props.children);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.provider = "translate-codex";
  state.stream = { text: "Hello", done: true, error: undefined };
  state.translate.mockClear();
});

describe("bilingual user bubble", () => {
  it("renders both languages in its own right-aligned bubble without a host wrapper", () => {
    const result = render();
    expect(result.props.style.alignItems).toBe("flex-end");
    expect(result.props.children.props.style.backgroundColor).toBe("#333");
    expect(texts(result)).toEqual(["Hallo", "Hello"]);
    expect(state.translate).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("keeps the original visible while translating and after a failure", () => {
    state.stream = { text: "", done: false, error: undefined };
    expect(texts(render())).toEqual(["Hallo", "translating"]);
    state.stream.error = new Error("offline");
    expect(texts(render())).toEqual(["Hallo", "translationUnavailable", "retryTranslation"]);
  });

  it("suppresses identical translations and translations for foreign providers", () => {
    state.stream.text = "Hallo";
    expect(texts(render())).toEqual(["Hallo"]);
    state.provider = "codex";
    state.stream.text = "Hello";
    expect(texts(render())).toEqual(["Hallo"]);
    expect(state.translate).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("preserves slash-command prefixes in both languages", () => {
    expect(texts(render("/model Hallo"))).toEqual(["/model Hallo", "/model Hello"]);
  });
});
