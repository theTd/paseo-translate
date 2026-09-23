import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

/**
 * Simplified port of the native Claude provider's tool-call mapping
 * (`tool-call-mapper.ts` + `tool-call-detail-parser.ts` in Paseo).
 *
 * The previous translate provider flattened every tool call to
 * `plain_text` carrying `JSON.stringify(input)`, so the app lost its
 * structured shell/read/edit/write/search/fetch rendering. This maps the
 * common Claude tool names to the plugin protocol's structured details and
 * keeps `plain_text` only as the fallback for unknown tools.
 *
 * Translation never touches these details: tool names, paths, commands, and
 * outputs already arrive in the agent language.
 */

const SHELL_NAMES = new Set(["Bash", "bash", "shell", "exec_command"]);
const READ_NAMES = new Set(["Read", "read", "read_file", "view_file"]);
const WRITE_NAMES = new Set(["Write", "write", "write_file", "create_file"]);
const EDIT_NAMES = new Set([
  "Edit",
  "MultiEdit",
  "multi_edit",
  "edit",
  "apply_patch",
  "apply_diff",
  "str_replace_editor",
]);
const SEARCH_NAMES = new Set([
  "WebSearch",
  "web_search",
  "search",
  "Grep",
  "grep",
  "Glob",
  "glob",
]);
const FETCH_NAMES = new Set([
  "WebFetch",
  "web_fetch",
  "WebFetchTool",
  "web_fetch_tool",
  "webfetch",
]);

function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readInputJson(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

/** Structured detail for a running tool call (no output yet). */
export function describeRunningTool(name: string, input: unknown): ProviderToolCallDetail {
  const trimmed = name.trim();
  if (trimmed === "Task") {
    return {
      type: "sub_agent",
      ...(readString(input, "subagent_type") !== undefined
        ? { subAgentType: readString(input, "subagent_type") }
        : {}),
      ...(readString(input, "description") !== undefined
        ? { description: readString(input, "description") }
        : {}),
      log: "",
    };
  }
  if (trimmed === "ExitPlanMode") {
    const plan = readString(input, "plan");
    if (plan !== undefined) return { type: "plan", text: plan };
    return { type: "plain_text", label: trimmed, text: readInputJson(input) };
  }
  if (SHELL_NAMES.has(trimmed)) {
    return {
      type: "shell",
      command: readString(input, "command") ?? readInputJson(input),
      ...(readString(input, "cwd") !== undefined ? { cwd: readString(input, "cwd") } : {}),
    };
  }
  if (READ_NAMES.has(trimmed)) {
    return {
      type: "read",
      filePath: readString(input, "file_path") ?? readString(input, "path") ?? trimmed,
    };
  }
  if (WRITE_NAMES.has(trimmed)) {
    return {
      type: "write",
      filePath: readString(input, "file_path") ?? readString(input, "path") ?? trimmed,
      ...(readString(input, "content") !== undefined
        ? { content: readString(input, "content") }
        : {}),
    };
  }
  if (EDIT_NAMES.has(trimmed)) {
    return {
      type: "edit",
      filePath: readString(input, "file_path") ?? readString(input, "path") ?? trimmed,
      ...(readString(input, "old_string") !== undefined
        ? { oldString: readString(input, "old_string") }
        : {}),
      ...(readString(input, "new_string") !== undefined
        ? { newString: readString(input, "new_string") }
        : {}),
    };
  }
  if (SEARCH_NAMES.has(trimmed)) {
    return {
      type: "search",
      query:
        readString(input, "query") ??
        readString(input, "pattern") ??
        readString(input, "path") ??
        readInputJson(input),
    };
  }
  if (FETCH_NAMES.has(trimmed)) {
    return {
      type: "fetch",
      url: readString(input, "url") ?? readInputJson(input),
      ...(readString(input, "prompt") !== undefined ? { prompt: readString(input, "prompt") } : {}),
    };
  }
  return { type: "plain_text", label: trimmed, text: readInputJson(input) };
}

/**
 * Fold the tool output into the running detail so the completed/failed card
 * keeps its structured shape instead of degrading to raw JSON.
 */
export function describeFinishedTool(
  name: string,
  input: unknown,
  output: string | null,
): ProviderToolCallDetail {
  const running = describeRunningTool(name, input);
  if (output === null) return running;
  switch (running.type) {
    case "shell":
      return { ...running, output, exitCode: null };
    case "search":
      return { ...running, content: output };
    case "fetch":
      return { ...running, result: output };
    case "sub_agent":
      return { ...running, log: output };
    case "plan":
      return running;
    case "read":
    case "write":
    case "edit":
      return running;
    case "plain_text":
      return { ...running, text: `${running.text ?? ""}\n${output}`.trim() };
    default:
      return running;
  }
}
