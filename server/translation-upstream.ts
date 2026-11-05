/**
 * Process-wide concurrency gate for translation endpoint calls.
 *
 * Display jobs are opened eagerly: a reopened long session, several clients
 * and a remounting timeline each start a translation, and the prompt path
 * starts another on every send. Without a bound the endpoint sees an
 * unbounded burst, returns 429s, and the one translation a user is actually
 * waiting for — the prompt — queues behind display work on the provider side.
 * A small cap keeps the endpoint's per-key limit usable; the prompt path
 * waits in a priority lane so a display backlog cannot starve it.
 *
 * Only the actual endpoint request runs inside a slot: cache hits and
 * in-flight joins never reach this gate.
 */

import { TRANSLATION_BUSY_MESSAGE } from "../shared/translation-retry";
import { LlmRequestCanceledError } from "./llm-client";

/**
 * Endpoint calls allowed at once. Deliberately small: six requests keep a
 * typical OpenAI-compatible endpoint under its per-key concurrency without
 * queueing us server-side, and leave the prompt path a slot to jump into.
 */
export const MAX_CONCURRENT_UPSTREAM = 6;
/**
 * Waiters allowed behind those slots. Past this the backlog is no longer a
 * working set but a client pile-up; rejecting with the client's existing
 * `busy` error lets the renderer back off instead of growing the queue.
 */
export const MAX_QUEUED_UPSTREAM = 64;
/**
 * Extra slots only agent-bound prompt work may use. Display streams can hold a
 * slot for minutes (their timeout bounds gaps, not the whole stream), so a
 * queue jump alone would still leave a prompt waiting behind six of them while
 * the agent turn stalls.
 */
export const PRIORITY_UPSTREAM_HEADROOM = 2;

export interface UpstreamGateOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  priorityHeadroom?: number;
}

export interface UpstreamWaitOptions {
  /** Releases the waiter while it runs or waits; aborting a queued call is free. */
  signal?: AbortSignal;
  /** Agent-bound prompt work: jumps ahead of queued display jobs. */
  priority?: boolean;
}

export interface UpstreamGateStats {
  /** Index signature so the memory probe can render this as `upstream.key=value`. */
  [key: string]: number;
  /** Endpoint calls currently running. */
  active: number;
  /** Calls waiting for a slot (both lanes). */
  queued: number;
  /** The agent-bound subset of `queued`. */
  priorityQueued: number;
}

export interface UpstreamGate {
  /**
   * Runs `task` in a slot, waiting first when every slot is busy. A queued
   * waiter that aborts never starts and releases nothing.
   */
  run<T>(task: () => Promise<T>, options?: UpstreamWaitOptions): Promise<T>;
  /** Queue occupancy, read by the memory probe. */
  stats(): UpstreamGateStats;
}

interface QueueEntry {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  priority: boolean;
  queued: boolean;
  onAbort?: () => void;
}

export function createUpstreamGate(options: UpstreamGateOptions = {}): UpstreamGate {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? MAX_CONCURRENT_UPSTREAM);
  const maxQueued = Math.max(0, options.maxQueued ?? MAX_QUEUED_UPSTREAM);
  const priorityLimit = maxConcurrent + Math.max(0, options.priorityHeadroom ?? PRIORITY_UPSTREAM_HEADROOM);
  const priorityQueue: QueueEntry[] = [];
  const displayQueue: QueueEntry[] = [];
  let active = 0;

  function queuedCount(): number {
    return priorityQueue.length + displayQueue.length;
  }

  function queueFor(entry: QueueEntry): QueueEntry[] {
    return entry.priority ? priorityQueue : displayQueue;
  }

  function dequeue(entry: QueueEntry): void {
    const queue = queueFor(entry);
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  }

  function detach(entry: QueueEntry): void {
    if (entry.onAbort !== undefined) {
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.onAbort = undefined;
    }
  }

  function start(entry: QueueEntry): void {
    entry.queued = false;
    detach(entry);
    active += 1;
    void (async () => {
      try {
        entry.resolve(await entry.task());
      } catch (error) {
        entry.reject(error);
      } finally {
        active -= 1;
        drain();
      }
    })();
  }

  function limitFor(priority: boolean): number {
    return priority ? priorityLimit : maxConcurrent;
  }

  function drain(): void {
    while (active < priorityLimit && priorityQueue.length > 0) {
      start(priorityQueue.shift() as QueueEntry);
    }
    while (active < maxConcurrent && displayQueue.length > 0) {
      start(displayQueue.shift() as QueueEntry);
    }
  }

  return {
    run<T>(task: () => Promise<T>, waitOptions?: UpstreamWaitOptions): Promise<T> {
      const signal = waitOptions?.signal;
      if (signal?.aborted) return Promise.reject(new LlmRequestCanceledError());
      return new Promise<T>((resolve, reject) => {
        const entry: QueueEntry = {
          task,
          resolve: (value) => resolve(value as T),
          reject,
          signal,
          priority: waitOptions?.priority === true,
          queued: true,
        };
        if (active < limitFor(entry.priority)) {
          start(entry);
          return;
        }
        // The prompt path fails closed, so a busy refusal there would fail the
        // user's send; only display work is turned away.
        if (!entry.priority && displayQueue.length >= maxQueued) {
          reject(new Error(TRANSLATION_BUSY_MESSAGE));
          return;
        }
        queueFor(entry).push(entry);
        const onAbort = () => {
          if (!entry.queued) return;
          entry.queued = false;
          dequeue(entry);
          detach(entry);
          reject(new LlmRequestCanceledError());
        };
        entry.onAbort = onAbort;
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    stats() {
      return {
        active,
        queued: queuedCount(),
        priorityQueued: priorityQueue.length,
      };
    },
  };
}
