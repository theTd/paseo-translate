import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { claudeProjectDir } from "./claude-project-dir";

interface TranscriptPreview {
  claudeSessionId: string;
  title: string | undefined;
  updatedAt: Date;
}

/**
 * Extracts a bounded preview from a transcript's head: the session id, the
 * first user text as the title, and the newest timestamp seen in that window.
 */
async function readTranscriptPreview(path: string): Promise<TranscriptPreview | null> {
  const base = path.split(/[\\/]/).pop() ?? "";
  const claudeSessionId = /^([0-9a-fA-F][0-9a-fA-F-]{7,})\.jsonl$/.exec(base)?.[1];
  if (claudeSessionId === undefined) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  // Only the head is inspected: titles come from the first user message, so
  // a multi-megabyte session never needs a full parse for the listing.
  const head = raw.slice(0, 512_000);
  let title: string | undefined;
  let updatedAt: Date | undefined;
  for (const line of head.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (updatedAt === undefined && typeof entry.timestamp === "string") {
      const parsed = new Date(entry.timestamp);
      if (!Number.isNaN(parsed.getTime())) updatedAt = parsed;
    }
    if (title === undefined && entry.type === "user") {
      const text = firstUserText(entry.message);
      if (text !== undefined) title = text;
    }
    if (title !== undefined && updatedAt !== undefined) break;
  }
  if (title === undefined) return null;
  try {
    const stats = await stat(path);
    updatedAt = updatedAt ?? stats.mtime;
  } catch {
    // Timestamp from the head lines is good enough on its own.
  }
  return {
    claudeSessionId,
    title: title.length > 200 ? `${title.slice(0, 200)}…` : title,
    updatedAt: updatedAt ?? new Date(0),
  };
}

function firstUserText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

/**
 * Lists this provider's own Claude sessions for a working directory by
 * scanning the encoded project transcript directory. Failures read as an
 * empty list: listing is discoverability, never a session blocker.
 */
export async function listClaudeTranscriptSummaries(
  cwd: string,
  limit: number,
): Promise<ProviderSessionSummary[]> {
  const directory = claudeProjectDir(cwd);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const previews: TranscriptPreview[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const preview = await readTranscriptPreview(join(directory, name));
    if (preview === null) continue;
    previews.push(preview);
  }
  previews.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  return previews.slice(0, Math.max(1, limit)).map((preview) => ({
    persistence: { version: 1, data: { claudeSessionId: preview.claudeSessionId } },
    cwd,
    title: preview.title,
    updatedAt: preview.updatedAt.toISOString(),
  }));
}
