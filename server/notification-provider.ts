import { randomUUID } from "node:crypto";
import type {
  ProviderEvent,
  ProviderPermissionRequest,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import {
  TRANSLATION_TEXT_LIMIT,
  isDataUriImageOnlyText,
  isProviderImageMarkdown,
  resolveTranslationContextKey,
  type TranslateSettingsValues,
} from "../shared/translate";
import { requiresHostRenderer } from "../shared/host-rendered-message";
import {
  NOTIFICATION_BOUNDARY_KIND,
  NOTIFICATION_PREVIEW_PREFIX,
  notificationFallback,
} from "../shared/notification-preview";
import { createTranslator, type TranslatorDeps } from "./translate";
import { inlineText, parseMarkdownBlocks, type BlockNode } from "../shared/markdown-parse";

/** Source cap for items the app never translates itself (legacy plain-text preview). */
const PREVIEW_SOURCE_LIMIT = 2_000;
/** Visible preview length; longer previews end in an ellipsis. */
const PREVIEW_TEXT_LIMIT = 220;

interface NotificationSession {
  contextKey: string;
  turnId: string | null;
  lastEndedTurnId: string | null;
  /**
   * The trailing run of assistant rows exactly as the app will hold them:
   * keyed by message id (the app merges deltas per message id), each value
   * the concatenated deltas of that row. The completion preview translates
   * these texts verbatim, so its translations are the very cache entries
   * the reply renderer asks for, instead of a second, differently-keyed
   * translation of a plain-text excerpt.
   */
  run: Map<string, string>;
  snapshots: Map<string, string>;
  previousWasAssistant: boolean;
  epoch: number;
  closed: boolean;
  terminationReceived: boolean;
  pending: Promise<void>;
  /**
   * False where the host never raises attention notifications: its internal
   * structured agents (git metadata, branch names) open with persist:false
   * and the host consumes their last assistant text as run output, and
   * subsessions only feed read-only track rows (child permission events are
   * dropped, child turns never drive lifecycle). Those sessions pass through
   * untouched — a preview row there could only corrupt run output or pollute
   * replayed track timelines.
   */
  notificationEligible: boolean;
  values: TranslateSettingsValues | null;
  abort: AbortController;
}

/**
 * Translate notification source fields before the host sees permission/turn
 * completion. Only notification-eligible sessions participate (see
 * NotificationSession.notificationEligible); everything else passes through
 * untouched.
 */
export function withNotificationTranslation(
  provider: ProviderRegistration,
  deps: TranslatorDeps,
): ProviderRegistration {
  const translator = createTranslator(deps);
  return {
    ...provider,
    async connect(request) {
      const supportsPluginTimeline = request.capabilities.includes("timeline.plugin");
      const inner = await provider.connect(request);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, NotificationSession>();
      const requestSessions = new Map<string, string>();
      let closed = false;
      const emit = (event: ProviderEvent) => {
        if (!closed) for (const listener of listeners) listener(event);
      };
      const getSession = (id: string): NotificationSession => {
        let session = sessions.get(id);
        if (session === undefined) {
          session = {
            contextKey: id,
            turnId: null,
            lastEndedTurnId: null,
            run: new Map(),
            snapshots: new Map(),
            previousWasAssistant: false,
            epoch: 0,
            closed: false,
            pending: Promise.resolve(),
            notificationEligible: true,
            values: null,
            terminationReceived: false,
            abort: new AbortController(),
          };
          sessions.set(id, session);
        }
        return session;
      };
      const loadValues = async (session: NotificationSession) => {
        try {
          session.values = await deps.loadConfig();
          return session.values;
        } catch {
          // A previously enabled session must not leak source text when settings become invalid.
          return session.values;
        }
      };
      /** Plain-text excerpt of a source the app does not translate itself. */
      const plainPreviewTranslation = async (
        source: string,
        session: NotificationSession,
        signal: AbortSignal,
      ): Promise<string> => {
        const plainSource = notificationText(source.slice(0, PREVIEW_SOURCE_LIMIT));
        if (!plainSource) throw new Error("No notification prose");
        return untilAborted(
          translator.translate(plainSource, "agent-to-user", { contextKey: session.contextKey }),
          signal,
        );
      };
      const permissionPreview = async (
        source: string,
        session: NotificationSession,
        values: TranslateSettingsValues,
        signal: AbortSignal,
      ): Promise<string> => {
        try {
          if (signal.aborted) throw new Error("Notification translation canceled");
          if (!source.trim() || isDataUriImageOnlyText(source) || isProviderImageMarkdown(source)) {
            throw new Error("No notification prose");
          }
          const plainText = notificationText(await plainPreviewTranslation(source, session, signal));
          if (!plainText) throw new Error("Empty notification translation");
          return clipPreview(plainText, false);
        } catch {
          return notificationFallback(values.userLanguage, "permission");
        }
      };
      /**
       * Completion preview from the turn's trailing assistant rows. Each row
       * the app renders through the translated view is translated verbatim
       * — the reply renderer's own cache key — so opening the conversation
       * afterwards is a cache hit (or joins the still-running request)
       * rather than a second translation. The wait ends as soon as enough
       * translated text exists for the preview, or after one endpoint
       * timeout; the current row keeps translating into the cache, while
       * later rows are left to the app (they may never be read). With reply
       * translation off the app never reads those entries, so every row
       * uses the bounded plain-text excerpt instead.
       */
      const finishedPreview = async (
        rows: readonly string[],
        session: NotificationSession,
        values: TranslateSettingsValues,
        signal: AbortSignal,
      ): Promise<string> => {
        const fallback = notificationFallback(values.userLanguage, "finished");
        const prose = rows.filter(
          (text) => text.trim().length > 0 && !isDataUriImageOnlyText(text) && !isProviderImageMarkdown(text),
        );
        if (prose.length === 0 || signal.aborted) return fallback;
        const finished: string[] = [];
        let partial = "";
        const plainSoFar = (current: string) =>
          notificationText([...finished, current].filter((text) => text.length > 0).join("\n\n"));
        return new Promise<string>((resolve) => {
          let settled = false;
          const finish = (text: string, complete: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve(text.length > 0 ? clipPreview(text, !complete) : fallback);
          };
          // A partial translation is still a faithful preview (it is clipped
          // anyway); only an empty one falls back to the generic message.
          const timer = setTimeout(() => finish(plainSoFar(partial), false), values.translationTimeoutMs);
          const onAbort = () => finish("", false);
          signal.addEventListener("abort", onAbort, { once: true });
          void (async () => {
            for (const source of prose) {
              if (settled) return;
              partial = "";
              // Full-row translation only pays off when the app will read it;
              // with reply translation off, a short plain excerpt suffices.
              const shared =
                values.translateResponses &&
                !requiresHostRenderer(source) &&
                source.length <= TRANSLATION_TEXT_LIMIT;
              const translated = shared
                ? await translator.translateStream(
                    source,
                    "agent-to-user",
                    (delta) => {
                      partial += delta;
                      const plain = plainSoFar(partial);
                      if (plain.length > PREVIEW_TEXT_LIMIT) finish(plain, false);
                    },
                    { contextKey: session.contextKey, signal },
                  )
                : await plainPreviewTranslation(source, session, signal);
              finished.push(translated);
              partial = "";
              const plain = plainSoFar("");
              if (plain.length > PREVIEW_TEXT_LIMIT) {
                finish(plain, false);
                return;
              }
            }
            finish(plainSoFar(""), true);
          })().catch(() => finish(plainSoFar(""), false));
        });
      };
      const handle = async (event: ProviderEvent, session: NotificationSession, epoch: number) => {
        if (event.type === "request.completed" || event.type === "request.failed") {
          emit(event);
          requestSessions.delete(event.requestId);
          return;
        }
        if (closed) return;
        if (
          session.closed &&
          (event.type === "session.permission" ||
            (event.type === "session.turn" && event.state !== "started"))
        )
          return;
        const signal = session.abort.signal;
        if (event.type === "session.closed" || event.type === "session.runtime_failed") {
          session.run.clear();
          session.snapshots.clear();
        }
        if (event.type === "session.turn" && event.state === "started") {
          session.turnId = event.turnId;
          session.run.clear();
          session.snapshots.clear();
          session.previousWasAssistant = false;
        }
        if (event.type === "session.opened") {
          // Subsessions feed read-only track rows on the host; Claude replay
          // also wraps each replayed child turn in live-looking terminal
          // events, which must never trigger previews.
          if (event.parentSessionId !== undefined) session.notificationEligible = false;
          if (supportsPluginTimeline) {
            event = {
              ...event,
              capabilities: [...new Set([...event.capabilities, "timeline.plugin"])],
            };
          }
        }
        if (session.notificationEligible && event.type === "timeline.item" && session.turnId !== null) {
          if (event.item.type === "assistant_message") {
            const previous = session.snapshots.get(event.item.id) ?? "";
            const delta = event.item.text.startsWith(previous)
              ? event.item.text.slice(previous.length)
              : event.item.text;
            session.snapshots.set(event.item.id, event.item.text);
            // Match the host adapter's snapshot-to-delta mapping (including
            // non-prefix text blocks) and the app's row assembly: deltas join
            // per message id with CRs stripped, and a whitespace-only first
            // chunk never opens a row.
            const chunk = delta.replace(/\r/g, "");
            if (chunk.length > 0) {
              if (!session.previousWasAssistant) session.run.clear();
              const rowId = event.item.messageId ?? event.item.id;
              const existing = session.run.get(rowId);
              if (existing !== undefined || /\S/.test(chunk)) {
                session.run.set(rowId, (existing ?? "") + chunk);
              }
              session.previousWasAssistant = true;
            }
          } else {
            session.previousWasAssistant = false;
          }
        }
        if (session.notificationEligible && event.type === "session.permission") {
          if (epoch !== session.epoch) return;
          const values = await loadValues(session);
          if (values?.translateNotifications) {
            const source = permissionSummary(event.request);
            const title = await permissionPreview(source, session, values, signal);
            if (closed || session.closed || epoch !== session.epoch) return;
            emit({ ...event, request: { ...event.request, title, description: "" } });
            return;
          }
        }
        if (session.notificationEligible && event.type === "session.turn" && event.state !== "started") {
          // Only live, matching turns generate previews; replay and duplicate terminal events do not.
          if (session.lastEndedTurnId === event.turnId) return;
          if (session.turnId !== event.turnId) {
            emit(event);
            return;
          }
          if (event.state === "completed" && epoch !== session.epoch) {
            session.turnId = null;
            session.lastEndedTurnId = event.turnId;
            emit({ ...event, state: "canceled" });
            return;
          }
          if (event.state === "completed") {
            const values = await loadValues(session);
            if (values?.translateNotifications) {
              if (!supportsPluginTimeline) {
                // This can only happen if an older host enables the setting after session open.
                emit({
                  ...event,
                  state: "failed",
                  error: {
                    message: "Notification previews require Paseo timeline.plugin support",
                  },
                });
                session.turnId = null;
                session.lastEndedTurnId = event.turnId;
                return;
              }
              const text = await finishedPreview([...session.run.values()], session, values, signal);
              if (closed || session.closed) return;
              if (epoch !== session.epoch) {
                session.turnId = null;
                session.lastEndedTurnId = event.turnId;
                emit({ ...event, state: "canceled" });
                return;
              }
              const id = `${NOTIFICATION_PREVIEW_PREFIX}${randomUUID()}`;
              // The host concatenates consecutive assistant rows for its notification preview.
              // A plugin row commits a boundary without changing the original response.
              emit({
                type: "timeline.item",
                sessionId: event.sessionId,
                item: {
                  type: "plugin",
                  id: `${id}:boundary`,
                  pluginId: "translate",
                  kind: NOTIFICATION_BOUNDARY_KIND,
                  version: 1,
                  data: {},
                },
              });
              emit({
                type: "timeline.item",
                sessionId: event.sessionId,
                item: { type: "assistant_message", id, messageId: id, text },
              });
            }
          }
          session.turnId = null;
          session.lastEndedTurnId = event.turnId;
        }
        if (!closed) emit(event);
      };
      const unsubscribe = inner.onEvent((event) => {
        const sessionId =
          "sessionId" in event
            ? event.sessionId
            : "requestId" in event
              ? requestSessions.get(event.requestId)
              : undefined;
        if (sessionId === undefined) {
          emit(event);
          return;
        }
        const session = getSession(sessionId);
        if (
          session.terminationReceived &&
          event.type !== "request.completed" &&
          event.type !== "request.failed"
        )
          return;
        if (event.type === "session.closed" || event.type === "session.runtime_failed") {
          session.terminationReceived = true;
          session.closed = true;
          session.epoch += 1;
          session.abort.abort();
        }
        const epoch = session.epoch;
        // Each session has its own lane: one slow translation cannot delay another agent.
        session.pending = session.pending
          .then(() => handle(event, session, epoch))
          .catch((error) => {
            console.warn("[translate] notification event processing failed", error);
          });
      });
      return {
        version: inner.version,
        capabilities: supportsPluginTimeline
          ? [...new Set([...inner.capabilities, "timeline.plugin"])]
          : inner.capabilities,
        async send(input) {
          if ("sessionId" in input && "requestId" in input) {
            requestSessions.set(input.requestId, input.sessionId);
          }
          if (input.type === "session.open") {
            const session = getSession(input.sessionId);
            session.contextKey = resolveTranslationContextKey(input.config.env, input.sessionId);
            // The host opens its internal structured agents (git metadata,
            // branch names) with persist:false: they never raise attention
            // notifications and their last assistant text is consumed as run
            // output, so preview rows there would only corrupt it.
            session.notificationEligible = input.config.persist !== false;
            const values = await loadValues(session);
            if (values?.translateNotifications && !supportsPluginTimeline && session.notificationEligible) {
              requestSessions.delete(input.requestId);
              throw new Error("Notification previews require Paseo timeline.plugin support");
            }
          } else if ("sessionId" in input) {
            const session = getSession(input.sessionId);
            if (input.type === "session.interrupt" || input.type === "session.close") {
              session.epoch += 1;
              session.abort.abort();
              session.abort = new AbortController();
              if (input.type === "session.close") session.closed = true;
            }
            if (input.type === "session.prompt" && input.prompt.delivery !== "steer") {
              await session.pending;
            }
          }
          try {
            await inner.send(input);
          } catch (error) {
            if ("requestId" in input) requestSessions.delete(input.requestId);
            throw error;
          }
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async close() {
          closed = true;
          unsubscribe();
          listeners.clear();
          for (const session of sessions.values()) {
            session.closed = true;
            session.abort.abort();
          }
          sessions.clear();
          requestSessions.clear();
          await inner.close();
        },
      };
    },
  };
}

/** Clips to the preview length; an unfinished translation always ends in an ellipsis. */
function clipPreview(text: string, partial: boolean): string {
  if (text.length > PREVIEW_TEXT_LIMIT) return `${text.slice(0, PREVIEW_TEXT_LIMIT - 3).trimEnd()}...`;
  return partial ? `${text.trimEnd()}...` : text;
}

function notificationText(markdown: string): string {
  const blockText = (blocks: readonly BlockNode[]): string =>
    blocks
      .map((block) => {
        switch (block.type) {
          case "paragraph":
          case "heading":
            return inlineText(block.children);
          case "codeblock":
            return block.text;
          case "quote":
            return blockText(block.children);
          case "ul":
          case "ol":
            return block.items.map((item) => blockText(item.blocks)).join(" ");
          case "table":
            return [...block.header, ...block.rows.flat()].map(inlineText).join(" ");
          case "hr":
            return "";
        }
      })
      .join(" ");
  return blockText(parseMarkdownBlocks(markdown)).replace(/\s+/g, " ").trim();
}

async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Notification translation canceled"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function permissionSummary(request: ProviderPermissionRequest): string {
  if (request.kind === "question" && Array.isArray(request.input?.questions)) {
    const first = request.input.questions.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        typeof item.question === "string",
    );
    if (
      first !== undefined &&
      typeof first === "object" &&
      first !== null &&
      !Array.isArray(first)
    ) {
      // Question display strings can be bilingual; the notification uses the first (translated) line.
      if (typeof first.question === "string") return first.question.split("\n")[0];
    }
  }
  return (
    [request.title, request.description].filter((text) => text?.trim()).join(" - ") ||
    `Permission requested: ${request.name}`
  );
}
