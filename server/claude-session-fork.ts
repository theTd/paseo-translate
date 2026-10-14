import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { TRANSLATE_CLAUDE_PROVIDER_ID } from "../shared/translate";
import type { ClaudeSessionForkResult } from "../shared/claude-session-fork";
import { defaultTranslationCacheDirectory } from "./translation-cache-store";
import { claudeProjectDir } from "./claude-project-dir";
import { cloneClaudeSession, claudeSessionCloneSchema, type ClaudeSessionClone } from "./claude-session-clone";
import { ClaudeForkCoordinator, claudeForkConfigurationSchema, claudeForkConfiguration } from "./claude-fork-coordinator";
import { createPaseoCli } from "./paseo-cli";

const OPERATION_LABEL = "translate.claude-fork-operation";
const sourceSchema = z.object({ Id: z.string(), Provider: z.string(), Cwd: z.string() });
const importedSchema = z.object({ agentId: z.string(), provider: z.string(), cwd: z.string() });
const operationSchema = z.object({
  sourceAgentId: z.string(), sourceSessionId: z.uuid(), newSessionId: z.uuid(),
  cwd: z.string(), configDir: z.string(), title: z.string(), copiedFiles: z.number().int().positive().optional(),
  config: claudeForkConfigurationSchema,
  agentId: z.string().optional(),
});
type Operation = z.output<typeof operationSchema>;
const persistenceSchema = z.object({ version: z.literal(1), data: z.object({ claudeSessionId: z.uuid(), configDir: z.string() }) });

function isForkHandle(handle: string | undefined, operation: Operation): boolean {
  if (!handle?.startsWith("plugin:")) return false;
  try {
    const persisted = persistenceSchema.parse(JSON.parse(handle.slice("plugin:".length)));
    return persisted.data.claudeSessionId === operation.newSessionId && persisted.data.configDir === operation.configDir;
  } catch { return false; }
}

export interface ClaudeForkDeps {
  coordinator: ClaudeForkCoordinator;
  directory?: string;
  /** Structured argv invocation through the host's process wrapper. */
  cli?: (args: string[]) => Promise<string>;
  clone?: typeof cloneClaudeSession;
}

/** Durable steps allow retry after import or rename failure without copying the session again. */
export function createClaudeSessionForkHandler(deps: ClaudeForkDeps) {
  const directory = deps.directory ?? path.join(defaultTranslationCacheDirectory(), "claude-forks");
  const home = path.resolve(directory, "../../..");
  const cli = deps.cli ?? createPaseoCli(home);
  const clone = deps.clone ?? cloneClaudeSession;
  const pending = new Map<string, Promise<ClaudeSessionForkResult>>();

  async function save(file: string, operation: Operation): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(operation) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  }

  async function findImported(context: PluginHandlerContext, operationId: string, operation: Operation): Promise<string | undefined> {
    let cursor: string | undefined;
    do {
      const page = await context.paseo.agents.list({
        filter: { includeArchived: true, labels: { [OPERATION_LABEL]: operationId } }, page: { limit: 200, cursor },
      });
      const found = page.entries.find(({ agent }) => agent.provider === TRANSLATE_CLAUDE_PROVIDER_ID &&
        agent.labels[OPERATION_LABEL] === operationId && isForkHandle(agent.persistence?.sessionId, operation));
      if (found) return found.agent.id;
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return undefined;
  }

  async function run(input: { agentId: string; operationId: string }, context: PluginHandlerContext): Promise<ClaudeSessionForkResult> {
    const source = await context.paseo.agents.ref(input.agentId).refresh();
    if (!source || source.agent.provider !== TRANSLATE_CLAUDE_PROVIDER_ID) {
      throw new Error("Only Translate (Claude Code) sessions can be forked");
    }
    if (source.agent.archivedAt) throw new Error("Open and unarchive the source session before forking it");
    // Verify CLI targeting before any filesystem mutation. A wrong home must never receive the copy.
    const inspected = sourceSchema.parse(JSON.parse(await cli(["agent", "inspect", input.agentId])));
    if (inspected.Id !== input.agentId || inspected.Provider !== TRANSLATE_CLAUDE_PROVIDER_ID ||
      path.resolve(inspected.Cwd) !== path.resolve(source.agent.cwd)) {
      throw new Error("Paseo CLI is connected to a different daemon or source session");
    }
    const file = path.join(directory, `${createHash("sha256").update(input.agentId).digest("hex")}-${input.operationId}.json`);
    let operation: Operation | undefined;
    try { operation = operationSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (operation && operation.sourceAgentId !== input.agentId) throw new Error("Fork operation belongs to a different source");

    let restartRequired = false;
    await deps.coordinator.exclusive(input.agentId, async () => {
      if (operation?.copiedFiles !== undefined) return;
      const prepared = await deps.coordinator.prepare(input.agentId);
      if (!operation) {
        const newSessionId = randomUUID();
        operation = operationSchema.parse({ sourceAgentId: input.agentId, sourceSessionId: prepared.claudeSessionId,
          newSessionId, cwd: prepared.config.cwd, configDir: prepared.configDir,
          title: `${(source.agent.title?.trim() || "Claude session").slice(0, 170)} (fork ${newSessionId.slice(0, 8)})`,
          config: claudeForkConfiguration(prepared.config) });
        await save(file, operation);
      }
      if (operation.sourceSessionId !== prepared.claudeSessionId || operation.configDir !== prepared.configDir ||
        path.resolve(operation.cwd) !== path.resolve(prepared.config.cwd)) {
        restartRequired = true;
        return;
      }
      const transcript = path.join(claudeProjectDir(operation.cwd, operation.configDir), `${operation.sourceSessionId}.jsonl`);
      const manifest = path.join(path.dirname(transcript), `${operation.newSessionId}.clone.json`);
      let copied: ClaudeSessionClone;
      let savedManifest: string | undefined;
      try {
        savedManifest = await readFile(manifest, "utf8");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (savedManifest !== undefined) {
        copied = claudeSessionCloneSchema.parse(JSON.parse(savedManifest));
        if (copied.sourceSessionId !== operation.sourceSessionId || copied.newSessionId !== operation.newSessionId ||
          copied.transcript !== path.join(path.dirname(transcript), `${operation.newSessionId}.jsonl`) ||
          copied.identifierMapping[operation.sourceSessionId] !== operation.newSessionId || copied.files.length !== copied.copiedFiles ||
          !copied.files.some((entry) => entry.copy === copied.transcript)) {
          throw new Error("Fork manifest does not match the saved operation");
        }
        const roots = [path.join(path.dirname(transcript), operation.newSessionId),
          path.join(operation.configDir, "file-history", operation.newSessionId),
          path.join(operation.configDir, "session-env", operation.newSessionId)];
        for (const entry of copied.files) {
          if (entry.copy !== copied.transcript && !roots.some((root) => entry.copy.startsWith(root + path.sep))) {
            throw new Error("Fork manifest contains a path outside the copied session");
          }
          const hash = createHash("sha256").update(await readFile(entry.copy)).digest("hex");
          if (hash !== entry.sha256) throw new Error("Incomplete fork copy; inspect its saved manifest before retrying");
        }
      } else {
        copied = await clone({ transcript, configDir: operation.configDir,
          newSessionId: operation.newSessionId, title: operation.title });
      }
      operation.copiedFiles = copied.copiedFiles;
      await save(file, operation);
    });
    if (restartRequired) return { kind: "restart_required", message: "The source session changed after the previous attempt. Confirm a new fork of the current session." };
    if (!operation || operation.copiedFiles === undefined) throw new Error("Fork copy did not complete");
    const handle = `plugin:${JSON.stringify({ version: 1, data: { claudeSessionId: operation.newSessionId,
      configDir: operation.configDir, forkConfig: operation.config } })}`;
    operation.agentId ??= await findImported(context, input.operationId, operation);
    if (!operation.agentId) {
      const imported = importedSchema.parse(JSON.parse(await cli(["import", handle,
        "--provider", TRANSLATE_CLAUDE_PROVIDER_ID, "--cwd", operation.cwd,
        "--label", `${OPERATION_LABEL}=${input.operationId}`])));
      if (imported.provider !== TRANSLATE_CLAUDE_PROVIDER_ID || path.resolve(imported.cwd) !== path.resolve(operation.cwd)) {
        throw new Error("Paseo imported an unexpected provider or working directory");
      }
      operation.agentId = imported.agentId;
    }
    await save(file, operation);
    // Persist a visible Paseo title as well as the custom-title in Claude storage.
    await cli(["agent", "update", operation.agentId, "--name", operation.title]);
    const target = await context.paseo.agents.ref(operation.agentId).refresh();
    if (!target) throw new Error("Fork import verification failed: imported agent is missing; retry this operation to finish it");
    if (target.agent.provider !== TRANSLATE_CLAUDE_PROVIDER_ID || !isForkHandle(target.agent.persistence?.sessionId, operation)) {
      throw new Error("Fork import verification failed: provider or session identity mismatch; retry this operation to finish it");
    }
    if (target.agent.title !== operation.title) {
      throw new Error("Fork title verification failed: the saved title differs from the requested title; retry this operation to finish it");
    }
    return { kind: "forked", agentId: operation.agentId, claudeSessionId: operation.newSessionId, copiedFiles: operation.copiedFiles };
  }

  return (input: { agentId: string; operationId: string }, context: PluginHandlerContext) => {
    const key = `${input.agentId}:${input.operationId}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const result = run(input, context);
    pending.set(key, result);
    const clear = () => { if (pending.get(key) === result) pending.delete(key); };
    void result.then(clear, clear);
    return result;
  };
}
