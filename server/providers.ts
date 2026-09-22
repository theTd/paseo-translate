import type { RpcInput } from "@getpaseo/plugin";
import { knownAcpCommand, translateProvidersRpc } from "../shared/translate";

export type ProvidersHandlerInput = RpcInput<typeof translateProvidersRpc>;

/**
 * Lists the daemon's providers for the settings picker, resolving each
 * selectable entry's ACP launch command:
 *
 * - custom `extends: "acp"` entries use the command configured on the daemon
 *   (read through the SDK's raw config surface; only the command is extracted
 *   — env and keys from the config entry never leave this handler),
 * - built-in ACP providers use their configured command when overridden and
 *   the built-in default otherwise.
 *
 * Custom non-ACP providers (SDK-based overrides like `extends: "claude"`)
 * cannot be wrapped by an ACP proxy and are filtered out.
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
    const providers = snapshot.entries
      .flatMap((entry) => {
        const option = toOption(entry, configured);
        return option === null ? [] : [option];
      })
      .filter((option) => option.selectable)
      // One-tap entries (resolved command) first so they lead the picker.
      .sort(
        (a, b) =>
          Number(b.command !== null) - Number(a.command !== null) || a.id.localeCompare(b.id),
      )
      .map((option) => ({
        id: option.id,
        label: option.label,
        status: option.status,
        command: option.command,
      }));
    return { providers };
  };
}

interface ProviderOption {
  id: string;
  label: string;
  status: "ready" | "loading" | "error" | "unavailable";
  command: string[] | null;
  selectable: boolean;
}

function toOption(entry: unknown, configured: Record<string, unknown>): ProviderOption | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as { provider?: unknown; status?: unknown; label?: unknown };
  if (typeof record.provider !== "string" || record.provider.length === 0) return null;
  const id = record.provider;
  const configEntry = configured[id];
  const isCustomAcp = readExtends(configEntry) === "acp";
  const known = knownAcpCommand(id);
  if (!isCustomAcp && known === null) {
    // Built-in non-ACP provider or custom non-ACP override: an ACP proxy
    // cannot wrap it, so it must not appear in the picker.
    return null;
  }
  return {
    id,
    label: typeof record.label === "string" && record.label.length > 0 ? record.label : id,
    status: readStatus(record.status),
    // A configured command wins (custom ACP entry, or a built-in override);
    // fall back to the built-in default. A custom ACP entry without a usable
    // command stays selectable for manual entry.
    command:
      readAcpCommand(configEntry) ?? (isCustomAcp ? null : known === null ? null : [...known]),
    selectable: true,
  };
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

function readStatus(value: unknown): ProviderOption["status"] {
  return value === "ready" || value === "loading" || value === "error" || value === "unavailable"
    ? value
    : "unavailable";
}
