import { describe, expect, it } from "vitest";
import type {
  ProviderConnection,
  ProviderConnectRequest,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { currentSessionEnv, withSessionEnv } from "./acp-session-env";

const REQUEST: ProviderConnectRequest = { versions: [1], capabilities: [] };

/** ES2023 lib: Promise.withResolvers (ES2024) is unavailable. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function openInput(env: Readonly<Record<string, string>>): ProviderInput {
  return {
    type: "session.open",
    requestId: "open-1",
    sessionId: "session-1",
    history: "skip",
    config: { cwd: "/tmp", env, mcpServers: {}, settings: {}, persist: false },
  };
}

/** Registration whose send records the session env visible to `connector()`. */
function recordingRegistration(
  observe: (env: Readonly<Record<string, string>> | undefined) => void | Promise<void>,
): ProviderRegistration {
  const connection: ProviderConnection = {
    version: 1,
    capabilities: [],
    async send() {
      await observe(currentSessionEnv());
    },
    onEvent: () => () => undefined,
    async close() {},
  };
  return {
    id: "fake",
    label: "Fake",
    async connect() {
      return connection;
    },
  };
}

describe("session env context", () => {
  it("exposes the opened session's env to the connector's async work", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const connection = await withSessionEnv(
      recordingRegistration((env) => {
        seen.push(env);
      }),
    ).connect(REQUEST);
    await connection.send(openInput({ CLAYWORKBENCH_AUTH_FILE: "/tmp/auth", OTHER: "1" }));
    expect(seen).toEqual([{ CLAYWORKBENCH_AUTH_FILE: "/tmp/auth", OTHER: "1" }]);
  });

  it("leaves the env empty outside a session open", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const connection = await withSessionEnv(
      recordingRegistration((env) => {
        seen.push(env);
      }),
    ).connect(REQUEST);
    await connection.send({ type: "catalog", requestId: "catalog-1" });
    expect(seen).toEqual([undefined]);
  });

  it("keeps concurrent opens in their own env", async () => {
    // Both sends must be inside their open before either resumes, so a shared
    // (rather than async-context) store would show the last writer to both.
    const bothStarted = deferred();
    let entered = 0;
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const connection = await withSessionEnv(
      recordingRegistration(async (env) => {
        entered += 1;
        if (entered === 2) bothStarted.resolve();
        await bothStarted.promise;
        seen.push(env);
      }),
    ).connect(REQUEST);
    await Promise.all([
      connection.send(openInput({ TOKEN: "first" })),
      connection.send(openInput({ TOKEN: "second" })),
    ]);
    expect(seen).toEqual([{ TOKEN: "first" }, { TOKEN: "second" }]);
  });

  it("does not enter a context for an empty env", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const connection = await withSessionEnv(
      recordingRegistration((env) => {
        seen.push(env);
      }),
    ).connect(REQUEST);
    await connection.send(openInput({}));
    expect(seen).toEqual([undefined]);
  });
});
