import { completeStreamFirst, createLlmClient, type ChatMessage } from "./llm-client";
import type { TranslationCacheStore } from "./translation-cache-store";
import {
  resolveLanguagePair,
  type TranslateDirection,
  type TranslateSettingsValues,
} from "../shared/translate";

/** One committed translation exchange: the wrapped source and its translation. */
export interface TranslationTurn {
  user: string;
  assistant: string;
}

/** Committed context for one translation request: shared memory + per-direction turns. */
export interface TranslationContextSnapshot {
  memory: string;
  turns: readonly TranslationTurn[];
}

export interface TranslationContextManagerDeps {
  loadConfig(): Promise<TranslateSettingsValues>;
  fetchFn?: typeof fetch;
  /**
   * Persistence for compacted terminology memories (keyed by scope), so a
   * daemon restart keeps the established conventions. The translation cache
   * store implementation doubles as this key-value store; absent means
   * memory-only (tests, unused paths).
   */
  memoryStore?: TranslationCacheStore;
  /** Clock override for tests. */
  now?: () => number;
  /** Sweep cadence; 0 disables the timer (tests drive sweep() manually). */
  sweepIntervalMs?: number;
}

interface ScopeState {
  memory: string;
  turns: Record<TranslateDirection, TranslationTurn[]>;
  /** Sum of kept turn text lengths across both directions. */
  chars: number;
  /** Last translation activity (record or cache-hit touch); compaction requires idleness past this. */
  lastActivityAt: number;
  /**
   * Whether the transcript changed since the last successful compaction.
   * Without it an idle scope whose kept turns still exceed the threshold
   * would be re-compacted on every sweep, drifting the memory each minute.
   */
  dirty: boolean;
  compacting: boolean;
}

/** Turns kept per direction after a compaction. */
const CONTEXT_KEEP_TURNS = 6;
/** Defensive bound on one compacted memory. */
const CONTEXT_MEMORY_LIMIT = 20_000;
/** Upper bound on the serialized history sent to the compaction call. */
const COMPACTION_INPUT_LIMIT = 200_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/**
 * Floor for the in-memory scope eviction horizon: a scope idle this long
 * (or past the configured idle minutes, whichever is later) is dropped from
 * the map. Its durable essence — the compacted memory — is already
 * persisted, so the daemon's RAM does not grow with every session ever seen;
 * the un-distilled kept turns of a day-old idle scope are the accepted loss.
 */
const SCOPE_EVICT_MIN_IDLE_MS = 24 * 60 * 60 * 1000;

/** Memory-store key prefix; exported for tests that seed persisted memories. */
export const CONTEXT_MEMORY_KEY_PREFIX = "context-memory:v1:";

/**
 * Per-session translation transcripts. Each scope (agent session) accumulates
 * the translation pairs it produced, split by direction, plus one compacted
 * terminology memory shared by both directions of that session. Requests
 * snapshot the committed state; only successful endpoint calls record, so a
 * failed or cache-served translation never distorts the transcript.
 *
 * Compaction implements the idle policy: a scope is compacted when it has
 * been idle at least translationContextIdleMinutes AND its transcript exceeds
 * translationContextMaxChars AND no new translation arrived meanwhile. The
 * compaction call asks the endpoint to distill a terminology/style memory,
 * then keeps only the newest few turns. Failure is fail-soft: the scope is
 * retried on the next sweep and translation itself is never blocked.
 *
 * An active session never waits for the idle policy: snapshot() applies a
 * deterministic tail-trim once the transcript reaches twice the configured
 * size, so a busy conversation cannot grow the request payload without bound.
 */
export function createTranslationContextManager(deps: TranslationContextManagerDeps) {
  const now = deps.now ?? (() => Date.now());
  const scopes = new Map<string, ScopeState>();

  function scopeState(scopeKey: string): ScopeState {
    let state = scopes.get(scopeKey);
    if (state === undefined) {
      state = {
        memory: deps.memoryStore?.get(CONTEXT_MEMORY_KEY_PREFIX + scopeKey) ?? "",
        turns: { "user-to-agent": [], "agent-to-user": [] },
        chars: 0,
        lastActivityAt: 0,
        dirty: false,
        compacting: false,
      };
      scopes.set(scopeKey, state);
    }
    return state;
  }

  function persistMemory(scopeKey: string, memory: string): void {
    try {
      deps.memoryStore?.set(CONTEXT_MEMORY_KEY_PREFIX + scopeKey, memory);
    } catch {
      // Persistence is best-effort; the in-memory state stays authoritative.
    }
  }

  // Turns are stored per direction, but trimming must drop the globally
  // oldest pair across both lanes. A monotonically increasing sequence per
  // turn (WeakMap, no cleanup needed) provides that cross-lane age order.
  const turnSequence = new WeakMap<TranslationTurn, number>();
  let nextSequence = 0;

  function trimTo(state: ScopeState, maxChars: number): void {
    while (state.chars > maxChars) {
      const userHead = state.turns["user-to-agent"][0];
      const agentHead = state.turns["agent-to-user"][0];
      if (userHead === undefined && agentHead === undefined) return;
      const direction: TranslateDirection =
        agentHead === undefined ||
        (userHead !== undefined &&
          (turnSequence.get(userHead) ?? 0) <= (turnSequence.get(agentHead) ?? 0))
          ? "user-to-agent"
          : "agent-to-user";
      const dropped = state.turns[direction].shift();
      if (dropped === undefined) return;
      state.chars -= dropped.user.length + dropped.assistant.length;
    }
  }

  async function compact(scopeKey: string, state: ScopeState, values: TranslateSettingsValues) {
    state.compacting = true;
    try {
      const client = createLlmClient(
        {
          baseUrl: values.endpointBaseUrl,
          apiKey: values.endpointApiKey,
          model: values.endpointModel,
          timeoutMs: values.translationTimeoutMs,
          reasoningEffort: values.translationReasoningEffort,
          protocol: values.endpointProtocol,
        },
        { fetchFn: deps.fetchFn },
      );
      // Revision captured before the endpoint await: a record() landing
      // mid-compaction produced a turn the distilled memory never saw, so the
      // scope must stay dirty and re-arm the idle policy instead of going
      // clean with a stale memory.
      const revision = nextSequence;
      const memory = await completeStreamFirst(client, buildCompactionMessages(state, values));
      const trimmed = memory.trim();
      if (trimmed.length === 0) return;
      state.memory = trimmed.slice(0, CONTEXT_MEMORY_LIMIT);
      for (const direction of ["user-to-agent", "agent-to-user"] as const) {
        const kept = state.turns[direction].slice(-CONTEXT_KEEP_TURNS);
        state.turns[direction] = kept;
      }
      state.chars = countChars(state);
      // Compacted state is clean: without new translations the scope must not
      // be re-distilled on every sweep even if the kept turns still exceed
      // the size threshold.
      state.dirty = nextSequence !== revision;
      persistMemory(scopeKey, state.memory);
    } finally {
      state.compacting = false;
    }
  }

  async function sweep(): Promise<void> {
    const values = await deps.loadConfig();
    if (!values.translationContextEnabled) return;
    const idleMs = values.translationContextIdleMinutes * 60_000;
    const evictAfterMs = Math.max(idleMs, SCOPE_EVICT_MIN_IDLE_MS);
    const timestamp = now();
    for (const [scopeKey, state] of scopes) {
      if (state.compacting) continue;
      // Long-abandoned scopes leave the map; the compacted memory is on disk
      // and scopeState() reseeds from it if the session ever comes back.
      if (
        state.lastActivityAt > 0 &&
        timestamp - state.lastActivityAt >= evictAfterMs
      ) {
        scopes.delete(scopeKey);
        continue;
      }
      if (!state.dirty) continue;
      if (state.chars < values.translationContextMaxChars) continue;
      if (state.lastActivityAt === 0 || timestamp - state.lastActivityAt < idleMs) continue;
      try {
        await compact(scopeKey, state, values);
      } catch {
        // Fail soft: compaction never blocks translation; retry next sweep.
      }
    }
  }

  const intervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          void sweep().catch(() => undefined);
        }, intervalMs)
      : null;
  // The sweep timer must never keep a daemon/plugin process (or a test run)
  // alive on its own.
  timer?.unref?.();

  return {
    /**
     * Committed context for one request. Applies the hard-cap tail-trim
     * first (at twice the configured size) so active sessions stay bounded.
     */
    snapshot(
      scopeKey: string,
      direction: TranslateDirection,
      options: { hardCapChars: number },
    ): TranslationContextSnapshot {
      const state = scopeState(scopeKey);
      trimTo(state, options.hardCapChars);
      return { memory: state.memory, turns: [...state.turns[direction]] };
    },

    /** Appends one successful translation to the scope's transcript. */
    record(
      scopeKey: string,
      direction: TranslateDirection,
      user: string,
      assistant: string,
    ): void {
      const state = scopeState(scopeKey);
      const turn: TranslationTurn = { user, assistant };
      turnSequence.set(turn, nextSequence);
      nextSequence += 1;
      state.turns[direction].push(turn);
      state.chars += user.length + assistant.length;
      state.dirty = true;
      state.lastActivityAt = now();
    },

    /**
     * Marks translation activity that produced no new pair (a cache hit):
     * the idle clock must see the session is alive or a hot-cache session
     * would look idle and get compacted mid-conversation.
     */
    touch(scopeKey: string): void {
      scopeState(scopeKey).lastActivityAt = now();
    },

    /** One compaction pass over all idle, oversized scopes. Exposed for tests. */
    sweep,

    /** Stops the sweep timer; called from the plugin's cleanup. */
    dispose(): void {
      if (timer !== null) clearInterval(timer);
    },
  };
}

export type TranslationContextManager = ReturnType<typeof createTranslationContextManager>;

function countChars(state: ScopeState): number {
  let total = 0;
  for (const direction of ["user-to-agent", "agent-to-user"] as const) {
    for (const turn of state.turns[direction]) {
      total += turn.user.length + turn.assistant.length;
    }
  }
  return total;
}

function buildCompactionMessages(
  state: ScopeState,
  values: TranslateSettingsValues,
): ChatMessage[] {
  const userToAgent = resolveLanguagePair(values, "user-to-agent");
  const agentToUser = resolveLanguagePair(values, "agent-to-user");
  const sections: string[] = [];
  if (state.memory.length > 0) {
    sections.push(`Previous memory:\n${state.memory}`);
  }
  sections.push(
    serializeHistory("user-to-agent", userToAgent, state.turns["user-to-agent"]),
    serializeHistory("agent-to-user", agentToUser, state.turns["agent-to-user"]),
  );
  let history = sections.join("\n\n");
  if (history.length > COMPACTION_INPUT_LIMIT) {
    const cut = history.length - COMPACTION_INPUT_LIMIT;
    // Keep the newest turns, but align the cut to a turn boundary: an
    // arbitrary offset can split a surrogate pair or half a translation pair.
    const boundary = history.indexOf("\n---\n", cut);
    history = history.slice(boundary === -1 ? cut : boundary + "\n---\n".length);
  }
  return [
    {
      role: "system",
      content: [
        "You maintain translation consistency for an ongoing translation session",
        `between ${values.userLanguage} and ${values.agentLanguage}.`,
        "You are given the session's previous memory (if any) and its recent translation history in both directions.",
        "Produce an updated compact memory that future translations will be conditioned on:",
        "(1) a terminology glossary mapping recurring source terms to their established translations,",
        "(2) style and register conventions observed,",
        "(3) domain context worth keeping.",
        "Be concise (at most 400 words). Output ONLY the memory text: no preamble, no explanations.",
      ].join(" "),
    },
    { role: "user", content: history },
  ];
}

function serializeHistory(
  label: string,
  pair: { source: string; target: string },
  turns: readonly TranslationTurn[],
): string {
  if (turns.length === 0) return `[${label}: ${pair.source} -> ${pair.target}]\n(none)`;
  const body = turns.map((turn) => `${turn.user}\n=>\n${turn.assistant}`).join("\n---\n");
  return `[${label}: ${pair.source} -> ${pair.target}]\n${body}`;
}
