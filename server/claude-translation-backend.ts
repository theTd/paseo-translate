import type { SDKMessage, SDKUserMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import type { TranslationBackend, TranslationBackendFactory, TranslationBackendRequest } from "./translation-backend";

export interface ClaudeHiddenSessionFactoryOptions {
  queryFactory(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuery;
  optionsFactory(sessionKey: string, signal: AbortSignal): Options;
}

export interface ClaudeQuery {
  interrupt(): Promise<unknown>;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
}

/** Creates a real Claude SDK query per translation session, isolated from the root query. */
export function createClaudeHiddenTranslationBackendFactory(
  options: ClaudeHiddenSessionFactoryOptions,
): TranslationBackendFactory {
  return {
    create(sessionKey) {
      let query: ClaudeQuery | null = null;
      let closed = false;
      async function run(request: TranslationBackendRequest): Promise<string> {
        if (closed) throw new Error("Claude translation session is closed");
        const prompt = toUserMessage(request.messages);
        let sent = false;
        const input: AsyncIterable<SDKUserMessage> = {
          [Symbol.asyncIterator]: async function* () {
            if (!sent) { sent = true; yield prompt; }
          },
        };
        query = options.queryFactory({ prompt: input, options: options.optionsFactory(sessionKey, request.signal) });
        let text = "";
        try {
        for await (const message of query) {
          if (isUnsafeMessage(message)) throw new Error("Claude translation session emitted a tool or permission event");
          const delta = messageText(message);
          if (delta.length > 0) { text += delta; request.onDelta?.(delta); }
          if (message.type === "result") {
            const subtype = (message as unknown as { subtype?: unknown }).subtype;
            if (typeof subtype === "string" && subtype !== "success") throw new Error(`Claude translation session failed: ${subtype}`);
            break;
          }
        }
        } catch (error) {
          query = null;
          throw error;
        }
        if (text.trim().length === 0) throw new Error("Claude translation session returned no text");
        return text.trim();
      }
      return {
        kind: "claude",
        complete: run,
        stream: run,
        close: async () => {
          closed = true;
          await query?.interrupt();
        },
      };
    },
  };
}

function isUnsafeMessage(message: SDKMessage): boolean {
  const value = message as unknown as { type?: unknown; message?: { content?: unknown } };
  if (value.type === "permission_request" || value.type === "tool_use" || value.type === "tool_result") return true;
  const content = value.message?.content;
  return Array.isArray(content) && content.some((block) =>
    typeof block === "object" && block !== null && ["tool_use", "tool_result", "server_tool_use"].includes(String((block as { type?: unknown }).type)),
  );
}

function toUserMessage(messages: readonly { role: string; content: string }[]): SDKUserMessage {
  const text = messages.map((message) => `${message.role}:\n${message.content}`).join("\n\n");
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "translation" } as SDKUserMessage;
}

function messageText(message: SDKMessage): string {
  const value = message as unknown as { type?: string; result?: unknown; message?: { content?: unknown } };
  if (value.type === "result" && typeof value.result === "string") return value.result;
  const content = value.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is { type: "text"; text: string } =>
    typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
  ).map((block) => block.text).join("");
}
