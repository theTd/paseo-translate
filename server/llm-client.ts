/**
 * Minimal OpenAI-compatible chat-completions client for the translation
 * endpoint. One attempt per call; the caller owns the failure policy.
 */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface LlmClient {
  complete(messages: readonly ChatMessage[]): Promise<string>;
}

export function createLlmClient(
  config: LlmEndpointConfig,
  options: { fetchFn?: typeof fetch } = {},
): LlmClient {
  const fetchFn = options.fetchFn ?? fetch;
  return {
    async complete(messages) {
      const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey.length > 0) headers.authorization = `Bearer ${config.apiKey}`;
      let body: string;
      let status: number;
      let ok: boolean;
      const controller = new AbortController();
      // The abort signal covers the response body too: a slow endpoint that
      // sends headers and then stalls must not hang the caller.
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0,
            stream: false,
          }),
          signal: controller.signal,
        });
        status = response.status;
        ok = response.ok;
        body = await response.text();
      } catch (error) {
        throw new Error(
          `Translation endpoint request failed after ${config.timeoutMs}ms (${url}): ${describeError(error)}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }
      if (!ok) {
        throw new Error(`Translation endpoint returned HTTP ${status}: ${excerpt(body)}`);
      }
      let content: unknown;
      try {
        const parsed: unknown = JSON.parse(body);
        content = readChoiceContent(parsed);
      } catch (error) {
        throw new Error(`Translation endpoint returned an unexpected response: ${excerpt(body)}`, {
          cause: error,
        });
      }
      if (typeof content !== "string" || content.length === 0) {
        throw new Error(`Translation endpoint returned no message text: ${excerpt(body)}`);
      }
      return content;
    },
  };
}

interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function readChoiceContent(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const completion = parsed as ChatCompletionShape;
  return completion.choices?.[0]?.message?.content;
}

function excerpt(body: string): string {
  const flattened = body.replace(/\s+/g, " ").trim();
  return flattened.length > 300 ? `${flattened.slice(0, 300)}…` : flattened;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
