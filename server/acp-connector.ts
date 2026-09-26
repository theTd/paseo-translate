import { spawn } from "node:child_process";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { isSerializedAttachment, restorePromptFragment, translatePromptFragment } from "./prompt-text";
import {
  MAX_SESSION_LIST_TITLES_PER_FRAME,
  SESSION_TITLE_DISPLAY_LIMIT,
} from "./session-titles";
export interface TranslatingConnectorConfig {
  /** argv of the inner ACP-speaking agent, e.g. ["node", "agent.js"]. */
  command: readonly string[];
  env?: Readonly<Record<string, string>>;
  /**
   * Translates one user-language text fragment into the agent language.
   * Fail closed: when this rejects, the prompt never reaches the inner agent.
   */
  translate(text: string): Promise<string>;
  /**
   * Translates one agent-language text fragment into the user language for
   * display. Used for question-like `session/request_permission` requests
   * inbound from the inner agent (chooser options, titles, and text content)
   * and `session/list` result titles; option ids, kinds, raw input/output,
   * diffs, and paths always pass through untouched so agent behavior never
   * changes. Absent means no inbound translation. Fail soft: a rejection
   * delivers the original frame rather than breaking the turn.
   */
  translateDisplay?: (text: string) => Promise<string>;
  /**
   * Exact user-language original for a previously translated fragment, if the
   * reverse entry is still cached. Session-list titles prefer this over a
   * billed display translation; a miss falls through to translateDisplay.
   */
  restoreOriginal?: (translatedFragment: string) => string | undefined;
}

const KILL_GRACE_MS = 3_000;

/**
 * A full-duplex ACP stream proxy in front of the inner agent process.
 *
 * Outbound (daemon → agent): `session/prompt` requests get every text content
 * block translated before the frame is forwarded (serialized-attachment JSON
 * blocks pass verbatim), and `session/new`/`session/load` system prompts are
 * translated too. Permission *responses* (`session/request_permission`
 * results) carry only the selected option id, so they need no translation and
 * pass through verbatim. All other frames pass through verbatim. Writes are
 * serialized so frame order is preserved.
 *
 * Inbound (agent → daemon): most frames pass through untouched — the live
 * stream stays in the agent language. Two display-only exceptions, both fail
 * soft (a failed translation delivers the original frame): question-like
 * `session/request_permission` requests (chooser shape: a repeated allow
 * option kind, which is how inner agents surface clarifying questions with
 * answer options — their human-readable title, option names, and text
 * content are translated into the user language so the permission card
 * renders translated) and `session/list` result titles (the inner agent's
 * own titles; exact prompt-time originals always restore first, the display
 * path needs translateDisplay, only the first 100 entries translate and
 * over-long titles stay verbatim). Everything addressable (ids, kinds, raw
 * input, diffs, terminals, locations) stays verbatim.
 *
 * When a prompt translation fails, a JSON-RPC error response with the same id is
 * synthesized back to the adapter and the original frame is dropped: the
 * agent never sees untranslated user text.
 */
export function createTranslatingAcpStream(config: TranslatingConnectorConfig): AcpStream {
  const [executable, ...args] = config.command;
  if (!executable || executable.trim().length === 0) {
    throw new Error("Translate connector requires an inner agent command");
  }
  const child = spawn(executable, args, {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => undefined);
  child.stdin.on("error", () => undefined);

  let teardownStarted = false;
  let killTimer: NodeJS.Timeout | null = null;
  let inboundController: ReadableStreamDefaultController<AcpStreamMessage> | null = null;
  let inboundSettled = false;
  const pendingInbound: AcpStreamMessage[] = [];

  const enqueueInbound = (message: AcpStreamMessage): void => {
    if (inboundSettled) return;
    pendingInbound.push(message);
    flushInbound();
  };

  const flushInbound = (): void => {
    // The controller is only assigned once in `start` and never reset, so a
    // single check is enough; the loop drains the synchronously-held queue.
    if (inboundController === null) return;
    const controller = inboundController;
    while (pendingInbound.length > 0) {
      controller.enqueue(pendingInbound.shift() as AcpStreamMessage);
    }
  };

  const closeInbound = (): void => {
    if (inboundSettled) return;
    inboundSettled = true;
    try {
      inboundController?.close();
    } catch {
      // Already closed or errored by the stream consumer.
    }
  };

  const failInbound = (error: unknown): void => {
    if (inboundSettled) return;
    inboundSettled = true;
    try {
      inboundController?.error(error);
    } catch {
      // Already closed or errored by the stream consumer.
    }
  };

  const startTeardown = (): void => {
    if (teardownStarted) return;
    teardownStarted = true;
    child.stdin.end();
    child.kill("SIGTERM");
    // The DOM-vs-Node timer declarations clash with the SDK dependency's
    // bundled types; unify through the Node shape we actually run on.
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS) as unknown as NodeJS.Timeout;
    killTimer.unref?.();
  };

  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      inboundController = controller;
      flushInbound();
    },
    cancel() {
      startTeardown();
    },
  });

  child.on("error", (error) => {
    failInbound(new Error(`Translate connector could not start the inner agent: ${error.message}`));
    startTeardown();
  });
  child.once("close", () => {
    if (killTimer !== null) clearTimeout(killTimer);
    // Deliberately not drained through the lane: a frame still translating
    // when the agent exits belongs to a dead session — surfacing it would
    // show a permission card no answer can ever reach.
    closeInbound();
  });

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  // Serialized inbound lane: permission-question translation is async, and
  // the lane keeps inbound frame order identical to the agent's emission
  // order while each line is handled.
  let inboundLane: Promise<void> = Promise.resolve();
  const scheduleInboundLine = (line: string): void => {
    inboundLane = inboundLane.then(
      () => handleInboundLine(line),
      () => handleInboundLine(line),
    );
  };
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      scheduleInboundLine(line);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stdout.once("end", () => {
    const rest = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (rest.length > 0) scheduleInboundLine(rest);
  });

  async function handleInboundLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;
    let parsed: AcpStreamMessage;
    try {
      parsed = JSON.parse(line) as AcpStreamMessage;
    } catch (error) {
      failInbound(
        new Error(
          `Inner agent emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    try {
      enqueueInbound(await maybeTranslateInbound(parsed));
    } catch {
      // The stream closed or errored while a translation was in flight;
      // the frame has nowhere to go, so drop it instead of rejecting the
      // lane (enqueueInbound itself already no-ops once settled).
    }
  }

  /**
   * Display-only translation inbound (agent → daemon). Two cases, both fail
   * soft — anything unrecognized passes through verbatim, and any failure
   * delivers the original frame so inbound text never breaks the turn:
   * question-like `session/request_permission` choosers, and `session/list`
   * result titles.
   */
  async function maybeTranslateInbound(message: AcpStreamMessage): Promise<AcpStreamMessage> {
    if ("result" in message) {
      return maybeTranslateSessionList(message);
    }
    const display = config.translateDisplay;
    if (display === undefined) return message;
    if (!("method" in message) || message.method !== "session/request_permission") {
      return message;
    }
    return maybeTranslatePermission(message, display);
  }
  async function maybeTranslatePermission(
    message: AcpStreamMessage,
    display: (text: string) => Promise<string>,
  ): Promise<AcpStreamMessage> {
    if (!("params" in message)) return message;
    if (!isRecord(message.params)) return message;
    const params = message.params;
    if (!isRecord(params.toolCall) || !Array.isArray(params.options)) return message;
    if (!isChooserOptions(params.options)) return message;
    try {
      const translatedParams = {
        ...params,
        toolCall: await translatePermissionToolCall(params.toolCall, display),
        options: await translatePermissionOptions(params.options, display),
      };
      return { ...message, params: translatedParams };
    } catch {
      return message;
    }
  }

  /**
   * Translates `session/list` result titles for display. Exact prompt-time
   * originals restore even when display translation is off (no endpoint
   * call); the display path needs translateDisplay. Only the first
   * MAX_SESSION_LIST_TITLES_PER_FRAME entries translate — the rest pass
   * through — and over-long titles stay verbatim, so a hostile inner agent
   * cannot stall the inbound lane or bill without bound.
   */
  async function maybeTranslateSessionList(message: AcpStreamMessage): Promise<AcpStreamMessage> {
    if (!("result" in message)) return message;
    if (!isRecord(message.result)) return message;
    if (!Array.isArray(message.result.sessions)) return message;
    const entries = message.result.sessions;
    try {
      const translatedSessions: unknown[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        if (index >= MAX_SESSION_LIST_TITLES_PER_FRAME) {
          translatedSessions.push(...entries.slice(index));
          break;
        }
        translatedSessions.push(await translateSessionInfoTitle(entries[index]));
      }
      return {
        ...message,
        result: { ...message.result, sessions: translatedSessions },
      };
    } catch {
      return message;
    }
  }

  async function translateSessionInfoTitle(entry: unknown): Promise<unknown> {
    if (!isRecord(entry)) return entry;
    const title = entry.title;
    if (typeof title !== "string" || title.length === 0) return entry;
    if (isSerializedAttachment(title)) return entry;
    const restored = restoreSessionTitle(title);
    if (restored !== title) return { ...entry, title: restored };
    const display = config.translateDisplay;
    if (display === undefined) return entry;
    if (title.length > SESSION_TITLE_DISPLAY_LIMIT) return entry;
    try {
      const translated = await translatePromptFragment(title, display);
      if (translated.trim().length === 0) return entry;
      return { ...entry, title: translated };
    } catch {
      return entry;
    }
  }

  function restoreSessionTitle(title: string): string {
    const restore = config.restoreOriginal;
    if (restore === undefined) return title;
    try {
      return restorePromptFragment(title, (fragment) => safeRestore(restore, fragment));
    } catch {
      return title;
    }
  }
  // Serialized write lane: every outbound frame is forwarded in arrival order,
  // and the WritableStream waits on the lane so backpressure is preserved.
  let writeLane: Promise<void> = Promise.resolve();
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      writeLane = writeLane.then(
        () => forward(message),
        () => forward(message),
      );
      return writeLane;
    },
    close() {
      startTeardown();
    },
    abort() {
      startTeardown();
    },
  });

  async function forward(message: AcpStreamMessage): Promise<void> {
    const rewritten = await rewriteFrame(message);
    if (rewritten === null || teardownStarted) return;
    try {
      child.stdin.write(`${JSON.stringify(rewritten)}\n`);
    } catch {
      // write-after-end racing teardown; the inbound close reports the exit.
    }
  }

  /** Returns the frame to forward, or null when it was blocked. */
  async function rewriteFrame(message: AcpStreamMessage): Promise<AcpStreamMessage | null> {
    if (!("method" in message)) return message;
    if (message.method === "session/prompt") return rewritePrompt(message);
    if (message.method === "session/new" || message.method === "session/load") {
      return rewriteSession(message);
    }
    return message;
  }

  /**
   * Fail closed: block the request by answering the daemon with a JSON-RPC
   * error and dropping the original frame, so user-language text never
   * reaches the agent.
   *
   * This enqueues synchronously and can overtake agent frames still queued
   * behind an in-flight inbound translation. That is benign: the error
   * carries its own request id and the daemon correlates responses by id,
   * never by arrival order across unrelated frames.
   */
  function blockRequest(message: AcpStreamMessage & { method: string }, reason: string): null {
    enqueueInbound({
      jsonrpc: "2.0",
      id: "id" in message ? message.id : null,
      error: {
        code: -32603,
        message: `Translate plugin blocked this ${message.method}: ${reason}`,
      },
    });
    return null;
  }

  function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function rewritePrompt(message: AcpStreamMessage): Promise<AcpStreamMessage | null> {
    if (!("method" in message) || message.method !== "session/prompt") return message;
    const blocks = readPromptBlocks(message.params);
    // `session/prompt` always carries a prompt array; anything else is a
    // malformed frame and is blocked rather than passed through untranslated.
    if (blocks === null) {
      return blockRequest(message, "the prompt content array is missing or malformed");
    }
    try {
      const translated: unknown[] = [];
      for (const block of blocks) {
        translated.push(await translateBlock(block, config));
      }
      const params = (message.params ?? {}) as Record<string, unknown>;
      return {
        ...message,
        params: { ...params, prompt: translated },
      } as AcpStreamMessage;
    } catch (error) {
      return blockRequest(message, describe(error));
    }
  }

  /**
   * Paseo sends a per-agent system prompt in `session/new`/`session/load`
   * `_meta._paseo.systemPrompt`. Translate it like a prompt so the agent's
   * instructions also arrive in the agent language.
   */
  async function rewriteSession(message: AcpStreamMessage): Promise<AcpStreamMessage | null> {
    if (!("method" in message)) return message;
    const params = message.params;
    if (typeof params !== "object" || params === null) return message;
    const meta = (params as { _meta?: unknown })._meta;
    if (typeof meta !== "object" || meta === null) return message;
    const paseo = (meta as { _paseo?: unknown })._paseo;
    if (typeof paseo !== "object" || paseo === null) return message;
    const systemPrompt = (paseo as { systemPrompt?: unknown }).systemPrompt;
    if (systemPrompt === undefined) return message;
    if (typeof systemPrompt !== "string") {
      return blockRequest(message, "systemPrompt must be a string");
    }
    if (systemPrompt.trim().length === 0) return message;
    try {
      const translated = await config.translate(systemPrompt);
      const newParams = {
        ...(params as Record<string, unknown>),
        _meta: {
          ...(meta as Record<string, unknown>),
          _paseo: { ...(paseo as Record<string, unknown>), systemPrompt: translated },
        },
      };
      return { ...message, params: newParams } as AcpStreamMessage;
    } catch (error) {
      return blockRequest(message, describe(error));
    }
  }

  return { writable, readable };
}

function readPromptBlocks(params: unknown): unknown[] | null {
  if (typeof params !== "object" || params === null) return null;
  const prompt = (params as { prompt?: unknown }).prompt;
  return Array.isArray(prompt) ? prompt : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeRestore(
  restore: (fragment: string) => string | undefined,
  fragment: string,
): string | undefined {
  try {
    return restore(fragment);
  } catch {
    return undefined;
  }
}

/**
 * Chooser heuristic (mirrors Paseo's ACP provider): a repeated allow option
 * kind means the options are answers to pick from — a question — rather than
 * an allow/reject approval of one operation.
 */
function isChooserOptions(options: unknown[]): boolean {
  const allowKinds = new Set<string>();
  for (const option of options) {
    if (!isRecord(option) || typeof option.kind !== "string") continue;
    if (!option.kind.startsWith("allow")) continue;
    if (allowKinds.has(option.kind)) return true;
    allowKinds.add(option.kind);
  }
  return false;
}

/**
 * Translates the title and text content of a permission tool call. Per the
 * ACP schema a ToolCall carries only title/content/locations/rawInput plus
 * machine enums (kind, status): ids, kinds, locations, raw input/output,
 * diffs, and terminals are addressable machine data and stay verbatim, so
 * agent behavior never changes — only what the permission card shows.
 */
async function translatePermissionToolCall(
  toolCall: Record<string, unknown>,
  display: (text: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const copy: Record<string, unknown> = { ...toolCall };
  if (typeof copy.title === "string" && copy.title.length > 0) {
    copy.title = await display(copy.title);
  }
  if (Array.isArray(copy.content)) {
    const content: unknown[] = [];
    for (const item of copy.content as unknown[]) {
      content.push(await translatePermissionContent(item, display));
    }
    copy.content = content;
  }
  return copy;
}

/**
 * Translates only plain text content blocks. Diffs, terminals, images, and
 * resource blobs are machine data and always pass through untouched.
 */
async function translatePermissionContent(
  item: unknown,
  display: (text: string) => Promise<string>,
): Promise<unknown> {
  if (!isRecord(item) || item.type !== "content") return item;
  const inner = item.content;
  if (!isRecord(inner) || inner.type !== "text") return item;
  if (typeof inner.text !== "string" || inner.text.length === 0) return item;
  return { ...item, content: { ...inner, text: await display(inner.text) } };
}

/** Translates permission option labels; ids and kinds stay verbatim. */
async function translatePermissionOptions(
  options: unknown[],
  display: (text: string) => Promise<string>,
): Promise<unknown[]> {
  const translated: unknown[] = [];
  for (const option of options) {
    if (!isRecord(option) || typeof option.name !== "string" || option.name.length === 0) {
      translated.push(option);
      continue;
    }
    translated.push({ ...option, name: await display(option.name) });
  }
  return translated;
}

async function translateBlock(
  block: unknown,
  config: TranslatingConnectorConfig,
): Promise<unknown> {
  if (
    typeof block !== "object" ||
    block === null ||
    (block as { type?: unknown }).type !== "text"
  ) {
    return block;
  }
  const text = (block as { text?: unknown }).text;
  if (typeof text !== "string") return block;
  return { ...block, text: await translatePromptFragment(text, config.translate) };
}
