import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { createTranslatingAcpStream } from "./acp-connector";
import { createTranslator, type TranslatorDeps } from "./translate";
import {
  TRANSLATE_PROVIDER_ID,
  TRANSLATE_PROVIDER_LABEL,
  assertAcpConfigured,
} from "../shared/translate";

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
    icon: "icon.svg",
    async connector() {
      const values = await deps.loadConfig();
      assertAcpConfigured(values);
      return createTranslatingAcpStream({
        command: values.innerAgentCommand,
        env: values.innerAgentEnv,
        translate: values.translatePrompts
          ? (text) => translator.translate(text, "user-to-agent")
          : passThrough,
      });
    },
  });
  return {
    ...registration,
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
