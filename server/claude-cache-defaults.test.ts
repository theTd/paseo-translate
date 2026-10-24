import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import contribute from "../index.server";
import { claudeCachePreferencesSchema } from "../shared/claude-cache-compaction";

vi.mock("./translation-cache-store", async (original) => {
  const module = await original<typeof import("./translation-cache-store")>();
  return { ...module, createPersistentTranslationCacheStore: () => module.createMemoryTranslationCacheStore() };
});
vi.mock("./claude-cache-preferences", () => ({ createClaudeCachePreferenceStore: () => ({ get: () => undefined, set: vi.fn() }) }));

describe("Claude new-session defaults", () => {
  it("snapshots defaults only at creation and preserves explicit configuration", async () => {
    let defaults = claudeCachePreferencesSchema.parse({ enabled: false });
    const hooks = new Map<string, (input: { request: { config: AgentSessionConfig } }) => Promise<{ config: AgentSessionConfig } | undefined>>();
    const server = { registerSettings: (definition: { id: string }) => ({
      read: async () => ({ status: "ready", values: definition.id === "claude-cache" ? defaults : {} }),
    }), before: (name: string, handler: typeof hooks extends Map<string, infer H> ? H : never) => {
      hooks.set(name, handler); return vi.fn();
    }, on: vi.fn(() => vi.fn()), handle: vi.fn(), registerProvider: vi.fn() } as unknown as PluginServerContext;
    const dispose = contribute(server);
    try {
      const create = hooks.get("agent.create")!;
      const config: AgentSessionConfig = { provider: "translate-claude", cwd: "/repo", providerOptions: { custom: "keep" } };
      const first = (await create({ request: { config } }))!;
      expect(first.config.providerOptions).toEqual({ custom: "keep", translateClaudeCache: defaults });
      defaults = { enabled: true, thresholdTokens: 300_000, leadSeconds: 300 };
      const second = (await create({ request: { config } }))!;
      expect(second.config.providerOptions?.translateClaudeCache).toEqual(defaults);
      expect(first.config.providerOptions?.translateClaudeCache).toMatchObject({ enabled: false, thresholdTokens: 200_000 });
      const explicit = (await create({ request: { config: first.config } }))!;
      expect(explicit.config.providerOptions?.translateClaudeCache).toEqual(first.config.providerOptions?.translateClaudeCache);
      expect(await create({ request: { config: { ...config, provider: "translate-codex" } } })).toBeUndefined();
      expect(await create({ request: { config: { ...config, internal: true } } })).toBeUndefined();
    } finally { dispose(); }
  });
});
