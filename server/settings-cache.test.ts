import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { createCachedSettingsReader } from "./settings-cache";

const schema = z.object({ language: z.string().default("de") });
type SettingsState = PluginSettingsState<typeof schema>;

function ready(language: string): SettingsState {
  return { status: "ready", revision: language, values: { language } };
}

function fakeSettings(overrides: Partial<PluginSettings<typeof schema>> = {}): PluginSettings<typeof schema> {
  return {
    read: async () => ready("de"),
    subscribe: () => () => {},
    ...overrides,
  };
}

describe("cached settings reader", () => {
  it("shares one host read between concurrent first callers", async () => {
    let reads = 0;
    let release!: (state: SettingsState) => void;
    const settings = fakeSettings({
      read: () => {
        reads += 1;
        return new Promise<SettingsState>((resolve) => { release = resolve; });
      },
    });
    const reader = createCachedSettingsReader(settings);
    const first = reader.read();
    const second = reader.read();
    release(ready("de"));
    await expect(first).resolves.toEqual(ready("de"));
    await expect(second).resolves.toEqual(ready("de"));
    expect(reads).toBe(1);
  });

  it("replaces the cached state when the host reports a change", async () => {
    let listener!: (state: SettingsState) => void;
    let reads = 0;
    const settings = fakeSettings({
      read: async () => { reads += 1; return ready("de"); },
      subscribe: (next) => { listener = next; return () => {}; },
    });
    const reader = createCachedSettingsReader(settings);
    await expect(reader.read()).resolves.toEqual(ready("de"));
    listener(ready("fr"));
    await expect(reader.read()).resolves.toEqual(ready("fr"));
    expect(reads).toBe(1);
  });

  it("serves the stale value and refreshes in the background after the TTL", async () => {
    let now = 0;
    let reads = 0;
    let release!: (state: SettingsState) => void;
    const settings = fakeSettings({
      read: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve(ready("de"));
        return new Promise<SettingsState>((resolve) => { release = resolve; });
      },
    });
    const reader = createCachedSettingsReader(settings, { ttlMs: 100, now: () => now });
    await expect(reader.read()).resolves.toEqual(ready("de"));
    now = 100;
    // Past the TTL the caller still gets the cached value at once.
    await expect(reader.read()).resolves.toEqual(ready("de"));
    expect(reads).toBe(2);
    release(ready("fr"));
    await Promise.resolve();
    await Promise.resolve();
    await expect(reader.read()).resolves.toEqual(ready("fr"));
    expect(reads).toBe(2);
  });

  it("does not cache a failed read and retries it", async () => {
    let reads = 0;
    const settings = fakeSettings({
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("settings disk unavailable");
        return ready("de");
      },
    });
    const reader = createCachedSettingsReader(settings);
    await expect(reader.read()).rejects.toThrow("settings disk unavailable");
    await expect(reader.read()).resolves.toEqual(ready("de"));
    expect(reads).toBe(2);
  });

  it("unsubscribes from the host when the plugin cleans up", () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const reader = createCachedSettingsReader(fakeSettings({ subscribe }));
    reader.dispose();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not let an earlier read overwrite a newer subscription update", async () => {
    let listener!: (state: SettingsState) => void;
    let release!: (state: SettingsState) => void;
    const settings = fakeSettings({
      read: () => new Promise<SettingsState>((resolve) => { release = resolve; }),
      subscribe: (next) => { listener = next; return () => {}; },
    });
    const reader = createCachedSettingsReader(settings);
    const pending = reader.read();
    listener(ready("fr"));
    release(ready("de"));
    await expect(pending).resolves.toEqual(ready("de"));
    await expect(reader.read()).resolves.toEqual(ready("fr"));
  });
});
