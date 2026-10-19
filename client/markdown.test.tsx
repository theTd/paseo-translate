import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "./markdown";

const state = vi.hoisted(() => ({ openExternalUrl: vi.fn(async (_url: string) => {}) }));

vi.mock("@getpaseo/plugin/client", () => ({ openExternalUrl: state.openExternalUrl }));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  Text: "Text",
  View: "View",
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof React>()),
  useMemo: (factory: () => unknown) => factory(),
}));

const COLORS = { foreground: "#fff", accent: "#0f0" };

interface TextProps {
  children?: React.ReactNode;
  onPress?: () => void;
}

// Components are invoked rather than mounted: the tree has no renderer, so a
// function component's output has to be expanded before walking its children.
function expand(node: React.ReactNode): React.ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!React.isValidElement<Record<string, unknown>>(node)) return node;
  const type = node.type as unknown;
  if (typeof type !== "function") return node;
  return expand((type as (props: unknown) => React.ReactNode)(node.props));
}

function plainText(node: React.ReactNode): string {
  const expanded = expand(node);
  if (typeof expanded === "string" || typeof expanded === "number") return String(expanded);
  if (Array.isArray(expanded)) return expanded.map(plainText).join("");
  if (!React.isValidElement<TextProps>(expanded)) return "";
  return plainText(expanded.props.children);
}

function pressableTexts(node: React.ReactNode): Array<{ text: string; onPress: () => void }> {
  const expanded = expand(node);
  if (Array.isArray(expanded)) return expanded.flatMap(pressableTexts);
  if (!React.isValidElement<TextProps>(expanded)) return [];
  const { children, onPress } = expanded.props;
  if (typeof onPress === "function") {
    return [{ text: plainText(children), onPress }];
  }
  return pressableTexts(children);
}

function render(text: string) {
  return MarkdownView({ text, colors: COLORS });
}

beforeEach(() => {
  state.openExternalUrl.mockClear();
});

describe("translated markdown links", () => {
  it("opens a link through the host external opener instead of window.open", () => {
    const links = pressableTexts(render("See [the docs](https://paseo.sh/docs) now."));

    expect(links.map((link) => link.text)).toEqual(["the docs"]);
    links[0]?.onPress();

    expect(state.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://paseo.sh/docs");
  });

  it("routes a bare URL to the same opener", () => {
    const links = pressableTexts(render("Install from https://paseo.sh/plugins today."));

    expect(links).toHaveLength(1);
    links[0]?.onPress();

    expect(state.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://paseo.sh/plugins");
  });
});
