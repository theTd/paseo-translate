import { describe, expect, it } from "vitest";
import { agentIsBusyForDisplay, observeStreamText } from "./display-translation-settle";

describe("agentIsBusyForDisplay", () => {
  it("stays unknown until the agent snapshot is loaded", () => {
    expect(agentIsBusyForDisplay(null)).toBeNull();
  });

  it("treats an in-flight agent as busy so live-head items do not settle on status", () => {
    expect(agentIsBusyForDisplay("running")).toBe(true);
    expect(agentIsBusyForDisplay("initializing")).toBe(true);
  });

  it("treats a finished agent as not busy so the last live-head item can settle", () => {
    expect(agentIsBusyForDisplay("idle")).toBe(false);
    expect(agentIsBusyForDisplay("error")).toBe(false);
    expect(agentIsBusyForDisplay("closed")).toBe(false);
  });
});

describe("observeStreamText", () => {
  it("records when the text last changed and the longest pause between changes", () => {
    let state = { text: "a", changedAt: 1_000, longestGapMs: 0 };
    state = observeStreamText(state, "ab", 1_200);
    expect(state).toEqual({ text: "ab", changedAt: 1_200, longestGapMs: 200 });
    state = observeStreamText(state, "abc", 4_200);
    expect(state.longestGapMs).toBe(3_000);
    state = observeStreamText(state, "abcd", 4_300);
    expect(state).toEqual({ text: "abcd", changedAt: 4_300, longestGapMs: 3_000 });
  });

  it("keeps the state when the text did not change (re-renders are not pauses)", () => {
    const state = { text: "same", changedAt: 1_000, longestGapMs: 50 };
    expect(observeStreamText(state, "same", 9_000)).toBe(state);
  });
});
