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

const isWindows = process.platform === "win32";

describe("translate providers handler", () => {
  it("resolves known ACP commands and keeps the rest visible as unknown", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith([
        { provider: "claude", status: "ready", source: "builtin", label: "Claude" },
        { provider: "copilot", status: "ready", source: "builtin", label: "Copilot" },
        { provider: "omp", status: "ready", source: "builtin", label: "OMP" },
        { provider: "opencode", status: "loading", source: "builtin" },
      ]),
    });
    // Known ACP commands lead; unknown-capability daemon providers stay
    // listed after the adapter presets instead of being hidden.
    expect(providers.map((provider) => `${provider.id}:${provider.acp}`)).toEqual([
      "copilot:known",
      "omp:known",
      "opencode:known",
      "adapter:claude-code:adapter",
      "adapter:codex:adapter",
      "claude:unknown",
    ]);
    expect(providers[0]).toMatchObject({ command: ["copilot", "--acp"] });
    expect(providers[1]).toMatchObject({ command: ["omp", "acp"] });
    expect(providers[2]).toMatchObject({ command: ["opencode", "acp"] });
    expect(providers[5]).toMatchObject({ id: "claude", command: null, status: "ready" });
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
    const daemonProviders = providers.filter((provider) => !provider.id.startsWith("adapter:"));
    // Custom non-ACP (my-claude) is still listed as unknown with no command.
    expect(daemonProviders.map((provider) => `${provider.id}:${provider.acp}`)).toEqual([
      "kimi:known",
      "my-claude:unknown",
    ]);
    expect(daemonProviders[0]).toMatchObject({ command: ["kimi", "acp"] });
    expect(daemonProviders[1]).toMatchObject({ command: null });
    // Only id/label/status/command/acp leave the handler — env and keys never do.
    expect(Object.keys(daemonProviders[0]).sort()).toEqual([
      "acp",
      "command",
      "id",
      "label",
      "status",
    ]);
    expect(JSON.stringify(providers)).not.toContain("secret");
  });

  it("prefers a configured command over the known default", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith(
        [{ provider: "omp", status: "ready", source: "builtin", label: "OMP" }],
        { omp: { command: ["omp", "acp", "--profile", "translate"] } },
      ),
    });
    const omp = providers.find((provider) => provider.id === "omp");
    expect(omp?.command).toEqual(["omp", "acp", "--profile", "translate"]);
    expect(omp?.acp).toBe("known");
  });

  it("appends adapter presets with a Windows-compatible npx shim", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, { paseo: paseoWith([]) });
    expect(providers.map((provider) => provider.id)).toEqual([
      "adapter:claude-code",
      "adapter:codex",
    ]);
    const claudeAdapter = providers[0];
    expect(claudeAdapter).toMatchObject({ acp: "adapter", status: "ready" });
    expect(claudeAdapter.command?.slice(0, isWindows ? 3 : 2)).toEqual(
      isWindows ? ["cmd", "/c", "npx"] : ["npx", "--yes"],
    );
    expect(claudeAdapter.command).toContain("@agentclientprotocol/claude-agent-acp@0.31.4");
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
    const customs = providers.filter(
      (provider) => provider.id === "broken" || provider.id === "empty",
    );
    expect(customs.map((provider) => provider.id).sort()).toEqual(["broken", "empty"]);
    expect(
      customs.every((provider) => provider.command === null && provider.acp === "unknown"),
    ).toBe(true);
  });

  it("skips malformed entries and maps unknown statuses to unavailable", async () => {
    const handler = createProvidersHandler();
    const { providers } = await handler({}, {
      paseo: paseoWith(
        [null, { status: "ready" }, { provider: "hermes", status: "weird", source: "custom" }],
        { hermes: { extends: "acp", command: ["hermes", "acp"] } },
      ),
    });
    const hermes = providers.find((provider) => provider.id === "hermes");
    expect(hermes).toMatchObject({
      status: "unavailable",
      command: ["hermes", "acp"],
      acp: "known",
    });
  });

  it("degrades to known defaults when the config face is unavailable", async () => {
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
    const daemonProviders = providers.filter((provider) => !provider.id.startsWith("adapter:"));
    // Custom ACP entries cannot be recognized without config and degrade to
    // unknown; built-in known commands still resolve.
    expect(daemonProviders.map((provider) => `${provider.id}:${provider.acp}`)).toEqual([
      "copilot:known",
      "kimi:unknown",
    ]);
    expect(daemonProviders[0].command).toEqual(["copilot", "--acp"]);
  });
});
