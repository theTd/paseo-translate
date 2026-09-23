import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useHosts } from "@getpaseo/plugin/client";
import { hasNewlyOnlineHost, isReturnToForeground, onlineHostIds } from "./reconnect-detection";

/**
 * Counter that goes up each time translation RPCs are likely to work again
 * after an outage: a host comes back online, or the app returns to the
 * foreground. Starts at 0 and never fires on mount.
 *
 * Both signals are needed. Coming back to the foreground is the earliest
 * sign of a return from AFK, but the connection may still be down then; a
 * host turning online is the reliable sign the RPC channel is back.
 * `useHosts` is supplied by the app's plugin runtime, not the SDK's
 * index.js.
 */
export function useReconnectEpoch(): number {
  const hosts = useHosts();
  const [epoch, setEpoch] = useState(0);
  const previousOnline = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    const online = onlineHostIds(hosts);
    if (previousOnline.current !== null && hasNewlyOnlineHost(previousOnline.current, online)) {
      setEpoch((value) => value + 1);
    }
    previousOnline.current = online;
  }, [hosts]);

  useEffect(() => {
    let previousState: AppStateStatus | null = AppState.currentState;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (isReturnToForeground(previousState, nextState)) {
        setEpoch((value) => value + 1);
      }
      previousState = nextState;
    });
    return () => subscription.remove();
  }, []);

  return epoch;
}
