import { describe, expect, it } from "vitest";
import { completeStreamFirst, createLlmClient } from "./llm-client";

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
      // Assistant history travels as input_text: the Responses input schema
      // rejects output_text outside a full output item.
      { role: "assistant", content: [{ type: "input_text", text: "Älter" }] },
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
