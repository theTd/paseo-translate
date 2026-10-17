import { describe, expect, it } from "vitest";
import {
  extractUserText,
  normalizeCodexQuestionPrompts,
  threadItemToTimeline,
  toCodexUsage,
} from "./codex-items";

describe("codex thread item mapping", () => {
  it("maps user, assistant, reasoning, and shell items", () => {
    expect(
      threadItemToTimeline({
        type: "userMessage",
        id: "u1",
        content: [{ type: "text", text: "Hello" }],
      }),
    ).toMatchObject({
      type: "user_message",
      text: "Hello",
      messageId: "u1",
      revertToken: "u1",
    });
    expect(threadItemToTimeline({ type: "agentMessage", id: "a1", text: "Hi" })).toMatchObject({
      type: "assistant_message",
      id: "a1",
      text: "Hi",
      messageId: "a1",
    });
    expect(
      threadItemToTimeline({ type: "reasoning", id: "r1", summary: ["thinking"] }),
    ).toMatchObject({ type: "reasoning", text: "thinking" });
    expect(
      threadItemToTimeline({
        type: "commandExecution",
        id: "c1",
        status: "completed",
        command: "ls",
        aggregatedOutput: "ok",
        exitCode: 0,
      }),
    ).toMatchObject({
      type: "tool_call",
      name: "shell",
      status: "completed",
      detail: { type: "shell", command: "ls", output: "ok", exitCode: 0 },
    });
  });

  it("maps file changes and web search", () => {
    expect(
      threadItemToTimeline({
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [{ path: "a.ts", diff: "@@\n+x" }],
      }),
    ).toMatchObject({
      type: "tool_call",
      name: "apply_patch",
      detail: { type: "edit", filePath: "a.ts", unifiedDiff: "@@\n+x" },
    });
    expect(
      threadItemToTimeline({ type: "webSearch", id: "s1", query: "paseo", status: "completed" }),
    ).toMatchObject({
      type: "tool_call",
      name: "web_search",
      detail: { type: "search", query: "paseo" },
    });
  });

  it("extracts user text and usage", () => {
    expect(extractUserText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(
      toCodexUsage({
        model_context_window: 200_000,
        last: { inputTokens: 10, outputTokens: 4, total_tokens: 14 },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 14,
    });
  });

  it("normalizes Codex question prompts", () => {
    expect(
      normalizeCodexQuestionPrompts([
        {
          id: "q1",
          header: "Choice",
          question: "Pick one",
          options: [{ label: "A" }, { label: "B", description: "bee" }],
          multiSelect: true,
        },
        { id: "bad" },
      ]),
    ).toEqual([
      {
        id: "q1",
        header: "Choice",
        question: "Pick one",
        options: [{ label: "A" }, { label: "B", description: "bee" }],
        multiSelect: true,
      },
    ]);
  });
});


it.each([
  'powershell.exe -NoProfile -Command "Get-Location"',
  'cmd.exe /c "Get-Location"',
  ['pwsh.exe', '-Command', 'Get-Location'],
  ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-Command', 'Get-Location'],
])("shows the actual Windows shell command: %s", (command) => {
  expect(threadItemToTimeline({ id: "shell", type: "commandExecution", command, status: "completed" }))
    .toMatchObject({ detail: { type: "shell", command: "Get-Location" } });
});

it("surfaces failed image generation and accepts structured image results", () => {
  expect(threadItemToTimeline({ id: "failed-image", type: "imageGeneration", status: "failed", failure: { message: "Image quota exhausted" } }))
    .toMatchObject({ type: "tool_call", name: "image_generation", status: "failed", error: { message: "Image quota exhausted" } });
  expect(threadItemToTimeline({ id: "image-url", type: "imageGeneration", status: "completed", result: { url: "https://example.test/image.png" } }))
    .toMatchObject({ type: "assistant_message", text: "![Image](https://example.test/image.png)" });
  expect(threadItemToTimeline({ id: "image-path", type: "imageGeneration", status: "completed", result: { path: "image.png" } }, { cwd: "E:/images" }))
    .toMatchObject({ type: "assistant_message", text: expect.stringContaining("/images/image.png") });
});
