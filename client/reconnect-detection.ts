/**
 * Pure transition checks behind the reconnect signal (see
 * use-reconnect-epoch.ts). Kept free of React and SDK imports so they are
 * unit testable; the hook only feeds them live host and app states.
 */

export interface HostStatusSnapshot {
  readonly serverId: string;
  readonly status: string;
}

/** Ids of the hosts that are currently online. */
export function onlineHostIds(hosts: readonly HostStatusSnapshot[]): ReadonlySet<string> {
  const online = new Set<string>();
  for (const host of hosts) {
    if (host.status === "online") online.add(host.serverId);
  }
  return online;
}

/**
 * True when some host is online now but was not before: a reconnect after
 * the connection dropped, or a host finishing its first connect.
 */
export function hasNewlyOnlineHost(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): boolean {
  for (const serverId of next) {
    if (!previous.has(serverId)) return true;
  }
  return false;
}

/** True when the app comes back to the foreground from any other state. */
export function isReturnToForeground(previous: string | null, next: string): boolean {
  return next === "active" && previous !== "active";
}
