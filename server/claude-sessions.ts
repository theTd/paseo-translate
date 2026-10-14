import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { claudeProjectDir } from "./claude-project-dir";

/** SDK rewinds create a new transcript without a clone manifest; retain managed ownership. */
export async function markManagedClaudeFork(cwd: string, configDir: string | undefined, sessionId: string): Promise<void> {
  const marker = join(claudeProjectDir(cwd, configDir), `${sessionId}.paseo-fork`);
  try {
    await writeFile(marker, "Managed by Translate session fork\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

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
  // Claude custom titles are appended, so the tail wins over the first prompt.
  for (const line of raw.slice(-512_000).split("\n").reverse()) {
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record === "object" && record !== null && "type" in record && record.type === "custom-title" &&
        "customTitle" in record && typeof record.customTitle === "string" && record.customTitle.trim()) {
        title = record.customTitle.trim();
        break;
      }
    } catch { /* A partial tail line must not suppress the transcript's prompt title. */ }
  }
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
  const storedNames = new Set(names);
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    // Forks are registered by their durable operation, including retry after failure.
    // A generic import handle would bypass that operation and open the same storage twice.
    const sessionId = name.slice(0, -".jsonl".length);
    if (storedNames.has(`${sessionId}.clone.json`) || storedNames.has(`${sessionId}.paseo-fork`)) continue;
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
