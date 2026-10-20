import { randomUUID, createHash } from "node:crypto";
import { lstat, readdir, readFile, mkdir, open, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UUID_FIELDS = new Set([
  "uuid", "parentUuid", "leafUuid", "messageId", "snapshotMessageId", "sourceToolAssistantUUID",
  "promptId", "commandUuid", "source_uuid", "deliveryId", "delivery_id", "sessionId",
]);
const TOOL_FIELDS = new Set(["toolUseID", "toolUseId", "sourceToolUseID", "tool_use_id"]);
const AGENT_FIELDS = new Set(["agentId", "task_id", "runId", "workflowRunId", "parentTaskId"]);

interface Snapshot {
  transcript: string;
  candidates: string[];
  trees: string[];
  directories: Set<string>;
  files: Map<string, Buffer>;
}

export const claudeSessionCloneSchema = z.object({
  sourceSessionId: z.uuid(), newSessionId: z.uuid(), transcript: z.string().min(1),
  copiedFiles: z.number().int().positive(), identifierMapping: z.record(z.string(), z.string()),
  files: z.array(z.object({ copy: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1),
});
export type ClaudeSessionClone = z.output<typeof claudeSessionCloneSchema>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function info(file: string) {
  try {
    const result = await lstat(file);
    if (result.isSymbolicLink()) throw new Error(`Linked session storage is unsupported: ${file}`);
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function walk(directory: string, directories: Set<string>, files: Set<string>): Promise<void> {
  const stats = await info(directory);
  if (!stats?.isDirectory()) throw new Error(`Expected a session directory: ${directory}`);
  directories.add(directory);
  for (const entry of await readdir(directory)) {
    const child = path.join(directory, entry);
    const childInfo = await info(child);
    if (childInfo?.isDirectory()) await walk(child, directories, files);
    else if (childInfo?.isFile()) files.add(child);
    else throw new Error(`Non-regular or disappearing session file: ${child}`);
  }
}

async function snapshot(transcript: string, configDir: string): Promise<Snapshot> {
  if (!(await info(transcript))?.isFile()) throw new Error(`Claude transcript not found: ${transcript}`);
  const id = path.basename(transcript, ".jsonl");
  const candidates = [path.join(path.dirname(transcript), id),
    path.join(configDir, "file-history", id), path.join(configDir, "session-env", id)];
  const trees: string[] = [];
  const directories = new Set<string>();
  const files = new Set([transcript]);
  for (const tree of candidates) {
    if (await info(tree)) {
      trees.push(tree);
      await walk(tree, directories, files);
    }
  }
  const result: Snapshot = { transcript, candidates, trees, directories, files: new Map() };
  for (const file of files) result.files.set(file, await readFile(file));
  await unchanged(result);
  return result;
}

async function unchanged(source: Snapshot): Promise<void> {
  const directories = new Set<string>();
  const files = new Set([source.transcript]);
  for (const tree of source.candidates) {
    if (await info(tree)) await walk(tree, directories, files);
  }
  if (directories.size !== source.directories.size || files.size !== source.files.size ||
    [...directories].some((file) => !source.directories.has(file)) ||
    [...files].some((file) => !source.files.has(file))) {
    throw new Error("Source session file/directory set changed while forking; retry when idle");
  }
  for (const [file, content] of source.files) {
    if (!(await info(file))?.isFile() || !(await readFile(file)).equals(content)) {
      throw new Error(`Source session changed while forking: ${file}`);
    }
  }
}

function text(file: string, bytes: Buffer): string {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`UTF-8 reading failed: ${file}`); }
  // Fatal decoding rejects malformed bytes; a literal U+FFFD is valid stored text.
  return decoded;
}

function records(file: string, content: string): unknown[] {
  const decoded = content.replace(/^\ufeff/, "");
  try {
    return file.endsWith(".jsonl")
      ? decoded.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown)
      : [JSON.parse(decoded) as unknown];
  } catch { throw new Error(`Invalid JSON in session storage: ${file}`); }
}

function mappings(source: Snapshot, newId: string): Map<string, string> {
  const result = new Map([[path.basename(source.transcript, ".jsonl"), newId]]);
  function allocate(value: unknown, agent = false): void {
    if (typeof value !== "string" || !value || result.has(value)) return;
    let replacement: string;
    if (UUID.test(value)) replacement = randomUUID();
    else if (agent) replacement = randomUUID().replaceAll("-", "").slice(0, /^[0-9a-f]+$/i.test(value) ? Math.min(value.length, 32) : 17);
    else if (/^(toolu_|srvtoolu_|mcptoolu_|msg_)/.test(value)) {
      const prefix = value.slice(0, value.indexOf("_") + 1);
      replacement = prefix + randomUUID().replaceAll("-", "").slice(0, Math.max(16, value.length - prefix.length));
    } else return;
    if (replacement === value || result.has(replacement) || [...result.values()].includes(replacement)) {
      throw new Error("Generated identifier collision; retry the fork");
    }
    result.set(value, replacement);
  }
  function envelope(value: unknown): void {
    const entry = object(value);
    if (!entry) return;
    for (const [key, child] of Object.entries(entry)) {
      if (AGENT_FIELDS.has(key)) allocate(child, true);
      else if (UUID_FIELDS.has(key) || TOOL_FIELDS.has(key)) allocate(child);
    }
  }
  const tree = path.join(path.dirname(source.transcript), path.basename(source.transcript, ".jsonl"));
  const parsedRecords: unknown[] = [];
  for (const [file, bytes] of source.files) {
    const relative = path.relative(tree, file).split(path.sep);
    const isSidechain = relative[0] === "subagents";
    const isWorkflow = relative[0] === "workflows";
    const filename = path.basename(file);
    const agent = /^agent-(.+)\.(?:jsonl|meta\.json)$/.exec(filename)?.[1];
    if (isSidechain && agent) allocate(agent, true);
    if (isSidechain && relative[1] === "workflows" && relative.length >= 4) allocate(relative[2], true);
    if (file !== source.transcript && !isSidechain && !isWorkflow) continue;
    if (!/\.(?:json|jsonl)$/.test(file)) continue;
    parsedRecords.push(...records(file, text(file, bytes)));
  }
  const agentTools = new Set<string>();
  for (const value of parsedRecords) {
    const message = object(object(value)?.message);
    for (const value of Array.isArray(message?.content) ? message.content : []) {
      const block = object(value);
      if (block?.type === "tool_use" && (block.name === "Task" || block.name === "Agent") && typeof block.id === "string") {
        agentTools.add(block.id);
      }
    }
  }
  for (const value of parsedRecords) {
      const entry = object(value);
      if (!entry) continue;
      envelope(entry);
      envelope(entry.attachment);
      const snap = object(entry.snapshot);
      allocate(snap?.messageId);
      const message = object(entry.message);
      if (message?.role === "assistant") allocate(message.id);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const value of blocks) {
        const block = object(value);
        if (block?.type === "tool_use" || block?.type === "mcp_tool_use" || block?.type === "server_tool_use") {
          allocate(block.id);
        } else if (typeof block?.type === "string" && (block.type === "tool_result" || block.type.endsWith("_tool_result"))) {
          allocate(block.tool_use_id);
        }
      }
      const toolResult = object(entry.toolUseResult);
      if (blocks.some((value) => {
        const block = object(value);
        return block?.type === "tool_result" && typeof block.tool_use_id === "string" && agentTools.has(block.tool_use_id);
      })) allocate(toolResult?.agentId, true);
  }
  if ([...result.values()].some((value) => result.has(value))) throw new Error("New identifiers overlap original identifiers");
  return result;
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Copy persisted Claude storage only. Project source and backup bytes remain untouched. */
export async function cloneClaudeSession(input: {
  transcript: string;
  configDir: string;
  newSessionId?: string;
  title?: string;
}): Promise<ClaudeSessionClone> {
  const oldId = path.basename(input.transcript, ".jsonl");
  const newId = input.newSessionId ?? randomUUID();
  if (!UUID.test(oldId) || !UUID.test(newId) || oldId.toLowerCase() === newId.toLowerCase()) {
    throw new Error("Fork requires distinct valid Claude session UUIDs");
  }
  const source = await snapshot(path.resolve(input.transcript), path.resolve(input.configDir));
  const mapping = mappings(source, newId);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identifierPattern = (keys: Iterable<string>) => new RegExp(`(?<![A-Za-z0-9_])(?:${[...keys].sort((a, b) => b.length - a.length).map(escape).join("|")})(?![A-Za-z0-9_])`, "g");
  const pattern = identifierPattern(mapping.keys());
  const rewrite = (value: string) => value.replace(pattern, (id) => mapping.get(id)!);
  // A Latin-1 view maps each byte to one character without decoding UTF-8.
  // Saved tool output may contain truncated characters; preserve all bytes
  // outside identifier matches, including malformed sequences and BOMs.
  const byteMapping = new Map([...mapping].map(([from, to]) => [
    Buffer.from(from, "utf8").toString("latin1"), Buffer.from(to, "utf8").toString("latin1"),
  ]));
  const bytePattern = identifierPattern(byteMapping.keys());
  function transform(value: unknown): unknown {
    if (typeof value === "string") return rewrite(value);
    if (Array.isArray(value)) return value.map(transform);
    const record = object(value);
    if (!record) return value;
    const entries = Object.entries(record).map(([key, child]) => [rewrite(key), transform(child)] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Fork identifier rewriting caused a JSON key collision");
    return Object.fromEntries(entries);
  }
  function destination(file: string): string {
    if (file === source.transcript) return path.join(path.dirname(file), `${newId}.jsonl`);
    const tree = source.trees.find((root) => file === root || file.startsWith(root + path.sep));
    if (!tree) throw new Error(`Path outside session snapshot: ${file}`);
    const relative = path.relative(tree, file).split(path.sep).map(rewrite);
    return path.join(path.dirname(tree), newId, ...relative);
  }
  const outputs = new Map<string, Buffer>();
  const sessionTree = path.join(path.dirname(source.transcript), oldId);
  for (const [file, bytes] of source.files) {
    let copy = bytes;
    if (file === source.transcript || file.startsWith(sessionTree + path.sep)) {
      if (/\.(jsonl?|txt)$/.test(file)) {
        const structured = /\.jsonl?$/.test(file);
        const original = structured ? text(file, bytes) : bytes.toString("latin1");
        let rewritten: string;
        if (structured) {
          const parsed = records(file, original);
          rewritten = original.replace(/"(?:\\.|[^"\\])*"/g, (token) => {
            const value = JSON.parse(token) as string;
            const next = rewrite(value);
            return value === next ? token : JSON.stringify(next);
          });
          if (!isDeepStrictEqual(records(file, rewritten), parsed.map(transform))) {
            throw new Error(`Fork JSON structural verification failed: ${file}`);
          }
        } else rewritten = original.replace(bytePattern, (id) => byteMapping.get(id)!);
        const verificationPattern = structured ? pattern : bytePattern;
        verificationPattern.lastIndex = 0;
        if (verificationPattern.test(rewritten)) throw new Error(`Original identifier remains in ${file}`);
        copy = Buffer.from(rewritten, structured ? "utf8" : "latin1");
      }
    }
    const target = destination(file);
    if (outputs.has(target)) throw new Error(`Fork destination path collision: ${target}`);
    outputs.set(target, copy);
  }
  const directories = new Set([...source.directories].map(destination));
  directories.add(path.join(path.dirname(source.transcript), newId));
  const transcript = destination(source.transcript);
  if (input.title) {
    const bytes = outputs.get(transcript)!;
    outputs.set(transcript, Buffer.concat([bytes,
      Buffer.from(`${bytes.at(-1) === 10 ? "" : "\n"}${JSON.stringify({ type: "custom-title", sessionId: newId, customTitle: input.title })}\n`)]));
  }
  const manifest = path.join(path.dirname(transcript), `${newId}.clone.json`);
  for (const target of [...outputs.keys(), ...directories, manifest]) {
    if (await info(target)) throw new Error(`Fork destination already exists: ${target}`);
  }
  const report: ClaudeSessionClone = { sourceSessionId: oldId, newSessionId: newId, transcript,
    copiedFiles: outputs.size, identifierMapping: Object.fromEntries(mapping),
    files: [...outputs].map(([copy, bytes]) => ({ copy, sha256: digest(bytes) })) };
  outputs.set(manifest, Buffer.from(JSON.stringify(report, null, 2) + "\n"));
  await unchanged(source);
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  try {
    for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
      await mkdir(directory);
      createdDirs.push(directory);
    }
    for (const [target, bytes] of [...outputs].sort(([a], [b]) => Number(a === transcript) - Number(b === transcript))) {
      if (target === transcript) await unchanged(source);
      // Exclusive open establishes ownership before write, including a partial-write failure.
      const handle = await open(target, "wx");
      createdFiles.push(target);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      if (!(await readFile(target)).equals(bytes)) throw new Error(`Fork write verification failed: ${target}`);
    }
    await unchanged(source);
    return report;
  } catch (error) {
    const cleanupErrors: string[] = [];
    for (const file of createdFiles.reverse()) {
      try { await unlink(file); } catch (failure) { cleanupErrors.push(String(failure)); }
    }
    for (const directory of createdDirs.reverse()) {
      try { await rmdir(directory); } catch (failure) { cleanupErrors.push(String(failure)); }
    }
    if (cleanupErrors.length) throw new Error(`${String(error)}; fork cleanup incomplete: ${cleanupErrors.join("; ")}`);
    throw error;
  }
}
