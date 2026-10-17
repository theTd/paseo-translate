import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ProviderCommand } from "@getpaseo/plugin/server/provider";

export function codexHome(env: Readonly<Record<string, string>>): string {
  return env.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function parsePrompt(markdown: string): { body: string; description?: string; argumentHint?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) return { body: markdown };
  const fields = Object.fromEntries(match[1].split(/\r?\n/).flatMap((line) => {
    const entry = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    return entry ? [[entry[1], entry[2].replace(/^(["'])([\s\S]*)\1$/, "$2")]] : [];
  }));
  return { body: match[2], description: fields.description, argumentHint: fields["argument-hint"] ?? fields.argument_hint };
}

export async function codexCustomPrompts(home: string): Promise<ProviderCommand[]> {
  let files;
  try { files = await readdir(path.join(home, "prompts"), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return Promise.all(files.filter((file) => file.isFile() && file.name.endsWith(".md")).map(async (file) => {
    const parsed = parsePrompt(await readFile(path.join(home, "prompts", file.name), "utf8"));
    return { name: `prompts:${file.name.slice(0, -3)}`, description: parsed.description ?? "Custom prompt", ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}) };
  }));
}

export async function expandCodexCustomPrompt(home: string, name: string, args: string): Promise<string> {
  const stem = name.slice("prompts:".length);
  if (!stem || /[\\/]/.test(stem) || stem === "." || stem === "..") throw new Error("Invalid custom prompt name");
  const parsed = parsePrompt(await readFile(path.join(home, "prompts", `${stem}.md`), "utf8"));
  const tokens = Array.from(args.matchAll(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g), (match) => match[0].replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_quoted, double: string | undefined, single: string | undefined) => single ?? double!.replace(/\\(["\\])/g, "$1")));
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokens) {
    const equals = token.indexOf("=");
    if (equals > 0) named.set(token.slice(0, equals), token.slice(equals + 1));
    else positional.push(token);
  }
  return parsed.body.replace(/\$(\$|ARGUMENTS\b|[1-9]\d*\b|[A-Za-z_][A-Za-z_0-9]*\b)/g, (match, key: string) => {
    if (key === "$") return "$";
    if (key === "ARGUMENTS") return args.trim();
    if (/^[1-9]\d*$/.test(key)) return positional[Number(key) - 1] ?? "";
    return named.get(key) ?? match;
  });
}
