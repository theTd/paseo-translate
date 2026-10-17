import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageInput } from "./claude-message-input";

function prompt(text: string): SDKUserMessage {
  return { type: "user", uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: text } };
}

describe("Claude query input ownership", () => {
  it("waits after a queued message is removed instead of returning EOF", async () => {
    const input = new ClaudeMessageInput();
    const iterator = input.iterable[Symbol.asyncIterator]();
    const waiting = iterator.next();
    input.push(prompt("withdrawn"));
    await input.withdraw();
    const next = prompt("next");
    input.push(next);
    await expect(waiting).resolves.toEqual({ value: next, done: false });
    input.close();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("withdraws delivered messages through the SDK and leaves started messages alone", async () => {
    const input = new ClaudeMessageInput();
    const first = prompt("started");
    const second = prompt("pending");
    input.push(first);
    input.push(second, true);
    const iterator = input.iterable[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    input.started(first.uuid!);
    const cancel = vi.fn(async () => true);
    expect(input.clearsPermissions).toBe(true);
    await expect(input.withdraw(cancel)).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(second.uuid);
    expect(input.clearsPermissions).toBe(false);
    input.close();
  });

  it("does not withdraw new input submitted during SDK cancellation", async () => {
    const input = new ClaudeMessageInput();
    input.push(prompt("old"));
    await input.iterable[Symbol.asyncIterator]().next();
    let release!: (value: boolean) => void;
    const withdrawing = input.withdraw(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const next = prompt("new");
    input.push(next);
    release(true);
    await withdrawing;
    expect(input.hasUnstarted(next.uuid!)).toBe(true);
    await expect(input.iterable[Symbol.asyncIterator]().next()).resolves.toMatchObject({ value: next });
    input.close();
  });
});
