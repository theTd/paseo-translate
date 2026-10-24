import type { OwnedSubscription, PaseoAgentListResult } from "@getpaseo/client";
import type { PluginClientContext } from "@getpaseo/plugin/client";

export type ObservedAgent = PaseoAgentListResult["entries"][number]["agent"];

/** Paginated SDK observations, shared by agent-scoped composer contributions. */
export function observeAgentList(client: PluginClientContext, register: (agent: ObservedAgent) => void,
  remove: (id: string) => void): () => void {
  const lifetime = new AbortController();
  let stopped = false;
  const known = new Set<string>();
  interface Page {
    active: boolean;
    agents: Map<string, ObservedAgent>;
    next?: Page;
    subscription?: OwnedSubscription<PaseoAgentListResult>;
    unsubscribe?: () => void;
  }
  function release(page: Page | undefined): void {
    if (!page) return;
    page.active = false;
    release(page.next);
    page.unsubscribe?.();
    void page.subscription?.release().catch((error) => console.error("Agent observation release failed", error));
  }
  function reconcile(): void {
    const agents = new Map<string, ObservedAgent>();
    for (let page: Page | undefined = firstPage; page; page = page.next) {
      for (const [id, agent] of page.agents) agents.set(id, agent);
    }
    for (const id of known) if (!agents.has(id)) { remove(id); known.delete(id); }
    for (const agent of agents.values()) { known.add(agent.id); register(agent); }
  }
  function observePage(cursor?: string): Page {
    const page: Page = { active: true, agents: new Map() };
    void client.paseo.agents.list({ page: { limit: 200, cursor }, subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        page.subscription = subscription;
        if (stopped || !page.active) { release(page); return; }
        page.unsubscribe = subscription.subscribe({
          snapshot: ({ entries, pageInfo }) => {
            if (stopped || !page.active) return;
            release(page.next);
            page.next = undefined;
            page.agents = new Map(entries.map(({ agent }) => [agent.id, agent]));
            if (pageInfo.nextCursor) page.next = observePage(pageInfo.nextCursor);
            reconcile();
          },
          update: (message) => {
            if (stopped || !page.active || message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind !== "remove") firstPage.agents.set(update.agent.id, update.agent);
            for (let current: Page | undefined = firstPage; current; current = current.next) {
              if (update.kind === "remove") current.agents.delete(update.agentId);
              else if (current.agents.has(update.agent.id)) current.agents.set(update.agent.id, update.agent);
            }
            if (update.kind === "remove") { known.delete(update.agentId); remove(update.agentId); }
            else { known.add(update.agent.id); register(update.agent); }
          },
        });
      }).catch((error) => { if (!stopped && page.active) console.error("Agent observation failed", error); });
    return page;
  }
  const firstPage = observePage();
  return () => { stopped = true; lifetime.abort(); release(firstPage); };
}
