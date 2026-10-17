/** Claude persists control messages alongside user-visible conversation content. */
export function isClaudeTranscriptNoise(text: string): boolean {
  const value = text.trim();
  return /^\[Request interrupted by user(?:[^\]]*)\]$/.test(value) ||
    value === "No response requested." ||
    /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(value);
}

export function isClaudeSyntheticUserEntry(entry: Record<string, unknown>): boolean {
  return entry.isSynthetic === true || entry.isMeta === true || Boolean(entry.toolUseResult);
}

export function claudeUserText(content: unknown): string | undefined {
  const parts = typeof content === "string" ? [content] : Array.isArray(content)
    ? content.flatMap((block: unknown) => {
      if (typeof block !== "object" || block === null) return [];
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    }) : [];
  const text = parts.filter((part) => !isClaudeTranscriptNoise(part)).join("\n").trim();
  return text || undefined;
}
