import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { TRANSLATE_AGENT_ID_ENV } from "../shared/translate";

export const claudeForkConfigurationSchema = z.object({ model: z.string().optional(), mode: z.string().optional(),
  thinkingOption: z.string().optional(), settings: z.record(z.string(), z.json()),
  providerOptions: z.record(z.string(), z.json()).optional(),
  systemPrompt: z.string().optional(), env: z.record(z.string(), z.string()).optional() });

/** The daemon supplies fresh identities and tool wiring to the imported agent. */
export function claudeForkEnvironment(env: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    key !== TRANSLATE_AGENT_ID_ENV && key !== "PASEO_AGENT_ID" && key !== "PASEO_AGENT_CWD"));
}

export function claudeForkConfiguration(config: ProviderSessionConfig) {
  return claudeForkConfigurationSchema.parse({ model: config.model, mode: config.mode,
    thinkingOption: config.thinkingOption, settings: { ...config.settings },
    providerOptions: config.providerOptions, systemPrompt: config.systemPrompt,
    env: claudeForkEnvironment(config.env) });
}

export interface ClaudeForkSource {
  claudeSessionId: string;
  configDir: string;
  config: ProviderSessionConfig;
}

/** Shared by the provider and RPC handler; all source mutations use the same queue. */
export class ClaudeForkCoordinator {
  private readonly sources = new Map<string, () => Promise<ClaudeForkSource>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  register(agentId: string, prepare: () => Promise<ClaudeForkSource>): () => void {
    this.sources.set(agentId, prepare);
    return () => { if (this.sources.get(agentId) === prepare) this.sources.delete(agentId); };
  }

  exclusive<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.queues.set(agentId, next);
    const clear = () => { if (this.queues.get(agentId) === next) this.queues.delete(agentId); };
    void next.then(clear, clear);
    return next;
  }

  async prepare(agentId: string): Promise<ClaudeForkSource> {
    const source = this.sources.get(agentId);
    if (!source) throw new Error("Open the source Claude session in Paseo before forking it");
    return source();
  }

}
