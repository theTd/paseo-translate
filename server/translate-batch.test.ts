import { describe, expect, it } from "vitest";
import {
  translationItemClose,
  translationItemOpen,
  unwrapTranslationInput,
} from "../shared/translate";
import {
  packTranslationBatches,
  parseTranslationBatch,
  pickBatchNonce,
  wrapTranslationBatch,
} from "./translate-batch";

describe("translation batch packing", () => {
  it("keeps a short list in one pack", () => {
    expect(packTranslationBatches(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("splits on item count", () => {
    expect(packTranslationBatches(["a", "b", "c", "d"], { maxItems: 2 })).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("splits on character budget without isolating a text that already exceeds it", () => {
    expect(packTranslationBatches(["aa", "b", "ccc"], { maxChars: 3 })).toEqual([
      ["aa", "b"],
      ["ccc"],
    ]);
    expect(packTranslationBatches(["abcd"], { maxChars: 3 })).toEqual([["abcd"]]);
  });
});

describe("translation batch wrap/parse", () => {
  it("round-trips several texts including ones that contain </ti>", () => {
    const texts = ["Hello", "a </ti> trap\nnext", "already in target"];
    const nonce = pickBatchNonce(texts);
    for (const text of texts) expect(text.includes(nonce)).toBe(false);
    const wrapped = wrapTranslationBatch(texts, nonce);
    const inner = unwrapTranslationInput(wrapped);
    expect(inner).toContain(translationItemOpen(nonce, 0));
    expect(inner).toContain(translationItemClose(nonce, 2));
    expect(parseTranslationBatch(inner, texts.length, nonce)).toEqual(texts);
  });

  it("ignores prose around the tagged items", () => {
    const nonce = "abc123";
    const output = [
      "Sure, here you go:",
      translationItemOpen(nonce, 0),
      "Hallo",
      translationItemClose(nonce, 0),
      translationItemOpen(nonce, 1),
      "Welt",
      translationItemClose(nonce, 1),
      "Done.",
    ].join("\n");
    expect(parseTranslationBatch(output, 2, nonce)).toEqual(["Hallo", "Welt"]);
  });

  it("rejects missing, empty, or out-of-order items", () => {
    const nonce = "abc123";
    const one = `${translationItemOpen(nonce, 0)}\nHallo\n${translationItemClose(nonce, 0)}`;
    expect(parseTranslationBatch(one, 2, nonce)).toBeNull();
    const empty = `${translationItemOpen(nonce, 0)}\n   \n${translationItemClose(nonce, 0)}`;
    expect(parseTranslationBatch(empty, 1, nonce)).toBeNull();
    const swapped = [
      `${translationItemOpen(nonce, 1)}\nWelt\n${translationItemClose(nonce, 1)}`,
      `${translationItemOpen(nonce, 0)}\nHallo\n${translationItemClose(nonce, 0)}`,
    ].join("\n");
    expect(parseTranslationBatch(swapped, 2, nonce)).toBeNull();
  });

  it("picks a nonce that does not appear in any source text", () => {
    const texts = ["keep-out"];
    const nonce = pickBatchNonce(texts);
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect(nonce.includes("-")).toBe(false);
  });
});
