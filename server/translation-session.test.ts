import { describe, expect, it } from "vitest";
import { createTranslationSessionManager } from "./translation-session";

describe("translation session manager", () => {
  it("serializes one session and prioritizes prompt work", async () => {
    const manager = createTranslationSessionManager({ promptCacheKey: (key, epoch) => `${key}:${epoch}` });
    const events: string[] = [];
    let releaseDisplay!: () => void;
    const display = manager.run("a", "display", async () => {
      events.push("display:start");
      await new Promise<void>((resolve) => { releaseDisplay = resolve; });
      events.push("display:end");
      return "display";
    });
    const prompt = manager.run("a", "prompt", async () => { events.push("prompt"); return "prompt"; });
    await Promise.resolve();
    expect(events).toEqual(["display:start"]);
    releaseDisplay();
    await expect(display).resolves.toBe("display");
    await expect(prompt).resolves.toBe("prompt");
    expect(events).toEqual(["display:start", "display:end", "prompt"]);
  });

  it("runs different sessions concurrently and rotates cache epochs", async () => {
    const manager = createTranslationSessionManager({ promptCacheKey: (key, epoch) => `${key}:${epoch}` });
    const gate: string[] = [];
    const a = manager.run("a", "prompt", async () => { gate.push("a"); return "a"; });
    const b = manager.run("b", "prompt", async () => { gate.push("b"); return "b"; });
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(gate.sort()).toEqual(["a", "b"]);
    expect(manager.getOrCreate("a").promptCacheKey).toBe("a:0");
    manager.bumpCacheEpoch("a");
    expect(manager.getOrCreate("a").promptCacheKey).toBe("a:1");
  });

  it("rotates the epoch when the session configuration changes", () => {
    const manager = createTranslationSessionManager({ promptCacheKey: (key, epoch) => `${key}:${epoch}` });
    manager.ensureConfiguration("a", "model-a");
    expect(manager.getOrCreate("a").cacheEpoch).toBe(0);
    manager.ensureConfiguration("a", "model-b");
    expect(manager.getOrCreate("a").cacheEpoch).toBe(1);
    manager.ensureConfiguration("a", "model-b");
    expect(manager.getOrCreate("a").cacheEpoch).toBe(1);
  });

  it("rejects a queued canceled request without running it", async () => {
    const manager = createTranslationSessionManager();
    let release!: () => void;
    const first = manager.run("a", "prompt", async () => new Promise<string>((resolve) => { release = () => resolve("done"); }));
    const controller = new AbortController();
    const second = manager.run("a", "prompt", async () => "should not run", controller.signal);
    controller.abort();
    release();
    await first;
    await expect(second).rejects.toThrow();
  });
});
