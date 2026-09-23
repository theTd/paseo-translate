# Paseo Translate plugin

Converse in your language while the agent works in another. Prompts are translated
into the agent language before they reach the inner agent; replies stream back in
the agent's own words and are translated in the app after each stream completes.

The agent's context stays purely in the agent language — it never sees the user
language, and the canonical timeline keeps what each side actually said. The
user-language rendering of replies exists only in the app's plugin view.

## How it works

| Direction | Where | Failure policy |
| --- | --- | --- |
| Prompt (you → agent) | The plugin's `translate-acp` provider proxies the inner ACP agent and translates `session/prompt` text blocks and the per-agent system prompt on the wire | Fail closed: a failed translation blocks that request with an error instead of leaking your language to the agent |
| Reply (agent → you) | A client timeline transformer + renderer opens a streaming translation job (`translate.stream.start/poll`) once the message phase is `complete` and renders each poll as Markdown | Display only: stream-first against the endpoint's SSE with bounded retries from a fresh job (exponential backoff, longer for `busy`; fatal errors such as oversized text or an unconfigured endpoint fail fast), then a retried `translate.text` fallback. No total time limit: a stream attempt is dropped only when its text stops growing for 2 × `translationTimeoutMs` + 15s of awake time (device sleep does not count). On failure the original text stays, with an error hint and a manual Retry translation button; non-fatal failures also retry by themselves when a host comes back online or the app returns to the foreground |

Slash-command frames keep their command word verbatim; only the free-text
remainder is translated. Non-text content blocks (images) pass through
untouched.

## Install

Requires Paseo >= 0.8.0 with plugins enabled (`pluginsEnabled: true` in the
daemon config, then `paseo reload`). Plugins are trusted, unsandboxed code; the
provider spawns the inner agent command you configure. The API key is stored in
host-scoped plugin settings on the daemon machine.

```bash
paseo plugin install E:\misc\paseo-translate-plugin
```

Then open the plugin's **Translate** settings screen in the app and configure:

- **Endpoint base URL / API key / model** — any OpenAI-compatible `/chat/completions` endpoint
- **Reasoning effort** — thinking depth sent with each translation request as the standard `reasoning_effort` parameter (Default/minimal/low/medium/high; Default omits the parameter). Low or minimal keeps prompt translation fast since it sits on the fail-closed path of every turn
- **Your language** and **Agent language** — e.g. `en` and `de`
- **Inner agent command** — the ACP-speaking command to wrap. The settings screen lists the daemon's providers and fills the command automatically where an ACP mode is verified: custom `extends: "acp"` providers use the command configured on the daemon, and CLIs shipping an ACP subcommand (`copilot --acp`, `cursor-agent acp`, `omp acp`, `opencode acp`) use their configured override or the built-in default. Claude Code and Codex appear as adapter presets (`cmd /c npx …` on Windows). Providers marked unknown may still ship an ACP mode the picker cannot detect — if the CLI has one, enter it manually (arguments are split on spaces; on Windows avoid `.cmd` shims or prefix them with `cmd /c`).
- **Translation timeout** — per-request bound, prompts fail closed past it

Create agents against the **Translate (ACP)** provider. Each session spawns the
inner agent through the translating proxy.

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
- Reasoning (thinking) streams as reasoning timeline items; they stay in the
  agent language untranslated.
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

- **Installing this plugin replaces the assistant-message rendering for every
  agent on the daemon** with this plugin's translated view (timeline
  transformers are app-wide), not just agents using the Translate provider.
  Both the translation and the original render as Markdown through the
  plugin's own dependency-free renderer (the daemon's client compiler
  rejects Node builtins anywhere in the client import graph, which rules
  out the usual markdown packages).
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
  translation jobs at once; `busy` refusals back off longer with jitter and
  degrade to direct unary calls. There is no cross-message global throttle.
- Prompt turns pay one extra translation round trip before the agent starts.
- The inner agent command is split on spaces; quoted arguments are not
  supported in the settings UI.
