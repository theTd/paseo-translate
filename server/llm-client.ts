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
  /** OpenAI-compatible reasoning effort; omit or "default" to send none. */
  reasoningEffort?: string;
}

export interface LlmClient {
  complete(messages: readonly ChatMessage[]): Promise<string>;
  /**
   * Streaming completion against `stream: true` SSE. Deltas arrive through
   * `onDelta` as they decode; the resolved value is the full text. Throws
   * when the endpoint refuses the stream so the caller can fall back to
   * `complete()`.
   */
  stream(messages: readonly ChatMessage[], onDelta: (delta: string) => void): Promise<string>;
}

export function createLlmClient(
  config: LlmEndpointConfig,
  options: { fetchFn?: typeof fetch } = {},
): LlmClient {
  const fetchFn = options.fetchFn ?? fetch;

  async function postCompletions(
    messages: readonly ChatMessage[],
    stream: boolean,
  ): Promise<{ response: Response; url: string; release: () => void }> {
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey.length > 0) headers.authorization = `Bearer ${config.apiKey}`;
    const controller = new AbortController();
    // The abort signal covers the response body too: a slow endpoint that
    // sends headers and then stalls must not hang the caller.
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const release = () => clearTimeout(timer);
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0,
          stream,
          ...(config.reasoningEffort !== undefined &&
          config.reasoningEffort.length > 0 &&
          config.reasoningEffort !== "default"
            ? { reasoning_effort: config.reasoningEffort }
            : {}),
        }),
        // The SDK dependency bundles DOM-style globals that clash with the
        // Node declarations; bridge them at this boundary through the
        // fetch-side signal type.
        signal: controller.signal as unknown as RequestInit["signal"],
      });
      return { response, url, release };
    } catch (error) {
      release();
      throw new Error(
        `Translation endpoint request failed after ${config.timeoutMs}ms (${url}): ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  return {
    async complete(messages) {
      const { response, url, release } = await postCompletions(messages, false);
      let body: string;
      let status: number;
      let ok: boolean;
      try {
        status = response.status;
        ok = response.ok;
        body = await response.text();
      } catch (error) {
        throw new Error(
          `Translation endpoint request failed after ${config.timeoutMs}ms (${url}): ${describeError(error)}`,
          { cause: error },
        );
      } finally {
        release();
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

    async stream(messages, onDelta) {
      const { response, release } = await postCompletions(messages, true);
      try {
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `Translation endpoint refused the stream (HTTP ${response.status}): ${excerpt(body)}`,
          );
        }
        if (response.body === null) {
          throw new Error("Translation endpoint returned an empty stream");
        }
        return await readSseDeltas(response.body, onDelta);
      } finally {
        release();
        try {
          await response.body?.cancel();
        } catch {
          // Already closed by a completed read; nothing to release.
        }
      }
    },
  };
}

interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: unknown } }>;
}

interface ChatCompletionChunkShape {
  choices?: Array<{ delta?: { content?: unknown } }>;
}

/**
 * Decodes an OpenAI-compatible SSE stream, forwarding each text delta and
 * resolving with the concatenated full text. Chunk boundaries are arbitrary
 * bytes, so decoding buffers until a blank line completes one event.
 */
async function readSseDeltas(
  body: NonNullable<Response["body"]>,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) buffer += decoder.decode(value, { stream: !done });
    if (done) break;
    buffer = consumeSseEvents(buffer, (data) => {
      accumulated += data;
      if (data.length > 0) onDelta(data);
    });
  }
  buffer = consumeSseEvents(buffer, (data) => {
    accumulated += data;
    if (data.length > 0) onDelta(data);
  });
  if (accumulated.length === 0) {
    throw new Error("Translation endpoint streamed no message text");
  }
  return accumulated;
}

/** Folds complete `data:` events out of the buffer; returns the remainder. */
function consumeSseEvents(buffer: string, onData: (data: string) => void): string {
  let rest = buffer;
  for (;;) {
    const boundary = rest.indexOf("\n\n");
    if (boundary === -1) return rest;
    const event = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    for (const line of event.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed: unknown = JSON.parse(payload);
        const delta = (parsed as ChatCompletionChunkShape).choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) onData(delta);
      } catch {
        // A gateway heartbeat or comment frame; not translation content.
      }
    }
  }
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
