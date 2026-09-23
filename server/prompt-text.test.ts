import { describe, expect, it, vi } from "vitest";
import { restorePromptFragment, translatePromptFragment } from "./prompt-text";

describe("restorePromptFragment", () => {
  it("restores a plain fragment on a hit and keeps it on a miss", () => {
    expect(restorePromptFragment("DE(Hallo)", (fragment) => (fragment === "DE(Hallo)" ? "Hello" : undefined))).toBe(
      "Hello",
    );
    expect(restorePromptFragment("DE(Hallo)", () => undefined)).toBe("DE(Hallo)");
  });

  it("restores only the remainder of slash commands", () => {
    const lookup = vi.fn((fragment: string) =>
      fragment === "DE(args here)" ? "args here" : undefined,
    );
    expect(restorePromptFragment("/model DE(args here)", lookup)).toBe("/model args here");
    expect(lookup).toHaveBeenCalledWith("DE(args here)");
    // A missed remainder keeps the whole translated block for the caller to
    // back-translate or keep as-is.
    expect(restorePromptFragment("/model DE(neu)", () => undefined)).toBe("/model DE(neu)");
  });

  it("passes attachments, blanks, and arg-less commands through without consulting the lookup", () => {
    const attachment = JSON.stringify({ type: "x", mimeType: "text/plain" });
    const lookup = vi.fn((): string | undefined => "SHOULD NOT HAPPEN");
    expect(restorePromptFragment(attachment, lookup)).toBe(attachment);
    expect(restorePromptFragment("   ", lookup)).toBe("   ");
    expect(restorePromptFragment("/compact", lookup)).toBe("/compact");
    expect(restorePromptFragment("/compact   ", lookup)).toBe("/compact   ");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("round-trips with translatePromptFragment", async () => {
    const forward = new Map([
      ["Hello", "DE(Hello)"],
      ["world", "DE(world)"],
    ]);
    const original = "/model Hello";
    const translated = await translatePromptFragment(
      original,
      async (text) => forward.get(text) ?? `DE(${text})`,
    );
    expect(translated).toBe("/model DE(Hello)");
    const reverse = new Map([...forward].map(([originalText, translatedText]) => [translatedText, originalText]));
    expect(restorePromptFragment(translated, (text) => reverse.get(text))).toBe(original);
  });
});
