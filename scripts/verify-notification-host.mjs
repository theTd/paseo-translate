import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Optional integration check against a local Paseo source checkout, without starting a daemon.
// Usage: node scripts/verify-notification-host.mjs <paseo-checkout>
if (!process.argv[2]) throw new Error("Pass the path to a Paseo source checkout");
const paseoRoot = path.resolve(process.argv[2]);
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const hostRequire = createRequire(path.join(paseoRoot, "package.json"));
const pluginRequire = createRequire(path.join(pluginRoot, "package.json"));
const { tsImport } = hostRequire("tsx/esm/api");
const { buildSync } = pluginRequire("esbuild");
async function load(root, relativePath) {
  const module = await tsImport(pathToFileURL(path.join(root, relativePath)).href, import.meta.url);
  return { ...module.default, ...module };
}
function loadPlugin(relativePath) {
  const result = buildSync({
    entryPoints: [path.join(pluginRoot, relativePath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["@getpaseo/plugin", "@getpaseo/plugin/*"],
    write: false,
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    pluginRequire,
    module,
    module.exports,
  );
  return module.exports;
}

const { PluginAgentClientRegistry } = await load(
  paseoRoot,
  "packages/server/src/server/agent/plugin-provider.ts",
);
const { InMemoryAgentTimelineStore } = await load(
  paseoRoot,
  "packages/server/src/server/agent/agent-timeline-store.ts",
);
const { AgentStreamCoalescer } = await load(
  paseoRoot,
  "packages/server/src/server/agent/agent-stream-coalescer.ts",
);
const { buildAgentAttentionNotificationPayload, findLatestAssistantMessageFromTimeline } =
  await load(paseoRoot, "packages/protocol/src/agent-attention-notification.ts");
const { withNotificationTranslation } = loadPlugin("server/notification-provider.ts");
const { translateSettings } = loadPlugin("shared/translate.ts");
const { transformAssistantMessage } = loadPlugin("client/transformer.ts");

let receive;
let rootProviderSessionId;
let translationCalls = 0;
const provider = {
  id: "translate-test",
  label: "Test",
  async connect() {
    return {
      version: 1,
      capabilities: ["prompt.message"],
      onEvent(listener) {
        receive = listener;
        return () => {};
      },
      async send(input) {
        const sessionId = input.sessionId;
        if (input.type === "session.open") {
          if (rootProviderSessionId === undefined) rootProviderSessionId = input.sessionId;
          receive({
            type: "session.opened",
            sessionId,
            requestId: input.requestId,
            cwd: input.config.cwd,
            restoration: "core",
            capabilities: ["prompt.message"],
          });
          receive({ type: "session.ready", sessionId, requestId: input.requestId });
          receive({ type: "request.completed", requestId: input.requestId });
        }
        if (input.type === "session.prompt") {
          receive({ type: "session.turn", sessionId, turnId: "t", state: "started" });
          receive({
            type: "session.prompt_result",
            sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "turn", turnId: "t" },
          });
          for (const text of ["Original", "Original reply."]) {
            receive({
              type: "timeline.item",
              sessionId,
              item: { type: "assistant_message", id: "m", messageId: "m", text },
            });
          }
          receive({ type: "session.turn", sessionId, turnId: "t", state: "completed" });
        }
        if (input.type === "session.close") {
          receive({ type: "session.closed", sessionId });
          receive({ type: "request.completed", requestId: input.requestId });
        }
      },
      async close() {},
    };
  },
};
const values = translateSettings.schema.parse({
  translateNotifications: true,
  userLanguage: "zh-CN",
  agentLanguage: "en",
  endpointBaseUrl: "https://example.invalid/v1",
  endpointModel: "test",
  endpointProtocol: "chat-completions",
});
const wrapped = withNotificationTranslation(provider, {
  loadConfig: async () => values,
  fetchFn: async () => {
    translationCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "任务完成。" } }] }));
  },
});
const registry = new PluginAgentClientRegistry({ warn() {} });
const store = new InMemoryAgentTimelineStore();
store.initialize("a");
const coalescer = new AgentStreamCoalescer({
  timers: { setTimeout, clearTimeout },
  onFlush(event) {
    store.append(event.agentId, event.item, { turnId: event.turnId });
  },
});
try {
  registry.replace([wrapped]);
  const client = registry.clients()["translate-test"];
  const session = await client.createSession({ provider: "translate-test", cwd: process.cwd() });
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const subagentEvents = [];
  let childDone;
  const childFinished = new Promise((resolve) => {
    childDone = resolve;
  });
  session.subscribe((event) => {
    if (coalescer.handle("a", event)) return;
    coalescer.flushFor("a");
    if (event.type === "timeline") store.append("a", event.item, { turnId: event.turnId });
    if (event.type === "turn_completed") finish();
    if (event.type === "provider_subagent") {
      subagentEvents.push(event.event);
      if (event.event.type === "upsert" && event.event.status === "completed") childDone();
    }
  });
  await session.startTurn("hello");
  await finished;
  const items = store.getItems("a");
  assert.equal(items.length, 3);
  assert.equal(items[0].text, "Original reply.");
  assert.equal(items[1].type, "plugin");
  assert.equal(items[2].text, "任务完成。");
  assert.deepEqual(transformAssistantMessage({ item: items[2], phase: "complete" }), { items: [] });
  const notification = buildAgentAttentionNotificationPayload({
    reason: "finished",
    serverId: "host",
    workspaceId: "w",
    agentId: "a",
    assistantMessage: findLatestAssistantMessageFromTimeline(items),
  });
  assert.equal(notification.body, "任务完成。");
  assert.equal(translationCalls, 1);

  // Host-internal structured agent (persistSession:false — the shape git
  // metadata and branch-name generation use): no injected rows, and the
  // timeline's last assistant message stays the model's real run output.
  store.initialize("b");
  const internal = await client.createSession(
    { provider: "translate-test", cwd: process.cwd() },
    undefined,
    { persistSession: false },
  );
  let internalDone;
  const internalFinished = new Promise((resolve) => {
    internalDone = resolve;
  });
  internal.subscribe((event) => {
    if (coalescer.handle("b", event)) return;
    coalescer.flushFor("b");
    if (event.type === "timeline") store.append("b", event.item, { turnId: event.turnId });
    if (event.type === "turn_completed") internalDone();
  });
  await internal.startTurn("hello");
  await internalFinished;
  const internalItems = store.getItems("b");
  assert.equal(internalItems.length, 1);
  assert.equal(internalItems[0].text, "Original reply.");
  assert.ok(!internalItems.some((item) => item.type === "plugin"));
  assert.equal(findLatestAssistantMessageFromTimeline(internalItems), "Original reply.");
  assert.equal(translationCalls, 1);

  // Claude-shaped subsession replay: turn-wrapped child turns must not
  // trigger previews, boundary rows, or translations; the child track row
  // keeps only the real replayed item.
  receive({
    type: "session.opened",
    sessionId: "child",
    parentSessionId: rootProviderSessionId,
    toolCallId: "tc-1",
    capabilities: [],
    restoration: "parent",
    cwd: process.cwd(),
    title: "Subagent",
  });
  receive({ type: "session.turn", sessionId: "child", turnId: "ct", state: "started" });
  receive({
    type: "timeline.item",
    sessionId: "child",
    item: { type: "assistant_message", id: "cm", messageId: "cm", text: "Child result" },
  });
  receive({ type: "session.turn", sessionId: "child", turnId: "ct", state: "completed" });
  await childFinished;
  const childTimeline = subagentEvents
    .filter((event) => event.type === "timeline")
    .map((event) => event.item);
  assert.equal(childTimeline.length, 1);
  assert.equal(childTimeline[0].text, "Child result");
  assert.equal(store.getItems("a").length, 3);
  assert.equal(translationCalls, 1);
  console.log(
    "PASS: real Paseo adapter/coalescer/timeline/notification pipeline with translated preview; internal (persist:false) and subsession replay stay untouched.",
  );
} finally {
  coalescer.flushAndDiscard("a");
  coalescer.flushAndDiscard("b");
  await registry.shutdown();
}
