import { mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REPLAY_CHILD_ITEMS,
  MAX_REPLAY_ITEMS,
  MAX_REPLAY_LINES,
  MAX_REPLAY_SIDECARS,
  readClaudeReplay,
  type ReplayResult,
  type ReplayUserTextRestore,
} from "./claude-transcript";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function assistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

function userText(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text }] },
  });
}

interface Fixture {
  configDir: string;
  cwd: string;
  sessionId: string;
}

/** Mirrors the source's encode/canonicalize so symlinked tmpdirs cannot mismatch. */
function createFixture(): Fixture {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-config-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "claude-cwd-"));
  tempRoots.push(configDir, cwd);
  return { configDir, cwd, sessionId: "cs-tail" };
}

function projectDirOf(fixture: Fixture): string {
  const encoded = realpathSync(fixture.cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(fixture.configDir, "projects", encoded);
}

function writeRootSession(fixture: Fixture, lines: string[]): void {
  const projectDir = projectDirOf(fixture);
  mkdirSync(projectDir, { recursive: true });
  // No trailing newline: split("\n") then yields exactly lines.length
  // elements, so window arithmetic in the assertions below is exact.
  writeFileSync(path.join(projectDir, `${fixture.sessionId}.jsonl`), lines.join("\n"), "utf8");
}

function writeSidecar(
  fixture: Fixture,
  agentId: string,
  toolUseId: string,
  lines: string[],
  mtimeMs?: number,
): void {
  const projectDir = projectDirOf(fixture);
  const sidecarDir = path.join(projectDir, fixture.sessionId, "subagents");
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    path.join(sidecarDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "Explore", toolUseId }),
    "utf8",
  );
  const jsonlPath = path.join(sidecarDir, `agent-${agentId}.jsonl`);
  writeFileSync(jsonlPath, `${lines.join("\n")}\n`, "utf8");
  if (mtimeMs !== undefined) {
    const atime = new Date(mtimeMs);
    utimesSync(jsonlPath, atime, atime);
  }
}

async function replay(fixture: Fixture, restore?: ReplayUserTextRestore): Promise<ReplayResult> {
  const previous = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = fixture.configDir;
  try {
    return await readClaudeReplay(fixture.cwd, fixture.sessionId, restore);
  } finally {
    if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previous;
  }
}

function textsOf(items: ReplayResult["rootItems"]): string[] {
  return items.map((item) => ("text" in item ? String(item.text) : ""));
}

describe("claude transcript replay windows", () => {
  it("keeps the most recent items beyond the item window", async () => {
    const total = MAX_REPLAY_ITEMS + 500;
    const lines: string[] = [];
    for (let i = 0; i < total; i++) {
      lines.push(assistantText(`msg-${String(i).padStart(4, "0")}`));
    }
    const fixture = createFixture();
    writeRootSession(fixture, lines);
    const result = await replay(fixture);
    const texts = textsOf(result.rootItems);
    expect(texts).toHaveLength(MAX_REPLAY_ITEMS);
    // The head falls off; the tail — including the final response — survives, in order.
    expect(texts[0]).toBe(`msg-${String(total - MAX_REPLAY_ITEMS).padStart(4, "0")}`);
    expect(texts[texts.length - 1]).toBe(`msg-${String(total - 1).padStart(4, "0")}`);
    expect(texts).not.toContain("msg-0000");
  });

  it("keeps the most recent lines beyond the line window", async () => {
    // 500 early texts + 9500 itemless attachments + 500 late texts: the
    // line window drops exactly the 500 head lines, and the surviving 500
    // late texts fit the item window untouched, so this test isolates the
    // LINE window (the item-window test above isolates the item window).
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(assistantText(`early-${String(i).padStart(3, "0")}`));
    }
    for (let i = 0; i < MAX_REPLAY_LINES - 500; i++) {
      lines.push(JSON.stringify({ type: "attachment", text: `filler-${i}` }));
    }
    for (let i = 0; i < 500; i++) {
      lines.push(assistantText(`late-${String(i).padStart(3, "0")}`));
    }
    expect(lines).toHaveLength(MAX_REPLAY_LINES + 500);
    const fixture = createFixture();
    writeRootSession(fixture, lines);
    const result = await replay(fixture);
    const texts = textsOf(result.rootItems);
    expect(texts).toHaveLength(500);
    expect(texts[0]).toBe("late-000");
    expect(texts[texts.length - 1]).toBe("late-499");
    expect(texts).not.toContain("early-000");
  });

  it("replays a tail tool_result with the generic tool name when its tool_use fell outside the line window", async () => {
    const lines: string[] = [];
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-old", name: "Bash", input: { command: "old" } }],
        },
      }),
    );
    for (let i = 0; i < MAX_REPLAY_LINES; i++) {
      lines.push(userText(`filler-${i}`));
    }
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu-old", content: "done" }],
        },
      }),
    );
    const fixture = createFixture();
    writeRootSession(fixture, lines);
    const result = await replay(fixture);
    const toolCalls = result.rootItems.filter((item) => item.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ id: "tu-old", callId: "tu-old", name: "tool" });
  });

  it("bounds sidecar items by the shared child budget, newest children first", async () => {
    const fixture = createFixture();
    writeRootSession(fixture, [userText("hello")]);
    const perChild = Math.floor(MAX_REPLAY_CHILD_ITEMS / 2) + 500;
    const childLines = (prefix: string): string[] => {
      const lines: string[] = [];
      for (let i = 0; i < perChild; i++) {
        lines.push(assistantText(`${prefix}-${String(i).padStart(4, "0")}`));
      }
      return lines;
    };
    writeSidecar(fixture, "aaa", "tu-aaa", childLines("child-a"), Date.now() - 60_000);
    writeSidecar(fixture, "bbb", "tu-bbb", childLines("child-b"), Date.now());
    const result = await replay(fixture);
    expect(result.children).toHaveLength(2);
    const total = result.children.reduce((sum, child) => sum + child.items.length, 0);
    expect(total).toBe(MAX_REPLAY_CHILD_ITEMS);
    // Root window is untouched by the child budget.
    expect(textsOf(result.rootItems)).toEqual(["hello"]);
    // Mtime order decides priority: the newer sidecar survives whole, the
    // older one is trimmed to its own tail (which keeps its final item).
    const byId = new Map(result.children.map((child) => [child.canonicalId, child]));
    expect(textsOf(byId.get("tu-bbb")?.items ?? [])).toHaveLength(perChild);
    const olderTexts = textsOf(byId.get("tu-aaa")?.items ?? []);
    expect(olderTexts).toHaveLength(MAX_REPLAY_CHILD_ITEMS - perChild);
    expect(olderTexts[olderTexts.length - 1]).toBe(
      `child-a-${String(perChild - 1).padStart(4, "0")}`,
    );
  });

  it("stages only the newest sidecars beyond the sidecar window", async () => {
    const fixture = createFixture();
    writeRootSession(fixture, [userText("hello")]);
    const total = MAX_REPLAY_SIDECARS + 3;
    const base = Date.now() - total * 1000;
    for (let i = 0; i < total; i++) {
      const id = `s${String(i).padStart(2, "0")}`;
      writeSidecar(fixture, id, `tu-${id}`, [assistantText(`sidecar-${id}`)], base + i * 1000);
    }
    const result = await replay(fixture);
    expect(result.children).toHaveLength(MAX_REPLAY_SIDECARS);
    const ids = new Set(result.children.map((child) => child.canonicalId));
    // The three oldest sidecars fall outside the window; the newest stays.
    expect(ids.has("tu-s00")).toBe(false);
    expect(ids.has("tu-s01")).toBe(false);
    expect(ids.has("tu-s02")).toBe(false);
    expect(ids.has(`tu-s${String(total - 1).padStart(2, "0")}`)).toBe(true);
  });
});

describe("user text restoration", () => {
  it("restores root user blocks per-block before joining, leaving assistants alone", async () => {
    const fixture = createFixture();
    writeRootSession(fixture, [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "DE(Hello)" }, { type: "text", text: "DE(world)" }] },
      }),
      assistantText("Antwort"),
    ]);
    const restoreRootBlock = vi.fn((block: string) =>
      block === "DE(Hello)" ? "Hello" : block === "DE(world)" ? "world" : block,
    );
    const result = await replay(fixture, {
      restoreRootBlock,
      restoreChildBlock: (block) => block,
    });
    const users = result.rootItems.filter((item) => item.type === "user_message");
    // Block boundaries are the exact lookup keys: the joined replay text is
    // built from individually restored blocks.
    expect(users.map((item) => ("text" in item ? item.text : null))).toEqual(["Hello\nworld"]);
    expect(restoreRootBlock).toHaveBeenCalledWith("DE(Hello)");
    expect(restoreRootBlock).toHaveBeenCalledWith("DE(world)");
    expect(textsOf(result.rootItems)).toContain("Antwort");
  });

  it("routes sidecar user blocks through the child restorer, never the root one", async () => {
    const fixture = createFixture();
    writeRootSession(fixture, [userText("DE(root)")]);
    writeSidecar(fixture, "aaa", "tu-aaa", [userText("DE(child)")], Date.now());
    const restoreRootBlock = vi.fn(async (block: string) => `ROOT:${block}`);
    const restoreChildBlock = vi.fn((block: string) => `CHILD:${block}`);
    const result = await replay(fixture, { restoreRootBlock, restoreChildBlock });
    expect(textsOf(result.rootItems)).toEqual(["ROOT:DE(root)"]);
    expect(restoreRootBlock).toHaveBeenCalledWith("DE(root)");
    expect(restoreRootBlock).not.toHaveBeenCalledWith("DE(child)");
    expect(result.children).toHaveLength(1);
    expect(textsOf(result.children[0]?.items ?? [])).toEqual(["CHILD:DE(child)"]);
    expect(restoreChildBlock).toHaveBeenCalledWith("DE(child)");
    expect(restoreChildBlock).not.toHaveBeenCalledWith("DE(root)");
  });

  it("never feeds tool-result content to the restorer", async () => {
    const fixture = createFixture();
    writeRootSession(fixture, [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "DE(output)" }] },
      }),
    ]);
    const restoreRootBlock = vi.fn((block: string) => `RESTORED:${block}`);
    const result = await replay(fixture, {
      restoreRootBlock,
      restoreChildBlock: (block) => block,
    });
    // No user_message at all: the tool result replays as a tool_call whose
    // detail comes from the tool input/output, never the user restorer.
    expect(result.rootItems.some((item) => item.type === "user_message")).toBe(false);
    expect(restoreRootBlock).not.toHaveBeenCalled();
    // One running card from the assistant tool_use plus its completed card
    // from the user tool_result.
    expect(result.rootItems.filter((item) => item.type === "tool_call")).toHaveLength(2);
  });

  it("supports async root restorers (the back-translation fallback)", async () => {
    const fixture = createFixture();
    writeRootSession(fixture, [userText("Hallo Welt")]);
    const result = await replay(fixture, {
      restoreRootBlock: async (block) => `BACK:${block}`,
      restoreChildBlock: (block) => block,
    });
    expect(textsOf(result.rootItems)).toEqual(["BACK:Hallo Welt"]);
  });

  it("keeps a throwing block verbatim instead of dropping the whole replay", async () => {
    const fixture = createFixture();
    writeRootSession(fixture, [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "good" }, { type: "text", text: "bad" }] },
      }),
    ]);
    const result = await replay(fixture, {
      restoreRootBlock: (block) => {
        if (block === "bad") throw new Error("restorer boom");
        return `R:${block}`;
      },
      restoreChildBlock: (block) => block,
    });
    // One bad block degrades to its translated text; the good block and the
    // replay as a whole survive.
    expect(textsOf(result.rootItems)).toEqual(["R:good\nbad"]);
  });
});
