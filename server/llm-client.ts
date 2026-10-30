/**
 * Minimal OpenAI-compatible client for the translation endpoint, speaking
 * either wire protocol: Responses (`/responses`, the default) or classic
 * Chat Completions (`/chat/completions`) for gateways without a Responses
 * route. One attempt per call; the caller owns the failure policy.
 */

import { createSizeWatch, createStepTracer } from "./memory-probe";

const step = createStepTracer();
/** Wire bytes accepted for one unary body or SSE stream, before decoding. */
const ENDPOINT_MAX_BYTES = 8 * 1024 * 1024;

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
  /**
   * `prompt_cache_key`: an affinity key the endpoint uses to route requests
   * of one conversation to the same prompt cache. Omitted sends nothing, so
   * gateways that reject the parameter stay usable.
   */
  promptCacheKey?: string;
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
  ): Promise<{ response: Response; url: string; release: () => void; touch: () => void; abort: () => void }> {
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
      const payload = JSON.stringify(
        config.protocol === "responses"
          ? buildResponsesBody(config, messages, stream)
          : buildChatBody(config, messages, stream),
      );
      // Request-size marker: a runaway *input* (an agent pasting a huge tool
      // result into a prompt) is visible here before the endpoint answers, and
      // a normal translation prompt stays far below the first magnitude.
      createSizeWatch({ label: "llm.req" }).report(payload.length, `stream=${stream}`);
      const donePost = step.start("http.post", `chars=${payload.length} stream=${stream}`);
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body: payload,
        // The SDK dependency bundles DOM-style globals that clash with the
        // Node declarations; bridge them at this boundary through the
        // fetch-side signal type.
        signal: controller.signal as unknown as RequestInit["signal"],
      }).finally(donePost);
      return { response, url, release, touch, abort: () => controller.abort() };
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
      const { response, url, release, abort } = await postCompletions(messages, false, signal);
      let body: string;
      let status: number;
      let ok: boolean;
      try {
        status = response.status;
        ok = response.ok;
        const doneBody = step.start("http.body");
        body = await readBoundedResponseText(response).finally(doneBody);
        // The bounded raw body, parsed tree and extracted text coexist from
        // here on; the wire cap keeps that overlap below the heap ceiling.
        createSizeWatch({ label: "llm.resp" }).report(body.length);
      } catch (error) {
        abort();
        if (signal?.aborted) throw new LlmRequestCanceledError();
        throw new Error(
          `Translation endpoint request failed after ${config.timeoutMs}ms (${url}): ${describeError(error)}`,
          { cause: error },
        );
      } finally {
        release();
        try {
          await response.body?.cancel();
        } catch {
          // Already closed or errored; the abort above owns failed teardown.
        }
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
      const { response, url, release, touch, abort } = await postCompletions(messages, true, signal);
      try {
        if (!response.ok) {
          const body = await readBoundedResponseText(response).catch(() => "");
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
          const doneBody = step.start("http.body", "non-sse");
          const body = await readBoundedResponseText(response).finally(doneBody);
          createSizeWatch({ label: "llm.resp" }).report(body.length, "non-sse");
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
        // Size/parser failures must tear down the old response before the
        // stream-first caller is allowed to start its unary fallback.
        abort();
        if (signal?.aborted && !(error instanceof LlmRequestCanceledError)) {
          throw new LlmRequestCanceledError();
        }
        throw error;
      } finally {
        release();
        try {
          // readSseDeltas releases its reader lock in every outcome, so this
          // cancel reaches the original body instead of failing while locked.
          await response.body?.cancel();
        } catch {
          // Already closed or aborted by the request controller.
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
    // No `temperature`: reasoning models on this protocol hard-reject any
    // value but the default (a 400 that fails the fail-closed prompt path),
    // and the plugin cannot know which model is reasoning-capable. Losing
    // the determinism nudge beats failing the turn.
    stream,
    ...(config.reasoningEffort !== undefined &&
    config.reasoningEffort.length > 0 &&
    config.reasoningEffort !== "default"
      ? { reasoning_effort: config.reasoningEffort }
      : {}),
    ...(config.promptCacheKey !== undefined && config.promptCacheKey.length > 0
      ? { prompt_cache_key: config.promptCacheKey }
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
      // Assistant history travels as a plain string, never as typed content
      // parts. Part-type validators disagree per role: OpenAI's own input
      // content parts are input_*, while strictly-validating gateways treat
      // an assistant message's content as output content and reject
      // `input_text` there ("Supported values are: output_text"). The
      // "easy message" shape accepts a bare string for every role, so no
      // validator has a part type to reject. Conditioning only needs the
      // text.
      input.push({ role: "assistant", content: message.content });
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
    ...(config.promptCacheKey !== undefined && config.promptCacheKey.length > 0
      ? { prompt_cache_key: config.promptCacheKey }
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
/** Events folded per synchronous slice before the reader yields to timers. */
const SSE_EVENT_SLICE = 2_048;
/**
 * Hard bounds on one stream. The per-event idle timeout cannot fire on a
 * gateway that keeps sending: it is re-armed by exactly the traffic that makes
 * the stream pathological. These end a runaway stream with a named error
 * instead of letting it grind the host into the heap ceiling.
 */
const SSE_MAX_EVENTS = 200_000;
const SSE_MAX_CHARS = 400_000;
const SSE_MAX_DURATION_MS = 10 * 60_000;

async function readSseDeltas(
  body: NonNullable<Response["body"]>,
  onDelta: (delta: string) => void,
  readDelta: (parsed: unknown) => string | undefined,
  onChunk: () => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const size = createSizeWatch({ label: "llm.sse" });
  const wire = createSizeWatch({ label: "llm.wire" });
  // An unterminated event grows this decoded remainder while accumulated
  // output stays empty, so buffer and total wire sizes need separate markers.
  const raw = createSizeWatch({ label: "llm.raw" });
  const events = createSizeWatch({ label: "llm.events", stepChars: 10_000 });
  const doneLoop = step.start("sse.loop");
  let buffer = "";
  let accumulated = "";
  let eventCount = 0;
  let receivedBytes = 0;
  const startedAt = Date.now();
  const collect = (data: string): void => {
    if (accumulated.length + data.length > SSE_MAX_CHARS) {
      throw new Error(`Translation endpoint stream exceeded ${SSE_MAX_CHARS} characters`);
    }
    accumulated += data;
    size.report(accumulated.length);
    const doneDelta = step.start("sse.delta", `chars=${data.length}`);
    try {
      onDelta(data);
    } finally {
      doneDelta();
    }
  };
  try {
    for (;;) {
      const doneRead = step.start("sse.read");
      const { done, value } = await reader.read().finally(doneRead);
      if (value !== undefined) {
        receivedBytes += value.byteLength;
        wire.report(receivedBytes);
        // Check before decoding: one oversized chunk must not allocate a
        // second, multi-megabyte string before the bound can fire.
        if (receivedBytes > ENDPOINT_MAX_BYTES) {
          throw new Error(`Translation endpoint stream exceeded ${ENDPOINT_MAX_BYTES} bytes`);
        }
        raw.report(value.byteLength, "chunk");
        const doneDecode = step.start("sse.decode", `bytes=${value.byteLength} done=${done}`);
        buffer += decoder.decode(value, { stream: !done });
        doneDecode();
        raw.report(buffer.length);
      }
      if (done) {
        const doneDecode = step.start("sse.decode", "final");
        buffer += decoder.decode();
        doneDecode();
      }

      let folded = 0;
      let yielded = false;
      do {
        const doneFold = step.start("sse.fold", `buffered=${buffer.length}`);
        const slice = consumeSseEvents(buffer, readDelta, onChunk, collect, SSE_EVENT_SLICE);
        doneFold();
        buffer = slice.rest;
        folded = slice.processed;
        // Count lifecycle and other non-content frames too: they cost the
        // same parsing work while leaving the delta-only output at zero.
        eventCount += folded;
        events.report(eventCount);
        if (eventCount > SSE_MAX_EVENTS) {
          throw new Error(`Translation endpoint stream exceeded ${SSE_MAX_EVENTS} events`);
        }
        if (Date.now() - startedAt > SSE_MAX_DURATION_MS) {
          throw new Error(`Translation endpoint stream exceeded ${SSE_MAX_DURATION_MS}ms`);
        }
        if (folded >= SSE_EVENT_SLICE) {
          const doneYield = step.start("sse.yield", "slice");
          await yieldToEventLoop().finally(doneYield);
          yielded = true;
        }
      } while (folded >= SSE_EVENT_SLICE);

      // The final read goes through the same bounded fold as every other
      // chunk. Non-final reads always yield, including one-event chunks whose
      // promises would otherwise resolve as an endless microtask chain.
      if (done) {
        // Proxies close the stream right after the last frame without the
        // trailing blank line; that frame is still the endpoint's answer.
        const slice = consumeSseEvents(
          buffer.endsWith("\n") || buffer.endsWith("\r") ? `${buffer}\n` : `${buffer}\n\n`,
          readDelta,
          onChunk,
          collect,
          SSE_EVENT_SLICE,
        );
        eventCount += slice.processed;
        buffer = slice.rest;
        break;
      }
      if (!yielded) {
        const doneYield = step.start("sse.yield", "chunk");
        await yieldToEventLoop().finally(doneYield);
      }
    }
    if (accumulated.length === 0) {
      throw new Error("Translation endpoint streamed no message text");
    }
    return accumulated;
  } finally {
    doneLoop();
    // The outer response.body.cancel() can only succeed after this lock is
    // released, including cap, parse, abort and downstream callback errors.
    reader.releaseLock();
  }
}

/** Lets timers, abort callbacks, I/O and diagnostics run before more parsing. */
function yieldToEventLoop(): Promise<void> {
  // Node 20 / ES2023 target: Promise.withResolvers is not available.
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** Reads a unary/error body with the same wire ceiling and scheduling rule. */
async function readBoundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) {
        await yieldToEventLoop();
        continue;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > ENDPOINT_MAX_BYTES) {
        throw new Error(`Translation endpoint response exceeded ${ENDPOINT_MAX_BYTES} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
      await yieldToEventLoop();
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Folds complete `data:` events out of the buffer; returns the remainder.
 * `onEvent` fires for every well-formed data event (content, reasoning or
 * lifecycle), which re-arms the idle timeout. Comment frames such as
 * `: keep-alive` do not: a gateway that keeps a stuck request open with
 * heartbeats must still time out, or every retry would join that request.
 *
 * Framing follows the SSE spec, not the LF conventions one gateway happens
 * to use: lines end with CRLF, LF or CR, an event ends at a blank line, and
 * several `data:` lines in one event concatenate with `\n` before parsing.
 * Endpoints differ (Azure and several Java/nginx frontends send CRLF), and
 * getting this wrong turns a valid translation into "streamed no message
 * text" plus a billed fallback request.
 */
function consumeSseEvents(
  buffer: string,
  readDelta: (parsed: unknown) => string | undefined,
  onEvent: () => void,
  onData: (data: string) => void,
  budget = Number.POSITIVE_INFINITY,
): { rest: string; processed: number } {
  let rest = buffer;
  let processed = 0;
  while (processed < budget) {
    const boundary = findEventBoundary(rest);
    if (boundary === null) break;
    const event = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary.length);
    processed += 1;
    if (event.length === 0) continue;
    let payload = "";
    let hasData = false;
    for (const line of event.split(/\r\n|\r|\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const value = trimmed.slice("data:".length).trim();
      // `data:` lines of one event join with a newline before parsing.
      payload = hasData ? `${payload}\n${value}` : value;
      hasData = true;
    }
    if (!hasData || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A gateway heartbeat or malformed data frame; not translation text.
      continue;
    }
    onEvent();
    const delta = readDelta(parsed);
    // Consumer failures are not JSON errors: propagate them so the request
    // is aborted instead of continuing to allocate behind a failed caller.
    if (delta !== undefined) onData(delta);
  }
  return { rest, processed };
}

/**
 * First blank-line boundary in `buffer`, over any of the spec's three line
 * endings. Returns the offset where the *event text* stops and the number of
 * characters the separator occupies (2 for CRLF, else 1). `null` when no
 * complete event is buffered yet.
 */
function findEventBoundary(buffer: string): { index: number; length: number } | null {
  let crlf = buffer.indexOf("\r\n\r\n");
  let lf = buffer.indexOf("\n\n");
  let cr = buffer.indexOf("\r\r");
  // A CRLF pair already contains an `\r`; the single-character searches must
  // not match inside it, so compare the earliest index first and let CRLF
  // win at the same offset.
  if (crlf !== -1 && (lf === -1 || crlf <= lf) && (cr === -1 || crlf <= cr)) {
    return { index: crlf, length: 4 };
  }
  if (lf !== -1 && (cr === -1 || lf < cr)) return { index: lf, length: 2 };
  if (cr !== -1) return { index: cr, length: 2 };
  return null;
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
    // A client-side refusal (4xx other than the timeout/rate-limit classes)
    // cannot become a success by dropping `stream`: the same request body
    // without the flag hits the same validator. Retrying it only doubles the
    // bill and delays the failure, so surface it instead.
    if (isPermanentHttpRefusal(error)) throw error;
    return client.complete(messages, options);
  }
}

/**
 * True when the unary fallback cannot succeed: the exact same request body
 * with only `stream` flipped would hit the same rejection.
 *
 * The one 4xx that backwards into a fallback is a gateway refusing the
 * `stream` flag itself (typically 400 or 422 with "stream" in the error
 * body) — dropping the flag is exactly the fix, so those keep the retry.
 * Everything else in 4xx is about the request's content, credentials or
 * route: 401/403 (key), 404/405 (missing route), 413 (too large), or a 400
 * whose body never mentions streaming. Billing a second identical call there
 * only doubles the cost and delays the failure. 408 and 429 stay retryable.
 */
function isPermanentHttpRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  if (status === undefined) return false;
  const code = Number(status);
  if (code < 400 || code > 499) return false;
  if (code === 408 || code === 429) return false;
  if (code === 400 || code === 422) return !/stream/i.test(message);
  return true;
}
