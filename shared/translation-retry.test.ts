import { describe, expect, it } from "vitest";
import {
  DISPLAY_BUSY_RETRY_BASE_MS,
  DISPLAY_DEFAULT_ENDPOINT_TIMEOUT_MS,
  DISPLAY_RETRY_BASE_MS,
  DISPLAY_STREAM_IDLE_MARGIN_MS,
  DISPLAY_STREAM_BUSY_SETTLE_MAX_MS,
  DISPLAY_STREAM_BUSY_SETTLE_MIN_MS,
  DISPLAY_STREAM_SETTLE_MS,
  displaySettleQuietMs,
  displayStreamIdleTimeoutMs,
  DISPLAY_RETRY_CAP_MS,
  TRANSLATION_BUSY_MESSAGE,
  classifyTranslationError,
  retryDelayMs,
} from "./translation-retry";

describe("retryDelayMs", () => {
  it("doubles per attempt and clamps to the cap", () => {
    expect(retryDelayMs(1, DISPLAY_RETRY_BASE_MS, DISPLAY_RETRY_CAP_MS)).toBe(500);
    expect(retryDelayMs(2, DISPLAY_RETRY_BASE_MS, DISPLAY_RETRY_CAP_MS)).toBe(1000);
    expect(retryDelayMs(3, DISPLAY_RETRY_BASE_MS, DISPLAY_RETRY_CAP_MS)).toBe(2000);
    expect(retryDelayMs(10, DISPLAY_RETRY_BASE_MS, DISPLAY_RETRY_CAP_MS)).toBe(2000);
  });

  it("clamps non-positive attempts to the first step", () => {
    expect(retryDelayMs(0, DISPLAY_RETRY_BASE_MS, DISPLAY_RETRY_CAP_MS)).toBe(500);
    expect(retryDelayMs(-3, DISPLAY_RETRY_BASE_MS, DISPLAY_RETRY_CAP_MS)).toBe(500);
  });

  it("keeps busy backoff longer than the default backoff", () => {
    expect(DISPLAY_BUSY_RETRY_BASE_MS).toBeGreaterThan(DISPLAY_RETRY_BASE_MS);
    expect(retryDelayMs(1, DISPLAY_BUSY_RETRY_BASE_MS, DISPLAY_RETRY_CAP_MS)).toBe(2000);
  });
});

describe("displayStreamIdleTimeoutMs", () => {
  it("covers the server's silent worst case (stream timeout + completion timeout) plus margin", () => {
    expect(displayStreamIdleTimeoutMs(30_000)).toBe(2 * 30_000 + DISPLAY_STREAM_IDLE_MARGIN_MS);
    expect(displayStreamIdleTimeoutMs(600_000)).toBe(2 * 600_000 + DISPLAY_STREAM_IDLE_MARGIN_MS);
  });

  it("falls back to the default endpoint timeout for missing or invalid values", () => {
    const fallback = 2 * DISPLAY_DEFAULT_ENDPOINT_TIMEOUT_MS + DISPLAY_STREAM_IDLE_MARGIN_MS;
    expect(displayStreamIdleTimeoutMs(undefined)).toBe(fallback);
    expect(displayStreamIdleTimeoutMs(Number.NaN)).toBe(fallback);
    expect(displayStreamIdleTimeoutMs(0)).toBe(fallback);
  });
});

describe("DISPLAY_STREAM_SETTLE_MS", () => {
  it("is longer than the host's 60ms stream-coalesce window so an active token stream keeps resetting", () => {
    expect(DISPLAY_STREAM_SETTLE_MS).toBeGreaterThan(60);
  });
});

describe("displaySettleQuietMs", () => {
  it("uses the short window once the agent is known idle", () => {
    expect(displaySettleQuietMs({ agentIsBusy: false, longestGapMs: 5_000 })).toBe(DISPLAY_STREAM_SETTLE_MS);
  });

  it("waits long enough mid-turn that ordinary stream pauses never start a billed job", () => {
    for (const agentIsBusy of [true, null]) {
      expect(displaySettleQuietMs({ agentIsBusy, longestGapMs: 0 })).toBe(DISPLAY_STREAM_BUSY_SETTLE_MIN_MS);
      // The old 800ms gate fired on any 1s pause of a slow gateway.
      expect(displaySettleQuietMs({ agentIsBusy, longestGapMs: 1_000 })).toBeGreaterThan(1_000 * 3);
    }
  });

  it("stretches with the slowest pause seen in the item, up to a cap", () => {
    expect(displaySettleQuietMs({ agentIsBusy: true, longestGapMs: 3_000 })).toBe(12_000);
    expect(displaySettleQuietMs({ agentIsBusy: true, longestGapMs: 60_000 })).toBe(DISPLAY_STREAM_BUSY_SETTLE_MAX_MS);
    expect(displaySettleQuietMs({ agentIsBusy: true, longestGapMs: Number.NaN })).toBe(DISPLAY_STREAM_BUSY_SETTLE_MIN_MS);
  });
});

describe("classifyTranslationError", () => {
  it("treats server busy refusals as busy", () => {
    expect(classifyTranslationError(new Error(TRANSLATION_BUSY_MESSAGE))).toBe("busy");
  });

  it("treats oversized-text refusals as fatal", () => {
    expect(classifyTranslationError(new Error("Refusing to translate 123456 characters (limit 100000)"))).toBe(
      "fatal",
    );
  });

  it("treats unconfigured-endpoint errors as fatal", () => {
    expect(
      classifyTranslationError(new Error("Translate plugin settings are invalid: boom")),
    ).toBe("fatal");
    expect(classifyTranslationError(new Error("Translate plugin is not configured yet"))).toBe(
      "fatal",
    );
  });

  it("treats transport, timeout, and protocol errors as retryable", () => {
    expect(classifyTranslationError(new Error("Unknown translation job"))).toBe("retryable");
    expect(classifyTranslationError(new Error("Translation endpoint returned HTTP 500: x"))).toBe(
      "retryable",
    );
    expect(classifyTranslationError(new Error("Translation endpoint request failed"))).toBe(
      "retryable",
    );
    expect(classifyTranslationError("plain string failure")).toBe("retryable");
  });
});
