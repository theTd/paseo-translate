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
