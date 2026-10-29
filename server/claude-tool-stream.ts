import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { parsePartialJsonObject } from "./claude-partial-json";
import { describeRunningTool } from "./claude-tool-details";
import { createStepTracer } from "./memory-probe";

const step = createStepTracer();

/** Incremental tool arguments use the same partial-JSON parsing rules as native Paseo. */
export class ClaudeToolStream {
  private readonly ids = new Map<number, string>();
  private readonly buffers = new Map<string, string>();

  clear(): void { this.ids.clear(); this.buffers.clear(); }

  observe(message: SDKMessage, names: Map<string, string>, inputs: Map<string, unknown>): ProviderTimelineItem[] {
    if (message.type !== "stream_event") return [];
    const event = message.event;
    if (event.type === "message_start") { this.clear(); return []; }
    let id: string | undefined;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type !== "tool_use") return [];
      id = block.id;
      this.ids.set(event.index, id);
      names.set(id, block.name);
      inputs.set(id, block.input);
    } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
      id = this.ids.get(event.index);
      if (!id) return [];
      const buffer = (this.buffers.get(id) ?? "") + event.delta.partial_json;
      this.buffers.set(id, buffer);
      const doneParse = step.start("claude.tool.parse", `chars=${buffer.length}`);
      const parsed = parsePartialJsonObject(buffer);
      doneParse();
      if (!parsed || (!parsed.complete && Object.keys(parsed.value).length === 0)) return [];
      const doneCompare = step.start("claude.tool.compare", `chars=${buffer.length}`);
      const unchanged = JSON.stringify(inputs.get(id)) === JSON.stringify(parsed.value);
      doneCompare();
      if (unchanged) return [];
      inputs.set(id, parsed.value);
    } else if (event.type === "content_block_stop") {
      id = this.ids.get(event.index);
      this.ids.delete(event.index);
      if (id) this.buffers.delete(id);
      return [];
    } else return [];
    const name = names.get(id);
    if (!name) return [];
    const doneDetail = step.start("claude.tool.detail", name);
    const detail = describeRunningTool(name, inputs.get(id));
    doneDetail();
    return [{ type: "tool_call", id, callId: id, name, status: "running", error: null, detail }];
  }
}
