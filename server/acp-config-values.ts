/**
 * ACP `select` config options whose value is the empty string.
 *
 * Some inner agents report an empty value as a real choice — observed on a
 * bridge agent's `thought_level` option: `options: ["", "low", "high"]` with
 * `currentValue: ""`. The plugin SDK maps each option value straight to a
 * provider id, and the host's schema requires a non-empty id, so opening a
 * session against such an agent fails with `config.thinkingOptions[0].id:
 * Too small`.
 *
 * This module rewrites the two directions symmetrically, between the inner
 * agent and the host:
 *   inbound (agent → host): swap `""` for a non-empty stand-in (`default`
 *     when free, else `__empty__`) and remember which config option used it;
 *   outbound (host → agent): a `session/set_config_option` that sets the
 *     stand-in is sent as `""` again.
 * Every other frame passes through untouched. Pure functions; the caller owns
 * the per-connection state.
 */

export interface EmptyValueState {
  /** Config option id → stand-in value. */
  readonly mapped: Map<string, string>;
}

export function createEmptyValueState(): EmptyValueState {
  return { mapped: new Map() };
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every value a select option offers, including grouped ones. */
function optionValues(options: unknown[]): unknown[] {
  return options.flatMap((option) => {
    if (!isRecord(option)) return [];
    if (Array.isArray(option.options)) {
      return option.options.map((nested) => (isRecord(nested) ? nested.value : undefined));
    }
    return [option.value];
  });
}

function replaceEmpty(options: unknown[], sentinel: string): unknown[] {
  return options.map((option) => {
    if (!isRecord(option)) return option;
    if (Array.isArray(option.options)) {
      return { ...option, options: replaceEmpty(option.options, sentinel) };
    }
    return option.value === "" ? { ...option, value: sentinel } : option;
  });
}

/** Rewrites a list of config options; returns the same array when nothing uses `""`. */
export function normalizeConfigOptions(
  configOptions: unknown[],
  state: EmptyValueState,
): unknown[] {
  let changed = false;
  const normalized = configOptions.map((option) => {
    if (!isRecord(option) || typeof option.id !== "string" || !Array.isArray(option.options)) {
      return option;
    }
    const values = optionValues(option.options);
    if (!values.includes("") && option.currentValue !== "") return option;
    const sentinel = state.mapped.get(option.id) ?? (values.includes("default") ? "__empty__" : "default");
    state.mapped.set(option.id, sentinel);
    changed = true;
    return {
      ...option,
      options: replaceEmpty(option.options, sentinel),
      ...(option.currentValue === "" ? { currentValue: sentinel } : {}),
    };
  });
  return changed ? normalized : configOptions;
}

/** Inbound frame: `result.configOptions`, or a `session/update` carrying them. */
export function normalizeInboundFrame<T>(message: T, state: EmptyValueState): T {
  if (!isRecord(message)) return message;
  const result = message.result;
  if (isRecord(result) && Array.isArray(result.configOptions)) {
    const next = normalizeConfigOptions(result.configOptions, state);
    if (next !== result.configOptions) return { ...message, result: { ...result, configOptions: next } } as T;
  }
  const params = message.params;
  if (
    message.method === "session/update" &&
    isRecord(params) &&
    isRecord(params.update) &&
    Array.isArray(params.update.configOptions)
  ) {
    const next = normalizeConfigOptions(params.update.configOptions, state);
    if (next !== params.update.configOptions) {
      return { ...message, params: { ...params, update: { ...params.update, configOptions: next } } } as T;
    }
  }
  return message;
}

/** Outbound frame: `session/set_config_option` setting the stand-in means `""`. */
export function denormalizeOutboundFrame<T>(message: T, state: EmptyValueState): T {
  if (!isRecord(message) || message.method !== "session/set_config_option") return message;
  const params = message.params;
  if (!isRecord(params) || typeof params.configId !== "string") return message;
  const sentinel = state.mapped.get(params.configId);
  if (sentinel === undefined || params.value !== sentinel) return message;
  return { ...message, params: { ...params, value: "" } } as T;
}
