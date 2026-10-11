import { randomUUID } from "node:crypto";
import type {
  ProviderEvent,
  ProviderPermissionRequest,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import {
  isDataUriImageOnlyText,
  isProviderImageMarkdown,
  resolveTranslationContextKey,
  type TranslateSettingsValues,
} from "../shared/translate";
import {
  NOTIFICATION_BOUNDARY_KIND,
  NOTIFICATION_PREVIEW_PREFIX,
  notificationFallback,
} from "../shared/notification-preview";
import { createTranslator, type TranslatorDeps } from "./translate";
import { parseMarkdownBlocks, type BlockNode, type InlineNode } from "../shared/markdown-parse";

const PREVIEW_SOURCE_LIMIT = 2_000;

interface NotificationSession {
  contextKey: string;
  turnId: string | null;
  lastEndedTurnId: string | null;
  segment: string;
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
            segment: "",
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
      const preview = async (
        source: string,
        session: NotificationSession,
        values: TranslateSettingsValues,
        reason: "finished" | "permission",
        signal: AbortSignal,
      ): Promise<string> => {
        try {
          if (signal.aborted) throw new Error("Notification translation canceled");
          if (!source.trim() || isDataUriImageOnlyText(source) || isProviderImageMarkdown(source)) {
            throw new Error("No notification prose");
          }
          const plainSource = notificationText(source.slice(0, PREVIEW_SOURCE_LIMIT));
          if (!plainSource) throw new Error("No notification prose");
          const text = await untilAborted(
            translator.translate(plainSource, "agent-to-user", { contextKey: session.contextKey }),
            signal,
          );
          const plainText = notificationText(text);
          if (!plainText) throw new Error("Empty notification translation");
          return plainText.length > 220 ? `${plainText.slice(0, 217).trimEnd()}...` : plainText;
        } catch {
          return notificationFallback(values.userLanguage, reason);
        }
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
          session.segment = "";
          session.snapshots.clear();
        }
        if (event.type === "session.turn" && event.state === "started") {
          session.turnId = event.turnId;
          session.segment = "";
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
            // Match the host adapter's snapshot-to-delta mapping, including non-prefix text blocks.
            if (delta.length > 0) {
              if (!session.previousWasAssistant) session.segment = "";
              session.segment = (session.segment + delta).slice(0, PREVIEW_SOURCE_LIMIT);
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
            const title = await preview(source, session, values, "permission", signal);
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
              const source = session.segment;
              const text = await preview(source, session, values, "finished", signal);
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

function notificationText(markdown: string): string {
  const inlineText = (nodes: readonly InlineNode[]): string =>
    nodes
      .map((node) => {
        if (node.type === "text" || node.type === "code") return node.text;
        if (node.type === "break") return " ";
        return inlineText(node.children);
      })
      .join("");
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
