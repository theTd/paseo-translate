import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvidersHandler } from "./server/providers";
import { createTranslateProvider } from "./server/provider";
// Pre-bundled: keeps the claude-agent-sdk (and its defensive type fallbacks)
// out of the daemon compiler's dependency walk. See server/claude-provider.dist.d.cts.
import { createTranslateClaudeProvider } from "./server/claude-provider.dist.cjs";
import { createTranslateCodexProvider } from "./server/codex-provider";
import { createTranslateHandler } from "./server/translate";
import {
  createTranslateStreamManager,
  createTranslateStreamPollHandler,
  createTranslateStreamStartHandler,
} from "./server/translate";
import {
  createPersistentTranslationCacheStore,
  defaultTranslationCacheDirectory,
} from "./server/translation-cache-store";
import {
  assertConfigured,
  translateProvidersRpc,
  translateSettings,
  translateStreamPollRpc,
  translateStreamStartRpc,
  translateTextRpc,
} from "./shared/translate";

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
  server.registerProvider(createTranslateProvider({ loadConfig, cacheStore }));
  server.registerProvider(createTranslateClaudeProvider({ loadConfig, cacheStore }));
  server.registerProvider(createTranslateCodexProvider({ loadConfig, cacheStore }));
  server.handle(translateTextRpc, createTranslateHandler({ loadConfig, cacheStore }));
  const streamManager = createTranslateStreamManager({ loadConfig, cacheStore });
  server.handle(translateStreamStartRpc, createTranslateStreamStartHandler(streamManager));
  server.handle(translateStreamPollRpc, createTranslateStreamPollHandler(streamManager));
  server.handle(translateProvidersRpc, createProvidersHandler());
  return () => {};
}
