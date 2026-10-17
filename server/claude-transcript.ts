import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { describeFinishedTool, describeRunningTool } from "./claude-tool-details";
import { claudeProjectDir } from "./claude-project-dir";
import { materializeImageOutput, renderImageOutputMarkdown } from "./image-output";
import { isClaudeSyntheticUserEntry, isClaudeTranscriptNoise } from "./claude-transcript-content";

/**
 * Best-effort history replay for the Translate (Claude Code) provider.
 *
 * On `session.open` with `history: "replay"`, the daemon expects the provider
 * to re-emit its persisted timeline. Claude Code persists transcripts as
 * JSONL under `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`, with
 * each subagent beside it as `<sessionId>/subagents/agent-<agentId>.jsonl`
 * plus an `agent-<agentId>.meta.json` carrying the spawning Task
 * `tool_use_id` (the same canonical id the live task protocol uses).
 *
 * This mirrors the native provider's replay in simplified form: root text /
 * thinking / tool cards are rebuilt, and each sidecar becomes a replayed
 * child session (`session.opened` with `parentSessionId`, then its items,
 * then a completed turn). Nesting resolves through the same owner rule as
 * the live path — a Task `tool_use` recorded inside a sidechain belongs to
 * that sidechain's child.
 *
 * Everything here is undocumented Claude Code internals, so every field is
 * optional and any failure reads as "no replay": the session still opens and
 * stays fully usable live. Subagent usage reuses the native definition (the
 * LAST assistant entry's usage sum — a context-size reading, not cumulative
 * spend).
 */

interface ReplayEntry {
  type?: unknown;
  timestamp?: unknown;
  parent_tool_use_id?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown; id?: unknown; usage?: unknown };
  /** Older CLIs stamp usage beside the message instead of inside it. */
  usage?: {
    input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    output_tokens?: unknown;
  };
  [key: string]: unknown;
}

export interface ReplayedChild {
  canonicalId: string;
  title?: string;
  description?: string;
  parentCanonicalId?: string;
  items: ProviderTimelineItem[];
  totalTokens?: number;
}

export interface ReplayResult {
  rootItems: ProviderTimelineItem[];
  children: ReplayedChild[];
}

/**
 * Per-block user-text restoration for history replay.
 *
 * Claude persists the translated (agent-language) prompts this plugin sent
 * it, so replaying them verbatim would show the user their own messages in
 * the wrong language after a reopen. The provider passes:
 * - `restoreRootBlock`: exact reverse lookup plus a back-translation
 *   fallback for sessions predating the reverse index. Only the root
 *   timeline gets the fallback — Task sidechain prompts are agent-language
 *   by design and must never be back-translated.
 * - `restoreChildBlock`: exact reverse lookup only (a miss keeps the block).
 *
 * Both receive one translated user text block at a time (never tool-result
 * content) and resolve with the text to emit. Absent means no restoration.
 * Callbacks SHOULD NOT throw — a throwing block is kept verbatim by the
 * per-block backstop above, but callers get no failure signal there.
 */
export interface ReplayUserTextRestore {
  restoreRootBlock: (translatedBlock: string) => Promise<string> | string;
  restoreChildBlock: (translatedBlock: string) => Promise<string> | string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function readJsonLines(path: string): Promise<ReplayEntry[]> {
  const raw = await readFile(path, "utf8");
  const entries: ReplayEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) entries.push(parsed as ReplayEntry);
    } catch {
      // A single corrupt line never fails the whole replay.
    }
  }
  return entries;
}

function readTotalTokens(entry: ReplayEntry): number | undefined {
  // Newer CLIs stamp usage inside message; older ones beside it.
  const usage =
    typeof entry.message?.usage === "object" && entry.message.usage !== null
      ? (entry.message.usage as {
          input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          output_tokens?: unknown;
        })
      : entry.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const counters = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ];
  if (!counters.some((counter) => typeof counter === "number")) return undefined;
  let total = 0;
  for (const counter of counters) {
    if (typeof counter === "number") total += counter;
  }
  return total;
}

interface Collector {
  items: ProviderTimelineItem[];
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
  taskInputs: Map<string, Record<string, unknown>>;
  ownerCanonicalByToolUseId: Map<string, string>;
  contextCanonicalId: string | null;
  totalTokens?: number;
}

function createCollector(contextCanonicalId: string | null): Collector {
  return {
    items: [],
    toolNames: new Map(),
    toolInputs: new Map(),
    taskInputs: new Map(),
    ownerCanonicalByToolUseId: new Map(),
    contextCanonicalId,
    totalTokens: undefined,
  };
}

function pushItem(collector: Collector, item: ProviderTimelineItem): void {
  collector.items.push(item);
}

async function collectEntry(
  collector: Collector,
  entry: ReplayEntry,
  idSeed: string,
  restoreUserBlock?: (translatedBlock: string) => Promise<string> | string,
): Promise<void> {
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    const metadata = (entry.compaction ?? entry.metadata ?? entry.compactMetadata) as
      { trigger?: unknown; preTokens?: unknown; pre_tokens?: unknown } | undefined;
    const preTokens = metadata?.preTokens ?? metadata?.pre_tokens;
    pushItem(collector, { type: "compaction", id: idSeed, status: "completed",
      trigger: metadata?.trigger === "manual" ? "manual" : "auto",
      ...(typeof preTokens === "number" ? { preTokens } : {}) });
    return;
  }
  if (entry.isCompactSummary) return;
  if (entry.type === "user" && isClaudeSyntheticUserEntry(entry)) {
    const content = entry.message?.content;
    if (!Array.isArray(content) || !content.some((block) =>
      typeof block === "object" && block !== null && block.type === "tool_result")) return;
  }
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  const withTimestamp = <T extends object>(item: T): T =>
    timestamp !== undefined ? { ...item, timestamp } : item;
  if (entry.type === "assistant") {
    const tokens = readTotalTokens(entry);
    if (tokens !== undefined) collector.totalTokens = tokens;
    const rawContent = entry.message?.content;
    if (typeof rawContent === "string") {
      const text = rawContent.trim();
      if (text.length > 0 && !isClaudeTranscriptNoise(text)) {
        pushItem(
          collector,
          withTimestamp({
            type: "assistant_message",
            id: `${idSeed}`,
            text,
          } satisfies ProviderTimelineItem),
        );
      }
      return;
    }
    const content = rawContent;
    if (!Array.isArray(content)) return;
    const messageId = readString(entry.message?.id);
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as { type?: unknown };
      if (record.type === "text") {
        const text = readString((block as { text?: unknown }).text);
        if (text === undefined || isClaudeTranscriptNoise(text)) continue;
        pushItem(
          collector,
          withTimestamp({
            type: "assistant_message",
            id: `${idSeed}`,
            text,
            ...(messageId !== undefined ? { messageId } : {}),
          } satisfies ProviderTimelineItem),
        );
      } else if (record.type === "thinking") {
        const thinking = readString((block as { thinking?: unknown }).thinking);
        if (thinking === undefined) continue;
        pushItem(
          collector,
          withTimestamp({
            type: "reasoning",
            id: `${idSeed}`,
            text: thinking,
          } satisfies ProviderTimelineItem),
        );
      } else if (record.type === "tool_use") {
        const use = block as { id?: unknown; name?: unknown; input?: unknown };
        if (typeof use.id !== "string" || typeof use.name !== "string") continue;
        collector.toolNames.set(use.id, use.name);
        collector.toolInputs.set(use.id, use.input);
        if (collector.contextCanonicalId !== null) {
          collector.ownerCanonicalByToolUseId.set(use.id, collector.contextCanonicalId);
        }
        if (use.name === "Task" && typeof use.input === "object" && use.input !== null) {
          collector.taskInputs.set(use.id, use.input as Record<string, unknown>);
        }
        pushItem(
          collector,
          withTimestamp({
            type: "tool_call",
            id: use.id,
            callId: use.id,
            name: use.name,
            status: "running",
            error: null,
            detail: describeRunningTool(use.name, use.input),
          } satisfies ProviderTimelineItem),
        );
      }
    }
    return;
  }
  if (entry.type === "user") {
    const content = entry.message?.content;
    // A throwing restorer must never fail the whole replay: on error the
    // translated block is kept (otherwise the readClaudeReplay catch-all
    // would drop every item on one bad block). Provider callbacks are
    // guarded already; this is the backstop for future callers.
    const restoreBlock = async (translatedBlock: string): Promise<string> => {
      if (restoreUserBlock === undefined) return translatedBlock;
      try {
        return await restoreUserBlock(translatedBlock);
      } catch {
        return translatedBlock;
      }
    };
    // Sidecar prompts serialize as a bare string rather than a block array.
    if (typeof content === "string") {
      const text = content.trim();
      if (text.length > 0 && !isClaudeTranscriptNoise(text)) {
        pushItem(
          collector,
          withTimestamp({
            type: "user_message",
            id: `${idSeed}`,
            text: await restoreBlock(text),
            ...rewindIdentity(entry),
          } satisfies ProviderTimelineItem),
        );
      }
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as { type?: unknown };
      if (record.type === "text") {
        const text = readString((block as { text?: unknown }).text);
        // Per-block restore BEFORE joining: forward translation ran per
        // block, so block boundaries are the only exact lookup keys. A
        // joined-string lookup would miss every multi-block turn.
        if (text !== undefined && !isClaudeTranscriptNoise(text)) texts.push(await restoreBlock(text));
      } else if (record.type === "tool_result") {
        const result = block as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
        if (typeof result.tool_use_id !== "string") continue;
        const name = collector.toolNames.get(result.tool_use_id) ?? "tool";
        const output = flattenReplayContent(result.content);
        pushItem(
          collector,
          withTimestamp({
            type: "tool_call",
            id: result.tool_use_id,
            callId: result.tool_use_id,
            name,
            ...(result.is_error === true
              ? { status: "failed" as const, error: output ?? "Tool failed" }
              : { status: "completed" as const, error: null }),
            detail: describeFinishedTool(name, collector.toolInputs.get(result.tool_use_id), output),
          } satisfies ProviderTimelineItem),
        );
        if (Array.isArray(result.content)) {
          for (const [index, block] of result.content.entries()) {
            if (typeof block !== "object" || block === null || block.type !== "image") continue;
            const source = block.source;
            if (source?.type !== "base64" || typeof source.data !== "string" || typeof source.media_type !== "string") continue;
            const image = materializeImageOutput(source.data, source.media_type);
            pushItem(collector, withTimestamp({ type: "assistant_message",
              id: `${result.tool_use_id}-image-${index}`,
              text: image ? renderImageOutputMarkdown(image.uri) : "Image output was omitted because it was not available as a file path or URL." }));
          }
        }
      }
    }
    if (texts.length > 0) {
      pushItem(
        collector,
        withTimestamp({
          type: "user_message",
          id: `${idSeed}`,
          text: texts.join("\n"),
            ...rewindIdentity(entry),
        } satisfies ProviderTimelineItem),
      );
    }
  }
}

/** Live rewind anchors use the Claude-side user uuid as revertToken. */
function rewindIdentity(
  entry: ReplayEntry,
): { messageId: string; revertToken: string } | Record<string, never> {
  const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
  if (uuid === undefined || uuid.length === 0) return {};
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)
  ) {
    return {};
  }
  return { messageId: uuid, revertToken: uuid };
}

function flattenReplayContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: unknown };
    if (record.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    } else if (record.type === "image") {
      // Same marker as the live path (flattenToolResult): the base64 payload
      // itself never enters timeline text.
      const source = (block as { source?: unknown }).source;
      if (
        typeof source === "object" &&
        source !== null &&
        typeof (source as { data?: unknown }).data === "string" &&
        typeof (source as { media_type?: unknown }).media_type === "string"
      ) {
        parts.push("[image]");
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Best-effort replay. Never throws: failures read as empty replay. */
export async function readClaudeReplay(
  cwd: string,
  claudeSessionId: string,
  restore?: ReplayUserTextRestore,
  configDir?: string,
): Promise<ReplayResult> {
  const empty: ReplayResult = { rootItems: [], children: [] };
  try {
    return await readReplayInner(cwd, claudeSessionId, restore, configDir);
  } catch {
    return empty;
  }
}

interface ReplayMeta {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
}

async function readReplayInner(
  cwd: string,
  claudeSessionId: string,
  restore?: ReplayUserTextRestore,
  configDir?: string,
): Promise<ReplayResult> {
  const projectDir = claudeProjectDir(cwd, configDir);
  const entries = await readJsonLines(join(projectDir, `${claudeSessionId}.jsonl`));
  if (entries.length === 0) return { rootItems: [], children: [] };

  const root = createCollector(null);
  let seed = 0;
  for (const entry of entries) {
    // Sidechain frames live in the same file on older CLIs
    // (`parent_tool_use_id`) or are flagged inline on newer ones
    // (`isSidechain`); children replay from sidecars either way.
    if (
      (typeof entry.parent_tool_use_id === "string" && entry.parent_tool_use_id.length > 0) ||
      entry.isSidechain === true
    ) {
      continue;
    }
    await collectEntry(root, entry, `replay-${seed++}`, restore?.restoreRootBlock);
  }

  const children = await readReplayChildren(projectDir, claudeSessionId, root, restore);
  return { rootItems: root.items, children };
}

async function readReplayChildren(
  projectDir: string,
  claudeSessionId: string,
  root: Collector,
  restore?: ReplayUserTextRestore,
): Promise<ReplayedChild[]> {
  let files: string[];
  try {
    files = await readdir(join(projectDir, claudeSessionId, "subagents"));
  } catch {
    return [];
  }
  const sidecars = files.filter((file) => file.startsWith("agent-") && file.endsWith(".jsonl"));
  // Replay every sidecar in activity order. An unreadable mtime sorts first.
  const byAge = await Promise.all(
    sidecars.map(async (file) => {
      let mtimeMs = 0;
      try {
        const fileStat = await stat(join(projectDir, claudeSessionId, "subagents", file));
        if (Number.isFinite(fileStat.mtimeMs)) mtimeMs = fileStat.mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { file, mtimeMs };
    }),
  );
  byAge.sort((a, b) => a.mtimeMs - b.mtimeMs);
  // Two passes: every sidecar's Task tool_use evidence merges first, so a
  // grandchild processed before its parent still resolves nesting.
  const staged: Array<{
    canonicalId: string;
    meta: { agentType?: unknown; description?: unknown };
    collector: Collector;
  }> = [];
  for (const { file } of byAge) {
    try {
      const agentId = file.slice("agent-".length, -".jsonl".length);
      const stagedChild = await stageReplayChild(
        projectDir,
        claudeSessionId,
        agentId,
        restore?.restoreChildBlock,
      );
      if (stagedChild) {
        staged.push(stagedChild);
        for (const [toolUseId, owner] of stagedChild.collector.ownerCanonicalByToolUseId) {
          root.ownerCanonicalByToolUseId.set(toolUseId, owner);
        }
        for (const [toolUseId, input] of stagedChild.collector.taskInputs) {
          root.taskInputs.set(toolUseId, input);
        }
      }
    } catch {
      // One unreadable sidecar never fails the rest of the replay.
    }
  }
  return staged.map(({ canonicalId, meta, collector }) => {
    const parentCanonicalId = root.ownerCanonicalByToolUseId.get(canonicalId);
    return {
      canonicalId,
      ...(readString(meta?.agentType) !== undefined ? { title: readString(meta?.agentType) } : {}),
      ...(readString(meta?.description) !== undefined
        ? { description: readString(meta?.description) }
        : {}),
      ...(parentCanonicalId !== undefined ? { parentCanonicalId } : {}),
      items: collector.items,
      ...(collector.totalTokens !== undefined ? { totalTokens: collector.totalTokens } : {}),
    };
  });
}

async function stageReplayChild(
  projectDir: string,
  claudeSessionId: string,
  agentId: string,
  restoreUserBlock?: (translatedBlock: string) => Promise<string> | string,
): Promise<{
  canonicalId: string;
  meta: { agentType?: unknown; description?: unknown };
  collector: Collector;
} | null> {
  const base = join(projectDir, claudeSessionId, "subagents", `agent-${agentId}`);
  let meta: ReplayMeta | null = null;
  try {
    const raw = await readFile(`${base}.meta.json`, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      meta = parsed as ReplayMeta;
    }
  } catch {
    meta = null;
  }
  const canonicalId = readString(meta?.toolUseId);
  if (canonicalId === undefined) return null;
  const entries = await readJsonLines(`${base}.jsonl`);
  if (entries.length === 0) return null;
  const collector = createCollector(canonicalId);
  let seed = 0;
  for (const entry of entries) {
    await collectEntry(collector, entry, `replay-${canonicalId}-${seed++}`, restoreUserBlock);
  }
  return { canonicalId, meta: meta ?? {}, collector };
}
