import { describe, expect, it } from "vitest";
import { createProvidersHandler } from "./providers";

function paseoWith(entries: unknown[], providers: Record<string, unknown> = {}) {
  return {
    providers: {
      async snapshot() {
        return { entries };
      },
    },
    config: {
      async get() {
        return { config: { providers } };
      },
    },
  };
}

describe("translate providers handler", () => {
  it("resolves built-in ACP commands and hides non-ACP built-ins", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith([
        { provider: "claude", status: "ready", source: "builtin", label: "Claude" },
        { provider: "copilot", status: "ready", source: "builtin", label: "Copilot" },
        { provider: "cursor", status: "loading", source: "builtin" },
        { provider: "codex", status: "error", source: "builtin", label: "Codex" },
      ]),
    });
    expect(providers.map((provider) => provider.id)).toEqual(["copilot", "cursor"]);
    expect(providers[0]).toMatchObject({
      id: "copilot",
      label: "Copilot",
      status: "ready",
      command: ["copilot", "--acp"],
    });
    expect(providers[1]).toMatchObject({
      id: "cursor",
      label: "cursor",
      status: "loading",
      command: ["cursor-agent", "acp"],
    });
  });

  it("auto-fills custom extends:acp commands from the daemon config", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith(
        [
          { provider: "kimi", status: "ready", source: "custom", label: "Kimi Code" },
          { provider: "my-claude", status: "ready", source: "custom", label: "My Claude" },
        ],
        {
          kimi: { extends: "acp", command: ["kimi", "acp"], env: { KIMI_API_KEY: "secret" } },
          "my-claude": { extends: "claude", command: ["claude"] },
        },
      ),
    });
    // Custom non-ACP overrides cannot be wrapped by an ACP proxy: dropped.
    expect(providers.map((provider) => provider.id)).toEqual(["kimi"]);
    expect(providers[0]).toMatchObject({ id: "kimi", command: ["kimi", "acp"] });
    // Only id/label/status/command leave the handler — env and keys never do.
    expect(Object.keys(providers[0]).sort()).toEqual(["command", "id", "label", "status"]);
    expect(JSON.stringify(providers)).not.toContain("secret");
  });

  it("prefers a configured command over the built-in default", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith(
        [{ provider: "cursor", status: "ready", source: "builtin", label: "Cursor" }],
        { cursor: { command: ["node", "E:\\bin\\cursor-acp.js"] } },
      ),
    });
    expect(providers[0].command).toEqual(["node", "E:\\bin\\cursor-acp.js"]);
  });

  it("keeps a custom ACP provider without a usable command for manual entry", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith(
        [
          { provider: "broken", status: "ready", source: "custom" },
          { provider: "empty", status: "ready", source: "custom" },
        ],
        { broken: { extends: "acp", command: ["", "x"] }, empty: { extends: "acp" } },
      ),
    });
    expect(providers.map((provider) => provider.id).sort()).toEqual(["broken", "empty"]);
    expect(providers.every((provider) => provider.command === null)).toBe(true);
  });

  it("skips malformed entries and maps unknown statuses to unavailable", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith([null, { status: "ready" }, { provider: "hermes", status: "weird", source: "custom" }], { hermes: { extends: "acp", command: ["hermes", "acp"] } }),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: "hermes",
      status: "unavailable",
      command: ["hermes", "acp"],
    });
  });

  it("degrades to built-in defaults when the config face is unavailable", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: {
        providers: {
          async snapshot() {
            return {
              entries: [
                { provider: "copilot", status: "ready", source: "builtin" },
                { provider: "kimi", status: "ready", source: "custom" },
              ],
            };
          },
        },
        config: {
          get() {
            return Promise.reject(new Error("older daemon without config face"));
          },
        },
      },
    });
    // Custom ACP entries cannot be recognized without config; built-ins still
    // resolve their default commands instead of failing the whole picker.
    expect(providers.map((provider) => provider.id)).toEqual(["copilot"]);
    expect(providers[0].command).toEqual(["copilot", "--acp"]);
  });
});
