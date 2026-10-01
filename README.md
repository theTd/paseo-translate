# Paseo Translate plugin

Converse in your language while the agent works in another. Prompts are translated
into the agent language before they reach the inner agent; replies stream back in
the agent's own words and are translated in the app after each stream completes.
Display-path and compaction calls are stream-first: a stream refusal falls back
to one plain completion inside the same call, and a JSON answer to a stream
request (a gateway that ignores `stream: true`) is accepted as-is. The
fail-closed prompt path instead uses one bounded completion, so the configured
timeout stays its hard bound.

The agent's context stays purely in the agent language — it never sees the user
language, and the canonical timeline keeps what each side actually said. The
user-language rendering of replies exists only in the app's plugin view.

## How it works

| Direction | Where | Failure policy |
| --- | --- | --- |
| Prompt (you → agent) | The plugin's `translate-acp` provider proxies the inner ACP agent and translates `session/prompt` text blocks and the per-agent system prompt on the wire | Fail closed: a failed translation blocks that request with an error instead of leaking your language to the agent |
| Prompt display (you → you) | A client timeline transformer + renderer (`translated-user-message`) keeps the original as plain text inside the native user bubble and starts a `user-to-agent` display job only when **Show translation** is tapped. Prompt submission caches the joined display text as well as individual fragments, so cache-hot multi-fragment prompts reuse the exact result with no extra endpoint call. Slash-command prefixes and serialized attachments stay verbatim | Display only; requires **Translate prompts**, a Translate provider, and a root agent (subagent `user_message` rows are task prompts already in the agent language). Failures leave the original. Matching language pairs hide the button |
| Reply (agent → you) | A client timeline transformer + renderer opens a streaming translation job (`translate.stream.start/poll`) once the message is settled — `phase` is `complete`, the agent is no longer running, or the live-head text has been unchanged for 800ms — and renders each poll as Markdown | Display only: stream-first against the endpoint's SSE with bounded retries from a fresh job (exponential backoff, longer for `busy`; fatal errors such as oversized text or an unconfigured endpoint fail fast), then a retried `translate.text` fallback. No total time limit: a stream attempt is dropped only when its text stops growing for 2 × `translationTimeoutMs` + 15s of awake time (device sleep does not count). On failure the original text stays, with an error hint and a manual Retry translation button; non-fatal failures also retry by themselves when a host comes back online or the app returns to the foreground |
| Reasoning (agent thinking → you) | A separate client timeline transformer + renderer (`translated-reasoning`) with the same streaming job machinery, rendering muted so thoughts never look like replies | Opt-in via the **Translate thinking** setting (default off — thinking blocks are often long, so translating them doubles endpoint spend on auxiliary text) and additionally requires **Translate replies** (the server display path shares that gate). Same display-only failure policy as replies, plus a Show original / Show translation toggle |
| Session titles (agent → you) | History-list titles render in your language: the direct providers translate Claude transcript titles and Codex thread names/previews, and the ACP proxy translates `session/list` result titles inbound. Exact prompt-time originals always restore from cache first (no endpoint call, even with display translation off or matching languages); anything else goes through display translation, sequentially, with over-long titles and ACP entries past 100 per frame left verbatim | Display only; per-title fail soft (a failed title keeps its original text, the listing never fails for this) |

Slash-command frames keep their command word verbatim; only the free-text
remainder is translated. Non-text content blocks (images) pass through
untouched.

Display jobs that start within 80ms for the same session share one tagged
endpoint call (up to 40 items / 80k source chars). A lone live reply still
streams. If the model does not return the item tags, that batch falls back
to per-item streaming. Each result is cached under the single-item key, so
a later unary hit does not retranslate.

## Session translation context

Each agent session keeps its own translation transcript: recent translation
pairs (per direction) plus a compacted terminology memory shared by both
directions. Requests are conditioned on that context, so a recurring concept
translates the same way throughout one conversation. The direct Claude Code
and Codex providers scope the transcript by the paseo agent id (bridged into
the session env at open), so the prompt path and the in-app reply path share
one transcript that survives resumes and daemon restarts. The ACP proxy
scopes by the inner ACP session id instead — restart-stable via
`session/load`, but separate from the display path's transcript. Exact-match
cache hits still short-circuit without touching the endpoint; cached entries
are namespaced by the current memory, so a compaction starts a new cache
epoch and compacted terminology never leaks into another memory. Within one
memory epoch — fresh sessions whose memory is still empty included — a
repeated text can be served from the shared cache regardless of which
session's turns conditioned the first rendering.

When a session's transcript has been idle for **Compaction idle time**
(default 30 minutes) AND exceeds **History compaction threshold** (default
100k chars) with no new translations arriving, the plugin asks the endpoint
to distill a terminology/style memory and keeps only the newest few pairs;
the memory is persisted and survives daemon restarts. Active sessions are
bounded too: at twice the threshold the oldest pairs drop out. Compaction is
fail-soft — a failed compaction retries later and never blocks a translation.
Turn the whole feature off with **Session translation context** to restore
independent per-request translation.

## Install

Requires Paseo >= 0.8.0 with plugins enabled (`pluginsEnabled: true` in the
daemon config, then `paseo reload`). Plugins are trusted, unsandboxed code; the
provider spawns the inner agent command you configure. The API key is stored in
host-scoped plugin settings on the daemon machine.

```bash
paseo plugin install E:\misc\paseo-translate-plugin
```

Then open the plugin's **Translate** settings screen in the app and configure:

- **Endpoint base URL / API key / model** — any OpenAI-compatible endpoint
- **Endpoint protocol** — **Responses** (`/v1/responses`, the default; the
  current OpenAI API) or **Chat Completions** (`/v1/chat/completions`, the
  lowest common denominator). Switch if your gateway has no Responses route
- **Reasoning effort** — thinking depth sent with each translation request (Default/minimal/low/medium/high; Default omits the parameter). Low or minimal keeps prompt translation fast since it sits on the fail-closed path of every turn
- **Your language** and **Agent language** — e.g. `en` and `de`
- **Inner agent command** — the ACP-speaking command to wrap for **Translate (ACP)**. The settings screen lists the daemon's providers and fills the command automatically where an ACP mode is verified: custom `extends: "acp"` providers use the command configured on the daemon, and CLIs shipping an ACP subcommand (`copilot --acp`, `cursor-agent acp`, `omp acp`, `opencode acp`) use their configured override or the built-in default. Claude Code and Codex still appear as ACP adapter presets (`cmd /c npx …` on Windows) for the ACP wrapper; prefer the direct **Translate (Claude Code)** / **Translate (Codex)** providers when you want native protocol support. Providers marked unknown may still ship an ACP mode the picker cannot detect — if the CLI has one, enter it manually (arguments are split on spaces; on Windows avoid `.cmd` shims or prefix them with `cmd /c`).
- **Translation timeout** — per-request bound, prompts fail closed past it
- **Session translation context / Compaction idle time / History compaction
  threshold** — per-session translation transcripts for consistent
  terminology, with automatic idle compaction (see below)

Create agents against **Translate (ACP)**, **Translate (Claude Code)**, or
**Translate (Codex)**. ACP sessions spawn the inner agent through the
translating proxy; the direct providers talk to Claude Code or Codex natively.

## Direct Claude Code provider

The plugin also registers **Translate (Claude Code)**: a direct provider that
drives `claude` through the official `@anthropic-ai/claude-agent-sdk` in
streaming-input mode — no ACP adapter layer. Prompts and the per-agent system
prompt are translated before Claude sees them (fail closed), replies stream
back in Claude's language, and the shared timeline renderer translates them in
the app after each turn.

- Requires the `claude` CLI installed and logged in on the daemon machine.
- **Executable resolution**: the provider drives the `claude` found on PATH
  (native `claude.exe`/`claude` preferred over `.cmd` shims), falling back to
  the daemon's bundled copy. The **Claude Code executable** setting overrides
  everything with an explicit path. PATH resolution is cached for the plugin
  process lifetime: after installing or upgrading `claude` on PATH, run
  `paseo plugin reload translate` to pick it up.
- Reasoning (thinking) streams as reasoning timeline items; by default they
  stay in the agent language untranslated — turn on **Translate thinking** to
  translate them for display (muted, with a Show original toggle).
- Model switching, thinking intensity, and permission modes match the native
  provider's surface: the catalog is probed live from the CLI's reported
  models (effort levels become thinking options), modes are
  Plan/Always Ask/Accept Edits/Bypass, and changes apply live through the
  SDK's control surface. "Auto" mode is not offered (it requires the API
  transport).
- Session persistence uses Claude's own session id (resume survives daemon
  restarts). Permissions pass through to you with Allow/Deny; interrupt maps
  to Claude's interrupt. "Always allow" style permission upgrades from the
  CLI's suggestions are not offered — every request is a plain Allow/Deny.
- Full surface: message/command/image prompts, active-turn steering, slash
  commands reported by the CLI, streaming text and thinking, structured
  tool-call cards (shell/read/write/edit/search/fetch/plan/sub-agent),
  Task subagents as provider subsessions (track rows with read-only
  timelines, nesting, backgrounded children, resume aliases), usage
  reporting, and history replay from Claude's own transcript files
  (including subagent sidecars). Archive/unarchive/revert/session-listing
  stay capability-gated off — the daemon handles their absence gracefully.
  Model selection passes the daemon-configured model through; the default
  catalog entry uses the CLI's default model.

## Direct Codex provider

The plugin also registers **Translate (Codex)**: a direct provider that drives
the official `codex app-server` JSON-RPC interface — the same protocol Paseo's
native Codex adapter uses, with no ACP shim. Prompts and the per-agent system
prompt are translated before Codex sees them (fail closed), replies stream back
in Codex's language, and the shared timeline renderer translates them in the
app after each turn.

- Requires the `codex` CLI installed and logged in on the daemon machine
  (`npm install -g @openai/codex`, then `codex login`).
- **Executable resolution**: the provider drives the `codex` found on PATH
  (native `codex.exe`/`codex` preferred over `.cmd` shims). The **Codex
  executable** setting overrides everything with an explicit path. PATH
  resolution is cached for the plugin process lifetime: after installing or
  upgrading `codex` on PATH, run `paseo plugin reload translate` to pick it up.
- Before starting app-server, the provider checks that `--version` reports
  `codex-cli <version>`. The npm package **`codex`** is an unrelated documentation
  generator; install **`@openai/codex`** instead. On macOS, use `type -a codex`
  and `codex --version` in Terminal to check for conflicting installations.
  If the daemon selects a different executable, set **Codex executable** to
  the absolute path of the official CLI, run `codex login` with that CLI,
  and reload the plugin. Startup errors include the selected executable.
- Model switching and thinking effort are probed live from `model/list`.
  Modes are Default Permissions / Auto-review / Full Access, matching the
  native provider. Fast mode is offered for models that support it.
- Session persistence uses Codex's thread id (resume survives daemon
  restarts). Permissions pass through Allow/Deny for commands and file
  changes; clarifying questions are translated for display and answers are
  translated back (fail closed).
- Interrupt maps to `turn/interrupt`. Active-turn steering maps to
  `turn/steer`. Conversation rewind forks the Codex thread.
- Slash commands listed from Codex skills keep the command word verbatim;
  only free-text arguments are translated.
- Sub-agent activity is flattened to tool-call cards (not provider
  subsessions). Archive/unarchive and file rewind stay capability-gated off.

## Interface language

The plugin's own screens and hints ship in nine languages (`ar`, `en`, `es`,
`fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`), matching the host app's locales.
By default the interface follows the device locale (detected via `Intl`); the
Translate settings screen has an **Interface language** picker to pin one
instead. The host does not expose its app-language setting to plugins, so
"System" tracks the device rather than the app: it reads only the device's
primary locale, so on multi-locale devices it can differ from the host app
language by one fallback step. The settings-screen title
is snapshotted at registration. Server-side and daemon-log text stays English.

## Develop

```bash
npm install
npm run build      # regenerates server/claude-provider.dist.cjs (commit it)
npm run typecheck
npm test
```

The direct Claude provider ships as a pre-built bundle
(`server/claude-provider.dist.cjs`): the claude-agent-sdk's type surface
contains defensive import fallbacks that the daemon's plugin compiler
resolves strictly, so the SDK is bundled ahead of time and the entry imports
only the bundle. The daemon evaluates plugin bundles without `__filename`,
so the build patches esbuild's `import.meta` shim to anchor at the running
process instead (`scripts/build.mjs`), and `scripts/verify-bundle.mjs`
re-checks the artifact in the daemon's exact evaluation shape. Edit
`server/claude-provider.ts`, re-run `npm run build`, and commit the
regenerated bundle alongside the source.

The connector tests spawn a real echo agent process and assert on what it
received: translation order, untouched frames, command-prefix preservation,
serialized-attachment passthrough, system-prompt translation, and the
fail-closed path where a blocked prompt never reaches the agent.

After editing plugin source, apply changes with `paseo plugin reload translate`.

## Limitations

- **Installing this plugin replaces the assistant-message, user-message, and reasoning
  rendering for every agent on the daemon** with this plugin's translated views (timeline
  transformers are app-wide), not just agents using the Translate provider.
  Reasoning keeps a muted style so it never looks like a reply; when thinking
  translation is off (the default) the muted view shows the original text.
  Reasoning also keeps the host's collapse behavior: expanded while the
  block streams, collapsed under a Thinking header once complete.
  Assistant originals and translations render as Markdown through the
  plugin's own dependency-free renderer (the daemon's client compiler
  rejects Node builtins anywhere in the client import graph, which rules
  out the usual markdown packages). User prompts that have nothing to
  translate (blank, serialized attachments, arg-less slash commands,
  provider images) stay on the host renderer; other user prompts render as
  plain text inside the host's right-aligned user bubble, with Show
  translation only on this plugin's root agents when Translate prompts is
  on. The host retains attachment previews, timestamps, copy, and rewind
  actions; copying and rewinding still use the original prompt. This needs
  the Paseo client change that retains the native source user row for plugin
  timeline items; reload the updated client along with the plugin.
- Structured attachments (forge issues, reviews, uploaded files) reach the
  agent as serialized JSON and are passed through untranslated; free text
  inside them stays in your language.
- A plain message that starts with `/word` keeps its first word untranslated,
  because flattened slash commands are indistinguishable on the wire.
- Sub-agent tracks and chat search operate on the agent-language text.
- History replay for the direct Claude provider is tail-kept per timeline:
  the root keeps its newest 2000 items (from the newest 10000 transcript
  lines) and all subagent sidecars share a further newest-2000 budget, so at
  most 4000 items are re-emitted per session open. After a daemon restart,
  older scrollback may be missing, but the newest messages — including the
  final response — always come back.
- Restart fan-out: after a daemon restart, many replayed messages open
  translation jobs at once. Same-session starts that land within 80ms share
  one tagged endpoint call (parse failure falls back to per-item). `busy`
  refusals still back off longer with jitter if the pending-job cap is hit,
  then degrade to direct unary calls.
- Prompt turns pay one extra translation round trip before the agent starts.
- Session translation context resends recent translation history with each
  endpoint call (bounded by the compaction threshold and the twice-size
  trim); turn it off to minimize endpoint spend.
- The inner agent command is split on spaces; quoted arguments are not
  supported in the settings UI.
