import { useEffect, useState } from "react";
import { DISPLAY_STREAM_SETTLE_MS } from "../shared/translation-retry";

/**
 * Maps the plugin agent snapshot's lifecycle onto the shared settled-gate's
 * `agentIsBusy` flag. `null` means the snapshot is not loaded yet, so the
 * gate stays conservative (a live-head item does not settle on status).
 */
export function agentIsBusyForDisplay(
  status: "initializing" | "idle" | "running" | "error" | "closed" | null,
): boolean | null {
  if (status === null) return null;
  return status === "running" || status === "initializing";
}

/**
 * True once this live-head item's text has been unchanged for
 * `DISPLAY_STREAM_SETTLE_MS`, or immediately when `phase` is `complete`.
 * Compared against the current `text` so a new token makes the flag false
 * on the same render, instead of one stale frame of "idle".
 */
export function useStreamIdle(
  text: string,
  phase: "streaming" | "complete",
  delayMs: number = DISPLAY_STREAM_SETTLE_MS,
): boolean {
  const [idleFor, setIdleFor] = useState<string | null>(phase === "complete" ? text : null);
  useEffect(() => {
    if (phase === "complete") {
      setIdleFor(text);
      return;
    }
    const timer = setTimeout(() => setIdleFor(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, phase, delayMs]);
  return phase === "complete" || idleFor === text;
}
