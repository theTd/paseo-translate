import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

interface MessageText {
  id: string;
  blocks: Map<number, { kind: "text" | "thinking"; text: string }>;
  text: string;
  thinking: string;
}

/** Convert incremental and final SDK content into the plugin's absolute snapshots. */
export class ClaudeMessageStream {
  private readonly messages = new Map<string, MessageText>();
  private activeId: string | undefined;

  clear(): void { this.messages.clear(); this.activeId = undefined; }

  observe(message: SDKMessage): ProviderTimelineItem[] {
    if (message.type === "assistant") {
      if (!Array.isArray(message.message.content)) return [];
      const id = message.message.id || message.uuid;
      if (!id) return [];
      const state = this.get(id);
      state.blocks.clear();
      message.message.content.forEach((block, index) => {
        if (block.type === "text") state.blocks.set(index, { kind: "text", text: block.text });
        else if (block.type === "thinking") state.blocks.set(index, { kind: "thinking", text: block.thinking });
      });
      return this.snapshots(state);
    }
    if (message.type !== "stream_event") return [];
    const event = message.event;
    if (event.type === "message_start") {
      if (!event.message.id) return [];
      this.activeId = event.message.id;
      this.get(this.activeId);
      return [];
    }
    if (!this.activeId) return [];
    const state = this.get(this.activeId);
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "text") state.blocks.set(event.index, { kind: "text", text: block.text });
      else if (block.type === "thinking") state.blocks.set(event.index, { kind: "thinking", text: block.thinking });
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta.type !== "text_delta" && delta.type !== "thinking_delta") return [];
      const kind = delta.type === "text_delta" ? "text" : "thinking";
      const block = state.blocks.get(event.index) ?? { kind, text: "" };
      block.text += delta.type === "text_delta" ? delta.text : delta.thinking;
      state.blocks.set(event.index, block);
    } else return [];
    return this.snapshots(state);
  }

  private get(id: string): MessageText {
    let state = this.messages.get(id);
    if (!state) {
      state = { id, blocks: new Map(), text: "", thinking: "" };
      this.messages.set(id, state);
      const oldest = this.messages.keys().next().value;
      if (this.messages.size > 256 && oldest !== undefined) this.messages.delete(oldest);
    }
    return state;
  }

  private snapshots(state: MessageText): ProviderTimelineItem[] {
    const items: ProviderTimelineItem[] = [];
    const blocks = [...state.blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
    const text = blocks.filter((block) => block.kind === "text").map((block) => block.text).join("");
    const thinking = blocks.filter((block) => block.kind === "thinking").map((block) => block.text).join("");
    if (text && text !== state.text && text !== "[Request interrupted by user]") {
      items.push({ type: "assistant_message", id: state.id, messageId: state.id, text });
      state.text = text;
    }
    if (thinking && thinking !== state.thinking) {
      items.push({ type: "reasoning", id: `${state.id}:thinking`, text: thinking });
      state.thinking = thinking;
    }
    return items;
  }
}
