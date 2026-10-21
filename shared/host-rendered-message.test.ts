import { describe, expect, it } from "vitest";
import { requiresHostRenderer } from "./host-rendered-message";

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

  it("translates file links instead of silently skipping the entire reply", () => {
    expect(requiresHostRenderer("see [app](src/app.ts:12)")).toBe(false);
    expect(requiresHostRenderer("see [file](file:///tmp/x.md)")).toBe(false);
    expect(requiresHostRenderer("see [report](./docs/report.pdf)")).toBe(false);
    expect(requiresHostRenderer("see [chart](/tmp/chart.png)")).toBe(false);
    expect(requiresHostRenderer("see [chart](file:///tmp/chart.png)")).toBe(false);
    expect(requiresHostRenderer("see [app](C:/repo/src/app.ts)")).toBe(false);
    expect(requiresHostRenderer("see [app](C:\\repo\\src\\app.ts)")).toBe(false);
  });

  it("translates inline paths including line suffixes", () => {
    expect(requiresHostRenderer("check `src/app.ts:12` next")).toBe(false);
    expect(requiresHostRenderer("check `src/app.ts#L33` next")).toBe(false);
    expect(requiresHostRenderer("check `C:\\repo\\app.ts` next")).toBe(false);
    expect(requiresHostRenderer("check `/etc/hosts` next")).toBe(false);
  });

  it("translates image paths that are references rather than embedded images", () => {
    expect(requiresHostRenderer("open `./report.pdf`")).toBe(false);
    expect(requiresHostRenderer("open `~/Downloads/a.png`")).toBe(false);
    expect(requiresHostRenderer("open `C:\\repo\\a.png`")).toBe(false);
    expect(requiresHostRenderer("open `file:///tmp/a.png`")).toBe(false);
    expect(requiresHostRenderer("open `/tmp/a.png`")).toBe(false);
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

  it("translates dotfile targets", () => {
    expect(requiresHostRenderer("see [config](.gitignore)")).toBe(false);
    expect(requiresHostRenderer("see [config](docs/.gitignore)")).toBe(false);
    expect(requiresHostRenderer("check `docs/.gitignore` next")).toBe(false);
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
});
