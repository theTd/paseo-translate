import { describe, expect, it } from "vitest";
import { createHttpTranslationBackend } from "./translation-backend";
import { createClaudeHiddenTranslationBackendFactory } from "./claude-translation-backend";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

describe("translation backend contract", () => {
  it("provides the HTTP fallback with the provider-neutral shape", async () => {
    const backend = createHttpTranslationBackend();
    expect(backend.kind).toBe("http");
    const client = {
      complete: async () => "translated",
    } as never;
    await expect(backend.complete({ client, messages: [], signal: new AbortController().signal })).resolves.toBe("translated");
    await expect(backend.close()).resolves.toBeUndefined();
  });

  it("keeps Claude translation on an isolated query and streams only text", async () => {
    let interrupted = false;
    let seenPrompt = "";
    const factory = createClaudeHiddenTranslationBackendFactory({
      optionsFactory: () => ({ cwd: "/tmp" } as never),
      queryFactory: ({ prompt }) => ({
        interrupt: async () => { interrupted = true; },
        async *[Symbol.asyncIterator]() {
          for await (const message of prompt) seenPrompt = String(message.message.content);
          yield { type: "assistant", message: { content: [{ type: "text", text: "part" }] } } as SDKMessage;
          yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
        },
      }),
    });
    const backend = await factory.create("session-1");
    const deltas: string[] = [];
    await expect(backend.stream({ client: {} as never, messages: [{ role: "user", content: "hello" }], signal: new AbortController().signal, onDelta: (d) => deltas.push(d) })).resolves.toBe("partdone");
    expect(seenPrompt).toContain("hello");
    expect(deltas).toEqual(["part", "done"]);
    await backend.close();
    expect(interrupted).toBe(true);
  });

  it("rejects tool events from a hidden Claude query", async () => {
    const factory = createClaudeHiddenTranslationBackendFactory({
      optionsFactory: () => ({ cwd: "/tmp" } as never),
      queryFactory: () => ({
        interrupt: async () => undefined,
        async *[Symbol.asyncIterator]() {
          yield { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } } as SDKMessage;
        },
      }),
    });
    const backend = await factory.create("session-1");
    await expect(backend.complete({ client: {} as never, messages: [], signal: new AbortController().signal })).rejects.toThrow("tool");
  });
});
