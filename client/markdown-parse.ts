/**
 * Minimal Markdown subset parser for translated message rendering.
 *
 * The daemon's plugin client compiler rejects any Node builtin anywhere in
 * the client import graph (including transitive dependencies), so the usual
 * markdown packages (`markdown-it` needs `punycode`) cannot ship here. This
 * covers what translations actually contain — headings, emphasis, code,
 * lists, quotes, tables, links — with no imports at all, so the block and
 * inline parsers stay unit-testable in plain Node.
 *
 * Streaming-safe: unclosed fences render as code to end-of-input and
 * unclosed emphasis renders literally, so partial translations never throw.
 */

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "del"; children: InlineNode[] }
  | { type: "code"; text: string }
  | { type: "link"; children: InlineNode[]; href: string }
  | { type: "break" };

export type ListItem = { blocks: BlockNode[] };

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: "codeblock"; language: string; text: string }
  | { type: "quote"; children: BlockNode[] }
  | { type: "ul"; items: ListItem[] }
  | { type: "ol"; start: number; items: ListItem[] }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

export function parseMarkdownBlocks(text: string): BlockNode[] {
  return parseBlocks(text.split("\n"));
}

function parseBlocks(lines: string[]): BlockNode[] {
  const blocks: BlockNode[] = [];
  let index = 0;
  const takeWhile = (predicate: (line: string) => boolean): string[] => {
    const taken: string[] = [];
    while (index < lines.length && predicate(lines[index] as string)) {
      taken.push(lines[index] as string);
      index += 1;
    }
    return taken;
  };

  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (fence !== null) {
      const marker = fence[1] as string;
      const language = (fence[2] as string).trim();
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0] as string}{3,}\\s*$`).test(lines[index] as string)) {
        code.push(lines[index] as string);
        index += 1;
      }
      // A closing fence ends the block; an unclosed fence (mid-stream)
      // simply runs to end-of-input.
      if (index < lines.length) index += 1;
      blocks.push({ type: "codeblock", language, text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] as string),
      });
      index += 1;
      continue;
    }
    if (/^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quoted = takeWhile((candidate) => /^ {0,3}>/.test(candidate)).map((candidate) =>
        candidate.replace(/^ {0,3}> ?/, ""),
      );
      blocks.push({ type: "quote", children: parseBlocks(quoted) });
      continue;
    }
    const tableHeader = splitTableRow(line);
    const delimiter = index + 1 < lines.length ? lines[index + 1] as string : "";
    if (tableHeader !== null && isTableDelimiter(delimiter)) {
      const header = tableHeader.map((cell) => parseInline(cell));
      index += 2;
      const rows: InlineNode[][][] = [];
      while (index < lines.length && (lines[index] as string).includes("|")) {
        const row = splitTableRow(lines[index] as string);
        if (row === null) break;
        rows.push(row.map((cell) => parseInline(cell)));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch !== null) {
      const ordered = /^\d/.test((listMatch[2] as string).trim());
      const baseIndent = (listMatch[1] as string).length;
      const items: ListItem[] = [];
      let start = 1;
      if (ordered) {
        const parsed = Number.parseInt(listMatch[2] as string, 10);
        start = Number.isFinite(parsed) ? parsed : 1;
      }
      while (index < lines.length) {
        const current = lines[index] as string;
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(current);
        if (match === null || (match[1] as string).length !== baseIndent) break;
        if (ordered !== /^\d/.test((match[2] as string).trim())) break;
        const itemLines = [match[3] as string];
        index += 1;
        while (index < lines.length) {
          const continuation = lines[index] as string;
          if (continuation.trim().length === 0) {
            // A blank line ends the item unless a deeper-indented line follows.
            const next = lines[index + 1] as string | undefined;
            if (next !== undefined && /^\s+\S/.test(next)) {
              itemLines.push("");
              index += 1;
              continue;
            }
            break;
          }
          const nested = /^(\s*)([-*+]|\d+[.)])\s+/.exec(continuation);
          if (nested !== null && (nested[1] as string).length <= baseIndent) break;
          if (/^\s/.test(continuation)) {
            itemLines.push(continuation.replace(/^\s{1,4}/, ""));
            index += 1;
            continue;
          }
          break;
        }
        items.push({ blocks: parseBlocks(itemLines) });
      }
      blocks.push(
        ordered ? { type: "ol", start, items } : { type: "ul", items },
      );
      continue;
    }
    const paragraph = takeWhile(
      (candidate) =>
        candidate.trim().length > 0 &&
        !/^ {0,3}(#{1,6}\s|`{3,}|~{3,}|>|(\*\s*){3,}|(-\s*){3,}|(_\s*){3,}|(\s*[-*+]|\s*\d+[.)])\s+)/.test(
          candidate,
        ),
    );
    blocks.push({ type: "paragraph", children: parseInline(joinSoftBreaks(paragraph)) });
  }
  return blocks;
}

/** Single newlines fold to spaces; hard breaks (two spaces / backslash) stay. */
function joinSoftBreaks(lines: string[]): string {
  return lines
    .map((line) => {
      if (line.endsWith("\\")) return `${line.slice(0, -1)}\n`;
      if (/ {2,}$/.test(line)) return `${line.replace(/ {2,}$/, "")}\n`;
      return line;
    })
    .join(" ")
    .replace(/ \n /g, "\n");
}

function splitTableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells = trimmed.split("|").map((cell) => cell.trim());
  if (cells.some((cell) => cell.length === 0 && cells.length > 1)) {
    // Tolerate a single empty row only when it is the whole line.
  }
  return cells;
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells === null || cells.length === 0) return false;
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = text;
  const flushText = (value: string): void => {
    if (value.length === 0) return;
    const last = nodes[nodes.length - 1];
    if (last !== undefined && last.type === "text") last.text += value;
    else nodes.push({ type: "text", text: value });
  };

  while (rest.length > 0) {
    if (rest.startsWith("\\") && rest.length > 1 && "\\`*_{}[]<>()#+-.!|~".includes(rest[1] as string)) {
      flushText(rest[1] as string);
      rest = rest.slice(2);
      continue;
    }
    if (rest.startsWith("`")) {
      const run = /^`+/.exec(rest) as RegExpExecArray;
      const closer = rest.indexOf(run[0], run[0].length);
      if (closer !== -1) {
        nodes.push({ type: "code", text: rest.slice(run[0].length, closer) });
        rest = rest.slice(closer + run[0].length);
        continue;
      }
      flushText("`");
      rest = rest.slice(1);
      continue;
    }
    if (rest === "\n" || rest.startsWith("\n")) {
      nodes.push({ type: "break" });
      rest = rest.slice(1);
      continue;
    }
    const link = parseLink(rest);
    if (link !== null) {
      nodes.push(link.node);
      rest = link.rest;
      continue;
    }
    const emphasis = parseEmphasis(rest);
    if (emphasis !== null) {
      nodes.push(emphasis.node);
      rest = emphasis.rest;
      continue;
    }
    const autolink = /^(https?:\/\/[^\s<>()]+)/.exec(rest);
    if (autolink !== null) {
      const url = trimTrailingPunctuation(autolink[1] as string);
      nodes.push({ type: "link", children: [{ type: "text", text: url }], href: url });
      rest = rest.slice(url.length);
      continue;
    }
    flushText(rest[0] as string);
    rest = rest.slice(1);
  }
  return nodes;
}

function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, "");
}

function parseEmphasis(rest: string): { node: InlineNode; rest: string } | null {
  const markers = ["**", "__", "~~", "*", "_"] as const;
  for (const marker of markers) {
    if (!rest.startsWith(marker)) continue;
    // An opener followed by whitespace is literal (prevents "* foo*" etc).
    const after = rest[marker.length];
    if (after === " " || after === "\t" || after === "\n" || after === undefined) continue;
    const closer = findCloser(rest, marker);
    if (closer === -1) continue;
    const inner = rest.slice(marker.length, closer);
    if (inner.trim().length === 0) continue;
    const children = parseInline(inner);
    const node: InlineNode =
      marker === "**" || marker === "__"
        ? { type: "strong", children }
        : marker === "~~"
          ? { type: "del", children }
          : { type: "em", children };
    return { node, rest: rest.slice(closer + marker.length) };
  }
  return null;
}

function findCloser(rest: string, marker: string): number {
  let from = marker.length;
  for (;;) {
    const found = rest.indexOf(marker, from);
    if (found === -1) return -1;
    const before = rest[found - 1];
    // A closer preceded by whitespace (or escaping backslash) is literal.
    if (before !== " " && before !== "\t" && before !== "\n" && before !== "\\") {
      // For single-char markers, skip closers that are part of a double run.
      if (marker.length === 1) {
        const prevTwo = rest.slice(found - 1, found + 1);
        const nextTwo = rest.slice(found, found + 2);
        if (prevTwo === marker + marker || nextTwo === marker + marker) {
          from = found + 1;
          continue;
        }
      }
      return found;
    }
    from = found + 1;
  }
}

function parseLink(rest: string): { node: InlineNode; rest: string } | null {
  if (!rest.startsWith("[")) return null;
  let depth = 0;
  let index = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "\\") {
      i += 1;
      continue;
    }
    if (rest[i] === "[") depth += 1;
    else if (rest[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        index = i;
        break;
      }
    }
  }
  if (index === -1 || rest[index + 1] !== "(") return null;
  const close = rest.indexOf(")", index + 2);
  if (close === -1) return null;
  const inside = rest.slice(index + 2, close).trim();
  const href = inside.split(/\s+/)[0] ?? "";
  if (href.length === 0 || /[\s<>]/.test(href)) return null;
  return {
    node: { type: "link", children: parseInline(rest.slice(1, index)), href },
    rest: rest.slice(close + 1),
  };
}
