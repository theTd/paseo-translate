import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvidersHandler } from "./server/providers";
import { createTranslateProvider } from "./server/provider";
// Pre-bundled: keeps the claude-agent-sdk (and its defensive type fallbacks)
// out of the daemon compiler's dependency walk. See server/claude-provider.dist.d.cts.
import { createTranslateClaudeProvider } from "./server/claude-provider.dist.cjs";
import { createTranslateCodexProvider } from "./server/codex-provider";
import { ClaudeForkCoordinator } from "./server/claude-fork-coordinator";
import { ClaudeCacheCompactionCoordinator } from "./server/claude-cache-compaction";
import { createClaudeCachePreferenceStore } from "./server/claude-cache-preferences";
import { CLAUDE_CACHE_OPTIONS_KEY, claudeCacheSettings, claudeCacheStatusRpc,
  claudeCacheConfigureRpc } from "./shared/claude-cache-compaction";
import { createClaudeSessionForkHandler } from "./server/claude-session-fork";
import { forkClaudeSessionRpc } from "./shared/claude-session-fork";
import { createTranslateHandler } from "./server/translate";
import {
  createTranslateStreamCancelHandler,
  createTranslateStreamManager,
  createTranslateStreamPollHandler,
  createTranslateStreamStartHandler,
} from "./server/translate";
import { createTranslationInflightRegistry } from "./server/translation-inflight";
import {
  createPersistentTranslationCacheStore,
  defaultTranslationCacheDirectory,
} from "./server/translation-cache-store";
import { createTranslationContextManager } from "./server/translation-context";
import { createFileDiagnosticSink, createMemoryProbe, createStepTracer, diagnosticProbesEnabled,
  memoryProbeOptionsFromEnv, setDiagnosticSink } from "./server/memory-probe";
import { installProcessDiagnostics } from "./server/process-diagnostics";
import { createCpuProfileRecorder } from "./server/cpu-profile";
import { createHeapProfileRecorder } from "./server/heap-profile";
import { withNotificationTranslation } from "./server/notification-provider";
import {
  assertConfigured,
  TRANSLATE_AGENT_ID_ENV,
  TRANSLATE_PROVIDER_IDS,
  translateProvidersRpc,
  translateSettings,
  translateStreamCancelRpc,
  translateStreamPollRpc,
  translateStreamStartRpc,
  translateTextRpc,
} from "./shared/translate";

/** Persisted terminology memories share the cache directory, in their own file. */
const CONTEXT_MEMORY_CAPACITY = 500;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(translateSettings);
  // Fail closed at use time: incomplete settings reject here with a clear
  // error instead of letting untranslated text reach the agent.
  const loadConfig = async () => {
    const state = await settings.read();
    if (state.status !== "ready") {
      throw new Error(`Translate plugin settings are invalid: ${state.error}`);
    }
    assertConfigured(state.values);
    return state.values;
  };
  // One disk-backed cache shared by every translator in this process
  // (ACP provider, Claude provider, Codex provider, timeline renderer RPC): translations
  // survive daemon restarts and plugin updates, so reopening a session is
  // served from disk instead of re-billing the endpoint.
  const cacheStore = createPersistentTranslationCacheStore({
    directory: defaultTranslationCacheDirectory(),
  });
  // One process-wide transcript manager, shared like the cache: every
  // translation for the same agent (prompt path, display path, questions)
  // feeds one transcript, so terminology stays consistent for the
  // conversation. The direct providers key it by agent id (injected into the
  // session env below); the ACP proxy keys it by the inner ACP session id,
  // which is restart-stable but separate from the display path's agent id.
  const context = createTranslationContextManager({
    loadConfig,
    memoryStore: createPersistentTranslationCacheStore({
      directory: path.join(defaultTranslationCacheDirectory(), "context"),
      maxEntries: CONTEXT_MEMORY_CAPACITY,
    }),
  });
  // One single-flight registry, shared like the cache: the prompt path, the
  // display jobs of every client and the notification previews join one
  // running request per text instead of each billing their own.
  const inflight = createTranslationInflightRegistry();
  // Diagnostics for the one failure this host cannot report itself: when the
  // plugin process dies of V8 heap exhaustion the daemon records only "Plugin
  // process exited", so the growth has to be visible before the fatal GC. The
  // gauges are the stores every provider writes through — cache, in-flight
  // registry, context scopes — so a climbing heap either shows up in one of
  // them or is held inside a provider's own per-session state.
  // Diagnostics go to a file this plugin owns, not only to the host's log:
  // a rotated daemon log has already swallowed a full crash trace once.
  setDiagnosticSink(createFileDiagnosticSink({
    file: path.join(defaultTranslationCacheDirectory(), "trace.log"),
  }));
  installProcessDiagnostics();
  const probesEnabled = diagnosticProbesEnabled();
  const cpuProfile = probesEnabled ? createCpuProfileRecorder({
    file: path.join(defaultTranslationCacheDirectory(), "current.cpuprofile"),
  }) : undefined;
  cpuProfile?.start();
  const heapProfile = probesEnabled ? createHeapProfileRecorder({
    file: path.join(defaultTranslationCacheDirectory(), "current.heapprofile"),
  }) : undefined;
  heapProfile?.start();
  const memoryProbe = probesEnabled ? createMemoryProbe(memoryProbeOptionsFromEnv()) : undefined;
  memoryProbe?.track({ name: "cache", read: () => cacheStore.stats() });
  memoryProbe?.track({ name: "inflight", read: () => inflight.stats() });
  memoryProbe?.track({ name: "context", read: () => context.stats() });
  memoryProbe?.start();
  const deps = { loadConfig, cacheStore, context, inflight };
  const forkCoordinator = new ClaudeForkCoordinator();
  const cacheDefaults = server.registerSettings(claudeCacheSettings);
  const cacheCoordinator = new ClaudeCacheCompactionCoordinator(createClaudeCachePreferenceStore(
    path.join(defaultTranslationCacheDirectory(), "claude-cache-preferences")));
  // Snapshot only at creation. Old/resumed agents without this seed stay off.
  const offCacheCreate = server.before("agent.create", async ({ request }) => {
    if (request.config.provider !== "translate-claude" || request.config.internal) return;
    const defaults = await cacheDefaults.read();
    if (defaults.status !== "ready") throw new Error("Claude cache defaults are invalid");
    const options = request.config.providerOptions ?? {};
    return { ...request, config: { ...request.config, providerOptions: { ...options,
      [CLAUDE_CACHE_OPTIONS_KEY]: options[CLAUDE_CACHE_OPTIONS_KEY] ?? defaults.values } } };
  });
  const offCacheArchive = server.on("agent.archived", ({ agent }) => cacheCoordinator.suspend(agent.id));
  const offCacheClose = server.on("agent.closed", ({ agent }) => cacheCoordinator.suspend(agent.id));
  server.handle(claudeCacheStatusRpc, ({ agentId }) => cacheCoordinator.status(agentId));
  server.handle(claudeCacheConfigureRpc, ({ agentId, preferences }) => cacheCoordinator.configure(agentId, preferences));
  // Bridge the agent id into our providers' session env: the daemon assigns
  // providers a fresh random session id per open, so without this the prompt
  // path could not share a transcript with the client display path (which
  // scopes by agent id) and memories would orphan on every restart.
  const offSessionOpen = server.before("agent.session_open", ({ request }) => {
    if (!(TRANSLATE_PROVIDER_IDS as readonly string[]).includes(request.provider)) return;
    return { ...request, env: { ...request.env, [TRANSLATE_AGENT_ID_ENV]: request.agentId } };
  });
  server.registerProvider(withNotificationTranslation(createTranslateProvider(deps), deps));
  server.registerProvider(withNotificationTranslation(createTranslateClaudeProvider({ ...deps, forkCoordinator, cacheCoordinator }), deps));
  server.handle(forkClaudeSessionRpc, createClaudeSessionForkHandler({ coordinator: forkCoordinator }));
  server.registerProvider(withNotificationTranslation(createTranslateCodexProvider(deps), deps));
  const step = createStepTracer();
  const translateHandler = createTranslateHandler(deps);
  // The daemon's `Plugin RPC timed out: translate.invoke` is the only signal a
  // stalled translation leaves today; pairing it with a step marker says
  // whether the handler itself is stuck or the plugin never got to it.
  server.handle(translateTextRpc, (input) => {
    const done = step.start("rpc.translate.invoke", `chars=${input.text.length}`);
    return translateHandler(input).finally(done);
  });
  const streamManager = createTranslateStreamManager(deps);
  server.handle(translateStreamStartRpc, createTranslateStreamStartHandler(streamManager));
  server.handle(translateStreamPollRpc, createTranslateStreamPollHandler(streamManager));
  server.handle(translateStreamCancelRpc, createTranslateStreamCancelHandler(streamManager));
  server.handle(translateProvidersRpc, createProvidersHandler());
  return () => {
    void cpuProfile?.dispose();
    void heapProfile?.dispose();
    memoryProbe?.dispose();
    offSessionOpen();
    offCacheCreate();
    offCacheArchive();
    offCacheClose();
    cacheCoordinator.dispose();
    streamManager.dispose();
    context.dispose();
  };
}
