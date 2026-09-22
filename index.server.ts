import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvidersHandler } from "./server/providers";
import { createTranslateProvider } from "./server/provider";
import { createTranslateHandler } from "./server/translate";
import {
  assertConfigured,
  translateProvidersRpc,
  translateSettings,
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
  server.registerProvider(createTranslateProvider({ loadConfig }));
  server.handle(translateTextRpc, createTranslateHandler({ loadConfig }));
  server.handle(translateProvidersRpc, createProvidersHandler());
  return () => {};
}
