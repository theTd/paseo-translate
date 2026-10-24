import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCacheCompactionCoordinator } from "./claude-cache-compaction";
import { claudeCachePreferencesSchema, type ClaudeCachePreferences } from "../shared/claude-cache-compaction";

const preferences = claudeCachePreferencesSchema.parse({ enabled: true });
const live: ClaudeCacheCompactionCoordinator[] = [];

function harness(options: { seed?: unknown; concurrency?: number } = {}) {
  const saved = new Map<string, ClaudeCachePreferences>();
  const service = new ClaudeCacheCompactionCoordinator({ get: (id) => saved.get(id),
    set: (id, value) => { saved.set(id, value); } }, Date.now, options.concurrency ?? 2);
  live.push(service);
  const state = { idle: true, contextTokens: 250_000 as number | null };
  const compact = vi.fn(async (guard: () => boolean) => {
    if (!guard()) return false;
    state.idle = false;
    return true;
  });
  const register = (id = "agent", seed: unknown = options.seed ?? preferences) => service.register(id, seed,
    { snapshot: () => state, compact });
  const unregister = register();
  function requesting(id = "agent") {
    service.observe(id, { type: "system", subtype: "status", status: "requesting" }, undefined);
  }
  function usage(ttl: "1h" | "5m" | "mixed" | "read" | "none" = "1h", id = "agent", explicit?: "5m" | "1h") {
    service.observe(id, { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start",
      message: { usage: { input_tokens: 30, cache_read_input_tokens: ttl === "read" ? 240_000 : 0,
        cache_creation_input_tokens: ttl === "none" || ttl === "read" ? 0 : 240_000,
        cache_creation: { ephemeral_1h_input_tokens: ttl === "1h" || ttl === "mixed" ? 240_000 : 0,
          ephemeral_5m_input_tokens: ttl === "5m" || ttl === "mixed" ? 240_000 : 0 } } } } }, explicit);
  }
  function complete(id = "agent") {
    service.observe(id, { type: "result", subtype: "success", is_error: false }, undefined);
  }
  function warm(ttl: Parameters<typeof usage>[0] = "1h", id = "agent") { requesting(id); usage(ttl, id); complete(id); }
  return { service, saved, state, compact, register, unregister, requesting, usage, complete, warm };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { for (const service of live.splice(0)) service.dispose(); vi.useRealTimers(); });

describe("Claude AFK cache scheduling", () => {
  it("starts five minutes before an observed one-hour cache expiry, once", async () => {
    const h = harness(); h.warm();
    expect(h.service.status("agent")).toMatchObject({ expiresAt: 4_600_000, scheduledAt: 4_300_000 });
    await vi.advanceTimersByTimeAsync(55 * 60_000 - 1);
    expect(h.compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).toHaveBeenCalledOnce();
    h.service.finish("agent", true);
    h.state.idle = true;
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(h.compact).toHaveBeenCalledOnce();
    expect(h.service.status("agent").state).toBe("compacted");
  });

  it("counts response generation against TTL instead of starting at completion", async () => {
    const h = harness(); h.requesting(); h.usage();
    await vi.advanceTimersByTimeAsync(20 * 60_000); h.complete();
    expect(h.service.status("agent").expiresAt).toBe(4_600_000);
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it.each([199_999, 200_000, null])("does not compact context at/below the threshold or unknown: %s", async (tokens) => {
    const h = harness(); h.state.contextTokens = tokens; h.warm();
    await vi.advanceTimersByTimeAsync(56 * 60_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it.each(["5m", "mixed", "none", "read"] as const)("does not schedule an excluded or unproven cache: %s", async (ttl) => {
    const h = harness(); h.warm(ttl);
    await vi.advanceTimersByTimeAsync(56 * 60_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("uses an explicit lifetime for cache-hit-only usage without assuming a subscription default", async () => {
    const h = harness(); h.requesting(); h.usage("read", "agent", "1h"); h.complete();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("does not invent an expiry from first-token or historical usage alone", async () => {
    const h = harness(); h.usage(); h.complete();
    expect(h.service.status("agent").expiresAt).toBeNull();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("permits full assistant usage to refine stream usage at the same request start", async () => {
    const h = harness(); h.requesting();
    h.service.observe("agent", { type: "assistant", message: { usage: {
      input_tokens: 1, cache_creation_input_tokens: 250_000 } } }, undefined);
    await vi.advanceTimersByTimeAsync(60_000); h.usage(); h.complete();
    expect(h.service.status("agent").expiresAt).toBe(4_600_000);
  });

  it("does not reset the root countdown for subagent messages", async () => {
    const h = harness(); h.warm();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    h.service.observe("agent", { type: "system", subtype: "status", status: "requesting", parent_tool_use_id: "child" }, undefined);
    h.usage();
    expect(h.service.status("agent").expiresAt).toBe(4_600_000);
  });

  it("waits for work to finish without an added inactivity timer", async () => {
    const h = harness(); h.state.idle = false; h.warm();
    await vi.advanceTimersByTimeAsync(56 * 60_000);
    expect(h.compact).not.toHaveBeenCalled();
    h.state.idle = true; h.service.refresh();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("skips a missed deadline instead of running a cold compaction", async () => {
    const h = harness(); h.state.idle = false; h.warm();
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    h.state.idle = true; h.service.refresh();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.service.status("agent").state).toBe("expired");
  });

  it.each(["disable", "raise", "prompt", "invalidate", "archive", "close", "dispose"])(
    "rechecks pending work after %s", async (action) => {
      const h = harness(); h.warm();
      if (action === "disable") h.service.configure("agent", { ...preferences, enabled: false });
      if (action === "raise") h.service.configure("agent", { ...preferences, thresholdTokens: 300_000 });
      if (action === "prompt") h.service.prompt("agent");
      if (action === "invalidate") h.service.invalidate("agent");
      if (action === "archive") h.service.suspend("agent");
      if (action === "close") h.unregister();
      if (action === "dispose") h.service.dispose();
      await vi.advanceTimersByTimeAsync(56 * 60_000);
      expect(h.compact).not.toHaveBeenCalled();
    });

  it("keeps legacy sessions off and persists an explicit session override", async () => {
    const h = harness({ seed: {} }); h.warm();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(h.compact).not.toHaveBeenCalled();
    h.service.configure("agent", preferences);
    expect(h.saved.get("agent")).toEqual(preferences);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).toHaveBeenCalledOnce();
    h.unregister(); h.register("agent", { enabled: false });
    expect(h.service.status("agent")).toMatchObject({ preferences: { enabled: true }, expiresAt: null, state: "unknown" });
  });

  it("rechecks the guard when a user prompt wins the provider fence", async () => {
    const h = harness(); h.warm();
    h.compact.mockImplementationOnce(async (guard) => { h.service.prompt("agent"); return guard(); });
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(h.service.status("agent").state).not.toBe("compacting");
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("bounds concurrent compactions and skips expired work waiting for a slot", async () => {
    const h = harness({ concurrency: 1 }); h.register("second"); h.warm(); h.warm("1h", "second");
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(h.compact).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    h.state.idle = true; h.service.finish("agent", true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("ignores a failed start from a replaced session", async () => {
    const h = harness(); h.warm();
    h.compact.mockImplementationOnce(async () => { h.register(); throw new Error("Old source closed"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(h.service.status("agent").state).toBe("unknown");
    warn.mockRestore();
  });

  it("does not block other sessions behind one source's mutation fence", async () => {
    const h = harness();
    let release!: () => void;
    const fence = new Promise<void>((resolve) => { release = resolve; });
    h.compact.mockImplementationOnce(async (guard) => { await fence; return guard(); });
    const second = vi.fn(async (guard: () => boolean) => guard());
    h.service.register("second", preferences, { snapshot: () => ({ idle: true, contextTokens: 250_000 }), compact: second });
    h.warm(); h.warm("1h", "second");
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(second).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(1);
  });
});
