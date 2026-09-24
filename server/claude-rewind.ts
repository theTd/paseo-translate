import { forkSession as claudeForkSession } from "@anthropic-ai/claude-agent-sdk";

/**
 * Conversation-rewind SDK seam. Mirrors the host app's claude rewind helper:
 * forking a Claude session up to a user message returns the forked session
 * id, which the next query then resumes instead of the original session.
 */
export interface ClaudeForkSessionSdk {
  forkSession(
    sessionId: string,
    options: { upToMessageId: string },
  ): Promise<{ sessionId: string }>;
}

export const forkSession: ClaudeForkSessionSdk = {
  forkSession: claudeForkSession,
};