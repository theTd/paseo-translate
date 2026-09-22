import type { RpcInput } from "@getpaseo/plugin";
import {
  ACP_ADAPTER_PRESETS,
  adapterCommand,
  knownAcpCommand,
  translateProvidersRpc,
} from "../shared/translate";

export type ProvidersHandlerInput = RpcInput<typeof translateProvidersRpc>;

interface ListedProvider {
  id: string;
  label: string;
  status: "ready" | "loading" | "error" | "unavailable";
  command: string[] | null;
  acp: "known" | "adapter" | "unknown";
}

/**
 * Lists selectable inner agents for the settings picker.
 *
 * Daemon providers resolve their ACP launch command when one is known:
 * custom `extends: "acp"` entries use the command configured on the daemon
 * (read through the SDK's raw config surface — only the command is
 * extracted, env and keys never leave this handler), and CLIs with a
 * verified ACP subcommand (`copilot --acp`, `omp acp`, ...) use the table.
 * A CLI's ACP capability is independent of Paseo's built-in integration
 * protocol, so the remaining daemon providers stay listed as `unknown`:
 * their CLI may still ship an ACP mode the picker cannot detect, and manual
 * entry applies. Adapter presets for CLIs without a native ACP mode are
 * appended with a Windows-compatible `cmd /c` npx shim.
 */
export function createProvidersHandler() {
  return async function handleProviders(
    input: ProvidersHandlerInput,
    context: {
      paseo: {
        providers: { snapshot(): Promise<{ entries: unknown[] }> };
        config: { get(): Promise<{ config: { providers?: unknown } }> };
      };
    },
  ) {
    translateProvidersRpc.input.parse(input);
    const [snapshot, configResult] = await Promise.all([
      context.paseo.providers.snapshot(),
      // Daemons without the SDK config face (older than the manifest floor
      // was tested against) degrade to built-in defaults: custom ACP entries
      // are simply absent instead of breaking the whole picker.
      context.paseo.config.get().catch(() => null),
    ]);
    const configured = readProvidersRecord(configResult?.config.providers);
    const daemon = snapshot.entries.flatMap((entry) => {
      const option = toOption(entry, configured);
      return option === null ? [] : [option];
    });
    const presets: ListedProvider[] = ACP_ADAPTER_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      status: "ready",
      command: [...adapterCommand(preset, process.platform)],
      acp: "adapter",
    }));
    // Resolved commands first, adapter presets next, unknown-capability
    // daemon providers last; alphabetical within each tier.
    const providers = [...daemon, ...presets].sort(byUsefulnessThenLabel);
    return { providers };
  };
}

function toOption(
  entry: unknown,
  configured: Record<string, unknown>,
): ListedProvider | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as { provider?: unknown; status?: unknown; label?: unknown };
  if (typeof record.provider !== "string" || record.provider.length === 0) return null;
  const id = record.provider;
  const configEntry = configured[id];
  const isCustomAcp = readExtends(configEntry) === "acp";
  const known = knownAcpCommand(id);
  // Custom ACP entries use their configured command (or degrade to manual
  // when unusable). Known-CLI entries prefer a configured override. Everyone
  // else must never borrow an entry's command: an SDK override's command
  // (e.g. bare `claude` without an ACP mode) does not speak ACP on stdio.
  const command = isCustomAcp
    ? readAcpCommand(configEntry)
    : known === null
      ? null
      : (readAcpCommand(configEntry) ?? [...known]);
  return {
    id,
    label: typeof record.label === "string" && record.label.length > 0 ? record.label : id,
    status: readStatus(record.status),
    command,
    acp: command !== null ? "known" : "unknown",
  };
}

function byUsefulnessThenLabel(a: ListedProvider, b: ListedProvider): number {
  return tier(a) - tier(b) || a.label.localeCompare(b.label);
}

function tier(provider: ListedProvider): number {
  if (provider.acp === "known") return 0;
  if (provider.acp === "adapter") return 1;
  return 2;
}

function readProvidersRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readExtends(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return undefined;
  return (entry as { extends?: unknown }).extends;
}

/** Extracts the configured launch command; rejects anything unsafe to spawn. */
function readAcpCommand(entry: unknown): string[] | null {
  if (typeof entry !== "object" || entry === null) return null;
  const command = (entry as { command?: unknown }).command;
  if (!Array.isArray(command) || command.length === 0) return null;
  if (!command.every((part) => typeof part === "string" && part.trim().length > 0)) return null;
  return command.slice();
}

function readStatus(value: unknown): ListedProvider["status"] {
  return value === "ready" || value === "loading" || value === "error" || value === "unavailable"
    ? value
    : "unavailable";
}
