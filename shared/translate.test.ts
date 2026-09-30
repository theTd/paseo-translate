import { describe, expect, it } from "vitest";
import {
  ACP_ADAPTER_PRESETS,
  TRANSLATE_AGENT_ID_ENV,
  TRANSLATION_INPUT_CLOSE_TAG,
  TRANSLATION_INPUT_OPEN_TAG,
  adapterCommand,
  assertAcpConfigured,
  assertConfigured,
  isDataUriImageOnlyText,
  isDisplayTranslationSettled,
  isProviderImageMarkdown,
  isReasoningTranslationEligible,
  knownAcpCommand,
  omitTranslationBridgeEnv,
  resolveTranslationContextKey,
  resolveTranslationSystemPrompt,
  translateProvidersRpc,
  translateSettings,
  translationSystemPrompt,
  unwrapTranslationInput,
  wrapTranslationInput,
  type TranslateSettingsValues,
} from "./translate";

const configured: TranslateSettingsValues = {
  endpointBaseUrl: "https://llm.example/v1",
  endpointApiKey: "key",
  endpointModel: "mt",
  endpointProtocol: "chat-completions" as const,
  translationReasoningEffort: "default" as const,
  translationSystemPrompt: "",
  translationDomainContext: "",
  userLanguage: "en",
  agentLanguage: "de",
  innerAgentCommand: ["agent"],
  innerAgentEnv: {},
  claudeExecutablePath: "",
  codexExecutablePath: "",
  translatePrompts: true,
  translateResponses: true,
  translateReasoning: false,
  translateAllTimelines: false,
  translationContextEnabled: true,
  translationContextIdleMinutes: 30,
  translationContextMaxChars: 100_000,
  translationTimeoutMs: 30_000,
  uiLanguage: "system" as const,
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
    expect(parsed.data.translateReasoning).toBe(false);
    expect(parsed.data.translationSystemPrompt).toBe("");
    expect(parsed.data.translationDomainContext).toBe("");
    expect(parsed.data.translationTimeoutMs).toBe(30_000);
    expect(parsed.data.endpointProtocol).toBe("responses");
    expect(parsed.data.uiLanguage).toBe("system");
  });

  it("accepts both endpoint protocols and rejects anything else", () => {
    for (const endpointProtocol of ["responses", "chat-completions"]) {
      expect(translateSettings.schema.safeParse({ endpointProtocol }).success).toBe(true);
    }
    expect(translateSettings.schema.safeParse({ endpointProtocol: "grpc" }).success).toBe(false);
  });

  it("accepts every reasoning-effort gear including none", () => {
    for (const effort of ["default", "none", "minimal", "low", "medium", "high"]) {
      const parsed = translateSettings.schema.safeParse({ translationReasoningEffort: effort });
      expect(parsed.success).toBe(true);
    }
    expect(
      translateSettings.schema.safeParse({ translationReasoningEffort: "extreme" }).success,
    ).toBe(false);
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

  it("appends the domain context to the built-in prompt and resolves {context} in templates", () => {
    const pair = { source: "en", target: "de" };
    // Empty or whitespace-only context adds nothing.
    expect(translationSystemPrompt(pair)).not.toContain("Domain context");
    expect(translationSystemPrompt(pair, "  \n")).not.toContain("Domain context");
    expect(translationSystemPrompt(pair, "coding assistant chat")).toContain(
      "Domain context: coding assistant chat",
    );
    expect(resolveTranslationSystemPrompt("", pair, "coding assistant chat")).toBe(
      translationSystemPrompt(pair, "coding assistant chat"),
    );
    expect(
      resolveTranslationSystemPrompt("Context: {context}. {source} -> {target}.", pair, "code"),
    ).toBe("Context: code. en -> de.");
  });

  it("wraps source text in the translation input tags", () => {
    expect(wrapTranslationInput("Hello")).toBe(
      `${TRANSLATION_INPUT_OPEN_TAG}\nHello\n${TRANSLATION_INPUT_CLOSE_TAG}`,
    );
    // The built-in prompt references the same tags the wrapper emits.
    const prompt = translationSystemPrompt({ source: "en", target: "de" });
    expect(prompt).toContain(TRANSLATION_INPUT_OPEN_TAG);
    expect(prompt).toContain(TRANSLATION_INPUT_CLOSE_TAG);
    // unwrap is the exact inverse and tolerates unwrapped text.
    expect(unwrapTranslationInput(wrapTranslationInput("Hello\nworld"))).toBe("Hello\nworld");
    expect(unwrapTranslationInput("plain")).toBe("plain");
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

describe("data-URI image text gate", () => {
  it("matches a lone tool-screenshot message", () => {
    expect(isDataUriImageOnlyText("![tool image](data:image/png;base64,aGVsbG8=)")).toBe(true);
  });

  it("matches several images separated by whitespace", () => {
    expect(
      isDataUriImageOnlyText(
        "![tool image](data:image/png;base64,aGVsbG8=)\n![tool image](data:image/jpeg;base64,aGk=)",
      ),
    ).toBe(true);
  });

  it("keeps ordinary text eligible", () => {
    expect(isDataUriImageOnlyText("Hello world")).toBe(false);
  });

  it("fails open on mixed text plus image", () => {
    expect(isDataUriImageOnlyText("See this: ![tool image](data:image/png;base64,aGk=)")).toBe(
      false,
    );
  });

  it("keeps remote-URL images eligible (their alt text still translates)", () => {
    expect(isDataUriImageOnlyText("![diagram](https://example.com/x.png)")).toBe(false);
  });

  it("leaves empty texts to the length gate", () => {
    expect(isDataUriImageOnlyText("")).toBe(false);
    expect(isDataUriImageOnlyText("   \n  ")).toBe(false);
  });
});

describe("provider image markdown gate", () => {
  const hash = "a".repeat(64);
  it("matches materialized file references in both URI shapes", () => {
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/${hash}.png)`)).toBe(true);
    expect(
      isProviderImageMarkdown(`![Image](file:///C:/Users/me/AppData/Local/Temp/paseo-attachments-x1/${hash}.webp)`),
    ).toBe(true);
  });

  it("leaves user-authored and remote images translatable", () => {
    expect(isProviderImageMarkdown("![diagram](./paseo-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    expect(isProviderImageMarkdown("Hello world")).toBe(false);
  });
});

describe("display translation settled", () => {
  it("treats complete as settled regardless of the live-head signals", () => {
    expect(isDisplayTranslationSettled({ phase: "complete" })).toBe(true);
    expect(
      isDisplayTranslationSettled({ phase: "complete", agentIsBusy: true, streamIdle: false }),
    ).toBe(true);
  });

  it("does not settle a live-head item while the agent is busy or unknown", () => {
    expect(isDisplayTranslationSettled({ phase: "streaming" })).toBe(false);
    expect(isDisplayTranslationSettled({ phase: "streaming", agentIsBusy: true })).toBe(false);
    expect(isDisplayTranslationSettled({ phase: "streaming", agentIsBusy: null })).toBe(false);
  });

  it("settles a live-head item once the agent is no longer busy", () => {
    expect(isDisplayTranslationSettled({ phase: "streaming", agentIsBusy: false })).toBe(true);
  });

  it("settles a live-head item whose text has stopped growing", () => {
    expect(
      isDisplayTranslationSettled({ phase: "streaming", agentIsBusy: true, streamIdle: true }),
    ).toBe(true);
    expect(isDisplayTranslationSettled({ phase: "streaming", streamIdle: true })).toBe(true);
  });
});

describe("reasoning translation eligibility", () => {
  const base = {
    phase: "complete" as const,
    textLength: 12,
    languagePair: "de>en",
    translateReasoning: true,
    translateResponses: true,
    ownedByTranslateProvider: true,
    translateAllTimelines: false,
  };

  it("translates a complete block for an owned provider when both switches are on", () => {
    expect(isReasoningTranslationEligible(base)).toBe(true);
  });

  it("stays off by default (translateReasoning false)", () => {
    expect(isReasoningTranslationEligible({ ...base, translateReasoning: false })).toBe(false);
  });

  it("requires the shared translateResponses display gate", () => {
    expect(isReasoningTranslationEligible({ ...base, translateResponses: false })).toBe(false);
  });

  it("never translates while streaming unless the live-head item has settled", () => {
    expect(isReasoningTranslationEligible({ ...base, phase: "streaming" })).toBe(false);
    expect(
      isReasoningTranslationEligible({ ...base, phase: "streaming", agentIsBusy: false }),
    ).toBe(true);
    expect(
      isReasoningTranslationEligible({ ...base, phase: "streaming", streamIdle: true }),
    ).toBe(true);
  });

  it("skips empty texts that would fail the RPC min(1) contract", () => {
    expect(isReasoningTranslationEligible({ ...base, textLength: 0 })).toBe(false);
  });

  it("stays off before settings load (null pair)", () => {
    expect(isReasoningTranslationEligible({ ...base, languagePair: null })).toBe(false);
  });

  it("covers foreign providers only when every timeline translates", () => {
    expect(
      isReasoningTranslationEligible({ ...base, ownedByTranslateProvider: false }),
    ).toBe(false);
    expect(
      isReasoningTranslationEligible({
        ...base,
        ownedByTranslateProvider: false,
        translateAllTimelines: true,
      }),
    ).toBe(true);
  });
});

describe("agent id env bridge", () => {
  it("scopes by the bridged agent id, falling back when absent or blank", () => {
    expect(resolveTranslationContextKey({ [TRANSLATE_AGENT_ID_ENV]: "agent-1" }, "s")).toBe(
      "agent-1",
    );
    expect(resolveTranslationContextKey({}, "s")).toBe("s");
    expect(resolveTranslationContextKey({ [TRANSLATE_AGENT_ID_ENV]: "  " }, "s")).toBe("s");
  });

  it("strips the bridge var for the inner agent environment, keeping the rest", () => {
    expect(
      omitTranslationBridgeEnv({ [TRANSLATE_AGENT_ID_ENV]: "agent-1", KEEP_ME: "1" }),
    ).toEqual({ KEEP_ME: "1" });
    expect(omitTranslationBridgeEnv({ KEEP_ME: "1" })).toEqual({ KEEP_ME: "1" });
  });
});
