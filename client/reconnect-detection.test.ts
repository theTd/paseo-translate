import { describe, expect, it } from "vitest";
import { hasNewlyOnlineHost, isReturnToForeground, onlineHostIds } from "./reconnect-detection";

describe("onlineHostIds", () => {
  it("keeps only online hosts", () => {
    const ids = onlineHostIds([
      { serverId: "a", status: "online" },
      { serverId: "b", status: "connecting" },
      { serverId: "c", status: "offline" },
      { serverId: "d", status: "online" },
    ]);
    expect([...ids].sort()).toEqual(["a", "d"]);
  });
});

describe("hasNewlyOnlineHost", () => {
  it("fires when a host goes from not-online to online", () => {
    expect(hasNewlyOnlineHost(new Set(), new Set(["a"]))).toBe(true);
    expect(hasNewlyOnlineHost(new Set(["a"]), new Set(["a", "b"]))).toBe(true);
  });

  it("stays quiet when nothing new came online", () => {
    expect(hasNewlyOnlineHost(new Set(["a"]), new Set(["a"]))).toBe(false);
    expect(hasNewlyOnlineHost(new Set(["a", "b"]), new Set(["a"]))).toBe(false);
    expect(hasNewlyOnlineHost(new Set(), new Set())).toBe(false);
  });
});

describe("isReturnToForeground", () => {
  it("fires on a transition into active", () => {
    expect(isReturnToForeground("background", "active")).toBe(true);
    expect(isReturnToForeground("inactive", "active")).toBe(true);
    expect(isReturnToForeground(null, "active")).toBe(true);
  });

  it("stays quiet otherwise", () => {
    expect(isReturnToForeground("active", "active")).toBe(false);
    expect(isReturnToForeground("active", "background")).toBe(false);
  });
});
