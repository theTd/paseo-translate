import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { claudeProjectDir } from "./claude-project-dir";
import { claudeUserText, isClaudeSyntheticUserEntry } from "./claude-transcript-content";

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

/** Read native titles and use file activity, rather than session creation, for ordering. */
async function readTranscriptPreview(path: string): Promise<TranscriptPreview | null> {
  const base = path.split(/[\\/]/).pop() ?? "";
  const claudeSessionId = /^([0-9a-fA-F][0-9a-fA-F-]{7,})\.jsonl$/.exec(base)?.[1];
  if (claudeSessionId === undefined) return null;
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch { return null; }
  let promptTitle: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let updatedAt = new Date(0);
  for (const line of raw.split(/\r?\n/)) {
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch { continue; }
    if (entry.isSidechain === true) continue;
    if (typeof entry.timestamp === "string") {
      const timestamp = new Date(entry.timestamp);
      if (timestamp > updatedAt) updatedAt = timestamp;
    }
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      customTitle = entry.customTitle.trim() || undefined;
    } else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
      aiTitle = entry.aiTitle.trim() || undefined;
    } else if (entry.type === "user" && !entry.isCompactSummary && !isClaudeSyntheticUserEntry(entry)) {
      const message = entry.message as { content?: unknown } | undefined;
      promptTitle ??= claudeUserText(message?.content);
    }
  }
  const title = customTitle ?? aiTitle ?? promptTitle;
  if (title === undefined) return null;
  try { updatedAt = (await stat(path)).mtime; } catch { /* Use the latest transcript timestamp. */ }
  return { claudeSessionId, title: title.length > 200 ? `${title.slice(0, 200)}…` : title, updatedAt };
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
