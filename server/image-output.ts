/**
 * Tool-screenshot materialization, mirroring Paseo's native providers
 * (`provider-image-output.ts` in the daemon source).
 *
 * Screenshots arrive as base64 image blocks inside tool_result content.
 * Base64 must never enter timeline text (it would be sent to the
 * translation endpoint), so each image is written to a content-hashed file
 * under a private temp dir and referenced as `![Image](file://…)` markdown,
 * which the host app renders with its image pipeline (preview, lightbox).
 * Filenames hash the bytes so re-materializing the same image reuses the
 * file instead of leaking a fresh one per turn or replay.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IMAGE_ATTACHMENT_DIR = "paseo-attachments";
const IMAGE_ATTACHMENT_DIR_PREFIX = `${IMAGE_ATTACHMENT_DIR}-`;
const PRIVATE_DIR_MODE = 0o700;
const IMAGE_FILE_MODE = 0o600;

export interface MaterializedImage {
  /** `file://` URI for timeline markdown. */
  uri: string;
  /** Absolute filesystem path (tests and cleanup). */
  path: string;
}

let materializedDir: string | null = null;

function canReuseDir(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    chmodSync(dir, PRIVATE_DIR_MODE);
    return true;
  } catch {
    return false;
  }
}

function attachmentDir(): string {
  if (materializedDir !== null && canReuseDir(materializedDir)) return materializedDir;
  materializedDir = mkdtempSync(path.join(os.tmpdir(), IMAGE_ATTACHMENT_DIR_PREFIX));
  chmodSync(materializedDir, PRIVATE_DIR_MODE);
  return materializedDir;
}

function imageExtension(mimeType: string): string | null {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return null;
  }
}

function normalizeData(mimeType: string, data: string): { mimeType: string; data: string } {
  if (data.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.*)$/.exec(data);
    if (match) return { mimeType: match[1] as string, data: match[2] as string };
  }
  return { mimeType, data };
}

function encodeFilePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function fileUri(absolutePath: string): string {
  const forward = absolutePath.replace(/\\/g, "/");
  const unc = /^\/\/\?\/UNC\//i.test(forward)
    ? `//${forward.slice(8)}`
    : /^\/\/\?\/[A-Za-z]:\//.test(forward)
      ? forward.slice(4)
      : forward;
  if (/^[A-Za-z]:\//.test(unc)) {
    return `file:///${unc.slice(0, 2)}${encodeFilePath(unc.slice(2))}`;
  }
  if (absolutePath.startsWith("\\\\") && unc.startsWith("//")) {
    return `file:${encodeFilePath(unc)}`;
  }
  if (unc.startsWith("/")) return `file://${encodeFilePath(unc)}`;
  return unc;
}

function escapeMarkdownSource(uri: string): string {
  return uri.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

/**
 * Writes one screenshot to the attachments dir and returns its markdown
 * reference. Returns null when the payload is empty, the mime type is not a
 * known raster image (the `[image]` text marker still records the shot), or
 * the write fails; callers fall back to marker-only output either way.
 */
export function materializeImageOutput(
  data: string,
  mimeType: string | null,
): MaterializedImage | null {
  if (data.trim().length === 0) return null;
  const normalized = normalizeData(mimeType ?? "image/png", data);
  const extension = imageExtension(normalized.mimeType);
  if (extension === null) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized.data, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filePath = path.join(attachmentDir(), `${hash}.${extension}`);
  try {
    if (!existsSync(filePath)) writeFileSync(filePath, bytes, { mode: IMAGE_FILE_MODE });
    chmodSync(filePath, IMAGE_FILE_MODE);
  } catch {
    return null;
  }
  return { uri: fileUri(filePath), path: filePath };
}

/** Renders a materialized image as timeline markdown (host renders it). */
export function renderImageOutputMarkdown(uri: string, altText = "Image"): string {
  return `![${escapeMarkdownAlt(altText)}](${escapeMarkdownSource(uri)})`;
}
