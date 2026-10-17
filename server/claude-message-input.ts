import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** One query owns one input and its unstarted Claude commands. */
export class ClaudeMessageInput {
  private readonly queue: SDKUserMessage[] = [];
  private readonly unstarted = new Map<string, { clearsPermissions: boolean }>();
  private wake: (() => void) | undefined;
  private closed = false;

  readonly iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        while (!this.closed) {
          const message = this.queue.shift();
          if (message) return { value: message, done: false };
          await new Promise<void>((resolve) => { this.wake = resolve; });
          this.wake = undefined;
        }
        return { value: undefined, done: true };
      },
    }),
  };

  push(message: SDKUserMessage, clearsPermissions = false): void {
    if (this.closed) throw new Error("Claude input is closed");
    if (message.uuid) this.unstarted.set(message.uuid, { clearsPermissions });
    this.queue.push(message);
    this.wake?.();
  }

  hasUnstarted(uuid: string): boolean { return this.unstarted.has(uuid); }
  get pendingUuids(): string[] { return [...this.unstarted.keys()]; }

  get clearsPermissions(): boolean {
    return [...this.unstarted.values()].some((entry) => entry.clearsPermissions);
  }

  started(uuid: string): void { this.unstarted.delete(uuid); }

  /** Snapshot before any await: a later user message belongs to the next turn. */
  async withdraw(cancel?: (uuid: string) => Promise<boolean>): Promise<string[]> {
    const ids = [...this.unstarted.keys()];
    const notWithdrawn: string[] = [];
    for (const id of ids) this.unstarted.delete(id);
    for (const id of ids) {
      const index = this.queue.findIndex((message) => message.uuid === id);
      if (index >= 0) { this.queue.splice(index, 1); continue; }
      if (!cancel || !await cancel(id)) notWithdrawn.push(id);
    }
    return notWithdrawn;
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.unstarted.clear();
    this.wake?.();
  }
}
