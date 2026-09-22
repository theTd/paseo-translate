import { describe, expect, it } from "vitest";
import {
  ACP_ADAPTER_PRESETS,
  adapterCommand,
  assertConfigured,
  knownAcpCommand,
  translateProvidersRpc,
  translateSettings,
  type TranslateSettingsValues,
} from "./translate";

const configured: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: ["agent"],
  innerAgentEnv: {},
  translatePrompts: true,
  translateResponses: true,
  translateAllTimelines: false,
  translationTimeoutMs: 30_000,
};

describe("translate settings schema", () => {
  it("parses an empty document into defaults so the settings form opens on a fresh install", () => {
    const parsed = translateSettings.schema.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.endpointBaseUrl).toBe("");
    expect(parsed.data.endpointModel).toBe("");
    expect(parsed.data.innerAgentCommand).toEqual([]);
    expect(parsed.data.userLanguage).toBe("en");
    expect(parsed.data.agentLanguage).toBe("de");
    expect(parsed.data.translationTimeoutMs).toBe(30_000);
  });

  it("fails closed at use time while required fields are unset", () => {
    expect(() => assertConfigured({ ...configured, endpointBaseUrl: "" })).toThrow(
      /missing endpoint base URL/,
    );
    expect(() => assertConfigured({ ...configured, endpointModel: "" })).toThrow(
      /missing endpoint model/,
    );
    expect(() => assertConfigured({ ...configured, innerAgentCommand: [] })).toThrow(
      /missing inner agent command/,
    );
    expect(() => assertConfigured(configured)).not.toThrow();
  });

  it("resolves known ACP provider commands and nulls the rest", () => {
    expect(knownAcpCommand("copilot")).toEqual(["copilot", "--acp"]);
    expect(knownAcpCommand("cursor")).toEqual(["cursor-agent", "acp"]);
    expect(knownAcpCommand("omp")).toEqual(["omp", "acp"]);
    expect(knownAcpCommand("opencode")).toEqual(["opencode", "acp"]);
    expect(knownAcpCommand("kimi")).toBeNull();
    expect(knownAcpCommand("__proto__")).toBeNull();
  });

  it("routes adapter presets through cmd /c on Windows only", () => {
    const preset = ACP_ADAPTER_PRESETS[0];
    expect(adapterCommand(preset, "win32")).toEqual(preset.windowsCommand);
    expect(adapterCommand(preset, "linux")).toEqual(preset.command);
    expect(adapterCommand(preset, "darwin")).toEqual(preset.command);
    for (const candidate of ACP_ADAPTER_PRESETS) {
      expect(candidate.windowsCommand.slice(0, 3)).toEqual(["cmd", "/c", "npx"]);
    }
  });

  it("shapes the providers list RPC contract", () => {
    expect(translateProvidersRpc.name).toBe("translate.providers.list");
    expect(
      translateProvidersRpc.output.parse({
        providers: [
          {
            id: "copilot",
            label: "Copilot",
            status: "ready",
            command: ["copilot", "--acp"],
            acp: "known",
          },
          { id: "claude", label: "Claude", status: "ready", command: null, acp: "unknown" },
          {
            id: "adapter:codex",
            label: "Codex (ACP adapter)",
            status: "ready",
            command: ["npx", "--yes", "@zed-industries/codex-acp@0.12.0"],
            acp: "adapter",
          },
        ],
      }),
    ).toEqual({
      providers: [
        {
          id: "copilot",
          label: "Copilot",
          status: "ready",
          command: ["copilot", "--acp"],
          acp: "known",
        },
        { id: "claude", label: "Claude", status: "ready", command: null, acp: "unknown" },
        {
          id: "adapter:codex",
          label: "Codex (ACP adapter)",
          status: "ready",
          command: ["npx", "--yes", "@zed-industries/codex-acp@0.12.0"],
          acp: "adapter",
        },
      ],
    });
    expect(
      translateProvidersRpc.output.safeParse({
        providers: [{ id: "x", command: null, acp: "known" }],
      }).success,
    ).toBe(false);
  });
});
