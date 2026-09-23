import { describe, expect, it } from "vitest";
import { createLlmClient } from "./llm-client";

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
  return new Response(stream, {
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
      { baseUrl: "https://llm.example/v1/", apiKey: "secret", model: "mt", timeoutMs: 5_000 },
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
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "low" },
      { fetchFn: capturingFetch(low, () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) },
    );
    const minimalClient = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "minimal" },
      { fetchFn: capturingFetch(minimal, () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) },
    );
    const noneClient = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "none" },
      { fetchFn: capturingFetch(none, () => jsonResponse({ choices: [{ message: { content: "ok" } }] })) },
    );
    const defaultClient = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "", model: "mt", timeoutMs: 5_000, reasoningEffort: "default" },
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
      { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "mt", timeoutMs: 5_000 },
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
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000 },
      { fetchFn: capturingFetch([], () => jsonResponse({ error: "quota exceeded" }, 429)) },
    );
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toThrow(
      /HTTP 429.*quota exceeded/,
    );
  });

  it("rejects responses without message text", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000 },
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
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000 },
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
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000 },
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
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000 },
      { fetchFn: capturingFetch([], () => sseResponse(["stream unsupported"], 400)) },
    );
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).rejects.toThrow(
      /refused the stream \(HTTP 400\)/,
    );
  });

  it("rejects an empty stream", async () => {
    const client = createLlmClient(
      { baseUrl: "https://llm.example/v1", apiKey: "k", model: "mt", timeoutMs: 5_000 },
      { fetchFn: capturingFetch([], () => sseResponse(["data: [DONE]\n\n"])) },
    );
    await expect(client.stream([{ role: "user", content: "x" }], () => {})).rejects.toThrow(
      /streamed no message text/,
    );
  });
});
