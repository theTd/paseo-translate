import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForkConfirmation, contributeClaudeSessionFork } from "./claude-session-fork";
import type { PluginClientContext } from "@getpaseo/plugin/client";

const state = vi.hoisted(() => ({ fork: vi.fn(), complete: vi.fn(), close: vi.fn(), toast: vi.fn(),
  error: vi.fn(), startNew: vi.fn(), key: "12345678-1234-4234-8234-123456789abc",
  provider: "translate-claude", setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof React>(), useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => { const setter = vi.fn(); state.setters.push(setter); return [value, setter]; },
  useEffect: vi.fn(),
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: (_id: string, select: (agent: unknown) => unknown) => select({ title: "Original", cwd: "/project", provider: state.provider }),
  useRpc: () => state.fork, useSettings: () => ({ status: "ready", values: { uiLanguage: "en" } }),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ useToast: () => ({ show: state.toast, error: state.error }) }));
vi.mock("./i18n", () => ({ useTranslate: () => ({ t: (key: string) => key }), detectSystemLocale: () => "en", translate: () => "Fork" }));

function buttons(node: React.ReactNode): Array<{ disabled?: boolean; onPress(): void; children: React.ReactNode }> {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!React.isValidElement<{ disabled?: boolean; onPress(): void; children: React.ReactNode }>(node)) return [];
  return node.type === "Pressable" ? [node.props] : buttons(node.props.children);
}

function render() {
  return buttons(ForkConfirmation({ sourceAgentId: "source-agent", getOperationId: () => state.key, startNewOperation: state.startNew,
    onComplete: state.complete, close: state.close,
    theme: { colors: { surface0: "#000", surface1: "#111", surface2: "#222", border: "#333", foreground: "#fff",
      foregroundMuted: "#aaa", accent: "#00f", accentForeground: "#fff", statusSuccess: "#0f0",
      statusWarning: "#ff0", statusDanger: "#f00" } }, host: { id: "host", label: "Local" },
    layout: { compact: false, platform: "web" }, context: "agent", agentId: "source-agent", workspaceId: "workspace",
  }));
}

beforeEach(() => {
  vi.clearAllMocks(); state.setters = []; state.provider = "translate-claude";
  state.key = "12345678-1234-4234-8234-123456789abc";
  state.startNew.mockImplementation(() => { state.key = "87654321-4321-4321-8321-987654321abc"; });
  state.fork.mockResolvedValue({ kind: "forked", agentId: "copy-agent" });
});

describe("Claude fork secondary confirmation", () => {
  it("opening and canceling the confirmation never invokes the fork", () => {
    const [cancel] = render();
    expect(state.fork).not.toHaveBeenCalled();
    cancel.onPress();
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.fork).not.toHaveBeenCalled();
  });

  it("requires confirmation, prevents double presses, and opens only the returned agent", async () => {
    const [, confirm] = render();
    confirm.onPress();
    confirm.onPress();
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
    expect(state.fork).toHaveBeenCalledOnce();
    expect(state.fork).toHaveBeenCalledWith({ agentId: "source-agent", operationId: "12345678-1234-4234-8234-123456789abc" });
    expect(state.complete).toHaveBeenCalledWith("copy-agent");
  });

  it("keeps failed confirmation retryable without closing it", async () => {
    state.fork.mockRejectedValueOnce(new Error("Background work is still running"));
    const [, confirm] = render();
    confirm.onPress();
    await vi.waitFor(() => expect(state.setters[1]).toHaveBeenCalledWith("Background work is still running"));
    expect(state.close).not.toHaveBeenCalled();
    confirm.onPress();
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledWith("copy-agent"));
    expect(state.fork).toHaveBeenCalledTimes(2);
  });

  it("requires a fresh confirmation/key after the source changes, preserving ordinary retry keys", async () => {
    state.fork.mockResolvedValueOnce({ kind: "restart_required", message: "The source changed" });
    const [, confirm] = render();
    confirm.onPress();
    await vi.waitFor(() => expect(state.setters[1]).toHaveBeenCalledWith("The source changed"));
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.startNew).not.toHaveBeenCalled();
    confirm.onPress();
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledWith("copy-agent"));
    expect(state.startNew).toHaveBeenCalledOnce();
    expect(state.fork.mock.calls.map(([input]) => input.operationId)).toEqual([
      "12345678-1234-4234-8234-123456789abc", "87654321-4321-4321-8321-987654321abc",
    ]);
  });

  it("disables confirmation when the original agent is unavailable or has another provider", () => {
    state.provider = "translate-codex";
    expect(render()[1].disabled).toBe(true);
  });
});

it("observes older pages, rebuilds them after reconnect, and releases every observation and button", async () => {
  type Agent = { id: string; provider: string; workspaceId: string };
  type Observer = { snapshot(page: { entries: Array<{ agent: Agent }>; pageInfo: { nextCursor: string | null } }): void;
    update(message: { type: string; payload: { kind: string; agent: Agent } }): void };
  const observations: Array<{ cursor?: string; observer?: Observer; release: ReturnType<typeof vi.fn> }> = [];
  const list = vi.fn(async ({ page }: { page: { cursor?: string } }) => {
    const entry = { cursor: page.cursor, observer: undefined as Observer | undefined, release: vi.fn(async () => {}) };
    observations.push(entry);
    return { subscription: { subscribe: (observer: Observer) => { entry.observer = observer; return vi.fn(); }, release: entry.release } };
  });
  const buttons: Array<{ agentId: string; remove: ReturnType<typeof vi.fn> }> = [];
  const removePanel = vi.fn();
  const context = { paseo: { agents: { list } }, addWorkspacePanel: () => removePanel,
    addComposerPill: ({ agentId }: { agentId: string }) => {
      const button = { agentId, remove: vi.fn() };
      buttons.push(button);
      return button;
    },
  } as unknown as PluginClientContext;
  const cleanup = contributeClaudeSessionFork(context);
  await vi.waitFor(() => expect(observations[0]?.observer).toBeDefined());
  const first = Array.from({ length: 200 }, (_, i) => ({ agent: { id: `agent-${i}`, provider: "translate-claude", workspaceId: "workspace" } }));
  observations[0].observer!.snapshot({ entries: first, pageInfo: { nextCursor: "older" } });
  await vi.waitFor(() => expect(observations[1]?.observer).toBeDefined());
  const newlyCreated = { id: "new-agent", provider: "translate-claude", workspaceId: "workspace" };
  observations[0].observer!.update({ type: "agent_update", payload: { kind: "upsert", agent: newlyCreated } });
  const older = { id: "older-agent", provider: "translate-claude", workspaceId: "workspace" };
  observations[1].observer!.snapshot({ entries: [{ agent: older }], pageInfo: { nextCursor: null } });
  const newButton = buttons.find((button) => button.agentId === newlyCreated.id);
  expect(newButton).toBeDefined();
  expect(newButton?.remove).not.toHaveBeenCalled();
  expect(buttons.find((button) => button.agentId === older.id)).toBeDefined();
  observations[0].observer!.snapshot({ entries: first, pageInfo: { nextCursor: "older" } });
  expect(observations[1].release).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(observations[2]?.observer).toBeDefined());
  observations[2].observer!.snapshot({ entries: [{ agent: older }], pageInfo: { nextCursor: null } });
  expect(buttons.filter((button) => button.agentId === older.id)).toHaveLength(2);
  observations[2].observer!.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...older, provider: "translate-codex" } } });
  expect(buttons.filter((button) => button.agentId === older.id).every((button) => button.remove.mock.calls.length === 1)).toBe(true);
  cleanup();
  expect(observations.every((entry) => entry.release.mock.calls.length === 1)).toBe(true);
  expect(buttons.every((button) => button.remove.mock.calls.length === 1)).toBe(true);
  expect(removePanel).toHaveBeenCalledOnce();
});
