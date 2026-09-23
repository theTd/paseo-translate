import { describe, expect, it } from "vitest";
import {
  DISPLAY_BUSY_RETRY_BASE_MS,
  DISPLAY_DEFAULT_ENDPOINT_TIMEOUT_MS,
  DISPLAY_RETRY_BASE_MS,
  DISPLAY_STREAM_IDLE_MARGIN_MS,
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
