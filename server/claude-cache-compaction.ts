import { claudeCachePreferencesSchema, type ClaudeCachePreferences, type ClaudeCacheSnapshot } from "../shared/claude-cache-compaction";
import type { ClaudeCachePreferenceStore } from "./claude-cache-preferences";

export interface ClaudeCacheSessionPort {
  snapshot(): { idle: boolean; contextTokens: number | null };
  /** Recheck guard under the provider's mutation fence, then reserve synchronously. */
  compact(guard: () => boolean): Promise<boolean>;
}

interface Entry {
  port: ClaudeCacheSessionPort;
  preferences: ClaudeCachePreferences;
  requestStartedAt: number | null;
  ttlSeconds: number | null;
  expiresAt: number | null;
  generation: number;
  attemptedGeneration: number;
  completed: boolean;
  running: boolean;
  suspended: boolean;
  outcome: "compacted" | "failed" | "no-cache" | null;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
const positive = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** One scheduler per installation, with bounded work and no per-session polling loop. */
export class ClaudeCacheCompactionCoordinator {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;
  private disposed = false;

  constructor(private readonly store: ClaudeCachePreferenceStore,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent = 2) {}

  register(agentId: string, seed: unknown, port: ClaudeCacheSessionPort): () => void {
    const parsed = claudeCachePreferencesSchema.safeParse(seed);
    const entry: Entry = { port, preferences: this.store.get(agentId) ??
      (parsed.success ? parsed.data : claudeCachePreferencesSchema.parse({})),
      requestStartedAt: null, ttlSeconds: null, expiresAt: null, generation: 0,
      attemptedGeneration: -1, completed: false, running: false, suspended: false, outcome: null };
    // An old source may still dispose after its replacement has registered.
    const previous = this.entries.get(agentId);
    if (previous?.running) this.inFlight--;
    this.entries.set(agentId, entry);
    this.schedule();
    return () => {
      if (this.entries.get(agentId) !== entry) return;
      if (entry.running) this.inFlight--;
      this.entries.delete(agentId);
      this.schedule();
    };
  }

  configure(agentId: string, preferences: ClaudeCachePreferences): ClaudeCacheSnapshot {
    const entry = this.entries.get(agentId);
    if (!entry) throw new Error("Open the Claude session before changing its AFK preferences");
    const validated = claudeCachePreferencesSchema.parse(preferences);
    this.store.set(agentId, validated);
    entry.preferences = validated;
    entry.generation++;
    this.schedule();
    return this.status(agentId);
  }

  suspend(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry) entry.suspended = true;
    this.schedule();
  }

  invalidate(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.requestStartedAt = entry.expiresAt = entry.ttlSeconds = null;
    entry.completed = false;
    entry.generation++;
    this.schedule();
  }

  prompt(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.completed = false;
    entry.generation++;
    entry.outcome = null;
    this.schedule();
  }

  refresh(): void { this.schedule(); }

  /** Observe root SDK messages only; child/translator activity never warms this cache. */
  observe(agentId: string, value: unknown, explicitTtl: "5m" | "1h" | undefined, maintenance = false): void {
    const entry = this.entries.get(agentId);
    const message = object(value);
    if (!entry || !message || typeof message.parent_tool_use_id === "string") return;
    if (maintenance) return;
    let changed = false;
    if (message.type === "system" && message.subtype === "status" && message.status === "requesting") {
      entry.requestStartedAt = this.now();
      entry.completed = false;
      entry.generation++;
      entry.outcome = null;
      changed = true;
    }
    const event = object(message.event);
    const payload = message.type === "stream_event" && event?.type === "message_start"
      ? object(event.message) : message.type === "assistant" ? object(message.message) : undefined;
    const usage = object(payload?.usage);
    if (usage && entry.requestStartedAt !== null) {
      changed = true;
      const writes = object(usage.cache_creation);
      const short = positive(writes?.ephemeral_5m_input_tokens);
      const long = positive(writes?.ephemeral_1h_input_tokens);
      const activity = positive(usage.cache_read_input_tokens) + positive(usage.cache_creation_input_tokens);
      if (activity > 0 || short > 0 || long > 0) {
        const ttl = short > 0 && long > 0 ? null : long > 0 ? 3600 : short > 0 ? 300 :
          explicitTtl === "1h" ? 3600 : explicitTtl === "5m" ? 300 : entry.ttlSeconds;
        entry.ttlSeconds = ttl;
        entry.expiresAt = ttl === null ? null : entry.requestStartedAt + ttl * 1000;
        entry.outcome = null;
      } else if (typeof usage.input_tokens === "number") {
        entry.expiresAt = entry.ttlSeconds = null;
        entry.outcome = "no-cache";
      }
      // A complete assistant frame can refine initially incomplete stream usage.
      // Keep the same request start so repeated usage never extends its deadline.
    }
    if (message.type === "result") {
      changed = true;
      entry.completed = message.subtype === "success" && message.is_error !== true;
      entry.requestStartedAt = null;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      changed = true;
      entry.attemptedGeneration = entry.generation;
      entry.expiresAt = entry.ttlSeconds = entry.requestStartedAt = null;
      entry.outcome = "compacted";
    }
    if (changed) this.schedule();
  }

  finish(agentId: string, success: boolean): void {
    const entry = this.entries.get(agentId);
    if (!entry?.running) return;
    entry.running = false;
    this.inFlight--;
    entry.completed = false;
    entry.expiresAt = entry.ttlSeconds = entry.requestStartedAt = null;
    entry.outcome = success ? "compacted" : "failed";
    this.schedule();
  }

  status(agentId: string): ClaudeCacheSnapshot {
    const entry = this.entries.get(agentId);
    const serverNow = this.now();
    if (!entry) return { serverNow, preferences: this.store.get(agentId) ?? claudeCachePreferencesSchema.parse({}),
      state: "not-open", reason: "Open this Claude session to observe its cache", contextTokens: null,
      ttlSeconds: null, expiresAt: null, scheduledAt: null };
    const snapshot = entry.port.snapshot();
    const state = entry.running ? "compacting" : entry.outcome ??
      (entry.expiresAt === null ? "unknown" : entry.expiresAt <= serverNow ? "expired" : "warm");
    let reason = "Waiting for the pre-expiry window";
    if (entry.suspended) reason = "Session archived or closed";
    else if (entry.running) reason = "AFK compaction is running";
    else if (entry.expiresAt === null) reason = "No reliable cache expiry estimate is available";
    else if (entry.expiresAt <= serverNow) reason = "Estimated cache deadline has passed";
    else if (entry.ttlSeconds === 300) reason = "Five-minute caches are excluded from AFK auto-compaction";
    else if (!entry.preferences.enabled) reason = "AFK auto-compaction is off for this session";
    else if (snapshot.contextTokens === null) reason = "Context usage is unknown";
    else if (snapshot.contextTokens <= entry.preferences.thresholdTokens) reason = "Context is at or below the AFK threshold";
    else if (!entry.completed || !snapshot.idle) reason = "Waiting for this run and its background work to finish";
    else if (entry.attemptedGeneration === entry.generation) reason = "This context has already had an automatic compaction attempt";
    return { serverNow, preferences: entry.preferences, state, reason,
      contextTokens: snapshot.contextTokens, ttlSeconds: entry.ttlSeconds, expiresAt: entry.expiresAt,
      scheduledAt: this.eligible(entry) ? this.due(entry) : null };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.entries.clear();
  }

  private due(entry: Entry): number { return entry.expiresAt! - entry.preferences.leadSeconds * 1000; }
  private eligible(entry: Entry): boolean {
    const snapshot = entry.port.snapshot();
    return !this.disposed && !entry.suspended && entry.preferences.enabled && entry.completed && snapshot.idle &&
      snapshot.contextTokens !== null && snapshot.contextTokens > entry.preferences.thresholdTokens &&
      entry.ttlSeconds !== null && entry.ttlSeconds > 300 && entry.expiresAt !== null && entry.expiresAt > this.now() &&
      entry.attemptedGeneration !== entry.generation;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.inFlight >= this.maxConcurrent) return;
    let due = Infinity;
    for (const entry of this.entries.values()) {
      if (!entry.running && this.eligible(entry)) due = Math.min(due, this.due(entry));
    }
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => { void this.tick(); }, Math.max(0, due - this.now()));
    this.timer.unref?.();
  }

  private tick(): void {
    for (const [agentId, entry] of this.entries) {
      if (this.inFlight >= this.maxConcurrent) break;
      if (entry.running || !this.eligible(entry) || this.due(entry) > this.now()) continue;
      void this.start(agentId, entry);
    }
    this.schedule();
  }

  private async start(agentId: string, entry: Entry): Promise<void> {
    const generation = entry.generation;
    entry.running = true;
    this.inFlight++;
    // Reserve one attempt before yielding, including failure and reentrant callbacks.
    entry.attemptedGeneration = generation;
    const guard = () => {
      const attempt = entry.attemptedGeneration;
      entry.attemptedGeneration = -1;
      const allowed = this.entries.get(agentId) === entry && entry.generation === generation && this.eligible(entry);
      entry.attemptedGeneration = attempt;
      return allowed;
    };
    try {
      const started = await entry.port.compact(guard);
      if (!started && this.entries.get(agentId) === entry && entry.running) {
        entry.running = false;
        this.inFlight--;
        // A new observation can reconsider; do not spin on a busy mutation fence.
      }
    } catch (error) {
      console.warn("[translate-claude] AFK compaction failed to start", error);
      if (this.entries.get(agentId) === entry) this.finish(agentId, false);
    }
    this.schedule();
  }
}
