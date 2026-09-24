import { describe, expect, it } from "vitest";
import { agentIsBusyForDisplay } from "./display-translation-settle";

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
