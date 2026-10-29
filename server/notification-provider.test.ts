import { describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import {
  buildAgentAttentionNotificationPayload,
  findLatestAssistantMessageFromTimeline,
} from "@getpaseo/protocol/agent-attention-notification";
import { withNotificationTranslation } from "./notification-provider";
import { createTranslateStreamManager, type TranslatorDeps } from "./translate";
import { createMemoryTranslationCacheStore } from "./translation-cache-store";
import { createTranslationInflightRegistry } from "./translation-inflight";
import { translateSettings, unwrapTranslationInput } from "../shared/translate";
import { isNotificationPreview, notificationFallback } from "../shared/notification-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness(
  options: {
    enabled?: boolean;
    language?: string;
    translate?: (text: string) => string | Promise<string>;
    pluginTimeline?: boolean;
    replyTranslationEnabled?: boolean;
    /** Replaces the JSON endpoint stub (the source is still recorded). */
    respond?: (source: string) => Response | Promise<Response>;
    cacheStore?: TranslatorDeps["cacheStore"];
    inflight?: TranslatorDeps["inflight"];
  } = {},
) {
  let values = translateSettings.schema.parse({
    endpointBaseUrl: "https://translation.example/v1",
    endpointModel: "translator",
    endpointProtocol: "chat-completions",
    userLanguage: options.language ?? "zh-CN",
    agentLanguage: "en",
    translateNotifications: options.enabled ?? true,
    translateResponses: options.replyTranslationEnabled ?? true,
  });
  let configFailure = false;
  let receive: (event: ProviderEvent) => void = () => {};
  const sent: ProviderInput[] = [];
  const requests: string[] = [];
  const inner: ProviderRegistration = {
    id: "translate-test",
    label: "Test",
    async connect() {
      return {
        version: 1,
        capabilities: ["prompt.message", "permission"],
        async send(input) {
          sent.push(input);
          if (input.type === "session.open") {
            receive({
              type: "session.opened",
              sessionId: input.sessionId,
              requestId: input.requestId,
              capabilities: ["prompt.message", "permission"],
              restoration: "core",
              cwd: input.config.cwd,
            });
            receive({ type: "request.completed", requestId: input.requestId });
          }
        },
        onEvent(listener) {
          receive = listener;
          return () => {
            receive = () => {};
          };
        },
        async close() {},
      };
    },
  };
  const deps: TranslatorDeps = {
    loadConfig: async () => {
      if (configFailure) throw new Error("settings unavailable");
      return values;
    },
    ...(options.cacheStore ? { cacheStore: options.cacheStore } : {}),
    ...(options.inflight ? { inflight: options.inflight } : {}),
    fetchFn: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const source = unwrapTranslationInput(
        body.messages.find((message: { role: string }) => message.role === "user").content,
      );
      requests.push(source);
      if (options.respond) return options.respond(source);
      const text = await (options.translate?.(source) ?? `译文：${source}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
    }) as typeof fetch,
  };
  const wrapped = withNotificationTranslation(inner, deps);
  const connection = await wrapped.connect({
    versions: [1],
    capabilities:
      options.pluginTimeline === false
        ? ["prompt.message", "permission"]
        : [...PROVIDER_CAPABILITIES],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });
  const wait = (predicate: (event: ProviderEvent) => boolean) =>
    new Promise<void>((resolve) => {
      const off = connection.onEvent((event) => {
        if (predicate(event)) {
          off();
          resolve();
        }
      });
    });
  let marker = 0;
  const flush = async (sessionId = "s") => {
    const id = `flush-${marker++}`;
    const done = wait((event) => event.type === "session.notice" && event.notice.id === id);
    receive({
      type: "session.notice",
      sessionId,
      notice: { id, severity: "info", title: "flush" },
    });
    await done;
  };
  const open = async (sessionId = "s", persist = true) => {
    await connection.send({
      type: "session.open",
      requestId: `open-${sessionId}`,
      sessionId,
      history: "skip",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist },
    });
    await flush(sessionId);
  };
  const turn = (
    state: "started" | "completed" | "failed" | "canceled",
    turnId = "t",
    sessionId = "s",
  ) => {
    receive({ type: "session.turn", state, turnId, sessionId });
  };
  const text = (text: string, id = "m", sessionId = "s") => {
    receive({
      type: "timeline.item",
      sessionId,
      item: { type: "assistant_message", id, messageId: id, text },
    });
  };
  const previews = () =>
    events.filter(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "assistant_message" &&
        isNotificationPreview(event.item.messageId),
    );
  return {
    deps,
    connection,
    events,
    receive,
    sent,
    requests,
    open,
    flush,
    wait,
    turn,
    text,
    previews,
    setEnabled(enabled: boolean) {
      values = { ...values, translateNotifications: enabled };
    },
    failConfig() {
      configFailure = true;
    },
  };
}

function completionBody(events: ProviderEvent[]): string {
  const timeline = events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
  return buildAgentAttentionNotificationPayload({
    reason: "finished",
    serverId: "host",
    workspaceId: "workspace",
    agentId: "agent",
    assistantMessage: findLatestAssistantMessageFromTimeline(timeline),
  }).body;
}

describe("notification provider", () => {
  it("preserves open ordering and advertises the plugin timeline capability", async () => {
    const h = await harness();
    await h.open();
    expect(h.events.slice(0, 2).map((event) => event.type)).toEqual([
      "session.opened",
      "request.completed",
    ]);
    expect(h.connection.capabilities).toContain("timeline.plugin");
    await h.connection.close();
  });

  it("uses the final translated rows without leaking original or incremental snapshots", async () => {
    const h = await harness({ translate: (source) => (source === "Done" ? "任务已完成" : "！") });
    await h.open();
    h.turn("started");
    h.text("Progress", "progress");
    h.receive({
      type: "timeline.item",
      sessionId: "s",
      item: { type: "reasoning", id: "thought", text: "Thinking" },
    });
    h.text("Do");
    h.text("Done");
    h.text("!", "last");
    h.turn("completed");
    await h.flush();
    // Each trailing row is translated verbatim, exactly as the app renders
    // it (separate message ids are separate rows), so the reply renderer
    // later hits the same cache entries instead of translating again.
    expect(h.requests).toEqual(["Done", "!"]);
    expect(completionBody(h.events)).toBe("任务已完成 ！");
    expect(h.previews()).toHaveLength(1);
    expect(
      h.events.findIndex((event) => event.type === "session.turn" && event.state === "completed"),
    ).toBeGreaterThan(
      h.events.findIndex(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          isNotificationPreview(event.item.messageId),
      ),
    );
    expect(
      h.events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "Done",
      ),
    ).toBe(true);
    await h.connection.close();
  });

  it("is opt-in and can be toggled for an existing session", async () => {
    const h = await harness({ enabled: false });
    await h.open();
    h.turn("started");
    h.text("Original");
    h.turn("completed");
    await h.flush();
    expect(h.requests).toEqual([]);
    expect(h.previews()).toHaveLength(0);
    h.setEnabled(true);
    h.turn("started", "t2");
    h.text("Next");
    h.turn("completed", "t2");
    await h.flush();
    expect(h.requests).toEqual(["Next"]);
    await h.connection.close();
  });

  it("includes consecutive non-prefix text blocks sharing a Claude message id", async () => {
    const h = await harness();
    await h.open();
    h.turn("started");
    h.text("First block.");
    h.text("Second block.");
    h.turn("completed");
    await h.flush();
    expect(h.requests).toEqual(["First block.Second block."]);
    await h.connection.close();
  });

  it.each(["throw", "blank"])(
    "uses a localized generic body when translation returns %s",
    async (failure) => {
      const h = await harness({
        translate: () => {
          if (failure === "throw") throw new Error("offline");
          return "   ";
        },
      });
      await h.open();
      h.turn("started");
      h.text("Private untranslated reply");
      h.turn("completed");
      await h.flush();
      expect(completionBody(h.events)).toBe(notificationFallback("zh-CN", "finished"));
      await h.connection.close();
    },
  );

  it("does not reuse an earlier response for a turn without an assistant message", async () => {
    const h = await harness();
    await h.open();
    h.turn("started");
    h.text("Earlier");
    h.turn("completed");
    await h.flush();
    h.turn("started", "next");
    h.turn("completed", "next");
    await h.flush();
    expect(h.requests).toEqual(["Earlier"]);
    expect(completionBody(h.events)).toBe(notificationFallback("zh", "finished"));
    await h.connection.close();
  });

  it("translates the row verbatim for reuse, clips the preview, accepts identical translations", async () => {
    const h = await harness({ translate: (source) => source });
    await h.open();
    h.turn("started");
    h.text("A".repeat(8_000));
    h.turn("completed");
    await h.flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toHaveLength(8_000);
    expect(completionBody(h.events)).toBe(`${"A".repeat(217)}...`);
    await h.connection.close();
  });

  it("uses plain notification prose and falls back when output is only markdown markers", async () => {
    const h = await harness({ translate: () => "---" });
    await h.open();
    h.turn("started");
    h.text("## Done\n\n**Tests** passed.");
    h.turn("completed");
    await h.flush();
    expect(h.requests).toEqual(["## Done\n\n**Tests** passed."]);
    expect(completionBody(h.events)).toBe(notificationFallback("zh", "finished"));
    await h.connection.close();
  });

  it("rejects preview-enabled sessions on hosts without plugin timeline support", async () => {
    const h = await harness({ pluginTimeline: false });
    await expect(h.open()).rejects.toThrow("timeline.plugin support");
    await h.connection.close();
  });

  it("supports permission-only translation when reply display translation is disabled", async () => {
    expect(notificationFallback("zh-Hans", "permission")).toBe(
      notificationFallback("Chinese", "permission"),
    );
    expect(notificationFallback("unsupported-language", "finished")).toBe("...");
    const h = await harness({ replyTranslationEnabled: false });
    await h.open();
    h.receive({
      type: "session.permission",
      sessionId: "s",
      request: {
        id: "p",
        name: "shell",
        kind: "tool",
        title: "Permission",
        actions: [{ id: "yes", label: "Allow", behavior: "allow" }],
      },
    });
    await h.flush();
    expect(h.requests).toEqual(["Permission"]);
    await h.connection.close();
  });

  it("delivers session closure after an explicit close request", async () => {
    const h = await harness();
    await h.open();
    await h.connection.send({ type: "session.close", sessionId: "s", requestId: "close" });
    const ended = h.wait((event) => event.type === "session.closed");
    h.receive({ type: "session.closed", sessionId: "s" });
    await ended;
    expect(h.events.at(-1)).toMatchObject({ type: "session.closed", sessionId: "s" });
    await h.connection.close();
  });

  it("adds no previews for replay, canceled/failed turns, or duplicate completion", async () => {
    const h = await harness();
    await h.open();
    h.text("Replayed");
    await h.flush();
    h.turn("started");
    h.text("Result");
    h.turn("completed");
    h.turn("completed");
    await h.flush();
    h.turn("started", "cancel");
    h.turn("canceled", "cancel");
    await h.flush();
    h.turn("started", "fail");
    h.turn("failed", "fail");
    await h.flush();
    expect(h.previews()).toHaveLength(1);
    expect(
      h.events.filter((event) => event.type === "session.turn" && event.state === "completed"),
    ).toHaveLength(1);
    await h.connection.close();
  });

  it("passes persist:false host-internal sessions through untouched", async () => {
    const h = await harness({ translate: (source) => `译:${source}` });
    await h.open("internal", false);
    h.turn("started", "t", "internal");
    h.text('{"title": "Real JSON output"}', "m", "internal");
    h.turn("completed", "t", "internal");
    h.receive({
      type: "session.permission",
      sessionId: "internal",
      request: {
        id: "p",
        name: "shell",
        kind: "tool",
        title: "Run command?",
        actions: [{ id: "yes", label: "Allow", behavior: "allow" }],
      },
    });
    await h.flush("internal");
    expect(h.requests).toEqual([]);
    expect(h.previews()).toHaveLength(0);
    expect(
      h.events
        .filter(
          (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
            event.type === "session.turn" && event.sessionId === "internal",
        )
        .map((event) => event.state),
    ).toEqual(["started", "completed"]);
    const timeline = h.events
      .filter(
        (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
          event.type === "timeline.item" && event.sessionId === "internal",
      )
      .map((event) => event.item);
    // The host's runAgent reads its final output from the last contiguous
    // assistant segment: it must stay the model's real reply.
    expect(findLatestAssistantMessageFromTimeline(timeline)).toBe('{"title": "Real JSON output"}');
    expect(h.events.find((event) => event.type === "session.permission")).toMatchObject({
      sessionId: "internal",
      request: { title: "Run command?", actions: [{ id: "yes" }] },
    });
    await h.connection.close();
  });

  it("passes subsessions through untouched, including replay-wrapped child turns", async () => {
    const h = await harness({ translate: (source) => `译:${source}` });
    await h.open();
    h.receive({
      type: "session.opened",
      sessionId: "child",
      parentSessionId: "s",
      toolCallId: "tc-1",
      capabilities: ["prompt.message"],
      restoration: "parent",
      cwd: "/repo",
      title: "Subagent",
    });
    h.turn("started", "t", "child");
    h.text("Replayed child result", "m", "child");
    h.turn("completed", "t", "child");
    h.receive({
      type: "session.permission",
      sessionId: "child",
      request: {
        id: "pc",
        name: "shell",
        kind: "tool",
        title: "Run command?",
        actions: [{ id: "yes", label: "Allow", behavior: "allow" }],
      },
    });
    await h.flush("child");
    expect(h.requests).toEqual([]);
    expect(h.previews()).toHaveLength(0);
    expect(
      h.events
        .filter(
          (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
            event.type === "session.turn" && event.sessionId === "child",
        )
        .map((event) => event.state),
    ).toEqual(["started", "completed"]);
    expect(h.events.find((event) => event.type === "session.permission")).toMatchObject({
      sessionId: "child",
      request: { title: "Run command?" },
    });
    await h.connection.close();
  });

  it("translates permission summaries while keeping the permission input and actions intact", async () => {
    const h = await harness({ translate: () => "允许执行命令？" });
    await h.open();
    const request = {
      id: "p",
      name: "shell",
      kind: "tool" as const,
      title: "Run command?",
      description: "npm test",
      input: { command: "npm test" },
      actions: [{ id: "yes", label: "Allow", behavior: "allow" as const }],
    };
    h.receive({ type: "session.permission", sessionId: "s", request });
    await h.flush();
    const permission = h.events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({
      request: { ...request, title: "允许执行命令？", description: "" },
    });
    if (permission?.type !== "session.permission") throw new Error("No permission");
    expect(
      buildAgentAttentionNotificationPayload({
        reason: "permission",
        serverId: "host",
        workspaceId: "w",
        agentId: "a",
        permissionRequest: { ...permission.request, provider: "test" },
      }).body,
    ).toBe("允许执行命令？");
    expect(request.title).toBe("Run command?");
    await h.connection.close();
  });

  it("uses the translated question instead of Codex's generic title or the bilingual original", async () => {
    const h = await harness();
    await h.open();
    h.receive({
      type: "session.permission",
      sessionId: "s",
      request: {
        id: "p",
        name: "question",
        kind: "question",
        title: "Question",
        input: { questions: [{ question: "选择方案？\nWhich option?" }] },
        actions: [{ id: "yes", label: "Allow", behavior: "allow" }],
      },
    });
    await h.flush();
    expect(h.requests).toEqual(["选择方案？"]);
    await h.connection.close();
  });

  it("keeps untranslated permission details out of notifications when translation fails", async () => {
    const h = await harness({
      translate: () => {
        throw new Error("offline");
      },
    });
    await h.open();
    h.receive({
      type: "session.permission",
      sessionId: "s",
      request: {
        id: "p",
        name: "shell",
        kind: "tool",
        title: "Secret original",
        input: { command: "npm test" },
        actions: [{ id: "yes", label: "Allow", behavior: "allow" }],
      },
    });
    await h.flush();
    expect(h.events.find((event) => event.type === "session.permission")).toMatchObject({
      request: {
        title: notificationFallback("zh", "permission"),
        description: "",
        input: { command: "npm test" },
      },
    });
    await h.connection.close();
  });

  it("uses the previous language for generic previews if settings become unavailable", async () => {
    const h = await harness();
    await h.open();
    h.failConfig();
    h.turn("started");
    h.text("Original");
    h.turn("completed");
    await h.flush();
    expect(completionBody(h.events)).toBe(notificationFallback("zh", "finished"));
    await h.connection.close();
  });

  it("lets another session finish while one translation is blocked", async () => {
    const blocked = deferred<string>();
    const entered = deferred<void>();
    const h = await harness({
      translate: (source) => {
        if (source === "Slow") {
          entered.resolve();
          return blocked.promise;
        }
        return "快速完成。";
      },
    });
    await h.open();
    await h.open("other");
    h.turn("started");
    h.text("Slow");
    h.turn("completed");
    await entered.promise;
    h.turn("started", "fast", "other");
    h.text("Fast", "m", "other");
    h.turn("completed", "fast", "other");
    await h.flush("other");
    expect(
      h.events.some(
        (event) =>
          event.type === "session.turn" && event.sessionId === "s" && event.state === "completed",
      ),
    ).toBe(false);
    expect(h.previews()).toHaveLength(1);
    blocked.resolve("缓慢完成。");
    await h.flush();
    expect(h.previews()).toHaveLength(2);
    await h.connection.close();
  });

  it("interrupts a pending completion without waiting for translation or notifying", async () => {
    const blocked = deferred<string>();
    const entered = deferred<void>();
    const h = await harness({
      translate: () => {
        entered.resolve();
        return blocked.promise;
      },
    });
    await h.open();
    h.turn("started");
    h.text("Slow");
    h.turn("completed");
    await entered.promise;
    await h.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "interrupt" });
    await h.flush();
    expect(h.previews()).toHaveLength(0);
    expect(
      h.events.filter((event) => event.type === "session.turn").map((event) => event.state),
    ).toEqual(["started", "canceled"]);
    blocked.resolve("Too late");
    await h.connection.close();
  });

  it("drops a permission translation after the session closes", async () => {
    const blocked = deferred<string>();
    const entered = deferred<void>();
    const h = await harness({
      translate: () => {
        entered.resolve();
        return blocked.promise;
      },
    });
    await h.open();
    h.receive({
      type: "session.permission",
      sessionId: "s",
      request: {
        id: "p",
        name: "shell",
        kind: "tool",
        title: "Permission",
        actions: [{ id: "yes", label: "Allow", behavior: "allow" }],
      },
    });
    await entered.promise;
    const ended = h.wait((event) => event.type === "session.closed");
    h.receive({ type: "session.closed", sessionId: "s" });
    await ended;
    blocked.resolve("Too late");
    await h.connection.close();
    expect(h.events.filter((event) => event.type === "session.permission")).toHaveLength(0);
  });

  it("preserves already received original text before a session closes", async () => {
    const h = await harness();
    await h.open();
    h.turn("started");
    h.text("Original before close");
    const ended = h.wait((event) => event.type === "session.closed");
    h.receive({ type: "session.closed", sessionId: "s" });
    await ended;
    expect(h.events.slice(-3).map((event) => event.type)).toEqual([
      "session.turn",
      "timeline.item",
      "session.closed",
    ]);
    expect(h.events.at(-2)).toMatchObject({ item: { text: "Original before close" } });
    await h.connection.close();
  });
});

describe("notification preview shares the reply translation", () => {
  type StreamManager = ReturnType<typeof createTranslateStreamManager>;
  async function pollUntilDone(manager: StreamManager, jobId: string): Promise<string> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const result = await manager.poll({ jobId });
      if (result.done) return result.text;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("translation job did not finish");
  }
  const sse = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

  it("serves the app's reply translation from the preview's request", async () => {
    const reply = "## Done\n\nAll **tests** passed.";
    const h = await harness({
      translate: (source) => `ZH:${source}`,
      cacheStore: createMemoryTranslationCacheStore(),
      inflight: createTranslationInflightRegistry(),
    });
    await h.open();
    h.turn("started");
    h.text(reply);
    h.turn("completed");
    await h.flush();
    expect(h.requests).toEqual([reply]);
    const manager = createTranslateStreamManager(h.deps, { coalesceDelayMs: 0 });
    const { jobId } = await manager.start({ text: reply, direction: "agent-to-user", sessionKey: "s" });
    await expect(pollUntilDone(manager, jobId)).resolves.toBe(`ZH:${reply}`);
    // Opening the conversation after the notification bills nothing.
    expect(h.requests).toHaveLength(1);
    manager.dispose();
    await h.connection.close();
  });

  it("keeps the bounded plain excerpt when reply translation is off", async () => {
    const reply = "x".repeat(5_000);
    const h = await harness({
      replyTranslationEnabled: false,
      cacheStore: createMemoryTranslationCacheStore(),
      inflight: createTranslationInflightRegistry(),
    });
    await h.open();
    h.turn("started");
    h.text(reply);
    h.turn("completed");
    await h.flush();
    // The app never reads a full-row translation here, so none is billed.
    expect(h.requests).toEqual(["x".repeat(2_000)]);
    await h.connection.close();
  });

  it("emits the preview from the first streamed text and lets the app join the running request", async () => {
    const release = deferred<void>();
    const encoder = new TextEncoder();
    const head = "甲".repeat(300);
    const tail = "乙".repeat(50);
    const h = await harness({
      cacheStore: createMemoryTranslationCacheStore(),
      inflight: createTranslationInflightRegistry(),
      respond: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(sse(head)));
              await release.promise;
              controller.enqueue(encoder.encode(sse(tail)));
              controller.close();
            },
          }) as unknown as ConstructorParameters<typeof Response>[0],
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    await h.open();
    h.turn("started");
    h.text("Long reply");
    const completed = h.wait((event) => event.type === "session.turn" && event.state === "completed");
    h.turn("completed");
    // The turn completes while the translation is still streaming.
    await completed;
    expect(completionBody(h.events)).toBe(`${"甲".repeat(217)}...`);
    const manager = createTranslateStreamManager(h.deps, { coalesceDelayMs: 0 });
    const { jobId } = await manager.start({ text: "Long reply", direction: "agent-to-user", sessionKey: "s" });
    release.resolve();
    await expect(pollUntilDone(manager, jobId)).resolves.toBe(head + tail);
    expect(h.requests).toHaveLength(1);
    manager.dispose();
    await h.connection.close();
  });

  it("finishes when a streamed heading prefix arrives without its text", async () => {
    const encoder = new TextEncoder();
    const h = await harness({
      respond: () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sse("# ")));
            controller.enqueue(encoder.encode(sse(`Title\n\n${"甲".repeat(300)}`)));
            controller.close();
          },
        }) as unknown as ConstructorParameters<typeof Response>[0],
        { headers: { "content-type": "text/event-stream" } },
      ),
    });
    await h.open();
    h.turn("started");
    h.text("Long reply");
    h.turn("completed");
    await h.flush();
    expect(completionBody(h.events)).toBe(`Title ${"甲".repeat(211)}...`);
    await h.connection.close();
  });
});
