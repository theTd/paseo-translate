# Claude cache countdown and pre-expiry compaction

Analysis date: 2026-10-22. Status: implementation prepared locally with automated
validation; no live-session experiment or plugin reload has been performed for
this feature. Request-start timing remains an estimate requiring isolated
real-CLI validation before treating it as operationally verified.

## Goal and scope

For Translate (Claude Code), show an estimated prompt-cache countdown and let the
user opt into one automatic native `/compact` before the relevant cached
conversation prefix expires. This concerns the Claude conversation, not the
translation endpoint's terminology-memory compaction.

The translation-rendering fix was committed separately as `ad350b9`.

## Verified facts

- Anthropic supports 5-minute and 1-hour prompt-cache lifetimes. A cache hit
  refreshes the reused entry. Lifetime is measured from the **start of the
  request**, not response completion. A four-minute response can therefore
  leave only about one minute on a five-minute entry.
- A cache belongs to a matching prompt prefix, not to a session as a whole.
  Different prefixes may have different lifetimes. Model/prompt changes can
  invalidate reuse before an estimated deadline. Expiry does not erase the
  conversation; it changes whether a later request can reuse cached input.
- The installed Agent SDK declares `promptCacheTtl: "5m" | "1h"`, with
  `CLAUDE_CODE_PROMPT_CACHE_TTL` taking precedence. Its documented automatic
  policy uses one hour for Claude subscriptions within usage limits and five
  minutes for API-key and cloud-provider sessions. Subagents have a separate
  setting and policy. The actual CLI version and backend must be considered;
  these declarations are not proof of the policy in every installed CLI.
- API usage can distinguish five-minute and one-hour **writes** through
  `cache_creation.ephemeral_5m_input_tokens` and
  `cache_creation.ephemeral_1h_input_tokens`. Aggregate cache-read counts do
  not identify the lifetime of every reused prefix. No authoritative per-entry
  expiry timestamp was found in the installed SDK surface inspected here.
- Compaction consumes an additional model request and replaces active context
  with a summary. It is not guaranteed to reduce total spend, especially for
  small conversations or sessions the user never resumes.

Sources:

- [Anthropic prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`: `Settings.promptCacheTtl`,
  `subagentPromptCacheTtl`, `SDKStatusMessage`, `SDKCompactBoundaryMessage`, `Query`.
- `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`:
  `CacheCreation`, `CacheControlEphemeral`.

## Existing integration points and gaps

- `server/claude-provider.ts` owns each live query, pending prompts,
  permissions, compaction state, cancellation ownership, and child tracking.
  It already receives root `message_start` usage and assistant usage. Child
  messages are separated before root accounting, which should also apply to
  cache observations.
- The provider accepts slash commands through its existing prompt pipeline.
  No dedicated `Query.compact()` method was found. Native `/compact` should
  remain the implementation route; do not write a separate summarizer or edit
  Claude's transcript files to emulate compaction.
- `configStateFor` exposes per-session provider settings; it currently offers
  the Fast toggle. The public setting contract supports toggles and selects.
- The client already registers agent-scoped composer pills in
  `client/claude-session-fork.tsx`. A cache pill can use that supported UI
  surface without a host patch.
- `index.server.ts` can inject a coordinator into the bundled Claude provider,
  following the existing fork coordinator pattern. Keep shared DTOs independent
  of SDK/provider implementation imports.
- Compaction metadata handling needs correction as a prerequisite:
  `readCompactionMetadata` reads `compaction`/`metadata` with camel-case fields,
  while the installed SDK declares `compact_metadata` with `pre_tokens` and
  `post_tokens`. Existing tests exercise the legacy shape. Add current-SDK
  fixtures before using these events to rebase the countdown or scheduler.
- The published Paseo `send` API defaults to interrupting an active turn.
  A status read followed by `send("/compact")` has a race and is unsuitable
  for unattended maintenance. Execution must reserve the idle provider session
  atomically and share normal command/turn ownership, rather than bypassing it
  with an independent CLI or an untracked write to the SDK input stream.

## Proposed behavior

1. Display a pill such as `Cache ≈03:42`. Its popover explains the lifetime
   source and offers automatic pre-expiry compaction. The estimate must never
   be presented as a server-guaranteed deadline.
2. Track estimated root request-start times. The SDK's `status: "requesting"`
   is a candidate observation; its timing, retry behavior, and root attribution
   need validation against an isolated test session. First-token arrival or
   turn completion alone cannot establish request-start time. Do not infer a
   precise countdown when those are the only available signals.
3. Confirm cache activity using usage observations. Prefer observed write
   lifetime and explicitly resolved configuration; do not assume all sessions
   have five-minute caches. On mixed lifetimes, show a conservative qualified
   estimate or range, and suppress automation if the relevant conversation
   prefix cannot be identified reliably.
4. Show distinct states for unknown, no cache observed, estimated active,
   estimated expired, compacting, and skipped/failed. Historical timestamps
   alone must not turn an imported or reopened session into a known warm cache.
5. Use a global default for newly created sessions, plus a per-session
   override (user decision). Initially default the global setting to off.
   Snapshot its effective value into a new session's persisted provider
   configuration at creation. Changing the global default affects later
   creations, not existing sessions. Existing sessions without an explicit
   setting remain off; resuming a session preserves its stored preference.
6. Schedule on the daemon so the app can be closed. The initial pre-expiry lead
   is **five minutes**, configurable. For a one-hour lifetime, the target is
   55 minutes after the latest observed request start that refreshed the
   relevant prefix. **Skip AFK auto-compaction for five-minute caches** (user
   decision); their countdown can still be displayed. Do not silently shorten
   the lead or compact immediately when a turn ends. The relevant cache read
   must start before expiry; the summary does not need to finish before expiry.
   A lead time cannot compensate for unknown timing or backend behavior.
7. Provide a user-configurable minimum context threshold for AFK auto-compaction
   (user requirement). Both the enable switch and `currentContext > threshold`
   must hold. Use current root context occupancy, including cached input, rather
   than cumulative session tokens or subagent totals. Unknown occupancy suppresses
   automation. Recheck the threshold immediately before starting; reaching it
   alone does not trigger compaction outside the idle/pre-expiry conditions.
   Offer a global default for new sessions and a per-session override, using
   the same creation-time persistence rule as the enable switch. Measure in
   **tokens**, with an initial threshold of **200,000 tokens** (user decision).
   Exactly 200,000 does not exceed this threshold. Do not silently lower it for
   a smaller context window: if native auto-compaction happens first, this AFK
   feature simply will not reach its threshold. Manual `/compact` is unaffected.
8. Require meaningful context growth since the last successful compaction.
   Never repeatedly compact an unchanged summary just because its cache was
   refreshed by the previous compaction, even if it still exceeds the threshold.
9. AFK means the session's current turn/run has **ended with no continuing or
   queued work**, and is waiting for the next user prompt (user definition).
   There is no two-minute inactivity delay and no keyboard/presence detector.
   This is a quiescent open session, not an archived/closed provider session.
   A terminal root result alone does not prove quiescence if children, tools,
   permissions, or autonomous work remain. New activity invalidates the idle
   state and pending scheduling decision; the plugin cannot assume that no
   future event will ever arrive solely because one turn ended.

## Execution constraints

- Operate only on already-open, opted-in root Claude sessions. Do not scan,
  resume, or launch all saved sessions to warm caches or compact them.
- At execution, atomically recheck the observation revision, opt-in state,
  latest context occupancy and effective threshold,
  deadline, foreground/autonomous activity, queued prompts, tools/background
  children, permissions, existing compaction, and fork/rewind operations.
  Busy sessions are deferred while still within a valid deadline, otherwise
  skipped. User work takes precedence; expiry never authorizes interruption.
- Use the existing provider command and lifecycle machinery. Internal
  maintenance must be recognizable as maintenance, with one owner and visible
  status, rather than appearing as a fabricated user prompt or completion
  notification. Resolve its ownership correctly if a user prompt or Stop arrives.
- Each content generation receives at most one successful automatic compaction.
  Bound retries before the deadline; after expiry, report the skip instead of
  launching a cold, potentially expensive compaction.
- Model/settings changes, resume, rewind, and session replacement invalidate
  incompatible observations and pending work. Subagent requests and translator
  requests do not reset the root countdown.
- Cancel scheduled work on close/archive/disposal or when disabled. Persist
  user preferences separately from observations. Never reset a deadline to
  `now + TTL` after a process restart; uncertain state remains unknown.
- For many sessions, schedule the next due event rather than polling every
  session each second. Fetch status for visible UI, then render the countdown
  locally from server time plus a fixed estimated deadline. Add a small
  concurrency bound for simultaneous compactions; skip work that misses its
  deadline while waiting.

## Validation before implementation is enabled

- Verify request-start observations, supported cache lifetimes, actual cached
  input on `/compact`, native command completion/failure, and whether the
  resulting event stream contains enough data for the estimate. Run only in
  explicitly authorized, disposable sessions with a known CLI/backend.
- Use deterministic clock/event tests for both lifetimes, long responses,
  usage with no cache, mixed lifetimes, retries, duplicate events, and clock
  jumps. No observed main-prefix TTL means no automatic compaction.
- Verify five-minute caches remain excluded even when the session is AFK and
  above threshold. Verify the five-minute lead for one-hour caches and that
  entering AFK adds no separate inactivity delay.
- Exercise prompt-versus-timer races, permissions, autonomous turns, children,
  native compaction, forks, rewinds, disabling, disposal, and stale callbacks.
- Verify no repeated compaction of unchanged content and no cold catch-up
  after restart or missed expiry. Simulate many sessions to verify scheduling
  and concurrency bounds.
- Test threshold values below, equal to, and above observed context, unknown
  usage, cached-input accounting, and threshold changes while a timer is
  pending. Verify global defaults do not change existing session preferences.
- Verify countdown and controls through the published plugin UI API. No
  plugin reload, daemon restart, or compaction of existing user sessions is
  part of this analysis or implicitly authorized for later validation.

## Confirmed product decision

Global default for new Claude sessions, plus per-session override. Existing
sessions are not enabled retroactively. The global default and session override
control this feature only; Claude's own context-full auto-compaction remains a
separate setting.

AFK auto-compaction must exceed a user-configurable context threshold, initially
**200,000 tokens**. The initial lead is **five minutes before estimated cache
expiry**. **Five-minute caches are excluded** from AFK auto-compaction.

AFK means the current run has ended, no continuing work remains, and the session
is waiting for the next user prompt. No elapsed-inactivity requirement applies.

Implementation includes the countdown, creation-time defaults, persisted
per-session overrides, and provider-owned scheduling. The global default is
off. Tests use controlled SDK streams and clocks; real-CLI validation remains a
separate, explicitly authorized step.
