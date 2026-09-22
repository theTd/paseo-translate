import { afterEach, describe, expect, it } from "vitest";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { createTranslatingAcpStream } from "./acp-connector";

/**
 * Minimal ACP-shaped echo agent: announces itself with one notification, then
 * answers every request by echoing method and params back. The test asserts
 * on the echo, which proves exactly what the inner agent received.
 */
const ECHO_AGENT = `
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "agent/started", params: {} }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { return; }
  if (message && typeof message.method === "string" && message.id !== undefined && message.id !== null) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { method: message.method, params: message.params ?? null } }) + "\\n");
  }
});
`;

const streams: AcpStream[] = [];

function echoStream(translate: (text: string) => Promise<string>): AcpStream {
  const stream = createTranslatingAcpStream({
    command: [process.execPath, "-e", ECHO_AGENT],
    translate,
  });
  streams.push(stream);
  return stream;
}

function promptRequest(id: number | string, blocks: unknown[]): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: "s", prompt: blocks },
  } as AcpStreamMessage;
}

async function readCount(
  stream: AcpStream,
  count: number,
  timeoutMs = 8_000,
): Promise<AcpStreamMessage[]> {
  const reader = stream.readable.getReader();
  const messages: AcpStreamMessage[] = [];
  try {
    const deadline = Date.now() + timeoutMs;
    while (messages.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out; got ${JSON.stringify(messages)}`);
      }
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("read timeout")), remaining) as unknown as NodeJS.Timeout;
        timer.unref?.();
      });
      const next = (await Promise.race([reader.read(), timeout])) as
        | { done: boolean; value?: AcpStreamMessage }
        | undefined;
      if (!next || next.done) break;
      if (next.value !== undefined) messages.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return messages;
}

function responses(messages: AcpStreamMessage[]): Array<{
  id: string | number | null;
  method: string;
  params: unknown;
}> {
  return messages
    .filter((message) => "result" in message)
    .map((message) => {
      const result = (message as { result: { method: string; params: unknown } }).result;
      return {
        id: (message as { id: string | number | null }).id,
        method: result.method,
        params: result.params,
      };
    });
}

function promptText(params: unknown): string {
  const blocks = (params as { prompt: Array<{ type: string; text?: string }> }).prompt;
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("|");
}

afterEach(async () => {
  while (streams.length > 0) {
    const stream = streams.pop();
    if (stream === undefined) break;
    await stream.writable.close().catch(() => undefined);
    await stream.readable.cancel().catch(() => undefined);
  }
});

describe("translating ACP connector", () => {
  it("translates prompt text, preserves frame order, and passes other frames through", async () => {
    const stream = echoStream(async (text) => `DE(${text})`);
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { client: {} },
    } as AcpStreamMessage);
    await writer.write(promptRequest(2, [{ type: "text", text: "Hello" }]));
    await writer.write(promptRequest(3, [{ type: "text", text: "World" }]));
    writer.releaseLock();

    const messages = await readCount(stream, 4);
    const started = messages.find(
      (message) => "method" in message && message.method === "agent/started",
    );
    expect(started).toEqual({ jsonrpc: "2.0", method: "agent/started", params: {} });

    const echoed = responses(messages);
    expect(echoed.map((response) => response.id)).toEqual([1, 2, 3]);
    expect(echoed[0].method).toBe("initialize");
    expect(echoed[0].params).toEqual({ client: {} });
    expect(promptText(echoed[1].params)).toBe("DE(Hello)");
    expect(promptText(echoed[2].params)).toBe("DE(World)");
  });

  it("leaves non-text content blocks untouched", async () => {
    const image = { type: "image", data: "aW1n", mimeType: "image/png" };
    const stream = echoStream(async (text) => `DE(${text})`);
    const writer = stream.writable.getWriter();
    await writer.write(promptRequest(7, [{ type: "text", text: "Look" }, image]));
    writer.releaseLock();

    const echoed = responses(await readCount(stream, 2));
    const blocks = (echoed[0].params as { prompt: unknown[] }).prompt;
    expect(blocks[0]).toEqual({ type: "text", text: "DE(Look)" });
    expect(blocks[1]).toEqual(image);
  });

  it("keeps slash-command words verbatim and translates only the remainder", async () => {
    const seen: string[] = [];
    const stream = echoStream(async (text) => {
      seen.push(text);
      return `DE(${text})`;
    });
    const writer = stream.writable.getWriter();
    await writer.write(promptRequest(1, [{ type: "text", text: "/model switch engines" }]));
    await writer.write(promptRequest(2, [{ type: "text", text: "/compact" }]));
    writer.releaseLock();

    const echoed = responses(await readCount(stream, 3));
    expect(promptText(echoed[0].params)).toBe("/model DE(switch engines)");
    expect(promptText(echoed[1].params)).toBe("/compact");
    expect(seen).toEqual(["switch engines"]);
  });

  it("fails closed: a failed translation blocks the prompt and the stream keeps working", async () => {
    const stream = echoStream(async (text) => {
      if (text.includes("FAIL")) throw new Error("endpoint down");
      return `DE(${text})`;
    });
    const writer = stream.writable.getWriter();
    await writer.write(promptRequest(1, [{ type: "text", text: "FAIL this one" }]));
    await writer.write(promptRequest(2, [{ type: "text", text: "Still works" }]));
    writer.releaseLock();

    const messages = await readCount(stream, 3);
    const blocked = messages.find((message) => "error" in message);
    expect(blocked).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: expect.stringContaining("blocked this session/prompt") },
    });
    // The blocked prompt never reached the agent: only id 2 was echoed.
    const echoed = responses(messages);
    expect(echoed.map((response) => response.id)).toEqual([2]);
    expect(promptText(echoed[0].params)).toBe("DE(Still works)");
  });

  it("passes serialized attachment blocks through verbatim", async () => {
    const attachment = JSON.stringify({
      type: "forge_issue",
      mimeType: "application/paseo-forge-issue",
      number: 7,
      title: "Login breaks",
    });
    const seen: string[] = [];
    const stream = echoStream(async (text) => {
      seen.push(text);
      return `DE(${text})`;
    });
    const writer = stream.writable.getWriter();
    await writer.write(
      promptRequest(1, [
        { type: "text", text: "Summarize" },
        { type: "text", text: attachment },
      ]),
    );
    writer.releaseLock();

    const echoed = responses(await readCount(stream, 2));
    const blocks = (echoed[0].params as { prompt: Array<{ type: string; text?: string }> }).prompt;
    expect(blocks[0].text).toBe("DE(Summarize)");
    expect(blocks[1].text).toBe(attachment);
    expect(seen).toEqual(["Summarize"]);
  });

  it("translates the per-agent system prompt on session/new", async () => {
    const stream = echoStream(async (text) => `DE(${text})`);
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: "2.0",
      id: 5,
      method: "session/new",
      params: {
        cwd: "/repo",
        mcpServers: [],
        _meta: { _paseo: { systemPrompt: "Be terse.", providerOptions: { x: 1 } } },
      },
    } as AcpStreamMessage);
    writer.releaseLock();

    const echoed = responses(await readCount(stream, 2));
    expect(echoed[0].method).toBe("session/new");
    const meta = (
      echoed[0].params as { _meta: { _paseo: { systemPrompt: string; providerOptions: unknown } } }
    )._meta._paseo;
    expect(meta.systemPrompt).toBe("DE(Be terse.)");
    expect(meta.providerOptions).toEqual({ x: 1 });
  });

  it("blocks a malformed session/prompt frame instead of passing it through", async () => {
    const stream = echoStream(async (text) => `DE(${text})`);
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId: "s", prompt: "not-an-array" },
    } as AcpStreamMessage);
    writer.releaseLock();

    const messages = await readCount(stream, 2);
    const blocked = messages.find((message) => "error" in message);
    expect(blocked).toMatchObject({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32603, message: expect.stringContaining("prompt content array is missing") },
    });
    expect(responses(messages)).toHaveLength(0);
  });
});
