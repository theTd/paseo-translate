import { parseMarkdownBlocks, type BlockNode, type InlineNode } from "./markdown-parse";

/**
 * Host image sources: `https?://` and base64 png/gif/jpeg data URIs, the only
 * forms the host's html-ish splitter renders.
 */
const HOST_IMAGE_SRC = /^(?:https?:\/\/|data:image\/(?:png|gif|jpe?g);base64,)/i;
/**
 * An HTML image tag with a real `src` attribute. Only used through `matchAll`,
 * which clones the pattern, so the sticky state of the `g` flag is harmless.
 */
const HTML_IMAGE = /<img\b[^>]*(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
/**
 * Cheap pre-check: the transformer runs on every streaming update, so only a
 * message that contains an image marker is worth parsing. File references
 * must not stop a reply from being translated.
 */
const MAY_NEED_HOST_RENDERER = /!\[|<img/i;

/**
 * True when a message needs the host's image pipeline:
 *
 * - Images. Markdown `![alt](src)` and HTML `<img>` tags with a host-renderable
 *   source (attachment loading, sizing and the preview are host-owned), while
 *   the translated view renders text only.
 *
 * File links and inline paths stay in the translated view. Falling back to the
 * host for those references silently disables translation for most code-change
 * summaries, including when a path arrives in the final streaming chunk.
 */
export function requiresHostRenderer(text: string): boolean {
  if (!MAY_NEED_HOST_RENDERER.test(text)) return false;
  return parseMarkdownBlocks(text).some(blockNeedsHostRenderer);
}

function blockNeedsHostRenderer(block: BlockNode): boolean {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return inlineRunNeedsHostRenderer(block.children);
    case "quote":
      return block.children.some(blockNeedsHostRenderer);
    case "ul":
    case "ol":
      return block.items.some((item) => item.blocks.some(blockNeedsHostRenderer));
    case "table":
      // HTML `<img>` inside a table cell is not detected: the host splits the
      // table into parts around it and the layout breaks. Markdown images
      // still keep the whole message on the host.
      return (
        block.header.some(cellNeedsHostRenderer) ||
        block.rows.some((row) => row.some(cellNeedsHostRenderer))
      );
    case "codeblock":
    case "hr":
      return false;
  }
}

/** A paragraph or heading inline run, including host-renderable HTML images. */
function inlineRunNeedsHostRenderer(nodes: readonly InlineNode[]): boolean {
  return nodes.some(inlineNodeNeedsHostRenderer) || textHasHostImage(plainInlineText(nodes));
}

/** A table cell: no HTML image detection, only nodes the host renders reliably. */
function cellNeedsHostRenderer(nodes: readonly InlineNode[]): boolean {
  return nodes.some(inlineNodeNeedsHostRenderer);
}

function inlineNodeNeedsHostRenderer(node: InlineNode): boolean {
  switch (node.type) {
    case "image":
      return true;
    case "link":
    case "strong":
    case "em":
    case "del":
      return node.children.some(inlineNodeNeedsHostRenderer);
    case "text":
    case "code":
    case "break":
      return false;
  }
}

/**
 * Inline text with code spans and images removed, because the host protects code
 * spans before it looks for HTML: `<img…>` written inside backticks renders as
 * code, never as an image.
 */
function plainInlineText(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "strong":
        case "em":
        case "del":
        case "link":
          return plainInlineText(node.children);
        case "code":
        case "image":
          return "";
        case "break":
          return " ";
      }
    })
    .join("");
}

function textHasHostImage(text: string): boolean {
  for (const match of text.matchAll(HTML_IMAGE)) {
    const src = match[1] ?? match[2] ?? match[3] ?? "";
    if (HOST_IMAGE_SRC.test(src.trim())) return true;
  }
  return false;
}
