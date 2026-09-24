/**
 * Maps Codex app-server thread items onto the plugin provider timeline.
 * Simplified from Paseo's native `threadItemToTimeline` / tool-call mapper:
 * structured shell/edit/search/plan cards, flattened sub-agent cards, and
 * text items. Translation never touches these details.
 */

import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function toObjectRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "collabAgentToolCall",
  "subAgentActivity",
]);

export interface CodexQuestionPrompt {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export function normalizeCodexQuestionPrompts(raw: unknown): CodexQuestionPrompt[] {
  if (!Array.isArray(raw)) return [];
  const questions: CodexQuestionPrompt[] = [];
  for (const item of raw) {
    const record = toObjectRecord(item);
    if (!record) continue;
    const id = nonEmptyString(record.id);
    const header = nonEmptyString(record.header);
    const question = nonEmptyString(record.question);
    if (!id || !header || !question) continue;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          const optionRecord = toObjectRecord(option);
          if (!optionRecord) return [];
          const label = nonEmptyString(optionRecord.label);
          if (!label) return [];
          const description = nonEmptyString(optionRecord.description);
          return [{ label, ...(description !== null ? { description } : {}) }];
        })
      : [];
    questions.push({
      id,
      header,
      question,
      options,
      ...(record.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

export function formatCodexQuestionPrompts(questions: CodexQuestionPrompt[]): string {
  return questions
    .map((question) => {
      const lines = [`${question.header}: ${question.question}`];
      if (question.options.length > 0) {
        lines.push(`Options: ${question.options.map((option) => option.label).join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n")
    .trim();
}

export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const record = toObjectRecord(item);
    if (record !== null && record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("\n");
}

export function reasoningTextFromItem(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
  const content = Array.isArray(item.content) ? item.content.join("\n") : "";
  return summary || content;
}

function toolStatus(
  status: unknown,
  error: unknown,
): Extract<ProviderTimelineItem, { type: "tool_call" }>["status"] {
  if (error != null && status !== "canceled") return "failed";
  if (status === "failed") return "failed";
  if (status === "canceled" || status === "interrupted") return "canceled";
  if (status === "completed" || status === "success") return "completed";
  return "running";
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const unix = trimmed.match(/^(?:(?:\/[^/\s]+)*\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/);
  if (unix?.[1]) return unix[1].trim().replace(/^(['"])(.*)\1$/s, "$2");
  return trimmed;
}

function commandFromItem(item: Record<string, unknown>): string | undefined {
  const value = item.command;
  if (typeof value === "string") {
    const normalized = unwrapShellCommand(value);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (parts.length >= 3 && (parts[1] === "-lc" || parts[1] === "-c")) {
    return parts[2];
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function mapCommandExecution(item: Record<string, unknown>): ProviderTimelineItem | null {
  const id = nonEmptyString(item.id);
  if (id === null) return null;
  const command = commandFromItem(item);
  const cwd = nonEmptyString(item.cwd) ?? undefined;
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  const error = item.error ?? null;
  const status = toolStatus(item.status, error);
  const detail: ProviderToolCallDetail = {
    type: "shell",
    command: command ?? "",
    ...(cwd !== undefined ? { cwd } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(exitCode !== null ? { exitCode } : {}),
  };
  return toolItem(id, "shell", status, detail, error);
}

function firstFileChange(item: Record<string, unknown>): {
  path: string;
  unifiedDiff?: string;
  newString?: string;
} | null {
  const changes = item.changes;
  const entries = Array.isArray(changes)
    ? changes
    : isRecord(changes)
      ? Object.entries(changes).map(([path, value]) =>
          isRecord(value) ? { path, ...value } : { path, diff: value },
        )
      : [];
  for (const entry of entries) {
    const record = toObjectRecord(entry);
    if (record === null) continue;
    const filePath =
      nonEmptyString(record.path) ??
      nonEmptyString(record.file_path) ??
      nonEmptyString(record.filePath);
    if (filePath === null) continue;
    const diff =
      nonEmptyString(record.diff) ??
      nonEmptyString(record.patch) ??
      nonEmptyString(record.unified_diff) ??
      nonEmptyString(record.unifiedDiff);
    const content = nonEmptyString(record.content) ?? nonEmptyString(record.newString);
    return {
      path: filePath,
      ...(diff !== null ? { unifiedDiff: diff } : {}),
      ...(content !== null && diff === null ? { newString: content } : {}),
    };
  }
  return null;
}

function mapFileChange(item: Record<string, unknown>): ProviderTimelineItem | null {
  const id = nonEmptyString(item.id);
  if (id === null) return null;
  const file = firstFileChange(item);
  const error = item.error ?? null;
  const status = toolStatus(item.status, error);
  const detail: ProviderToolCallDetail =
    file === null
      ? { type: "plain_text", label: "apply_patch", text: stringifyUnknown(item.changes) }
      : {
          type: "edit",
          filePath: file.path,
          ...(file.unifiedDiff !== undefined ? { unifiedDiff: file.unifiedDiff } : {}),
          ...(file.newString !== undefined ? { newString: file.newString } : {}),
        };
  return toolItem(id, "apply_patch", status, detail, error);
}

function mapWebSearch(item: Record<string, unknown>): ProviderTimelineItem | null {
  const id = nonEmptyString(item.id);
  if (id === null) return null;
  const query = nonEmptyString(item.query) ?? "";
  const error = item.error ?? null;
  const status = toolStatus(item.status ?? "completed", error);
  return toolItem(id, "web_search", status, { type: "search", query, toolName: "web_search" }, error);
}

function mapMcpToolCall(item: Record<string, unknown>): ProviderTimelineItem | null {
  const id = nonEmptyString(item.id);
  const tool = nonEmptyString(item.tool);
  if (id === null || tool === null) return null;
  const server = nonEmptyString(item.server);
  const name = server !== null ? `mcp__${server}__${tool}` : tool;
  const error = item.error ?? null;
  const status = toolStatus(item.status, error);
  return toolItem(
    id,
    name,
    status,
    {
      type: "plain_text",
      label: name,
      text: stringifyUnknown({ input: item.arguments, output: item.result }),
    },
    error,
  );
}

function mapSubAgent(item: Record<string, unknown>, name: string): ProviderTimelineItem | null {
  const id = nonEmptyString(item.id);
  if (id === null) return null;
  const description =
    nonEmptyString(item.prompt) ?? nonEmptyString(item.agentPath) ?? nonEmptyString(item.tool);
  const error = item.error ?? null;
  const status = toolStatus(item.status ?? (item.kind === "interrupted" ? "canceled" : "running"), error);
  return toolItem(
    id,
    "Sub-agent",
    status,
    {
      type: "sub_agent",
      subAgentType: name,
      ...(description !== null ? { description } : {}),
      log: "",
    },
    error,
  );
}

function mapPlan(item: Record<string, unknown>): ProviderTimelineItem | null {
  const id = nonEmptyString(item.id) ?? "plan";
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (text.length === 0) return null;
  return toolItem(id, "plan", "completed", { type: "plan", text }, null);
}

function toolItem(
  id: string,
  name: string,
  status: Extract<ProviderTimelineItem, { type: "tool_call" }>["status"],
  detail: ProviderToolCallDetail,
  error: unknown,
): ProviderTimelineItem {
  if (status === "failed") {
    return {
      type: "tool_call",
      id,
      callId: id,
      name,
      status,
      error: { message: errorMessage(error) },
      detail,
    };
  }
  return {
    type: "tool_call",
    id,
    callId: id,
    name,
    status,
    error: null,
    detail,
  };
}

export function threadItemToTimeline(
  item: unknown,
  options?: { includeUserMessage?: boolean },
): ProviderTimelineItem | null {
  const record = toObjectRecord(item);
  if (record === null) return null;
  const type = typeof record.type === "string" ? record.type : "";
  const id = nonEmptyString(record.id);

  if (type === "userMessage") {
    if (options?.includeUserMessage === false) return null;
    const text = extractUserText(record.content);
    const messageId = id;
    const clientMessageId =
      nonEmptyString(record.clientId) ??
      nonEmptyString(record.client_id) ??
      nonEmptyString(record.clientUserMessageId);
    return {
      type: "user_message",
      id: messageId ?? `user-${text.slice(0, 12)}`,
      text,
      ...(messageId !== null ? { messageId, revertToken: messageId } : {}),
      ...(clientMessageId !== null ? { clientMessageId } : {}),
    };
  }
  if (type === "agentMessage") {
    const text = typeof record.text === "string" ? record.text : "";
    return {
      type: "assistant_message",
      id: id ?? "assistant",
      text,
      ...(id !== null ? { messageId: id } : {}),
    };
  }
  if (type === "reasoning") {
    const text = reasoningTextFromItem(record);
    if (text.length === 0) return null;
    return { type: "reasoning", id: id ?? "reasoning", text };
  }
  if (type === "plan") return mapPlan(record);
  if (type === "contextCompaction") {
    return { type: "compaction", id: id ?? "compaction", status: "completed" };
  }
  if (type === "commandExecution") return mapCommandExecution(record);
  if (type === "fileChange") return mapFileChange(record);
  if (type === "webSearch") return mapWebSearch(record);
  if (type === "mcpToolCall") return mapMcpToolCall(record);
  if (type === "collabAgentToolCall") return mapSubAgent(record, "Sub-agent");
  if (type === "subAgentActivity") return mapSubAgent(record, "Sub-agent");
  if (TOOL_ITEM_TYPES.has(type)) {
    return mapMcpToolCall({ ...record, tool: type });
  }
  return null;
}

export function toCodexUsage(tokenUsage: unknown): {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
} | null {
  const usage = toObjectRecord(tokenUsage);
  if (usage === null) return null;
  const last = toObjectRecord(usage.last);
  const numberField = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  };
  const inputTokens = numberField(last?.inputTokens, last?.input_tokens);
  const cachedInputTokens = numberField(last?.cachedInputTokens, last?.cached_input_tokens);
  const outputTokens = numberField(last?.outputTokens, last?.output_tokens);
  const contextWindowMaxTokens = numberField(usage.model_context_window, usage.modelContextWindow);
  const contextWindowUsedTokens = numberField(last?.total_tokens, last?.totalTokens);
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    contextWindowMaxTokens === undefined &&
    contextWindowUsedTokens === undefined
  ) {
    return null;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
    ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
  };
}

export function readThreadId(response: unknown): string | null {
  const record = toObjectRecord(response);
  const thread = toObjectRecord(record?.thread);
  return nonEmptyString(thread?.id) ?? nonEmptyString(record?.threadId);
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "Tool call failed";
}

export function readTurnId(params: unknown): string | null {
  const record = toObjectRecord(params);
  if (record === null) return null;
  if (typeof record.turnId === "string") return record.turnId;
  const turn = toObjectRecord(record.turn);
  return nonEmptyString(turn?.id);
}
