import { describe, expect, it } from "vitest";
import {
  ACP_ADAPTER_PRESETS,
  adapterCommand,
  assertAcpConfigured,
  assertConfigured,
  knownAcpCommand,
  resolveTranslationSystemPrompt,
  translateProvidersRpc,
  translateSettings,
  translationSystemPrompt,
  type TranslateSettingsValues,
} from "./translate";

const configured: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  translationReasoningEffort: "default" as const,
  translationSystemPrompt: "",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: ["agent"],
  innerAgentEnv: {},
  claudeExecutablePath: "",
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
    expect(parsed.data.translationSystemPrompt).toBe("");
    expect(parsed.data.translationTimeoutMs).toBe(30_000);
  });

  it("fails closed at use time while required fields are unset", () => {
    expect(() => assertConfigured({ ...configured, endpointBaseUrl: "" })).toThrow(
      /missing endpoint base URL/,
    );
    expect(() => assertConfigured({ ...configured, endpointModel: "" })).toThrow(
      /missing endpoint model/,
    );
    // The inner agent command is only required by the ACP provider; the
    // direct Claude provider works without it.
    expect(() => assertConfigured({ ...configured, innerAgentCommand: [] })).not.toThrow();
    expect(() => assertAcpConfigured({ ...configured, innerAgentCommand: [] })).toThrow(
      /Translate \(ACP\) needs an inner agent command/,
    );
    expect(() => assertAcpConfigured(configured)).not.toThrow();
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

  it("resolves the effective system prompt from a custom template", () => {
    const pair = { source: "en", target: "de" };
    // Empty or whitespace-only falls back to the built-in default.
    expect(resolveTranslationSystemPrompt("", pair)).toBe(translationSystemPrompt(pair));
    expect(resolveTranslationSystemPrompt("   \n\t", pair)).toBe(translationSystemPrompt(pair));
    // {source}/{target} placeholders resolve so one template serves both
    // directions.
    expect(resolveTranslationSystemPrompt("Übersetze {source} nach {target}.", pair)).toBe(
      "Übersetze en nach de.",
    );
    expect(
      resolveTranslationSystemPrompt("Translate {target} text to {source}.", {
        source: "de",
        target: "en",
      }),
    ).toBe("Translate en text to de.");
    // A template without placeholders passes through verbatim.
    expect(resolveTranslationSystemPrompt("Translate everything to German.", pair)).toBe(
      "Translate everything to German.",
    );
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
      translateProvidersRpc.output.safeParse({ providers: [{ id: "x", command: null, acp: "known" }] })
        .success,
    ).toBe(false);
  });
});
