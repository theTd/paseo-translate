import { useEffect, useRef, useState } from "react";
import { displaySettleQuietMs } from "../shared/translation-retry";

/**
 * Maps the plugin agent snapshot's lifecycle onto the quiet-window policy's
 * `agentIsBusy` flag. `null` means the snapshot is not loaded yet, so the
 * policy stays conservative (the long, adaptive window).
 */
export function agentIsBusyForDisplay(
  status: "initializing" | "idle" | "running" | "error" | "closed" | null,
): boolean | null {
  if (status === null) return null;
  return status === "running" || status === "initializing";
}

/**
 * Pause tracking for one live item: when its text last changed and the
 * longest pause between two changes so far. Pure so the bookkeeping is
 * unit-testable without React.
 */
export interface StreamPauseState {
  text: string;
  changedAt: number;
  longestGapMs: number;
}

export function observeStreamText(
  state: StreamPauseState,
  text: string,
  now: number,
): StreamPauseState {
  if (state.text === text) return state;
  return {
    text,
    changedAt: now,
    longestGapMs: Math.max(state.longestGapMs, Math.max(0, now - state.changedAt)),
  };
}

/**
 * True once this live-head item's text has stayed unchanged for the
 * window from `displaySettleQuietMs`, or immediately when `phase` is
 * `complete`. Compared against the current `text` so a new token makes the
 * flag false on the same render instead of one stale frame of "quiet".
 */
export function useDisplayQuiet(
  text: string,
  phase: "streaming" | "complete",
  agentIsBusy: boolean | null,
): boolean {
  const pauses = useRef<StreamPauseState | null>(null);
  const [quietFor, setQuietFor] = useState<string | null>(phase === "complete" ? text : null);
  useEffect(() => {
    const now = Date.now();
    pauses.current =
      pauses.current === null
        ? { text, changedAt: now, longestGapMs: 0 }
        : observeStreamText(pauses.current, text, now);
    if (phase === "complete") {
      setQuietFor(text);
      return;
    }
    const state = pauses.current;
    const windowMs = displaySettleQuietMs({ agentIsBusy, longestGapMs: state.longestGapMs });
    const remaining = Math.max(0, state.changedAt + windowMs - now);
    const timer = setTimeout(() => setQuietFor(text), remaining);
    return () => clearTimeout(timer);
  }, [text, phase, agentIsBusy]);
  return phase === "complete" || quietFor === text;
}
