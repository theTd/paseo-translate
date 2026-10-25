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
import { createPaseoCli, createPaseoImport, isPaseoCliRequestTimeout, type PaseoImportRequest } from "./paseo-cli";

const OPERATION_LABEL = "translate.claude-fork-operation";
const sourceSchema = z.object({ Id: z.string(), Provider: z.string(), Cwd: z.string() });
const importedSchema = z.object({ agentId: z.string(), provider: z.string(), cwd: z.string(), workspaceId: z.string().optional() });
const operationSchema = z.object({
  sourceAgentId: z.string(), sourceSessionId: z.uuid(), newSessionId: z.uuid(),
  cwd: z.string(), configDir: z.string(), title: z.string(), copiedFiles: z.number().int().positive().optional(),
  // Import destination; an operation saved before workspace binding lacks it.
  workspaceId: z.string().optional(),
  config: claudeForkConfigurationSchema,
  agentId: z.string().optional(),
  importStartedAt: z.number().int().nonnegative().optional(),
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
  /** Daemon-client import; the CLI has no way to name the destination workspace. */
  importAgent?: (request: PaseoImportRequest) => Promise<string>;
  clone?: typeof cloneClaudeSession;
  /** The daemon rejects plugin RPCs after 30s; at this age the call reports in_progress. */
  inProgressAfterMs?: number;
  /** Poll the operation label after an import timeout without resubmitting it. */
  importPollIntervalMs?: number;
  /** Budget from import submission; expiry preserves the pending import for retry. */
  importRecoveryTimeoutMs?: number;
}
/** Every invocation races the shared run; copies and imports never repeat within one source. */
const IN_PROGRESS_AFTER_MS = 20_000;
const IMPORT_POLL_INTERVAL_MS = 1_000;
const IMPORT_RECOVERY_TIMEOUT_MS = 10 * 60_000;

/** Durable steps allow retry after import or rename failure without copying the session again. */
export function createClaudeSessionForkHandler(deps: ClaudeForkDeps) {
  const directory = deps.directory ?? path.join(defaultTranslationCacheDirectory(), "claude-forks");
  const home = path.resolve(directory, "../../..");
  const cli = deps.cli ?? createPaseoCli(home);
  const importAgent = deps.importAgent ?? createPaseoImport(home);
  const clone = deps.clone ?? cloneClaudeSession;
  const inProgressAfter = deps.inProgressAfterMs ?? IN_PROGRESS_AFTER_MS;
  const importPollInterval = deps.importPollIntervalMs ?? IMPORT_POLL_INTERVAL_MS;
  const importRecoveryTimeout = deps.importRecoveryTimeoutMs ?? IMPORT_RECOVERY_TIMEOUT_MS;
  const pending = new Map<string, { operationId: string; result: Promise<ClaudeSessionForkResult> }>();

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

  async function waitForImported(context: PluginHandlerContext, operationId: string, operation: Operation): Promise<string> {
    const deadline = operation.importStartedAt! + importRecoveryTimeout;
    for (;;) {
      const agentId = await findImported(context, operationId, operation);
      if (agentId) return agentId;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Paseo has not confirmed the fork import yet. Retry this operation to check again; starting a new fork creates a separate copy.");
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(importPollInterval, remaining)); });
    }
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
          newSessionId, cwd: prepared.config.cwd, workspaceId: source.agent.workspaceId, configDir: prepared.configDir,
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
    // A journal saved before workspace binding must still import into the
    // source workspace; the daemon otherwise picks the oldest one for the cwd.
    // An import already submitted without one keeps its daemon-chosen placement:
    // binding it now would fail verification on every retry.
    if (operation.workspaceId === undefined && source.agent.workspaceId !== undefined &&
      operation.agentId === undefined && operation.importStartedAt === undefined) {
      operation.workspaceId = source.agent.workspaceId;
      await save(file, operation);
    }
    const handle = `plugin:${JSON.stringify({ version: 1, data: { claudeSessionId: operation.newSessionId,
      configDir: operation.configDir, forkConfig: operation.config } })}`;
    operation.agentId ??= await findImported(context, input.operationId, operation);
    if (!operation.agentId) {
      if (operation.importStartedAt === undefined) {
        // Persist the intent before submission: a plugin restart must not
        // resubmit an import whose daemon-side outcome is still unknown.
        operation.importStartedAt = Date.now();
        await save(file, operation);
        let output: string | undefined;
        try {
          output = await importAgent({ handle, provider: TRANSLATE_CLAUDE_PROVIDER_ID, cwd: operation.cwd,
            workspaceId: operation.workspaceId, labels: { [OPERATION_LABEL]: input.operationId } });
        } catch (error) {
          if (!isPaseoCliRequestTimeout(error)) {
            delete operation.importStartedAt;
            await save(file, operation);
            throw error;
          }
        }
        if (output !== undefined) {
          const imported = importedSchema.parse(JSON.parse(output));
          if (imported.provider !== TRANSLATE_CLAUDE_PROVIDER_ID || path.resolve(imported.cwd) !== path.resolve(operation.cwd)) {
            throw new Error("Paseo imported an unexpected provider or working directory");
          }
          if (operation.workspaceId !== undefined && imported.workspaceId !== operation.workspaceId) {
            throw new Error(`Paseo imported the fork into workspace ${imported.workspaceId ?? "unknown"} instead of the source workspace ${operation.workspaceId}`);
          }
          operation.agentId = imported.agentId;
        }
      }
      operation.agentId ??= await waitForImported(context, input.operationId, operation);
    }
    delete operation.importStartedAt;
    await save(file, operation);
    // Persist a visible Paseo title as well as the custom-title in Claude storage.
    await cli(["agent", "update", operation.agentId, "--name", operation.title]);
    const target = await context.paseo.agents.ref(operation.agentId).refresh();
    if (!target) throw new Error("Fork import verification failed: imported agent is missing; retry this operation to finish it");
    if (target.agent.provider !== TRANSLATE_CLAUDE_PROVIDER_ID || !isForkHandle(target.agent.persistence?.sessionId, operation)) {
      throw new Error("Fork import verification failed: provider or session identity mismatch; retry this operation to finish it");
    }
    if (operation.workspaceId !== undefined && target.agent.workspaceId !== operation.workspaceId) {
      throw new Error(`Fork import verification failed: the fork is in workspace ${target.agent.workspaceId ?? "unknown"} instead of the source workspace ${operation.workspaceId}`);
    }
    if (target.agent.title !== operation.title) {
      throw new Error("Fork title verification failed: the saved title differs from the requested title; retry this operation to finish it");
    }
    return { kind: "forked", agentId: operation.agentId, claudeSessionId: operation.newSessionId, copiedFiles: operation.copiedFiles };
  }

  return (input: { agentId: string; operationId: string }, context: PluginHandlerContext) => {
    // One fork in flight per source: a restart with a fresh operation ID must
    // attach to the running copy instead of cloning the session twice.
    const existing = pending.get(input.agentId);
    if (existing && existing.operationId !== input.operationId) {
      // Hand back the durable retry key before waiting on a run that may
      // reject: retrying the new key would otherwise create a second copy.
      return Promise.resolve<ClaudeSessionForkResult>({ kind: "in_progress", operationId: existing.operationId });
    }
    const result = existing?.result ?? run(input, context);
    const clear = () => {
      if (pending.get(input.agentId)?.result === result) pending.delete(input.agentId);
    };
    if (!existing) {
      pending.set(input.agentId, { operationId: input.operationId, result });
      void result.then(clear, clear);
    }
    let timer: NodeJS.Timeout | undefined;
    const inProgress = new Promise<ClaudeSessionForkResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "in_progress" }), inProgressAfter);
    });
    return Promise.race([result, inProgress]).finally(() => clearTimeout(timer));
  };
}
