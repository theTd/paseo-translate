import { parseMarkdownBlocks, type BlockNode, type InlineNode } from "./markdown-parse";

const WEB_HREF = /^(?:https?:\/\/|mailto:|tel:)/i;
const CUSTOM_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MAX_PATH_LENGTH = 200;
/** `./x`, `../x`, `~/x` — an explicit relative root. */
const RELATIVE_PREFIX = /^(?:\.{1,2}|~)[\\/]/;
/** `C:\x` — a Windows drive root. */
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
/** `:12`, `:12:5`, `:12-20`, `#L33`, `(12,5)` — the line suffixes the host parses. */
const LINE_SUFFIX_SOURCE =
  String.raw`(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?|\(\d+(?:,\d+)?(?:-\d+(?:,\d+)?)?\))?`;
/** `dir/name.ts`, and the same with a line suffix. */
const FILE_WITH_EXTENSION = new RegExp(String.raw`\.[A-Za-z][A-Za-z0-9]{0,7}${LINE_SUFFIX_SOURCE}$`);
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
 * Extensions the host does not open as file links. The host applies its
 * extension whitelist only to bare relative targets, so this set is consulted
 * only there: explicit roots and absolute paths are always linkable.
 *
 * Mirror of the complement of `ASSISTANT_FILE_EXTENSIONS` in
 * `packages/app/src/assistant-file-links/parse.ts`; keep it current when that
 * list grows. Host-only knowledge, so it cannot be imported.
 */
const UNLINKABLE_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|avif|heic|svg|ico|bmp|pdf|csv|tsv|xlsx?|docx?|pptx?|ipynb|parquet|arrow|feather|avro|orc|pkl|npy|npz|h5|hdf5|onnx|ckpt|pt|pth|safetensors|joblib|mat|rds|sav|dta|sqlite3?|db|pcap|har|msgpack|tfrecord|webmanifest|zip|tar|gz|tgz|bz2|xz|7z|rar|apk|jar|class|bin|exe|dmg|iso|o|so|dll|dylib|pyc|wasm|map|jsonl|ndjson|mp3|wav|ogg|mp4|mov|webm|mkv|avi|flac|m4a|aac|opus|wmv|flv|srt|vtt|ttf|otf|woff2?|psd|ai|sketch|fig|tex|epub|glb|obj|stl|pem|crt|diff|patch|log)(?:$|[?#])/i;
/** `docs/.gitignore` — a dotfile last segment; the host treats dotfiles as files. */
const DOTFILE_TAIL = /(?:^|[\\/])\.[^\\/]+$/;
/**
 * Cheap pre-check: the transformer runs on every streaming update, so only a
 * message that contains an image marker, a markdown link, or a backticked token
 * with a path separator is worth parsing. Plain prose and backticked filenames
 * like `package.json` stay on the fast path.
 */
const MAY_NEED_HOST_RENDERER = /!\[|\]\(|<img|`[^`\n]*[\\/][^`\n]*`/i;

/**
 * True when the translated view cannot reproduce the message faithfully, so the
 * timeline transformer keeps the host's renderer for it:
 *
 * - Images. Markdown `![alt](src)` and HTML `<img>` tags with a host-renderable
 *   source (attachment loading, sizing and the preview are host-owned), while
 *   the translated view renders text only.
 * - Links that point at files. Anything that is not http(s), mailto:, tel:, an
 *   in-page `#anchor` or a custom scheme is treated as a workspace reference:
 *   the host resolves it through the daemon and opens the file in Paseo, while
 *   the plugin has no API for that and a translated row would swallow it.
 * - Inline code that reads as a workspace path, which the host turns into a file
 *   link.
 *
 * The message keeps its original text and loses its translation. That is the
 * same trade the materialized provider-image passthrough already makes, applied
 * to every image and file reference instead of just whole-image messages.
 */
export function requiresHostRenderer(text: string): boolean {
  if (!MAY_NEED_HOST_RENDERER.test(text)) return false;
  return parseMarkdownBlocks(text).some(blockNeedsHostRenderer);
}

/**
 * A path the host makes clickable, which the translated view cannot open.
 * Explicit roots always qualify: the host treats `./x`, `../x`, `~/x`, `/x`,
 * `C:\x` and `file://` as paths regardless of extension. A bare relative target
 * needs a directory separator plus an extension in the host's whitelist, or a
 * dotfile last segment (`docs/.gitignore`), so `src/app.ts:12` qualifies while
 * `package.json`, `.env`, `src/photo.png`, `and/or` and `npm run build` stay
 * translatable. `/clear` and `/compact` are single-segment slash commands, not
 * paths.
 */
export function looksLikeWorkspacePath(value: string): boolean {
  const token = value.trim();
  if (token.length === 0 || token.length > MAX_PATH_LENGTH) return false;
  if (/\s/.test(token)) return false;
  if (/^file:\/\//i.test(token)) return true;
  if (RELATIVE_PREFIX.test(token) || DRIVE_PREFIX.test(token)) return true;
  if (/^[\\/]/.test(token)) {
    // A bare root needs a second segment or an extension: `/etc/hosts` and
    // `/tmp/a.md` are paths, `/clear` and `/compact` are slash commands.
    const rest = token.slice(1);
    return /[\\/]/.test(rest) || FILE_WITH_EXTENSION.test(token);
  }
  if (!/[\\/]/.test(token)) return false;
  const linkable = FILE_WITH_EXTENSION.test(token) || DOTFILE_TAIL.test(token);
  return linkable && !UNLINKABLE_EXTENSION.test(token);
}

function linkNeedsHostRenderer(href: string): boolean {
  // An in-page anchor is a no-op in both renderers, so it must not cost the
  // message its translation.
  if (href.startsWith("#")) return false;
  if (WEB_HREF.test(href)) return false;
  // Custom schemes have no opener in either renderer. A Windows drive letter is
  // the exception: `C:/repo/a.ts` is a path, not the `c:` scheme.
  if (CUSTOM_SCHEME.test(href) && !DRIVE_PREFIX.test(href) && !/^file:/i.test(href)) {
    return false;
  }
  if (
    /^file:\/\//i.test(href) ||
    RELATIVE_PREFIX.test(href) ||
    DRIVE_PREFIX.test(href) ||
    /^[\\/]/.test(href)
  ) {
    return true;
  }
  const linkable = FILE_WITH_EXTENSION.test(href) || DOTFILE_TAIL.test(href);
  return linkable && !UNLINKABLE_EXTENSION.test(href);
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
      // table into parts around it and the layout breaks. Markdown images,
      // paths and file links still keep the whole message on the host.
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
      return linkNeedsHostRenderer(node.href) || node.children.some(inlineNodeNeedsHostRenderer);
    case "code":
      return looksLikeWorkspacePath(node.text);
    case "strong":
    case "em":
    case "del":
      return node.children.some(inlineNodeNeedsHostRenderer);
    case "text":
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
