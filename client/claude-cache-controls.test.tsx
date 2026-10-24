import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CachePreferencesForm, contributeClaudeCacheControls } from "./claude-cache-controls";
import { claudeCachePreferencesSchema, cacheCountdown } from "../shared/claude-cache-compaction";
import type { PluginClientContext } from "@getpaseo/plugin/client";

const state = vi.hoisted(() => ({ pending: false, enabled: true, threshold: "200000", lead: "300", setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof React>(),
  useState: (initial: unknown) => {
    const index = state.setters.length;
    const setter = vi.fn(); state.setters.push(setter);
    return [index === 0 ? state.enabled : index === 1 ? state.threshold : index === 2 ? state.lead : initial, setter];
  },
  useRef: () => ({ current: false }),
}));
vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsAction: "Action", SettingsCard: "Card", SettingsInput: "Input",
  SettingsSection: "Section", SettingsSwitch: "Switch" }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => ({ status: "ready", values: { uiLanguage: "en" } }) }));
vi.mock("./i18n", () => ({ useTranslate: () => ({ locale: "en" }), detectSystemLocale: () => "en" }));

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.enabled = true; state.threshold = "200000"; state.lead = "300"; state.setters = [];
});

function actions(node: React.ReactNode): Array<{ onPress(): void }> {
  if (Array.isArray(node)) return node.flatMap(actions);
  if (!React.isValidElement<{ onPress(): void; children?: React.ReactNode }>(node)) return [];
  return node.type === "Action" ? [node.props] : actions(node.props.children);
}

describe("Claude AFK controls", () => {
  it("only saves explicitly and sends the initial 200k/five-minute preferences", async () => {
    const save = vi.fn(async () => true);
    const form = CachePreferencesForm({ value: claudeCachePreferencesSchema.parse({}), saving: false, onSave: save });
    expect(save).not.toHaveBeenCalled();
    actions(form)[0].onPress(); actions(form)[0].onPress();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({ enabled: true, thresholdTokens: 200000, leadSeconds: 300 });
  });

  it.each(["", "-1", "0", "200000.5", "Infinity"])("rejects an invalid threshold: %s", (threshold) => {
    state.threshold = threshold;
    const save = vi.fn(async () => true);
    actions(CachePreferencesForm({ value: claudeCachePreferencesSchema.parse({}), saving: false, onSave: save }))[0].onPress();
    expect(save).not.toHaveBeenCalled();
    expect(state.setters[3]).toHaveBeenCalledWith(expect.stringContaining("whole-number"));
  });

  it("bounds the lead time and reports save failures", async () => {
    state.lead = "3600";
    const save = vi.fn(async () => { throw new Error("Disk unavailable"); });
    actions(CachePreferencesForm({ value: claudeCachePreferencesSchema.parse({}), saving: false, onSave: save }))[0].onPress();
    expect(save).not.toHaveBeenCalled();
    state.lead = "300"; state.setters = [];
    actions(CachePreferencesForm({ value: claudeCachePreferencesSchema.parse({}), saving: false, onSave: save }))[0].onPress();
    await vi.waitFor(() => expect(state.setters[3]).toHaveBeenCalledWith("Disk unavailable"));
  });

  it("formats a fixed deadline and stops at zero", () => {
    expect(cacheCountdown(3_600_000, 300_000)).toBe("55:00");
    expect(cacheCountdown(3_600_000, 3_599_500)).toBe("0:01");
    expect(cacheCountdown(3_600_000, 3_700_000)).toBe("0:00");
    expect(cacheCountdown(null, 0)).toBe("?");
  });

  it("registers cache pills without sending prompts or polling historical agents", async () => {
    let observer: { snapshot(value: unknown): void } | undefined;
    const release = vi.fn(async () => {});
    const remove = vi.fn();
    const context = { paseo: { agents: { list: vi.fn(async () => ({ subscription: {
      subscribe: (value: typeof observer) => { observer = value; return vi.fn(); }, release,
    } })) } }, addComposerPill: vi.fn(() => ({ remove, update: vi.fn() })) } as unknown as PluginClientContext;
    const stop = contributeClaudeCacheControls(context);
    await vi.waitFor(() => expect(observer).toBeDefined());
    observer!.snapshot({ entries: [
      { agent: { id: "claude", provider: "translate-claude", workspaceId: "workspace" } },
      { agent: { id: "codex", provider: "translate-codex", workspaceId: "workspace" } },
      { agent: { id: "archived", provider: "translate-claude", workspaceId: "workspace", archivedAt: "today" } },
    ], pageInfo: { nextCursor: null } });
    expect(context.addComposerPill).toHaveBeenCalledOnce();
    expect(context.addComposerPill).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude" }));
    stop();
    expect(remove).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
