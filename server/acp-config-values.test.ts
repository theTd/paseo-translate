import { describe, expect, it } from "vitest";
import {
  createEmptyValueState,
  denormalizeOutboundFrame,
  normalizeConfigOptions,
  normalizeInboundFrame,
} from "./acp-config-values";

function selectOption(id: string, values: string[], currentValue = ""): Record<string, unknown> {
  return {
    id,
    type: "select",
    name: id,
    currentValue,
    options: values.map((value) => ({ value, label: value.length === 0 ? "Default" : value })),
  };
}

describe("normalizeConfigOptions", () => {
  it("replaces the empty value with a non-empty stand-in and records it", () => {
    const state = createEmptyValueState();
    const options = [selectOption("thought", ["", "low", "high"])];
    expect(normalizeConfigOptions(options, state)).toEqual([
      expect.objectContaining({
        id: "thought",
        currentValue: "default",
        options: [
          { value: "default", label: "Default" },
          { value: "low", label: "low" },
          { value: "high", label: "high" },
        ],
      }),
    ]);
    expect(state.mapped.get("thought")).toBe("default");
  });

  it("falls back to __empty__ when default is a real choice", () => {
    const state = createEmptyValueState();
    const [normalized] = normalizeConfigOptions(
      [selectOption("thought", ["", "default", "low"])],
      state,
    ) as Array<Record<string, unknown>>;
    expect(normalized.currentValue).toBe("__empty__");
    expect((normalized.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      "__empty__",
      "default",
      "low",
    ]);
  });

  it("rewrites grouped options too", () => {
    const state = createEmptyValueState();
    const [normalized] = normalizeConfigOptions(
      [{
        id: "mode",
        type: "select",
        name: "Mode",
        currentValue: "",
        options: [{ group: "g", options: [{ value: "", label: "Default" }] }],
      }],
      state,
    ) as Array<Record<string, unknown>>;
    expect(normalized.options).toEqual([
      { group: "g", options: [{ value: "default", label: "Default" }] },
    ]);
  });

  it("returns the same array when no option carries an empty value", () => {
    const state = createEmptyValueState();
    const options = [selectOption("thought", ["low", "high"], "low")];
    expect(normalizeConfigOptions(options, state)).toBe(options);
  });
});

describe("normalizeInboundFrame", () => {
  it("rewrites result.configOptions", () => {
    const state = createEmptyValueState();
    const frame = { jsonrpc: "2.0", id: 1, result: { configOptions: [selectOption("thought", ["", "low"])] } };
    const normalized = normalizeInboundFrame(frame, state);
    expect(normalized.result.configOptions[0]).toMatchObject({ currentValue: "default" });
    expect(state.mapped.get("thought")).toBe("default");
  });

  it("rewrites session/update config options and passes other frames through untouched", () => {
    const state = createEmptyValueState();
    const update = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { configOptions: [selectOption("thought", [""])] } },
    };
    expect(normalizeInboundFrame(update, state).params.update.configOptions[0]).toMatchObject({
      currentValue: "default",
    });
    const other = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { kind: "text" } } };
    expect(normalizeInboundFrame(other, state)).toBe(other);
  });
});

describe("denormalizeOutboundFrame", () => {
  it("maps the recorded stand-in back to the empty string", () => {
    const state = createEmptyValueState();
    state.mapped.set("thought", "default");
    expect(
      denormalizeOutboundFrame(
        { jsonrpc: "2.0", id: 2, method: "session/set_config_option", params: { sessionId: "s", configId: "thought", value: "default" } },
        state,
      ),
    ).toMatchObject({ params: { value: "" } });
  });

  it("leaves real values and unknown config ids alone", () => {
    const state = createEmptyValueState();
    state.mapped.set("thought", "default");
    const real = { jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId: "s", configId: "thought", value: "low" } };
    expect(denormalizeOutboundFrame(real, state)).toBe(real);
    const unknown = { jsonrpc: "2.0", id: 4, method: "session/set_config_option", params: { sessionId: "s", configId: "mode", value: "default" } };
    expect(denormalizeOutboundFrame(unknown, state)).toBe(unknown);
  });
});
