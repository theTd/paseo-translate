import { describe, expect, it, vi } from "vitest";
import { completeStreamFirst, createLlmClient, isTranslationCanceled } from "./llm-client";
import { setDiagnosticSink } from "./memory-probe";

const ENDPOINT_MAX_BYTES = 8 * 1024 * 1024;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capturingFetch(calls: CapturedCall[], respond: () => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
}

function requestBody(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  // Type-only cast: react-native's global Response typing (pulled in by the
  // client files under the same tsconfig) can shadow Node's depending on
  // file order, and its BodyInit_ omits ReadableStream.
  return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function binaryResponse(chunks: readonly Uint8Array[], contentType: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
    headers: { "content-type": contentType },
  });
}

function sseData(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe("translation endpoint client", () => {
  it("posts an OpenAI-compatible completion and returns the message text", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1/", apiKey: "secret", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          jsonResponse({ choices: [{ message: { content: "Hallo" } }] }),
        ),
      },
    );
    await expect(
      client.complete([
        { role: "system", content: "sys" },
        { role: "user", content: "Hello" },
      ]),
    ).resolves.toBe("Hallo");
    expect(calls[0].url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    const body = requestBody(calls[0]);
    expect(body.model).toBe("mt");
    expect(body.stream).toBe(false);
    // No temperature: reasoning models on this protocol hard-reject any value
    // but the default, and the plugin cannot know which model that applies to.
    expect("temperature" in body).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Hello" },
    ]);
    // Default effort sends no parameter at all.
    expect("reasoning_effort" in body).toBe(false);
  });

  it("sends reasoning_effort only when a non-default effort is configured", async () => {
    const low: CapturedCall[] = [];
    const minimal: CapturedCall[] = [];
    const none: CapturedCall[] = [];
    const lowClient = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "low", protocol: "chat-completions" },
      { fetchFn: capturingFetch(low, () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) },
    );
    const minimalClient = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "minimal", protocol: "chat-completions" },
      { fetchFn: capturingFetch(minimal, () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) },
    );
    const noneClient = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "none", protocol: "chat-completions" },
      { fetchFn: capturingFetch(none, () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) },
    );
    const defaultClient = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "default", protocol: "chat-completions" },
      { fetchFn: capturingFetch(low, () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) },
    );
    await lowClient.complete([{ role: "user", content: "x" }]);
    await minimalClient.complete([{ role: "user", content: "x" }]);
    await noneClient.complete([{ role: "user", content: "x" }]);
    await defaultClient.complete([{ role: "user", content: "x" }]);
    expect(requestBody(low[0]).reasoning_effort).toBe("low");
    expect(requestBody(minimal[0]).reasoning_effort).toBe("minimal");
    expect(requestBody(none[0]).reasoning_effort).toBe("none");
    // The explicit "default" value lands in the shared capture array after
    // the low call and must not carry the parameter.
    expect("reasoning_effort" in requestBody(low[1])).toBe(false);
  });

  it("omits the authorization header for keyless endpoints", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          jsonResponse({ choices: [{ message: { content: "ok" } }] }),
        ),
      },
    );
    await client.complete([{ role: "user", content: "hi" }]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("fails with the HTTP status and a body excerpt on error responses", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      { fetchFn: capturingFetch([], () => jsonResponse({ error: "quota exceeded" }, 429)) },
    );
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toThrow(
      /HTTP 429.*quota exceeded/,
    );
  });

  it("rejects responses without message text", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch([], () =>
          jsonResponse({ choices: [{ message: { content: null } }] }),
        ),
      },
    );
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toThrow(
      /no message text/,
    );
  });

  it("wraps network failures with the endpoint URL", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
      },
    );
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toThrow(
      /Translation endpoint request failed after 5000ms \(https:\/\/llm\.example\/v1\/chat\/completions\): ECONNREFUSED/,
    );
  });
});

describe("translation endpoint streaming", () => {
  it("accumulates SSE deltas across chunk boundaries and posts stream:true", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          // Split mid-JSON on purpose: chunk boundaries are arbitrary bytes.
          sseResponse([sseData("Hal").slice(0, 20), sseData("Hal").slice(20) + sseData("lo"), "data: [DONE]\n\n"]),
        ),
      },
    );
    const deltas: string[] = [];
    await expect(
      client.stream([{ role: "user", content: "Hello" }], (delta) => deltas.push(delta)),
    ).resolves.toBe("Hallo");
    expect(requestBody(calls[0]).stream).toBe(true);
    expect(deltas.join("")).toBe("Hallo");
  });

  it("rejects the stream on HTTP errors so the caller can fall back", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      { fetchFn: capturingFetch([], () => sseResponse(["stream unsupported"], 400)) },
    );
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).rejects.toThrow(
      /refused the stream \(HTTP 400\)/,
    );
  });

  it("rejects an empty stream", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      { fetchFn: capturingFetch([], () => sseResponse(["data: [DONE]\n\n"])) },
    );
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).rejects.toThrow(
      /streamed no message text/,
    );
  });

  it("accepts a JSON completion answered to a stream request (endpoint ignored stream:true)", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          jsonResponse({ choices: [{ message: { content: "Hallo" } }] }),
        ),
      },
    );
    const deltas: string[] = [];
    await expect(
      client.stream([{ role: "user", content: "Hello" }], (delta) => deltas.push(delta)),
    ).resolves.toBe("Hallo");
    expect(requestBody(calls[0]).stream).toBe(true);
    expect(deltas).toEqual(["Hallo"]);
  });

  it("wraps a non-JSON answer to a stream request with a readable error", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(
          [],
          () => new Response("<html>Bad Gateway</html>", { status: 200 }),
        ),
      },
    );
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).rejects.toThrow(
      /unexpected response.*Bad Gateway/,
    );
  });

  // Framing varies between compliant gateways; all three shapes are legal SSE
  // and each was a silent "streamed no message text" before the parser
  // followed the spec instead of LF-only conventions.
  it("decodes CRLF-framed events", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch([], () =>
          sseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Hal" } }] })}\r\n\r\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\r\n\r\n`,
            "data: [DONE]\r\n\r\n",
          ]),
        ),
      },
    );
    const deltas: string[] = [];
    await expect(client.stream([{ role: "user", content: "x" }], (delta) => deltas.push(delta)))
      .resolves.toBe("Hallo");
    expect(deltas).toEqual(["Hal", "lo"]);
  });

  it("joins a multi-line data field before parsing it", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch([], () =>
          sseResponse([
            // One JSON payload split across two `data:` lines, as the spec
            // allows and some proxies emit when wrapping long frames.
            'data: {"choices":\ndata: [{"delta":{"content":"Hallo"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        ),
      },
    );
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).resolves.toBe("Hallo");
  });

  it("keeps the last event when the stream closes without a trailing blank line", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch([], () =>
          sseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Hallo" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: " Welt" } }] })}\n`,
          ]),
        ),
      },
    );
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).resolves.toBe(
      "Hallo Welt",
    );
  });
});

describe("endpoint resource bounds", () => {
  const config = {
    baseUrl: "https://llm.example/v1",
    apiKey: "k",
    model: "mt",
    timeoutMs: 5_000,
    protocol: "chat-completions" as const,
  };
  const messages = [{ role: "user" as const, content: "x" }];

  it.each(["complete", "stream"] as const)("bounds %s JSON bodies before decoding", async (method) => {
    const client = createLlmClient(config, {
      fetchFn: (async () => binaryResponse(
        [new Uint8Array(ENDPOINT_MAX_BYTES + 1)],
        "application/json",
      )) as typeof fetch,
    });
    const pending = method === "complete"
      ? client.complete(messages)
      : client.stream(messages, () => undefined);
    await expect(pending).rejects.toThrow(`exceeded ${ENDPOINT_MAX_BYTES} bytes`);
  });

  it("bounds raw SSE bytes before decoding an unterminated event", async () => {
    const client = createLlmClient(config, {
      fetchFn: (async () => binaryResponse(
        [new Uint8Array(ENDPOINT_MAX_BYTES + 1)],
        "text/event-stream",
      )) as typeof fetch,
    });
    await expect(client.stream(messages, () => undefined)).rejects.toThrow(
      `stream exceeded ${ENDPOINT_MAX_BYTES} bytes`,
    );
  });

  it("yields on small chunks and cancels a capped stream before fallback", async () => {
    const encoder = new TextEncoder();
    const frame = "data: {}\n\n".repeat(1_000);
    let calls = 0;
    let pulls = 0;
    let cancels = 0;
    let checkPhaseTurns = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls > 1) return jsonResponse({ choices: [{ message: { content: "fallback" } }] });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls <= 201) {
            controller.enqueue(encoder.encode(frame));
          } else {
            controller.enqueue(encoder.encode(`${sseData("ok")}data: [DONE]\n\n`));
            controller.close();
          }
        },
        cancel() {
          cancels += 1;
        },
      });
      return new Response(body as unknown as ConstructorParameters<typeof Response>[0], {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const client = createLlmClient(config, { fetchFn });
    const pending = completeStreamFirst(client, messages);
    setImmediate(() => { checkPhaseTurns += 1; });
    await expect(pending).resolves.toBe("fallback");
    expect(calls).toBe(2);
    expect(cancels).toBe(1);
    expect(checkPhaseTurns).toBeGreaterThan(0);
  });

  it("bounds and yields during a final read that carries a value", async () => {
    const encoder = new TextEncoder();
    let releases = 0;
    let checkPhaseTurns = 0;
    const reader = {
      read: async () => ({
        done: true,
        value: encoder.encode(`${sseData("ok")}${"data: {}\n\n".repeat(2_048)}`),
      }),
      releaseLock() {
        releases += 1;
      },
    };
    const body = {
      getReader: () => reader,
      cancel: async () => undefined,
    } as unknown as NonNullable<Response["body"]>;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
    } as unknown as Response;
    const client = createLlmClient(config, { fetchFn: (async () => response) as typeof fetch });
    const pending = client.stream(messages, () => undefined);
    setImmediate(() => { checkPhaseTurns += 1; });
    await expect(pending).resolves.toBe("ok");
    expect(checkPhaseTurns).toBeGreaterThan(0);
    expect(releases).toBe(1);
  });

  it("propagates consumer failures instead of hiding them as bad JSON", async () => {
    const client = createLlmClient(config, {
      fetchFn: capturingFetch([], () => sseResponse([sseData("a")])),
    });
    await expect(client.stream(messages, () => {
      throw new Error("consumer failed");
    })).rejects.toThrow("consumer failed");
  });
});

describe("stream-first completion policy", () => {
  it("streams when the endpoint serves SSE", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          sseResponse([`${sseData("Hi")}data: [DONE]\n\n`]),
        ),
      },
    );
    const deltas: string[] = [];
    await expect(
      completeStreamFirst(client, [{ role: "user", content: "Hello" }], (delta) =>
        deltas.push(delta),
      ),
    ).resolves.toBe("Hi");
    expect(calls).toHaveLength(1);
    expect(deltas).toEqual(["Hi"]);
  });

  it("falls back to a plain completion only when the stream is refused", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          calls.length === 1
            ? sseResponse(["stream unsupported"], 400)
            : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
        ),
      },
    );
    await expect(completeStreamFirst(client, [{ role: "user", content: "x" }])).resolves.toBe("ok");
    expect(calls).toHaveLength(2);
    expect(requestBody(calls[0]).stream).toBe(true);
    expect(requestBody(calls[1]).stream).toBe(false);
  });

  it("stays a single request when the endpoint answers a stream request with JSON", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          jsonResponse({ choices: [{ message: { content: "ok" } }] }),
        ),
      },
    );
    await expect(completeStreamFirst(client, [{ role: "user", content: "x" }])).resolves.toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("does not bill a second request when the rejection is about the request itself", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          jsonResponse({ error: { message: "Incorrect API key provided" } }, 401),
        ),
      },
    );
    await expect(completeStreamFirst(client, [{ role: "user", content: "x" }])).rejects.toThrow(
      /HTTP 401/,
    );
    // Dropping `stream` cannot fix a bad key: the fallback would burn a second
    // request and delay the failure.
    expect(calls).toHaveLength(1);
  });

  it("still falls back when the rejection is the stream flag itself", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000, protocol: "chat-completions" },
      {
        fetchFn: capturingFetch(calls, () =>
          calls.length === 1
            ? jsonResponse({ error: { message: "stream is not supported for this model" } }, 400)
            : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
        ),
      },
    );
    await expect(completeStreamFirst(client, [{ role: "user", content: "x" }])).resolves.toBe("ok");
    expect(calls).toHaveLength(2);
  });
});

describe("responses protocol", () => {
  const responsesConfig = {
    baseUrl: "https://llm.example/v1",
    apiKey: "k",
    model: "mt",
    timeoutMs: 5_000,
    protocol: "responses" as const,
  };

  function responsesText(text: string): Response {
    return jsonResponse({
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    });
  }

  it("posts the Responses shape: instructions, typed input items, store:false, reasoning effort", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(
      { ...responsesConfig, reasoningEffort: "low" },
      { fetchFn: capturingFetch(calls, () => responsesText("Hallo")) },
    );
    await expect(
      client.complete([
        { role: "system", content: "sys" },
        { role: "system", content: "sys2" },
        { role: "user", content: "older" },
        { role: "assistant", content: "Älter" },
        { role: "user", content: "Hello" },
      ]),
    ).resolves.toBe("Hallo");
    expect(calls[0].url).toBe("https://llm.example/v1/responses");
    const body = requestBody(calls[0]);
    // Multiple system messages fold into one instructions field.
    expect(body.instructions).toBe("sys\n\nsys2");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "older" }] },
      // Assistant history stays a bare string: typed parts there are output
      // content on role-strict gateways, which reject input_text with
      // "Supported values are: output_text".
      { role: "assistant", content: "Älter" },
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
    // Reasoning models on this API hard-reject a non-default temperature.
    expect("temperature" in body).toBe(false);
    expect("messages" in body).toBe(false);
  });

  it("omits instructions and reasoning when unset", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(responsesConfig, {
      fetchFn: capturingFetch(calls, () => responsesText("ok")),
    });
    await client.complete([{ role: "user", content: "x" }]);
    const body = requestBody(calls[0]);
    expect("instructions" in body).toBe(false);
    expect("reasoning" in body).toBe(false);
    // No manual key configured: the parameter is absent, so gateways that
    // reject it stay usable.
    expect("prompt_cache_key" in body).toBe(false);
  });

  it("sends prompt_cache_key on both protocols when one is configured", async () => {
    for (const protocol of ["responses", "chat-completions"] as const) {
      const calls: CapturedCall[] = [];
      const client = createLlmClient(
        { ...responsesConfig, protocol, promptCacheKey: "tr-session-42" },
        { fetchFn: capturingFetch(calls, () => (protocol === "responses"
          ? responsesText("ok")
          : jsonResponse({ choices: [{ message: { content: "ok" } }] }))) },
      );
      await client.complete([{ role: "user", content: "x" }]);
      expect(requestBody(calls[0]).prompt_cache_key).toBe("tr-session-42");
    }
  });

  it("streams response.output_text.delta events and ignores other event types", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(responsesConfig, {
      fetchFn: capturingFetch(calls, () =>
        sseResponse([
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hal" })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`,
        ]),
      ),
    });
    const deltas: string[] = [];
    await expect(
      client.stream([{ role: "user", content: "Hello" }], (delta) => deltas.push(delta)),
    ).resolves.toBe("Hallo");
    expect(requestBody(calls[0]).stream).toBe(true);
    expect(deltas).toEqual(["Hal", "lo"]);
  });

  it("accepts a JSON completion answered to a stream request", async () => {
    const calls: CapturedCall[] = [];
    const client = createLlmClient(responsesConfig, {
      fetchFn: capturingFetch(calls, () => responsesText("Hallo")),
    });
    const deltas: string[] = [];
    await expect(
      client.stream([{ role: "user", content: "Hello" }], (delta) => deltas.push(delta)),
    ).resolves.toBe("Hallo");
    expect(calls).toHaveLength(1);
    expect(deltas).toEqual(["Hallo"]);
  });

  it("rejects Responses bodies without output text", async () => {
    const client = createLlmClient(responsesConfig, {
      fetchFn: capturingFetch([], () => jsonResponse({ output: [] })),
    });
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toThrow(
      /no message text/,
    );
  });

  it("skips non-message output items like reasoning and function calls", async () => {
    const client = createLlmClient(responsesConfig, {
      fetchFn: capturingFetch([], () =>
        jsonResponse({
          output: [
            { type: "reasoning", summary: [] },
            { type: "function_call", name: "f", arguments: "{}" },
            {
              type: "message",
              content: [
                { type: "output_text", text: "Hal" },
                { type: "refusal", refusal: "no" },
                { type: "output_text", text: "lo" },
              ],
            },
          ],
        }),
      ),
    });
    await expect(client.complete([{ role: "user", content: "x" }])).resolves.toBe("Hallo");
  });

  it("errors when a Responses stream carries no text deltas", async () => {
    const client = createLlmClient(responsesConfig, {
      fetchFn: capturingFetch([], () =>
        sseResponse([
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`,
        ]),
      ),
    });
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).rejects.toThrow(
      /streamed no message text/,
    );
  });
});

describe("stream timeout and cancellation", () => {
  const config = {
    baseUrl: "https://llm.example/v1",
    apiKey: "k",
    model: "mt",
    timeoutMs: 100,
    protocol: "chat-completions" as const,
  };

  /** SSE body that emits `chunks` with `gapMs` between them, honoring aborts. */
  function pacedFetch(chunks: string[], gapMs: number, calls: { count: number }): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.count += 1;
      const signal = init?.signal as AbortSignal | undefined;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const onAbort = () => controller.error(new DOMException("aborted", "AbortError"));
          signal?.addEventListener("abort", onAbort, { once: true });
          for (const chunk of chunks) {
            await new Promise((resolve) => setTimeout(resolve, gapMs));
            if (signal?.aborted) return;
            controller.enqueue(encoder.encode(sseData(chunk)));
          }
          signal?.removeEventListener("abort", onAbort);
          controller.close();
        },
      });
      return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
  }

  it("bounds the gaps between chunks, not the total duration of a healthy stream", async () => {
    const calls = { count: 0 };
    const client = createLlmClient(config, {
      fetchFn: pacedFetch(["a", "b", "c", "d", "e", "f"], 40, calls),
    });
    // ~240ms in total with a 100ms timeout: progress keeps it alive.
    await expect(client.stream([{ role: "user", content: "x" }], () => undefined)).resolves.toBe("abcdef");
    expect(calls.count).toBe(1);
  });

  it("cuts off a stream that goes silent for one timeout", async () => {
    const calls = { count: 0 };
    const client = createLlmClient(config, { fetchFn: pacedFetch(["a", "b"], 300, calls) });
    await expect(client.stream([{ role: "user", content: "x" }], () => undefined)).rejects.toThrow(
      "stalled",
    );
  });

  it("does not let keep-alive comments hold a stuck stream open", async () => {
    const encoder = new TextEncoder();
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true },
          );
          controller.enqueue(encoder.encode(sseData("a")));
          // Heartbeats only, for far longer than one timeout.
          const aborted = () => signal?.aborted === true;
          for (let beat = 0; beat < 50 && !aborted(); beat += 1) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            if (!aborted()) controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }
        },
      });
      return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const client = createLlmClient(config, { fetchFn });
    const startedAt = Date.now();
    await expect(client.stream([{ role: "user", content: "x" }], () => undefined)).rejects.toThrow(
      "stalled",
    );
    // One timeout after the last data event, not after ~2s of heartbeats.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("cancels without a fallback request when the caller aborts", async () => {
    const calls = { count: 0 };
    const client = createLlmClient(
      { ...config, timeoutMs: 5_000 },
      { fetchFn: pacedFetch(["a", "b", "c"], 50, calls) },
    );
    const controller = new AbortController();
    const deltas: string[] = [];
    const pending = completeStreamFirst(
      client,
      [{ role: "user", content: "x" }],
      (delta) => {
        deltas.push(delta);
        controller.abort();
      },
      { signal: controller.signal },
    );
    await expect(pending).rejects.toSatisfy(isTranslationCanceled);
    expect(deltas).toEqual(["a"]);
    expect(calls.count).toBe(1);
  });

  it("rejects at once when the caller already aborted", async () => {
    const calls = { count: 0 };
    const client = createLlmClient(config, { fetchFn: pacedFetch(["a"], 1, calls) });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.complete([{ role: "user", content: "x" }], { signal: controller.signal }),
    ).rejects.toSatisfy(isTranslationCanceled);
    expect(calls.count).toBe(0);
  });
});

describe("stream diagnostics", () => {
  const config = {
    baseUrl: "https://llm.example/v1",
    apiKey: "k",
    model: "mt",
    timeoutMs: 100,
    protocol: "chat-completions" as const,
  };
  const messages = [{ role: "user" as const, content: "x" }];

  it("leaves a read marker when a stream stalls", async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("TRANSLATE_DIAGNOSTIC_PROBES", "1");
    setDiagnosticSink((line) => lines.push(line));
    try {
      const reader = {
        read: () => new Promise<never>(() => undefined),
        releaseLock: () => undefined,
      };
      const body = {
        getReader: () => reader,
        cancel: async () => undefined,
      } as unknown as NonNullable<Response["body"]>;
      const response = {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body,
      } as unknown as Response;
      const client = createLlmClient(config, { fetchFn: (async () => response) as typeof fetch });
      void client.stream(messages, () => undefined).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));

      expect(lines.some((line) => line.includes("sse.read"))).toBe(true);
      expect(lines.some((line) => line.includes("sse.decode"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      setDiagnosticSink(undefined);
      logSpy.mockRestore();
    }
  });

  it("marks read, decode, fold, delta and yield stages", async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("TRANSLATE_DIAGNOSTIC_PROBES", "1");
    setDiagnosticSink((line) => lines.push(line));
    try {
      const client = createLlmClient(config, {
        fetchFn: capturingFetch([], () => sseResponse([`${sseData("ok")}data: [DONE]\n\n`])),
      });
      await expect(client.stream(messages, () => undefined)).resolves.toBe("ok");
      for (const stage of ["sse.read", "sse.decode", "sse.fold", "sse.delta", "sse.yield"]) {
        expect(lines.some((line) => line.includes(stage))).toBe(true);
      }
    } finally {
      vi.unstubAllEnvs();
      setDiagnosticSink(undefined);
      logSpy.mockRestore();
    }
  });
});
