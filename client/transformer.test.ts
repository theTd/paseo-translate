import { describe, expect, it } from "vitest";
import {
  translatedMessageDataSchema,
  translatedReasoningDataSchema,
  translatedUserMessageDataSchema,
} from "../shared/translate";
import {
  transformAssistantMessage,
  transformReasoningMessage,
  transformUserMessage,
} from "./transformer";

describe("translate assistant transformer", () => {
  it("passes the accumulated text through with the streaming phase", () => {
    const result = transformAssistantMessage({
      item: { text: "Guten Tag", messageId: "m-1" },
      phase: "streaming",
    });
    expect(result).not.toBeUndefined();
    if (result === undefined) return;
    const item = result.items[0];
    expect(item).toMatchObject({ type: "plugin", kind: "translated-message", version: 1 });
    expect(translatedMessageDataSchema.parse(item?.data)).toEqual({
      text: "Guten Tag",
      phase: "streaming",
      messageId: "m-1",
    });
  });

  it("marks committed messages complete and defaults a missing messageId to null", () => {
    const result = transformAssistantMessage({ item: { text: "Fertig." }, phase: "complete" });
    expect(result).not.toBeUndefined();
    expect(translatedMessageDataSchema.parse(result?.items[0].data)).toEqual({
      text: "Fertig.",
      phase: "complete",
      messageId: null,
    });
  });

  it("passes materialized provider images through for native host rendering", () => {
    const hash = "b".repeat(64);
    expect(
      transformAssistantMessage({
        item: { text: `![Image](file:///tmp/paseo-attachments/${hash}.png)` },
        phase: "complete",
      }),
    ).toBeUndefined();
  });
});

describe("translate reasoning transformer", () => {
  it("emits a separate kind with a null messageId", () => {
    const result = transformReasoningMessage({
      item: { text: "Der Nutzer will…" },
      phase: "complete",
    });
    const item = result.items[0];
    expect(item.type).toBe("plugin");
    expect(item.kind).toBe("translated-reasoning");
    expect(item.version).toBe(1);
    expect(translatedReasoningDataSchema.parse(item.data)).toEqual({
      text: "Der Nutzer will…",
      phase: "complete",
      messageId: null,
    });
  });

  it("passes the streaming phase through", () => {
    const result = transformReasoningMessage({ item: { text: "Hmm" }, phase: "streaming" });
    expect(translatedReasoningDataSchema.parse(result.items[0].data)).toEqual({
      text: "Hmm",
      phase: "streaming",
      messageId: null,
    });
  });
});

describe("translate user transformer", () => {
  it("passes the original prompt through with the complete phase", () => {
    const result = transformUserMessage({
      item: { text: "Hallo Welt", messageId: "u-1" },
      phase: "complete",
    });
    expect(result).not.toBeUndefined();
    expect(result?.items[0]).toMatchObject({
      type: "plugin",
      kind: "translated-user-message",
      version: 1,
    });
    expect(translatedUserMessageDataSchema.parse(result?.items[0]?.data)).toEqual({
      text: "Hallo Welt",
      phase: "complete",
      messageId: "u-1",
    });
  });

  it("defaults a missing messageId to null", () => {
    const result = transformUserMessage({ item: { text: "/model switch engines" }, phase: "streaming" });
    expect(translatedUserMessageDataSchema.parse(result?.items[0]?.data)).toEqual({
      text: "/model switch engines",
      phase: "streaming",
      messageId: null,
    });
  });

  it("leaves blanks, attachments, and arg-less commands on the host renderer", () => {
    expect(transformUserMessage({ item: { text: "   " }, phase: "complete" })).toBeUndefined();
    expect(transformUserMessage({ item: { text: "/compact" }, phase: "complete" })).toBeUndefined();
    expect(
      transformUserMessage({
        item: { text: JSON.stringify({ type: "x", mimeType: "text/plain" }) },
        phase: "complete",
      }),
    ).toBeUndefined();
  });

  it("passes materialized provider images through for native host rendering", () => {
    const hash = "b".repeat(64);
    expect(
      transformUserMessage({
        item: { text: `![Image](file:///tmp/paseo-attachments/${hash}.png)` },
        phase: "complete",
      }),
    ).toBeUndefined();
  });

  it("keeps data-URI image-only prompts on the host renderer instead of plain text", () => {
    expect(
      transformUserMessage({
        item: { text: `![Image](data:image/png;base64,${"A".repeat(64)})` },
        phase: "complete",
      }),
    ).toBeUndefined();
  });
});
