/**
 * Minimal OpenAI-compatible client for the translation endpoint, speaking
 * either wire protocol: Responses (`/responses`, the default) or classic
 * Chat Completions (`/chat/completions`) for gateways without a Responses
 * route. One attempt per call; the caller owns the failure policy.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Wire protocol spoken to the endpoint (see translateSettings.endpointProtocol). */
export type LlmEndpointProtocol = "responses" | "chat-completions";

export interface LlmEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** OpenAI-compatible reasoning effort; omit or "default" to send none. */
  reasoningEffort?: string;
  protocol: LlmEndpointProtocol;
}

/** Per-request options shared by `complete` and `stream`. */
export interface LlmRequestOptions {
  /**
   * Caller cancellation. Aborting tears down the HTTP request (so a
   * streaming endpoint stops generating) and rejects with
   * {@link LlmRequestCanceledError}; it never triggers a fallback request.
   */
  signal?: AbortSignal;
}

/** Rejection used when the caller's signal canceled the request. */
export class LlmRequestCanceledError extends Error {
  constructor() {
    super("Translation request canceled");
    this.name = "LlmRequestCanceledError";
  }
}

/**
 * Cancellation check that also works across the pre-built Claude provider
 * bundle, which carries its own copy of this class while sharing the
 * process-wide in-flight registry (so `instanceof` alone can miss).
 */
export function isTranslationCanceled(error: unknown): boolean {
  return (
    error instanceof LlmRequestCanceledError ||
    (error instanceof Error && error.name === "LlmRequestCanceledError")
  );
}

export interface LlmClient {
  /** One non-streaming completion, bounded by `timeoutMs` end to end. */
  complete(messages: readonly ChatMessage[], options?: LlmRequestOptions): Promise<string>;
  /**
   * Streaming completion against `stream: true` SSE. Deltas arrive through
   * `onDelta` as they decode; the resolved value is the full text. Throws
   * when the endpoint refuses the stream so the caller can fall back to
   * `complete()`.
   *
   * `timeoutMs` bounds the wait for the response headers and every gap
   * between received chunks, never the total duration: a long translation
   * that keeps streaming is healthy however long it runs, while a stream
   * that goes silent is cut off after one timeout.
   */
  stream(
    messages: readonly ChatMessage[],
    onDelta: (delta: string) => void,
    options?: LlmRequestOptions,
  ): Promise<string>;
}

export function createLlmClient(
  config: LlmEndpointConfig,
  options: { fetchFn?: typeof fetch } = {},
): LlmClient {
  const fetchFn = options.fetchFn ?? fetch;

  async function postCompletions(
    messages: readonly ChatMessage[],
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; url: string; release: () => void; touch: () => void }> {
    if (signal?.aborted) throw new LlmRequestCanceledError();
    const path = config.protocol === "responses" ? "/responses" : "/chat/completions";
    const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey.length > 0) headers.authorization = `Bearer ${config.apiKey}`;
    const controller = new AbortController();
    // The abort signal covers the response body too: a slow endpoint that
    // sends headers and then stalls must not hang the caller. `touch`
    // re-arms it; only the streaming reader calls it, per SSE data event.
    let timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    };
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), config.timeoutMs);
    };
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(
          config.protocol === "responses"
            ? buildResponsesBody(config, messages, stream)
            : buildChatBody(config, messages, stream),
        ),
        // The SDK dependency bundles DOM-style globals that clash with the
        // Node declarations; bridge them at this boundary through the
        // fetch-side signal type.
        signal: controller.signal as unknown as RequestInit["signal"],
      });
      return { response, url, release, touch };
    } catch (error) {
      release();
      if (signal?.aborted) throw new LlmRequestCanceledError();
      throw new Error(
        `Translation endpoint request failed after ${config.timeoutMs}ms (${url}): ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  return {
    async complete(messages, requestOptions) {
      const signal = requestOptions?.signal;
      const { response, url, release } = await postCompletions(messages, false, signal);
      let body: string;
      let status: number;
      let ok: boolean;
      try {
        status = response.status;
        ok = response.ok;
        body = await response.text();
      } catch (error) {
        if (signal?.aborted) throw new LlmRequestCanceledError();
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
        content = readResponseText(config.protocol, parsed);
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

    async stream(messages, onDelta, requestOptions) {
      const signal = requestOptions?.signal;
      const { response, url, release, touch } = await postCompletions(messages, true, signal);
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
        // Some gateways silently ignore `stream: true` and answer with a
        // plain JSON completion: accept it as the endpoint's own choice of
        // non-streaming instead of forcing a second request.
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await response.text();
          let content: unknown;
          try {
            content = readResponseText(config.protocol, JSON.parse(body));
          } catch (error) {
            throw new Error(
              `Translation endpoint returned an unexpected response: ${excerpt(body)}`,
              { cause: error },
            );
          }
          if (typeof content !== "string" || content.length === 0) {
            throw new Error(`Translation endpoint returned no message text: ${excerpt(body)}`);
          }
          onDelta(content);
          return content;
        }
        try {
          return await readSseDeltas(
            response.body,
            onDelta,
            (parsed) => readStreamDelta(config.protocol, parsed),
            touch,
          );
        } catch (error) {
          if (signal?.aborted) throw new LlmRequestCanceledError();
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error(
              `Translation endpoint stream stalled for ${config.timeoutMs}ms (${url})`,
              { cause: error },
            );
          }
          throw error;
        }
      } catch (error) {
        if (signal?.aborted && !(error instanceof LlmRequestCanceledError)) {
          throw new LlmRequestCanceledError();
        }
        throw error;
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

function buildChatBody(
  config: LlmEndpointConfig,
  messages: readonly ChatMessage[],
  stream: boolean,
): Record<string, unknown> {
  return {
    model: config.model,
    messages,
    temperature: 0,
    stream,
    ...(config.reasoningEffort !== undefined &&
    config.reasoningEffort.length > 0 &&
    config.reasoningEffort !== "default"
      ? { reasoning_effort: config.reasoningEffort }
      : {}),
  };
}

/**
 * Responses API shape: system messages fold into `instructions`, user/assistant
 * turns become typed input items. No `temperature`: reasoning models on this
 * API hard-reject any value but the default, and a 400 is worse than losing
 * the determinism nudge. `store: false` keeps every request self-contained —
 * we never chain `previous_response_id`, so server-side state is pure cost.
 */
function buildResponsesBody(
  config: LlmEndpointConfig,
  messages: readonly ChatMessage[],
  stream: boolean,
): Record<string, unknown> {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      instructions.push(message.content);
    } else if (message.role === "user") {
      input.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
    } else {
      // Assistant history goes in as input_text too: the Responses input
      // schema only accepts output_text inside a full output item (with
      // type/id/status), and strictly-validating compatible gateways reject
      // anything else. Conditioning only needs the text either way.
      input.push({ role: "assistant", content: [{ type: "input_text", text: message.content }] });
    }
  }
  return {
    model: config.model,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    input,
    stream,
    store: false,
    ...(config.reasoningEffort !== undefined &&
    config.reasoningEffort.length > 0 &&
    config.reasoningEffort !== "default"
      ? { reasoning: { effort: config.reasoningEffort } }
      : {}),
  };
}

interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: unknown } }>;
}

interface ChatCompletionChunkShape {
  choices?: Array<{ delta?: { content?: unknown } }>;
}

interface ResponsesOutputShape {
  output?: Array<{
    type?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  }>;
}

/** Message text out of a non-streamed body, per wire protocol. */
function readResponseText(protocol: LlmEndpointProtocol, parsed: unknown): unknown {
  if (protocol === "chat-completions") {
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const completion = parsed as ChatCompletionShape;
    return completion.choices?.[0]?.message?.content;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const output = (parsed as ResponsesOutputShape).output;
  if (!Array.isArray(output)) return undefined;
  // Real responses carry a single message item; if a gateway ever sends
  // several, their texts join verbatim (no separator invented here).
  let text = "";
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text.length > 0 ? text : undefined;
}

/** One SSE `data:` payload → text delta, per wire protocol. */
function readStreamDelta(protocol: LlmEndpointProtocol, parsed: unknown): string | undefined {
  if (protocol === "chat-completions") {
    const delta = (parsed as ChatCompletionChunkShape).choices?.[0]?.delta?.content;
    return typeof delta === "string" && delta.length > 0 ? delta : undefined;
  }
  const event = parsed as { type?: unknown; delta?: unknown };
  return event.type === "response.output_text.delta" &&
    typeof event.delta === "string" &&
    event.delta.length > 0
    ? event.delta
    : undefined;
}

/**
 * Decodes an OpenAI-compatible SSE stream, forwarding each text delta and
 * resolving with the concatenated full text. Chunk boundaries are arbitrary
 * bytes, so decoding buffers until a blank line completes one event.
 */
async function readSseDeltas(
  body: NonNullable<Response["body"]>,
  onDelta: (delta: string) => void,
  readDelta: (parsed: unknown) => string | undefined,
  onChunk: () => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) buffer += decoder.decode(value, { stream: !done });
    if (done) break;
    buffer = consumeSseEvents(buffer, readDelta, onChunk, (data) => {
      accumulated += data;
      onDelta(data);
    });
  }
  buffer = consumeSseEvents(buffer, readDelta, onChunk, (data) => {
    accumulated += data;
    onDelta(data);
  });
  if (accumulated.length === 0) {
    throw new Error("Translation endpoint streamed no message text");
  }
  return accumulated;
}

/**
 * Folds complete `data:` events out of the buffer; returns the remainder.
 * `onEvent` fires for every well-formed data event (content, reasoning or
 * lifecycle), which re-arms the idle timeout. Comment frames such as
 * `: keep-alive` do not: a gateway that keeps a stuck request open with
 * heartbeats must still time out, or every retry would join that request.
 */
function consumeSseEvents(
  buffer: string,
  readDelta: (parsed: unknown) => string | undefined,
  onEvent: () => void,
  onData: (data: string) => void,
): string {
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
        onEvent();
        const delta = readDelta(parsed);
        if (delta !== undefined) onData(delta);
      } catch {
        // A gateway heartbeat or comment frame; not translation content.
      }
    }
  }
}

function excerpt(body: string): string {
  const flattened = body.replace(/\s+/g, " ").trim();
  return flattened.length > 300 ? `${flattened.slice(0, 300)}…` : flattened;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stream-first completion for paths that can use deltas or face long
 * generations: asks for SSE first and runs one plain completion inside the
 * same call only when the stream fails (the stream itself already tolerates
 * JSON answers to a stream request). Callers with no delta consumer and a
 * hard latency bound (the fail-closed prompt path) use `client.complete`
 * directly instead — for them a stream attempt is pure cost.
 */
export async function completeStreamFirst(
  client: LlmClient,
  messages: readonly ChatMessage[],
  onDelta: (delta: string) => void = () => undefined,
  options?: LlmRequestOptions,
): Promise<string> {
  try {
    return await client.stream(messages, onDelta, options);
  } catch (error) {
    // A canceled caller wants no answer at all: falling back would bill a
    // second request nobody reads.
    if (isTranslationCanceled(error) || options?.signal?.aborted) {
      throw isTranslationCanceled(error) ? error : new LlmRequestCanceledError();
    }
    return client.complete(messages, options);
  }
}
