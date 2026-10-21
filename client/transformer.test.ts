import { describe, expect, it } from "vitest";
import { NOTIFICATION_PREVIEW_PREFIX } from "../shared/notification-preview";
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
  it("hides notification previews without translating or displaying them again", () => {
    expect(transformAssistantMessage({ item: { text: "Translated preview",
      messageId: `${NOTIFICATION_PREVIEW_PREFIX}turn` }, phase: "complete" })).toEqual({ items: [] });
  });
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

  it("keeps any message with an image on the host renderer", () => {
    expect(
      transformAssistantMessage({
        item: { text: "Done.\n\n![shot](https://example.com/a.png)" },
        phase: "complete",
      }),
    ).toBeUndefined();
  });

  it.each(["streaming", "complete"] as const)(
    "keeps final summaries with file references eligible for translation (%s)",
    (phase) => {
      const text = "Changed `src/app.ts:12` and [the handler](src/server/handler.ts)";
      const result = transformAssistantMessage({ item: { text, messageId: "final-1" }, phase });
      expect(result?.items[0]).toMatchObject({ type: "plugin", kind: "translated-message" });
      expect(translatedMessageDataSchema.parse(result?.items[0].data)).toEqual({
        text,
        phase,
        messageId: "final-1",
      });
    },
  );

  it("translates summaries with bare filenames and relative targets", () => {
    expect(
      transformAssistantMessage({ item: { text: "Changed `package.json`" }, phase: "complete" }),
    ).not.toBeUndefined();
    // The host does not resolve a `.diff` target, so the translated row keeps
    // it and the message keeps its translation.
    expect(
      transformAssistantMessage({ item: { text: "See [the diff](changes.diff)" }, phase: "complete" }),
    ).not.toBeUndefined();
  });

  it("does not stop translating when a file reference arrives in the last chunk", () => {
    for (const text of ["Fixed the bug.", "Fixed the bug in `src/app.ts`."]) {
      expect(transformAssistantMessage({ item: { text }, phase: "streaming" })?.items[0])
        .toMatchObject({ kind: "translated-message", data: { text, phase: "streaming" } });
    }
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
