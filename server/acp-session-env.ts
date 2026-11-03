import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";

/**
 * The session environment of the connection being opened, visible to
 * `connector()`.
 *
 * Paseo's ACP adapter hands `session.open` `config.env` (daemon-provided and
 * `before agent.session_open` hook variables) to the inner process only in
 * `command` mode, where it spawns the child itself. In `connector` mode it
 * calls `connector()` without arguments, so a translating wrapper that starts
 * the inner agent must carry the env over. Widget-side credentials such as a
 * bridge auth-file path live there; dropping them breaks those sessions.
 *
 * The adapter calls `connector()` once per session inside the async work
 * started by `send(session.open)`, so running that send inside this storage
 * hands the env to exactly that connection, however many sessions open
 * concurrently. Capability probes, the model catalog and session listing
 * start processes outside any open and see no env (same as command mode).
 */
const openingSessionEnv = new AsyncLocalStorage<Readonly<Record<string, string>>>();

/** Session env of the connection being started; undefined outside an open. */
export function currentSessionEnv(): Readonly<Record<string, string>> | undefined {
  return openingSessionEnv.getStore();
}

/**
 * Wraps a registration so `send(session.open)` runs in that session's env.
 * Everything else passes straight through.
 */
export function withSessionEnv(registration: ProviderRegistration): ProviderRegistration {
  return {
    ...registration,
    async connect(request) {
      const connection = await registration.connect(request);
      return {
        ...connection,
        send(input) {
          if (input.type !== "session.open") return connection.send(input);
          const env = input.config.env;
          // An empty env would only add a store lookup: the connector treats
          // "no store" and "empty env" identically.
          return Object.keys(env).length > 0
            ? openingSessionEnv.run(env, () => connection.send(input))
            : connection.send(input);
        },
      };
    },
  };
}
