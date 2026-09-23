import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdownBlocks } from "./markdown-parse";

describe("markdown blocks", () => {
  it("parses headings, paragraphs, and rules", () => {
    const blocks = parseMarkdownBlocks("# Title\n\nSome **bold** text\n\n---");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "hr"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
  });

  it("keeps fenced code atomic, including unclosed fences mid-stream", () => {
    const closed = parseMarkdownBlocks("```ts\nconst a = 1;\n```\n\nafter");
    expect(closed.map((block) => block.type)).toEqual(["codeblock", "paragraph"]);
    expect(closed[0]).toMatchObject({ type: "codeblock", language: "ts", text: "const a = 1;" });
    const open = parseMarkdownBlocks("```py\nprint(1)\nprint(2)");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ type: "codeblock", text: "print(1)\nprint(2)" });
  });

  it("parses nested quotes and lists", () => {
    const blocks = parseMarkdownBlocks("> outer\n> - a\n> - b\n\n1. first\n2. second");
    expect(blocks.map((block) => block.type)).toEqual(["quote", "ol"]);
    const quote = blocks[0];
    if (quote.type !== "quote") throw new Error("expected quote");
    expect(quote.children.map((child) => child.type)).toEqual(["paragraph", "ul"]);
    const ordered = blocks[1];
    if (ordered.type !== "ol") throw new Error("expected ol");
    expect(ordered.start).toBe(1);
    expect(ordered.items).toHaveLength(2);
  });

  it("parses GFM tables", () => {
    const blocks = parseMarkdownBlocks("| A | B |\n| --- | :---: |\n| 1 | 2 |");
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.header).toHaveLength(2);
    expect(table.rows).toEqual([[[{ type: "text", text: "1" }], [{ type: "text", text: "2" }]]]);
  });
});

describe("markdown inline", () => {
  it("parses emphasis, code, and links", () => {
    expect(parseInline("**b** and *i* and `c`")).toEqual([
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "i" }] },
      { type: "text", text: " and " },
      { type: "code", text: "c" },
    ]);
    expect(parseInline("[docs](https://example.com/x)")).toEqual([
      {
        type: "link",
        children: [{ type: "text", text: "docs" }],
        href: "https://example.com/x",
      },
    ]);
  });

  it("renders unclosed markers literally for streaming partials", () => {
    expect(parseInline("unclosed **bold")).toEqual([{ type: "text", text: "unclosed **bold" }]);
    expect(parseInline("tick `code")).toEqual([{ type: "text", text: "tick `code" }]);
  });

  it("handles escapes and bare URLs", () => {
    expect(parseInline("\\*x\\* see https://example.com/a.")).toEqual([
      { type: "text", text: "*x* see " },
      {
        type: "link",
        children: [{ type: "text", text: "https://example.com/a" }],
        href: "https://example.com/a",
      },
      { type: "text", text: "." },
    ]);
  });
});
