import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { claudeProjectDir } from "./claude-project-dir";
import { listClaudeTranscriptSummaries } from "./claude-sessions";
import { cloneClaudeSession } from "./claude-session-clone";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("keeps managed forks out of generic import regardless of their mutable persistence config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-fork-list-"));
  roots.push(root);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "config"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const project = claudeProjectDir(cwd);
  await mkdir(project, { recursive: true });
  const sourceId = randomUUID();
  const transcript = path.join(project, `${sourceId}.jsonl`);
  await writeFile(transcript, JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: sourceId,
    message: { content: "Source title" }, timestamp: new Date().toISOString() }) + "\n");
  const copy = await cloneClaudeSession({ transcript, configDir: process.env.CLAUDE_CONFIG_DIR!, title: "Source title (fork)" });
  // A fork has a different handle at import, and again after configuration changes.
  for (const model of ["sonnet", "opus"]) {
    const forkHandle = { version: 1, data: { claudeSessionId: copy.newSessionId,
      configDir: process.env.CLAUDE_CONFIG_DIR, forkConfig: { model, settings: {} } } };
    const listed = await listClaudeTranscriptSummaries(cwd, 100);
    expect(listed).toHaveLength(1);
    expect(listed[0].persistence.data).toEqual({ claudeSessionId: sourceId });
    expect(listed.some(({ persistence }) =>
      (persistence.data as { claudeSessionId: string }).claudeSessionId === forkHandle.data.claudeSessionId)).toBe(false);
  }
});
