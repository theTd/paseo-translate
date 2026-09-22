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
| Reply (agent → you) | A client timeline transformer + renderer calls the plugin's `translate.text` RPC once the message phase is `complete` | Display only: on failure the original text stays, with an error hint |

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
- **Your language** and **Agent language** — e.g. `en` and `de`
- **Inner agent command** — the ACP-speaking command to wrap. The settings screen lists the daemon's ACP providers and fills the command automatically: custom `extends: "acp"` providers use the command configured on the daemon, built-ins (Copilot, Cursor) use their configured override or the built-in default (`copilot --acp` / `cursor-agent acp`). Non-ACP providers are hidden. Manual entry remains the fallback (arguments are split on spaces; on Windows use the full executable path, e.g. `C:\...\agent.exe`, since no shell resolves `.cmd` shims)
- **Translation timeout** — per-request bound, prompts fail closed past it

Create agents against the **Translate (ACP)** provider. Each session spawns the
inner agent through the translating proxy.

## Develop

```bash
npm install
npm run typecheck
npm test
```

The connector tests spawn a real echo agent process and assert on what it
received: translation order, untouched frames, command-prefix preservation,
serialized-attachment passthrough, system-prompt translation, and the
fail-closed path where a blocked prompt never reaches the agent.

After editing plugin source, apply changes with `paseo plugin reload translate`.

## Limitations

- **Installing this plugin replaces the assistant-message rendering for every
  agent on the daemon** with this plugin's plain-text view (timeline
  transformers are app-wide), not just agents using the Translate provider.
  Markdown formatting is lost until the translation replaces the text.
- Structured attachments (forge issues, reviews, uploaded files) reach the
  agent as serialized JSON and are passed through untranslated; free text
  inside them stays in your language.
- A plain message that starts with `/word` keeps its first word untranslated,
  because flattened slash commands are indistinguishable on the wire.
- Sub-agent tracks and chat search operate on the agent-language text.
- Prompt turns pay one extra translation round trip before the agent starts.
- The inner agent command is split on spaces; quoted arguments are not
  supported in the settings UI.
