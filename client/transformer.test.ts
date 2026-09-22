import { describe, expect, it } from "vitest";
import { translatedMessageDataSchema } from "../shared/translate";
import { transformAssistantMessage } from "./transformer";

describe("translate assistant transformer", () => {
  it("passes the accumulated text through with the streaming phase", () => {
    const result = transformAssistantMessage({
      item: { text: "Guten Tag", messageId: "m-1" },
      phase: "streaming",
    });
    const item = result.items[0];
    expect(item.type).toBe("plugin");
    expect(item.kind).toBe("translated-message");
    expect(item.version).toBe(1);
    expect(translatedMessageDataSchema.parse(item.data)).toEqual({
      text: "Guten Tag",
      phase: "streaming",
      messageId: "m-1",
    });
  });

  it("marks committed messages complete and defaults a missing messageId to null", () => {
    const result = transformAssistantMessage({ item: { text: "Fertig." }, phase: "complete" });
    expect(translatedMessageDataSchema.parse(result.items[0].data)).toEqual({
      text: "Fertig.",
      phase: "complete",
      messageId: null,
    });
  });
});
