import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { createTranslatingAcpStream } from "./acp-connector";
import { createTranslator, type TranslatorDeps } from "./translate";
import {
  TRANSLATE_PROVIDER_ID,
  TRANSLATE_PROVIDER_LABEL,
  assertAcpConfigured,
  resolveTranslationContextKey,
} from "../shared/translate";

/**
 * Agent id of the session being opened, visible to `connector()`. The ACP
 * runner calls `connector()` without arguments, once per session, inside the
 * async work started by `send(session.open)`; running that send in this
 * storage hands the bridged agent id to exactly that connection, however
 * many sessions open concurrently. Outside an open (catalog, session list)
 * the store is empty and frames fall back to their inner session id.
 */
const openingAgent = new AsyncLocalStorage<string>();

/**
 * Registers one ACP provider that wraps the configured inner agent command.
 * Every prompt is translated into the agent language before the inner agent
 * sees it; everything the agent emits streams back untouched.
 */
export function createTranslateProvider(deps: TranslatorDeps): ProviderRegistration {
  const translator = createTranslator(deps);
  const registration = runAcpProvider({
    id: TRANSLATE_PROVIDER_ID,
    label: TRANSLATE_PROVIDER_LABEL,
    description:
      "Converses in your language while the wrapped ACP agent works in its own. Prompts are translated before they reach the agent; replies are translated in the app after the stream completes.",
    icon: "icons/acp-translate.svg",
    async connector() {
      const scopeKey = openingAgent.getStore();
      const values = await deps.loadConfig();
      assertAcpConfigured(values);
      return createTranslatingAcpStream({
        command: values.innerAgentCommand,
        env: values.innerAgentEnv,
        ...(scopeKey !== undefined ? { scopeKey } : {}),
        translate: values.translatePrompts
          ? (text, contextKey) => translator.translate(text, "user-to-agent", { contextKey })
          : passThrough,
        rememberPromptDisplay: values.translatePrompts
          ? (fragments, contextKey) => translator.rememberPromptDisplay(fragments, { contextKey })
          : undefined,
        // Question-like permission requests and session-list titles inbound
        // from the inner agent render in the app untranslated (the timeline
        // renderer only owns assistant messages), so they are translated here
        // for display. Titles prefer the exact prompt-time originals.
        translateDisplay: values.translateResponses
          ? (text, contextKey) => translator.translate(text, "agent-to-user", { contextKey })
          : undefined,
        restoreOriginal: (fragment) => {
          try {
            return translator.restoreOriginalFragment(fragment);
          } catch {
            return undefined;
          }
        },
      });
    },
  });
  return {
    ...registration,
    async connect(request) {
      const connection = await registration.connect(request);
      return {
        ...connection,
        send(input) {
          if (input.type !== "session.open") return connection.send(input);
          const agentId = resolveTranslationContextKey(input.config.env, "");
          return agentId.length > 0
            ? openingAgent.run(agentId, () => connection.send(input))
            : connection.send(input);
        },
      };
    },
    async getCatalogCacheKey(options) {
      const values = await deps.loadConfig();
      // Equivalent commands share discovery; endpoint and languages do not
      // affect the catalog. Workspace discovery depends on the target
      // directory (agents may expose project-specific modes), and `force` is
      // intentionally ignored.
      return options.scope === "workspace"
        ? JSON.stringify({ command: values.innerAgentCommand, cwd: options.cwd })
        : JSON.stringify({ command: values.innerAgentCommand });
    },
  };
}

function passThrough(text: string): Promise<string> {
  return Promise.resolve(text);
}
