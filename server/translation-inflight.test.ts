import { describe, expect, it } from "vitest";
import { isTranslationCanceled } from "./llm-client";
import { createTranslationInflightRegistry, type InflightProducerContext } from "./translation-inflight";

function controllable() {
  let context!: InflightProducerContext;
  let resolve!: (text: string) => void;
  let reject!: (error: unknown) => void;
  const produce = (ctx: InflightProducerContext) => {
    context = ctx;
    return new Promise<string>((done, fail) => {
      resolve = done;
      reject = fail;
    });
  };
  return {
    produce,
    get context() {
      return context;
    },
    resolve: (text: string) => resolve(text),
    reject: (error: unknown) => reject(error),
  };
}

describe("translation in-flight registry", () => {
  it("lets later callers join the running translation and replays progress", async () => {
    const registry = createTranslationInflightRegistry();
    const job = controllable();
    const first = registry.start("k", job.produce);
    expect(registry.has("k")).toBe(true);
    job.context.progress("Hal");
    const seen: string[] = [];
    const second = registry.join("k", { onProgress: (text) => seen.push(text) });
    expect(second).toBeDefined();
    job.context.progress("Hallo");
    job.resolve("Hallo Welt");
    await expect(first).resolves.toBe("Hallo Welt");
    await expect(second).resolves.toBe("Hallo Welt");
    // The joiner first receives what had already streamed, then updates.
    expect(seen).toEqual(["Hal", "Hallo"]);
    expect(registry.has("k")).toBe(false);
    expect(registry.join("k")).toBeUndefined();
  });

  it("aborts the upstream only when the last cancellable waiter leaves", async () => {
    const registry = createTranslationInflightRegistry();
    const job = controllable();
    const a = new AbortController();
    const b = new AbortController();
    const first = registry.start("k", job.produce, { signal: a.signal });
    const second = registry.join("k", { signal: b.signal }) as Promise<string>;
    a.abort();
    await expect(first).rejects.toSatisfy(isTranslationCanceled);
    expect(job.context.signal.aborted).toBe(false);
    b.abort();
    await expect(second).rejects.toSatisfy(isTranslationCanceled);
    expect(job.context.signal.aborted).toBe(true);
    // The aborted entry is gone at once: the next request starts fresh.
    expect(registry.has("k")).toBe(false);
  });

  it("never aborts a translation that a non-cancellable waiter depends on", async () => {
    const registry = createTranslationInflightRegistry();
    const job = controllable();
    const display = new AbortController();
    const shown = registry.start("k", job.produce, { signal: display.signal });
    const prompt = registry.join("k") as Promise<string>;
    display.abort();
    await expect(shown).rejects.toSatisfy(isTranslationCanceled);
    expect(job.context.signal.aborted).toBe(false);
    job.resolve("Hallo");
    await expect(prompt).resolves.toBe("Hallo");
  });

  it("propagates failures to every waiter", async () => {
    const registry = createTranslationInflightRegistry();
    const job = controllable();
    const first = registry.start("k", job.produce);
    const second = registry.join("k") as Promise<string>;
    job.reject(new Error("HTTP 500"));
    await expect(first).rejects.toThrow("HTTP 500");
    await expect(second).rejects.toThrow("HTTP 500");
    expect(registry.has("k")).toBe(false);
  });

  it("rejects an already-aborted waiter without joining", async () => {
    const registry = createTranslationInflightRegistry();
    const job = controllable();
    const first = registry.start("k", job.produce);
    const aborted = new AbortController();
    aborted.abort();
    await expect(registry.join("k", { signal: aborted.signal })).rejects.toSatisfy(isTranslationCanceled);
    job.resolve("ok");
    await expect(first).resolves.toBe("ok");
  });

  it("never starts the upstream for an already-aborted first waiter", async () => {
    const registry = createTranslationInflightRegistry();
    const aborted = new AbortController();
    aborted.abort();
    let produced = false;
    const produce = async () => {
      produced = true;
      return "unused";
    };
    await expect(registry.start("k", produce, { signal: aborted.signal })).rejects.toSatisfy(
      isTranslationCanceled,
    );
    expect(produced).toBe(false);
    expect(registry.has("k")).toBe(false);
  });

  it("refuses to start a key twice", () => {
    const registry = createTranslationInflightRegistry();
    registry.start("k", controllable().produce).catch(() => undefined);
    expect(() => registry.start("k", controllable().produce)).toThrow("already in flight");
  });
});
