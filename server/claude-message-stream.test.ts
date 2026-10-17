import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageStream } from "./claude-message-stream";

function stream(event: unknown): SDKMessage {
  return { type: "stream_event", parent_tool_use_id: null, event } as SDKMessage;
}

describe("Claude text snapshots", () => {
  it("streams text and thinking separately and deduplicates the final assistant frame", () => {
    const messages = new ClaudeMessageStream();
    messages.observe(stream({ type: "message_start", message: { id: "api-message" } }));
    messages.observe(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    expect(messages.observe(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Consider" } })))
      .toEqual([{ type: "reasoning", id: "api-message:thinking", text: "Consider" }]);
    messages.observe(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    expect(messages.observe(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } })))
      .toEqual([{ type: "assistant_message", id: "api-message", messageId: "api-message", text: "Hello" }]);
    expect(messages.observe({ type: "assistant", uuid: "different-envelope", message: { id: "api-message",
      content: [{ type: "thinking", thinking: "Consider" }, { type: "text", text: "Hello" }] } } as unknown as SDKMessage)).toEqual([]);
  });

  it("joins multiple text blocks rather than treating them as replacement snapshots", () => {
    const messages = new ClaudeMessageStream();
    expect(messages.observe({ type: "assistant", uuid: "u", message: { content: [
      { type: "text", text: "Hello" }, { type: "text", text: "Hello world" },
    ] } } as unknown as SDKMessage)).toEqual([{ type: "assistant_message", id: "u", messageId: "u", text: "HelloHello world" }]);
  });
});
