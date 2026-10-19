import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The operation ID survives retries so an import failure never creates another copy. */
export const forkClaudeSessionRpc = defineRpc({
  name: "claude-session.fork",
  input: z.object({ agentId: z.string().min(1), operationId: z.uuid() }),
  output: z.discriminatedUnion("kind", [
    /** The daemon caps plugin RPCs at 30s; long copies/imports continue server-side. */
    z.object({ kind: z.literal("in_progress"), operationId: z.uuid().optional() }),
    z.object({ kind: z.literal("forked"), agentId: z.string(), claudeSessionId: z.uuid(), copiedFiles: z.number().int() }),
    z.object({ kind: z.literal("restart_required"), message: z.string() }),
  ]),
});
export type ClaudeSessionForkResult = z.output<typeof forkClaudeSessionRpc.output>;
