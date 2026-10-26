# Paseo Translate plugin

Converse in your language while the agent works in another. Prompts are translated
into the agent language before they reach the inner agent; replies stream back in
the agent's own words and are translated in the app after each stream completes.
Display-path and compaction calls are stream-first: a stream refusal falls back
to one plain completion inside the same call, and a JSON answer to a stream
request (a gateway that ignores `stream: true`) is accepted as-is. The
fail-closed prompt path instead uses one bounded completion, so the configured
timeout stays its hard bound. Streaming calls bound idle time instead of total
time: the timeout restarts on every received chunk, so a long translation that
keeps streaming is never cut off, while a stalled stream still fails.

The agent's context stays purely in the agent language — it never sees the user
language, and the canonical timeline keeps what each side actually said. The
user-language rendering of replies exists only in the app's plugin view.

## How it works

| Direction | Where | Failure policy |
| --- | --- | --- |
| Prompt (you → agent) | The plugin's `translate-acp` provider proxies the inner ACP agent and translates `session/prompt` text blocks and the per-agent system prompt on the wire | Fail closed: a failed translation blocks that request with an error instead of leaking your language to the agent |
| Prompt display (you → you) | A client timeline transformer + renderer (`translated-user-message`) shows the original and agent-language translation together in a plugin-owned right-aligned bubble. Translation starts automatically. Prompt submission caches joined display text and individual fragments, so cache-hot prompts need no extra endpoint call. Slash-command prefixes and serialized attachments stay verbatim | Display only; requires **Translate prompts**, a Translate provider, and a root agent. Failures leave the original. Matching languages and identical results show only one text. Runs on unmodified Paseo using the published plugin API. Replaced rows lack the native copy/rewind menu; original and translated text remain selectable |
| Reply (agent → you) | A client timeline transformer + renderer opens a streaming translation job (`translate.stream.start/poll`) once the message is settled — `phase` is `complete`, or the live-head text has stayed unchanged for a quiet window: 800ms while the agent is idle, otherwise at least 6s and up to 4× the longest pause the item has shown (capped at 30s), so a slow or bursty stream is not translated mid-sentence — and renders each poll as Markdown. When the text changes after a job started, the client cancels the superseded job (`translate.stream.cancel`) and the daemon aborts its endpoint request unless another caller still waits for it | Display only: stream-first against the endpoint's SSE with bounded retries from a fresh job (exponential backoff, longer for `busy`; fatal errors such as oversized text or an unconfigured endpoint fail fast), then a retried `translate.text` fallback. No total time limit: a stream attempt is dropped only when its text stops growing for 2 × `translationTimeoutMs` + 15s of awake time (device sleep does not count). On failure the original text stays, with an error hint and a manual Retry translation button; non-fatal failures also retry by themselves when a host comes back online or the app returns to the foreground |
| Reasoning (agent thinking → you) | A separate client timeline transformer + renderer (`translated-reasoning`) with the same streaming job machinery, rendering muted so thoughts never look like replies | Opt-in via the **Translate thinking** setting (default off — thinking blocks are often long, so translating them doubles endpoint spend on auxiliary text) and additionally requires **Translate replies** (the server display path shares that gate). Same display-only failure policy as replies, plus a Show original / Show translation toggle |
| Session titles (agent → you) | History-list titles render in your language: the direct providers translate Claude transcript titles and Codex thread names/previews, and the ACP proxy translates `session/list` result titles inbound. Exact prompt-time originals always restore from cache first (no endpoint call, even with display translation off or matching languages); anything else goes through display translation, sequentially, with over-long titles and ACP entries past 100 per frame left verbatim | Display only; per-title fail soft (a failed title keeps its original text, the listing never fails for this) |

Slash-command frames keep their command word verbatim; only the free-text
remainder is translated. Non-text content blocks (images) pass through
untouched.

Display jobs that start within 80ms for the same session share one tagged
endpoint call (up to 40 items / 80k source chars). A lone live reply still
streams. If the model does not return the item tags, that batch falls back
to per-item streaming. Each result is cached under the single-item key, so
a later unary hit does not retranslate. Identical source texts are translated
once per batch and shared, so a repeated line or a re-rendered item never
bills the endpoint twice.

Requests for the same text, direction and session are also shared while they
run: the fail-closed prompt path, display jobs from several devices, and
notification previews join one running endpoint request instead of starting
another. A prompt and its user-row display therefore show exactly the
translation the agent received, billed once. A canceled display job leaves a
shared request running for the remaining callers.

## Notification previews

Enable **Translate notification previews** in the plugin settings (off by default)
to translate completion and permission notification bodies for all three Translate
providers. This runs on the daemon, including when the app is closed, and does not
require platform changes. It is independent of **Translate replies**.

Permission summaries are translated before the request is emitted; the underlying
input and actions are preserved. With **Translate replies** on, completion
translates the turn's final reply rows verbatim, under the same session scope and
cache key the app's reply renderer uses, so opening the conversation afterwards
reuses that translation (or joins the still-running request) instead of
translating again. The hidden preview is emitted, and the turn ended, as soon as
about 220 characters of translation exist, or after one **Translation timeout**
(a partial result is clipped with `...`). The row in progress keeps translating
into the cache; later rows are left to the app. Rows the app does not render
through the translated view (host-rendered content, or longer than the display
limit), and every row while **Translate replies** is off, use a plain-text
translation of at most 2000 source characters instead. Original replies and
native agent transcripts stay intact. The separator and synthetic assistant
preview are hidden in the app, but appear in timeline API results; APIs that read
the last assistant message will receive the preview.
Native transcript replay does not regenerate notification previews.

Failed or empty translations use a generic message in the configured user language
for supported language tags (`ar`, `de`, `en`, `es`, `fr`, `ja`, `ko`, `pt`, `ru`,
`zh`, including regional variants); other languages use `...` rather than exposing
the original. Interrupting or closing a session discards pending previews.

Paseo still owns delivery and its fixed notification titles. This setting cannot
translate those titles or suppress a notification on translation failure. Agents
using other providers are unaffected, including when **Translate every agent's
timeline** is enabled. The host must support the `timeline.plugin` capability.

For an optional integration check against a local Paseo source checkout:

```bash
node scripts/verify-notification-host.mjs <paseo-checkout>
```

## Session translation context

Each agent session keeps its own translation transcript: recent translation
pairs (per direction) plus a compacted terminology memory shared by both
directions. Requests are conditioned on that context, so a recurring concept
translates the same way throughout one conversation. The direct Claude Code
and Codex providers scope the transcript by the paseo agent id (bridged into
the session env at open), so the prompt path and the in-app reply path share
one transcript that survives resumes and daemon restarts. The ACP proxy uses
the same agent id whenever the session carries that bridge, and falls back to
the inner ACP session id otherwise (restart-stable via `session/load`, but
separate from the display path's transcript). Each request also sees the
newest pairs of the opposite direction (reversed into the requested direction,
up to 8k chars), so a term you introduced in a prompt reads the same in the
replies and the other way round. History replay records each restored user
message together with the text the agent actually received, so after a resume
the user row shows that exact translation instead of requesting a new, possibly
different one. Exact-match
cache hits still short-circuit without touching the endpoint. Cached entries
are namespaced by the session scope (plus every output-affecting setting),
never by the memory digest: the compacted memory is rewritten as a session
ages, and a memory-bearing key would drop every cached translation of that
session — re-billing the whole conversation the next time it is opened. So
each text is translated once per session; a compaction changes only how later
*misses* are conditioned, never the addressability of what was already
translated. Terminology still cannot leak between sessions: the scope in the
key keeps each session's namespace separate (standalone translations and
sessions with context off live in their own scope-free namespace).

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
- **Translation timeout** — per-request bound, prompts fail closed past it;
  streaming calls treat it as an idle bound that restarts on every chunk
- **Translation instructions** — **Additional rules** (glossary entries, terms
  to keep untranslated, tone) are appended after the built-in prompt and
  survive plugin updates that improve it; **Domain context** describes the
  project; **Effective prompt** shows exactly what the endpoint receives for
  your language pair. **Replace the built-in prompt → Customize** opens a
  custom template seeded with the built-in text (`{source}`, `{target}` and
  `{context}` placeholders; without `{context}` the domain context is appended).
  A custom template stops following built-in prompt updates, so prefer
  Additional rules; **Revert** returns to the built-in prompt
- **Session translation context / Compaction idle time / History compaction
  threshold** — per-session translation transcripts for consistent
  terminology, with automatic idle compaction (see below)

Create agents against **Translate (ACP)**, **Translate (Claude Code)**, or
**Translate (Codex)**. Provider-list icons retain Claude's and Codex's native
logos with a small translation badge at the bottom right. The generic ACP wrapper
uses Paseo's agent fallback icon with the same badge. ACP sessions spawn the inner agent through the
translating proxy; the direct providers talk to Claude Code or Codex natively.

## Claude cache countdown and AFK compaction

Claude sessions have a **Claude cache** composer pill showing the estimated
remaining prompt-cache lifetime. To fit narrow composers the pill shows only
the countdown or a one-word state (Expired, Compacting, …); its tooltip and
accessibility label carry the full text. Open it to configure that session's AFK
auto-compaction switch, minimum context tokens, and seconds before expiry.
**Claude AFK defaults** in plugin settings controls newly created Claude
sessions only. Defaults are off, **200,000 tokens**, and **300 seconds**;
existing sessions stay off until explicitly configured. A session override
survives reopening and is independent of later global-default changes.

When enabled, AFK compaction uses Claude's native `/compact`. It runs only
after the current run and all pending/background work have finished, with
context **strictly above** the threshold. There is no inactivity timer. It
targets five minutes before a one-hour cache's estimated expiry; five-minute
caches are excluded. New user work takes priority, and missed/expired
deadlines are skipped. Unchanged context is not compacted repeatedly. The
scheduler runs on the daemon while the app is closed, but never opens dormant
sessions just to compact them.

The countdown is an estimate for the observed conversation prefix, not an
authoritative session-wide deadline. It uses request-start observations and
cache usage, including observed five-minute/one-hour writes or an explicit
runtime cache-lifetime override. When timing or lifetime is unknown, automatic
compaction stays off for that observation. Model/configuration changes and
process restarts invalidate observations; reopening never invents a fresh TTL.
Compaction status and any failure are visible in the pill/timeline.

Compaction consumes tokens and summarizes context; it does not necessarily
save money. If Claude's native context-full compaction occurs below 200k,
the default AFK threshold will not be reached. Manual `/compact` and Claude's
native auto-compaction settings remain independent. The new controls use
English or Simplified Chinese, with English fallback for other interface locales.

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
  models, supplemented by the curated catalog and custom models from Claude settings.
  Catalog probing disables persistence, hooks and MCP servers. Modes are
  Plan/Always Ask/Accept Edits/Auto/Bypass. Model and mode changes apply live;
  thinking changes apply at the next query. Auto is the default on the Anthropic API
  transport; Bedrock and Vertex omit Auto and default to Always Ask.
- Session persistence uses Claude's own session id (resume survives daemon
  restarts). When a wrapper (for example reclaude) moves Claude storage into an
  account directory, opening the session follows the directory that actually
  holds the transcript and records it for later resumes. Permissions pass
  through to you with Allow/Deny; interrupt maps
  to Claude's interrupt. "Always allow" style permission upgrades from the
  CLI's suggestions are passed through; the host determines which actions it offers.
  Tool permission cards include structured details and the originating tool identity.
  Configured `providerOptions.extraArgs` pass through to the CLI, including valueless flags.
- **Fork session** is an agent-scoped composer button (labelled **Fork**, full
  name in the tooltip) with a second confirmation.
  It copies the complete persisted Claude session, companion subagent/workflow
  storage, saved tool results, file-history backups, and session environment,
  assigning new session/message/tool/subagent identifiers. The copy gets a
  distinct `Original title (fork 12ab34cd)` title in both Claude storage and
  Paseo. Both sessions share the working directory. Finish foreground and
  background work and resolve permissions before forking; the source remains
  resumable under its original ID. Import/title failures can be retried without
  creating another copy. The daemon caps plugin RPCs at 30s, so a fork that
  exceeds it answers `in_progress` and the confirmation polls the durable
  operation until it settles; copies and imports never repeat for one source
  while a fork is in flight. A CLI daemon-response timeout keeps the import
  pending: the operation finds the eventual agent by its saved label, including
  after a plugin restart, instead of submitting another import. Forks preserve custom system instructions and process
  environment overrides, with new Paseo agent identities and tool wiring. They
  are opened through Paseo's session list or the fork operation's retry, and
  excluded from generic Claude session import to prevent duplicate writers.
  Forking uses the installed Paseo CLI against the
  daemon's home and requires Paseo 0.11.2 or newer; no daemon patch is needed.
- Root turns follow Claude's main-session lifecycle like the native provider:
  background child output and job heartbeats keep their timelines updating
  without opening a root turn. When Claude wakes to process a result, its
  `system/init` opens an autonomous turn, closed by its result or idle state.
  Follow-up messages can steer foreground and autonomous turns on the live
  Claude stream, keeping background work running. Stop cancels the main turn
  and withdraws unstarted prompts; background helpers survive, as in native
  Paseo. Ask Claude to stop a specific helper through its TaskStop tool.
- Session identity, runtime model and mode are captured from Claude init/status
  events, so a first-turn crash can resume the session. Rejected live settings
  changes report failure rather than claiming they were applied. Thinking
  changes take effect on the next query; Max uses the SDK session effort and
  supported models offer Off and Ultra Code.
- Text and thinking stream incrementally in root and child panes. Child panes
  include observed model/effort and final token usage; live usage uses the host
  usage events. Completed workflows show their bounded result-file output.
- Full surface: message/command/image prompts, active-turn steering, slash
  commands reported by the CLI, streaming text and thinking, structured
  tool-call cards (shell/read/write/edit/search/fetch/plan/sub-agent),
  Task subagents as provider subsessions (track rows with read-only
  timelines, nesting, backgrounded children, resume aliases), usage
  reporting, and history replay from Claude's own transcript files
  (including subagent sidecars), session listing, and file/conversation rewind.
  `/rewind [user_message_uuid]` runs locally against Claude file checkpoints and
  never goes through prompt translation or the model. Without a UUID it tries the newest
  available user checkpoints. Archive/unarchive stay capability-gated off; the daemon handles their absence
  gracefully. The default catalog entry uses the CLI's default model.

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
  Modes are Default Permissions / Auto-review / Full Access. Like the native
  provider, Codex 0.115+ defaults to Auto-review; older versions omit it.
  The catalog uses the configured model and reasoning defaults. Service tiers come from model metadata, including Fast when
  advertised. Plan mode uses the server collaboration modes and offers
  Dismiss/Implement approval for completed proposals.
- Session persistence uses Codex's thread id (resume survives daemon
  restarts). Permissions pass through Allow/Deny for commands and file
  changes; clarifying questions are translated for display and answers are
  translated back (fail closed). Preapproved MCP tools use the same per-tool
  approval configuration as native Paseo while retaining server launch settings.
- Interrupt maps to `turn/interrupt`. Active-turn steering maps to
  `turn/steer`. Conversation rewind forks the Codex thread.
- Session-list status tracks out-of-band root turns like the native
  provider: a `turn/started` arriving with no open foreground turn (a
  `turn/start` ack timeout whose turn still started server-side) opens a
  synthetic autonomous turn the daemon tracks as running, until the
  `turn/completed`, the next prompt, an interrupt, a rewind, or a process
  death. The interrupt flag is consumed by any `turn/completed`, so a
  killed request's trailing activity cannot wedge the status at running.
  Start notifications that arrive before an acknowledgement failure are
  recovered too. Superseded native turn completions cannot settle the next
  prompt, and a rejected interrupt keeps autonomous work tracked as running.
- Sub-agent threads are routed away from the root like the native adapter:
  their turn lifecycle never settles the root turn or overwrites the native
  turn id, and their user/agent/reasoning text never surfaces as root rows
  (it would read as replies and reach attention notifications). Sub-agent
  activity replays as completed or canceled historical calls, with resumed activity
  consolidated under the original call. Native archive/unarchive operations are
  supported; file rewind remains capability-gated off.
- `turn/completed` statuses are read from both wire shapes Codex has used
  (`turn.status`/`turn.error` and the older flat `status`/`errorMessage`).
- Child agents have their own nested session panes, streamed tools, text,
  reasoning and usage; their telemetry does not overwrite the root session.
- Session listing follows all requested pages (up to the native 500-thread scan
  window), orders by last activity, and deduplicates threads that move between pages.
  Root and child history retain their original event timestamps in both direct providers.
- Compaction displays loading and completed states, distinguishes manual from automatic
  runs, and merges duplicate item/notification completion signals. A terminal turn closes
  any unfinished loading marker. Generated-image failures remain visible; structured
  image results support paths, URLs, and inline image data.
- Windows shell cards display the command inside PowerShell/cmd wrappers, matching
  native Paseo.
- Ordinary and asynchronous questions translate their display/answers and
  remain cancellation-aware. Async answers persist across resume. Supported
  MCP elicitations use approval cards; URL prompts and forms requiring fields
  are declined, matching native Paseo.
- `/compact` and compatible CLI `/goal` commands use app-server control RPCs.
  Enabled skills refresh when commands run; custom `prompts:*` templates support
  positional/named arguments. Skill command words remain verbatim.
- Tool output streams include legacy events, stdin interactions and materialized
  images. Structured output schemas are normalized and forwarded per turn.
- Replay supports legacy and paginated histories. Rewind preserves the original
  thread, carries configuration to its fork, and rebuilds history and questions.

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
Reloading the provider plugin can affect active sessions; obtain explicit
approval before running it while sessions are in use.

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
  out the usual markdown packages). Messages with embedded images keep the
  host renderer instead and show only their original:
  markdown images (`![alt](src)`, and HTML `<img>` tags outside table cells
  with a web or data-URI source). The host owns image preview, which the
  plugin has no API for. File links and inline paths (`src/app.ts:12`,
  `src/app.ts#L33`, `./config.yaml`, `file:///...`) stay translated so final
  summaries do not silently lose translation. File references remain readable
  and copyable, but native click-to-open is unavailable in these plugin rows.
  Web links continue to open through the host's external browser opener.
  User prompts that have nothing to
  translate (blank, serialized attachments, arg-less slash commands,
  provider images) stay on the host renderer; other user prompts render as
  plain text in a plugin-owned right-aligned bubble. Original and translated
  text appear together on this plugin's root agents when Translate prompts
  is on; identical translations are hidden. No Paseo host changes are required.
  Replaced rows do not retain native attachment previews, timestamps, or the copy/rewind
  menu; original and translated text remain selectable. The direct Claude provider's
  `/rewind` command remains available. Display translation starts
  automatically and may call the endpoint when the prompt cache has expired.
- Structured attachments (forge issues, reviews, uploaded files) reach the
  agent as serialized JSON and are passed through untranslated; free text
  inside them stays in your language.
- A plain message that starts with `/word` keeps its first word untranslated,
  because flattened slash commands are indistinguishable on the wire.
- Sub-agent tracks and chat search operate on the agent-language text.
- History replay for the direct Claude provider retains the full root transcript and all available subagent sidecars.
  Replayed tool screenshots and compaction markers are restored; internal summaries,
  synthetic messages and control placeholders stay hidden. Very large histories use
  memory proportional to the transcript, matching the native provider.
  User prompts restore exact originals or already cached back-translations; cache
  misses keep the stored text so opening or importing never waits for a translation endpoint.
- Restart fan-out: after a daemon restart, many replayed messages open
  translation jobs at once. Same-session starts that land within 80ms share
  one tagged endpoint call (parse failure falls back to per-item). `busy`
  refusals still back off longer with jitter if the pending-job cap is hit,
  then degrade to direct unary calls.
- Prompt turns pay one extra translation round trip before the agent starts.
- Session translation context resends recent translation history with each
  endpoint call (bounded by the compaction threshold and the twice-size
  trim) plus up to 8k chars of opposite-direction pairs; turn it off to
  minimize endpoint spend.
- The inner agent command is split on spaces; quoted arguments are not
  supported in the settings UI.
