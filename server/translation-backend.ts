import { completeStreamFirst, type ChatMessage, type LlmClient } from "./llm-client";

export interface TranslationBackendRequest {
  messages: readonly ChatMessage[];
  client: LlmClient;
  signal: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface TranslationBackend {
  readonly kind: "http" | "acp" | "claude" | "codex";
  complete(request: TranslationBackendRequest): Promise<string>;
  stream(request: TranslationBackendRequest): Promise<string>;
  close(): Promise<void>;
}

export interface TranslationBackendFactory {
  create(sessionKey: string): Promise<TranslationBackend> | TranslationBackend;
}

/** Provider-neutral fallback used when no hidden provider session is available. */
export function createHttpTranslationBackend(): TranslationBackend {
  return {
    kind: "http",
    complete: ({ client, messages, signal }) => client.complete([...messages], { signal }),
    stream: ({ client, messages, signal, onDelta }) =>
      completeStreamFirst(client, [...messages], onDelta ?? (() => undefined), { signal }),
    close: async () => undefined,
  };
}
