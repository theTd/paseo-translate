import { describe, expect, it } from "vitest";
import { looksLikeWorkspacePath, requiresHostRenderer } from "./host-rendered-message";

const HASH = "b".repeat(64);

describe("host-rendered message detection", () => {
  it("keeps messages with any markdown image on the host renderer", () => {
    expect(requiresHostRenderer(`![Image](file:///tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
    expect(requiresHostRenderer("Prose\n\n![shot](https://example.com/a.png)")).toBe(true);
    expect(requiresHostRenderer("| a |\n| - |\n| ![s](x.png) |")).toBe(true);
  });

  it("keeps HTML images the host can render", () => {
    expect(requiresHostRenderer('Prose <img src="https://example.com/a.png"> more')).toBe(true);
    expect(requiresHostRenderer('<img src="data:image/png;base64,AAAA">')).toBe(true);
    expect(requiresHostRenderer('Line one\n<img\nsrc="https://example.com/a.png">')).toBe(true);
  });

  it("translates HTML images the host cannot render", () => {
    expect(requiresHostRenderer('Prose <img src="file:///tmp/a.png"> more')).toBe(false);
    expect(requiresHostRenderer("Prose <img> more")).toBe(false);
    expect(requiresHostRenderer('Prose <img data-src="https://example.com/a.png"> more')).toBe(
      false,
    );
    expect(requiresHostRenderer('Use `<img src="https://example.com/a.png">` in HTML')).toBe(false);
    expect(requiresHostRenderer("```html\n<img src=\"https://example.com/a.png\">\n```")).toBe(false);
    // The host splits a table around an inline image, which breaks the layout.
    expect(requiresHostRenderer('| a |\n| - |\n| <img src="https://example.com/a.png"> |')).toBe(
      false,
    );
  });

  it("keeps file links the host resolves on the host renderer", () => {
    expect(requiresHostRenderer("see [app](src/app.ts:12)")).toBe(true);
    expect(requiresHostRenderer("see [file](file:///tmp/x.md)")).toBe(true);
    expect(requiresHostRenderer("see [report](./docs/report.pdf)")).toBe(true);
    expect(requiresHostRenderer("see [chart](/tmp/chart.png)")).toBe(true);
    expect(requiresHostRenderer("see [chart](file:///tmp/chart.png)")).toBe(true);
    expect(requiresHostRenderer("see [app](C:/repo/src/app.ts)")).toBe(true);
    expect(requiresHostRenderer("see [app](C:\\repo\\src\\app.ts)")).toBe(true);
  });

  it("keeps host-supported path shapes on the host renderer", () => {
    expect(requiresHostRenderer("check `src/app.ts:12` next")).toBe(true);
    expect(requiresHostRenderer("check `src/app.ts#L33` next")).toBe(true);
    expect(requiresHostRenderer("check `C:\\repo\\app.ts` next")).toBe(true);
    expect(requiresHostRenderer("check `/etc/hosts` next")).toBe(true);
  });

  it("keeps explicit roots regardless of extension, because the host does", () => {
    expect(requiresHostRenderer("open `./report.pdf`")).toBe(true);
    expect(requiresHostRenderer("open `~/Downloads/a.png`")).toBe(true);
    expect(requiresHostRenderer("open `C:\\repo\\a.png`")).toBe(true);
    expect(requiresHostRenderer("open `file:///tmp/a.png`")).toBe(true);
    expect(requiresHostRenderer("open `/tmp/a.png`")).toBe(true);
  });

  it("translates web links, anchors, custom schemes, slash commands, and prose", () => {
    expect(requiresHostRenderer("see [docs](https://paseo.sh/docs)")).toBe(false);
    expect(requiresHostRenderer("mail [me](mailto:person@example.com)")).toBe(false);
    expect(requiresHostRenderer("see [Setup](#setup)")).toBe(false);
    expect(requiresHostRenderer("see [editor](vscode://file/tmp/a.ts)")).toBe(false);
    expect(requiresHostRenderer("run `npm run build`, then read `package.json`")).toBe(false);
    expect(requiresHostRenderer("run `/clear` now")).toBe(false);
    expect(requiresHostRenderer("plain prose with no references")).toBe(false);
  });

  it("keeps dotfile targets, which the host opens", () => {
    expect(requiresHostRenderer("see [config](.gitignore)")).toBe(true);
    expect(requiresHostRenderer("see [config](docs/.gitignore)")).toBe(true);
    expect(requiresHostRenderer("check `docs/.gitignore` next")).toBe(true);
  });

  it("translates bare relative targets the host would not open", () => {
    expect(requiresHostRenderer("See [the diff](changes.diff)")).toBe(false);
    expect(requiresHostRenderer("See [report](docs/report.pdf)")).toBe(false);
    expect(requiresHostRenderer("See [make](Makefile)")).toBe(false);
    expect(requiresHostRenderer("See [notes](notes)")).toBe(false);
    expect(requiresHostRenderer("open `src/photo.png`")).toBe(false);
    expect(requiresHostRenderer("open `src/data.jsonl`")).toBe(false);
    expect(requiresHostRenderer("open `assets/font.woff2`")).toBe(false);
    expect(requiresHostRenderer("open `weights/model.pkl`")).toBe(false);
    expect(requiresHostRenderer("open `clips/demo.avi`")).toBe(false);
  });

  it("translates code blocks even when they contain paths and images", () => {
    expect(requiresHostRenderer("```\nsrc/app.ts\n```")).toBe(false);
    expect(requiresHostRenderer("```md\n![shot](https://example.com/a.png)\n```")).toBe(false);
  });

  it("recognizes path shapes without flagging identifiers", () => {
    expect(looksLikeWorkspacePath("src/app.ts")).toBe(true);
    expect(looksLikeWorkspacePath("src/app.ts:12-20")).toBe(true);
    expect(looksLikeWorkspacePath("src/app.ts:12:5")).toBe(true);
    expect(looksLikeWorkspacePath("src/app.ts#L33")).toBe(true);
    expect(looksLikeWorkspacePath("src/app.ts(12)")).toBe(true);
    expect(looksLikeWorkspacePath("./config.yaml")).toBe(true);
    expect(looksLikeWorkspacePath("../shared/a.ts")).toBe(true);
    expect(looksLikeWorkspacePath("~/notes/a.md")).toBe(true);
    expect(looksLikeWorkspacePath("C:\\repo\\app.ts")).toBe(true);
    expect(looksLikeWorkspacePath("file:///tmp/a.md")).toBe(true);
    expect(looksLikeWorkspacePath("/etc/hosts")).toBe(true);
    expect(looksLikeWorkspacePath("/a.md")).toBe(true);
    expect(looksLikeWorkspacePath("package.json")).toBe(false);
    expect(looksLikeWorkspacePath(".env")).toBe(false);
    expect(looksLikeWorkspacePath("and/or")).toBe(false);
    expect(looksLikeWorkspacePath("A/B")).toBe(false);
    expect(looksLikeWorkspacePath("docs/v2")).toBe(false);
    expect(looksLikeWorkspacePath("/clear")).toBe(false);
    expect(looksLikeWorkspacePath("useEffect")).toBe(false);
    expect(looksLikeWorkspacePath("npm run build")).toBe(false);
    expect(looksLikeWorkspacePath("src/photo.png")).toBe(false);
    expect(looksLikeWorkspacePath("docs/report.pdf")).toBe(false);
  });
});
