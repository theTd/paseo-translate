import { describe, expect, it } from "vitest";
import { isSerializedAttachment, promptTranslationParts } from "./prompt-text";

describe("promptTranslationParts", () => {
  it("splits a plain fragment as a body with no prefix", () => {
    expect(promptTranslationParts("Hello")).toEqual({ prefix: "", body: "Hello" });
  });

  it("keeps only the remainder of slash commands", () => {
    expect(promptTranslationParts("/model switch engines")).toEqual({
      prefix: "/model ",
      body: "switch engines",
    });
  });

  it("returns null for blanks, attachments, and arg-less commands", () => {
    const attachment = JSON.stringify({ type: "x", mimeType: "text/plain" });
    expect(promptTranslationParts("   ")).toBeNull();
    expect(promptTranslationParts("")).toBeNull();
    expect(promptTranslationParts(attachment)).toBeNull();
    expect(promptTranslationParts("/compact")).toBeNull();
    expect(promptTranslationParts("/compact   ")).toBeNull();
  });
});

describe("isSerializedAttachment", () => {
  it("requires a mimeType string on a JSON object", () => {
    expect(isSerializedAttachment(JSON.stringify({ mimeType: "text/plain" }))).toBe(true);
    expect(isSerializedAttachment(JSON.stringify({ type: "x" }))).toBe(false);
    expect(isSerializedAttachment("not json")).toBe(false);
    expect(isSerializedAttachment("[1]")).toBe(false);
  });
});
