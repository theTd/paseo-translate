import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Verbatim-shaped port of Claude Code's project-directory encoding so
 * replay and session listing scan the same `~/.claude/projects/<dir>` the
 * SDK writes. Cap 200 matches the native provider (and this plugin's
 * transcript replay); a shorter cap would hash a different directory.
 */
export const PROJECT_DIR_LENGTH_CAP = 200;

export function resolveClaudeConfigDir(): string {
  const override = process.env["CLAUDE_CONFIG_DIR"];
  if (typeof override === "string" && override.length > 0) return override;
  return join(homedir(), ".claude");
}

/**
 * Resolves the explicit config-directory setting. An empty setting keeps the
 * previous contract (CLAUDE_CONFIG_DIR from the environment, else ~/.claude);
 * `~` is expanded because this value is typed by hand in settings UI.
 */
export function resolveConfiguredClaudeConfigDir(configured: string | undefined): string {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (value.length === 0) return resolveClaudeConfigDir();
  const expanded =
    value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
  return resolve(expanded);
}

export function canonicalizeProjectCwd(input: string): string {
  // Trailing separators survive realpath on missing paths and would hash a
  // different project dir than the SDK wrote; strip them first.
  const trimmed = input.replace(/[\\/]+$/, "") || input;
  try {
    return normalizeProjectPath(realpathSync.native(trimmed));
  } catch {
    return normalizeProjectPath(trimmed);
  }
}

export function encodeProjectDir(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) return replaced;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${Math.abs(hash).toString(36)}`;
}

/** `<configDir>/projects/<encoded-canonical-cwd>` — the transcript folder. */
export function claudeProjectDir(cwd: string, configDir = resolveClaudeConfigDir()): string {
  return join(configDir, "projects", encodeProjectDir(canonicalizeProjectCwd(cwd)));
}

function normalizeProjectPath(input: string): string {
  return process.platform === "darwin" ? input.normalize("NFC") : input;
}
