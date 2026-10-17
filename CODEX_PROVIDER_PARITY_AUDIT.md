# Codex provider parity audit

Reference: Paseo's native Codex adapter in `E:/misc/paseo`, commit `5805b776c`.
Plugin baseline: `f9ebd69`. This compares the two adapters and checks their
app-server handling against the official protocol documentation:
https://developers.openai.com/codex/app-server/

This records the original audit and the subsequent repair. The findings below
describe the baseline; repair status is recorded at the end. No native Paseo
file or running user conversation was modified. Translation and the
original-language display are expected differences; they do not explain the
adapter differences below.

## Evidence and limits

- The existing 53 tests pass across `codex-provider.test.ts`,
  `codex-items.test.ts`, and `codex-app-server.test.ts`.
- Additional controlled app-server scenarios compiled the current provider in
  memory and exercised its public connection, notifications, request handlers,
  delayed preparation and injected failures. No new test source was written.
- These scenarios reproduced the behaviors described as reproduced below.
  Source-only gaps are labeled separately. No live model turn, tool, or user
  thread was executed or modified.
- The native source is the reference for native-provider parity. Official
  protocol evolution can expose problems shared by both adapters; those are
  recorded separately rather than attributed exclusively to the plugin.

## Behavioral defects

### C01 — P1: prompt admission and cancellation start too late

Plugin: `server/codex-provider.ts:711`, `:805`, `:950`.
Native: `codex-app-server-agent.ts:4342`, `:4971`.

The plugin checks active state before awaiting translation/preparation, but
reserves the turn only after client/thread setup. Stop during preparation cannot
invalidate that request, and two prompts can both pass the initial admission.
Native uses `pendingForegroundStart` and `cancelRequested` across preparation.

Reproduced: an acknowledged Stop was followed by a `turn/start` for the stopped
prompt. Two concurrent prepared messages also generated two native start RPCs
and two local turn starts instead of one admission.

### C02 — P1: a steer can target an old turn after translation

Plugin: `server/codex-provider.ts:872`.
Native: `codex-app-server-agent.ts:4430` (`matchesSteerAdmission`).

The plugin captures client/thread/native/local turn identifiers, awaits
translation, then sends without validating that they still own the active turn.
Native revalidates before and after building input.

Reproduced: turn t1 completed and t2 started while a follow-up prepared. The
plugin still sent `expectedTurnId: t1` and reported the old steer as accepted
when the simulated server acknowledged t1.

### C03 — P1: steer errors can trigger destructive replacement or false acceptance

Plugin: `server/codex-provider.ts:916`; host bridge:
`plugin-provider.ts:1173`. Native: `codex-app-server-agent.ts:911`, `:4430`.

Every plugin steer exception becomes a failed prompt result, which the host
bridge interprets as steering unavailable and can replace by interrupting.
Native distinguishes a definitive rejection from an ambiguous timeout/disconnect;
ambiguous errors propagate so an accepted-but-unacknowledged message is not
automatically resent. Native also requires an exact accepted turn ID.

Reproduced: a timeout became a failed steer result. With
`clearPendingPermissions`, an existing approval was already canceled before the
server accepted the steer. An empty `{}` acknowledgement was also accepted as a
successful steer, because the plugin allows a missing acknowledged turn ID.

### C04 — P1: approvals for the same item overwrite each other

Plugin: `server/codex-provider.ts:1378`, `:1485`.
Native: `codex-app-server-agent.ts:6960`.

The plugin derives command permission IDs solely from itemId. Native uses
`approvalId ?? itemId` because multiple callbacks can belong to one tool item.

Reproduced: two requests with one itemId and distinct approvalIds emitted the
same card ID. Answering resolved the second RPC only; the first promise remained
orphaned and was no longer in the map for teardown to resolve.

### C05 — P2: question translation outlives its cancellation ownership

Plugin: `server/codex-provider.ts:1418`, `:1507`.
Native question registration: `codex-app-server-agent.ts:7052`.

Display translation runs before permission registration without a cancellation
generation or a closed/turn-ownership check. Answer translation removes the
pending entry before awaiting translation, likewise making it unreachable to
Stop or supersession. Native ordinary question registration has no such display
translation window; the translation adapter must explicitly own that window.

Reproduced: start preparing a question, acknowledge Stop, release preparation;
the plugin emits a new blocking permission card after Stop. The answer-side
late-completion risk is established by source inspection, not a live CLI test.

### C06 — P2: idle Stop affects a later, unrelated turn

Plugin: `server/codex-provider.ts:950`, `:1038`.
Native: `codex-app-server-agent.ts:4971`.

The plugin sets a session-wide interrupted flag even with no active turn. A
later `turn/started` sees the stale flag and automatically calls interrupt.
Native idle interruption returns without attaching cancellation to future work.

Reproduced: complete t1, Stop while idle, then announce a new root turn. The
plugin sends `turn/interrupt` for the new turn. The notification path also fires
that async interrupt without a rejection handler, so an actual interrupt RPC
failure can escape as an unhandled promise rejection.

### C07 — P2: child routing is incomplete and contaminates root telemetry

Plugin: capabilities at `server/codex-provider.ts:70`, routing at `:1008`, `:1258`.
Native: `codex-app-server-agent.ts:5401`, `:5583`, `:5888`.

The plugin does not advertise subsessions or register native child routes. It
drops child prose/reasoning and flattens child tools into the root. Child token
usage and plan updates are not rejected by the same child filter. Native buffers
early child notifications, creates child descriptors, and routes child activity
without treating aggregate child telemetry as root state.

Reproduced: a child's usage updated session s's root context meter to 98,765
tokens. The connection exposed no child-session capability. Child panes and
their conversation histories are therefore absent, not merely untranslated.

### C08 — P2: valid plan updates produce no checklist

Plugin: `server/codex-provider.ts:1352`.
Native: `codex-app-server-agent.ts:2708`, `:6192`.

The plugin reads `record.steps`; the native adapter and official protocol use
`plan`. Reproduced with a documented `turn/plan/updated` payload containing
`plan: [{ step, status }]`: zero todo items were emitted. Existing steps-shaped
fixtures do not cover this wire contract.

### C09 — P2: declined tools remain displayed as running

Plugin: `server/codex-items.ts:106`.
Native: `tool-call-mapper-utils.ts:3`, native Codex mapper tests at
`codex/tool-call-mapper.test.ts:675`.

The plugin recognizes failed/completed/canceled but not declined. Native maps
declined/denied/rejected to a failed terminal card. Reproduced: a completed
command item with `status: declined` mapped to `status: running`.

### C10 — P2: per-turn policy loses resolved workspace settings

Plugin: `server/codex-provider.ts:588`, `:650`, `:838`.
Native: `codex-app-server-agent.ts:3676`, `:2177`, `:4239`.

The plugin always imposes a workflow preset and constructs sandboxPolicy with
only its type. It neither reads resolved workspace settings nor retains the
sandbox returned by resume. Native respects explicit overrides and preserves
resolved network access, writable roots and temporary-directory exclusions.

Reproduced wire difference: thread config contained network_access=true and
writable_roots=[E:/shared], but the next turn explicitly sent only
`{ type: workspaceWrite }`. Whether a particular server defaults or rejects
missing fields depends on its schema; the configured fields are not preserved
by the adapter. This can explain extra approvals or different directory/network
access despite apparently matching settings.

### C11 — P2: leaving Auto-review does not explicitly reset its reviewer

Plugin: `server/codex-provider.ts:104`, `:847`.
Native: `codex-app-server-agent.ts:300`, `:4262`.

Only the Auto-review preset specifies approvalsReviewer. Native ordinary and
full-access presets explicitly select user, preventing a prior auto-review
selection from carrying forward.

Reproduced wire difference: the first turn sent auto_review; after switching to
Default the next turn omitted the field. The adapter sends no explicit reset,
so behavior depends on the server's retained thread configuration.

### C12 — P2: rewind drops provider/configuration context

Plugin: `server/codex-provider.ts:1727`.
Native: `codex/rewind.ts:100`, `codex-app-server-agent.ts:4940`.

The plugin forks with only threadId and beforeTurnId, clears its local mapping,
and does not reload the forked history. Native passes cwd, model, service tier,
inner config and extended-history settings, selects the supported rewind
strategy, then rebuilds history and pending question state. Native explicitly
documents that fork does not carry the parent provider config automatically.

Reproduced: a custom-model/custom-provider session's fork RPC contained no
model, config or cwd. Rewinding can therefore change the backend/model context
and leaves local history/anchor state less complete than native rewind.

### C13 — P2: model/default/speed settings lag native discovery

Plugin: `server/codex-provider.ts:115`, `:382`, `:833`, `:1981`.
Native: `codex-app-server-agent.ts:3850`, `:4204`, `:4636`, `:5224`, `:7449`.

Fast availability is a hardcoded model-name set, not model/list serviceTiers.
The plugin sends literal fast only when enabled and omits the explicit default
when disabled. Native uses the advertised tier ID and sends an explicit tier.
Native also reconciles configured model/reasoning defaults through config/read;
the plugin only uses the model catalog and largely ignores resolved resume state.

Reproduced: model gpt-6.1-sol advertised a Fast tier with ID priority, but the
plugin exposed no speed setting. Default-reconciliation and retained-tier
effects are source-level differences; no claim is made that every account or
Codex version exposes the same service tiers.

## Missing native user-facing features

### C14 — Plan mode and the plan approval/implementation flow

Native loads collaborationMode/list, sends collaborationMode on turns, offers
plan_mode, and turns a completed proposal into approval and implementation
actions (`codex-app-server-agent.ts:3730`, `:3792`, `:3885`, `:4205`, `:6155`).
The plugin never loads collaboration modes, exposes no Plan toggle, and renders
plan items as ordinary completed cards. Correcting C08 alone will not add this
workflow. This is a substantial behavioral gap rather than a translated label.

### C15 — Native asynchronous questions

Native `codex/async-questions.ts` recognizes completed agentMessage items with
`delivery: async` and structured questions, persists pending answers and submits
answers through the appropriate future turn. The plugin treats the item as an
ordinary text message and never creates the question UI.

Reproduced with the native async-question item shape: zero question cards.

### C16 — Built-in commands, goals and custom prompt templates

Native exposes compact, goal when enabled, configured prompts and refreshed
skills, and executes compact/goal through app-server control methods
(`codex-app-server-agent.ts:5067`, `:5103`, `:5140`, `:4145`).

The plugin loads skills once and converts every command into a skill-style
`$name` prompt. Reproduced `/compact`: ordinary input `$compact` was sent via
turn/start; no thread/compact/start RPC was made. Goals and custom prompt
expansion are not implemented.

### C17 — MCP elicitation

Native registers `mcpServer/elicitation/request` and handles resolution
notifications (`codex-app-server-agent.ts:3958`, `:5403`). The plugin registers
no elicitation handler; its unknown-request transport path acknowledges `{}`
(`server/codex-app-server.ts:378`).

Confirmed from the handler inventory. MCP form/auth interactions cannot use the
same native prompt/response flow and may receive a response lacking the required
elicitation action. No live MCP service was contacted for this audit.

### C18 — Tool progress, rich images and more complete tool projections

Native processes command/file output deltas, terminal interaction, compatibility
tool events, imageView/imageGeneration items and image-bearing MCP results.
The plugin handles basic item start/completion, text/reasoning and usage but
ignores those progress methods; its item mapper supports a smaller union.

Reproduced: imageView and imageGeneration both mapped to null. Source inspection
also shows MCP output serialized as generic JSON instead of the native image
materialization path. This explains silent-looking long commands and missing
image results. Multi-file display differences need care: native also selects a
primary file in its rich detail, so a first-file layout alone is not proof of a
plugin-only defect.

### C19 — Disabled and newly changed skills

Native filters enabled=false and refreshes skill discovery for commands
(`codex-app-server-agent.ts:3224`, `:5067`). The plugin's startup-only loader
ignores enabled. Reproduced: a disabled skill was still offered as a command.
Its command cache also does not refresh as native's does.

### C20 — Structured output

Native validates and passes outputSchema on turn/start
(`codex-app-server-agent.ts:4216`). The plugin does not advertise
prompt.output_schema and never forwards that field.

The public capability gate correctly rejected a structured prompt in the
controlled test. This is an explicit unsupported feature, not silent schema
loss. Any native workflow requiring structured output cannot use this provider
interchangeably until support is added.

## Shared protocol-evolution risk

The current official documentation says new persistent threads use paginated
history and describes thread/turns/list and thread/items/list. The plugin replay
only requests thread/read with includeTurns=true. The inspected native history
loader also uses that legacy-shaped response (`codex-app-server-agent.ts:2090`,
`:2150`). Do not describe paginated replay as a proven plugin-only regression.
Both need version-specific validation against the installed app-server.

Similarly, current official documentation describes thread/fork lastTurnId and
thread/revert beforeTurnId, while the inspected native adapter supports a
beforeTurnId fork path through its transport abstraction. A parameter-name
difference against today's documentation is insufficient on its own to declare
the plugin's existing fork unsupported by the user's installed version. C12's
missing configuration and state restoration are independently established.

## Repair direction

The plugin currently reproduces a smaller, separately maintained Codex adapter.
It has both implementation drift and missing native workflows. More translation
prompt tuning will not close these differences.

1. Repair admission/cancellation, exact steer ownership and error propagation,
   approval identity/lifetimes, terminal statuses and root/child routing first.
2. Match resolved sandbox/reviewer/model/service-tier behavior and preserve it
   through resume and rewind.
3. Add the native Plan, async-question, child-pane, command, MCP and rich-tool
   surfaces through the supported plugin protocol.
4. Keep translation around the prompt/question/display boundaries. Use native
   behavior and actual app-server shapes as the regression contract, rather
   than importing native implementation modules across the plugin boundary.

## Repair status

C01-C20 are implemented in the plugin. Focused regression tests cover admission
and Stop during translation/startup; stale and ambiguous steering; independent
approval callbacks and question cancellation; child routing and usage isolation;
plan payloads; resolved sandbox/reviewer/service tiers; Plan approval; persistent
async questions; compact/goals; refreshed enabled skills; MCP elicitation;
structured output; images, legacy tools and progress; and paginated rewind.

The provider keeps root/child rendering state in `codex-item-stream.ts`, child
routing in `codex-child-sessions.ts`, history hydration in `codex-history.ts`,
command templates in `codex-commands.ts`, and configuration/schema normalization
in explicitly named helpers. No native implementation is imported.

The installed CLI is `codex-cli 0.159.3`. Its generated JSON schemas confirm that
`thread/items/list` returns `{item, turnId}` entries and that rewind uses
`thread/revert.beforeTurnId`. The plugin uses fork + revert for 0.159+, the native
beforeTurnId fork path for 0.156-0.158/paginated older threads, and fork + rollback
for older legacy threads. Forks retain configuration and rebuild message mappings,
children and async-question state. The source thread is preserved.

MCP URL elicitations and forms requiring fields are declined, matching native
Paseo's current supported surface. Service tiers and Plan mode depend on server
advertisement; goals are enabled only on compatible CLIs (or explicit feature
configuration). Tests use controlled app-server traffic; no live model turn was
started.

## Final verification and independent review

- `npm run typecheck`: passed.
- Focused Codex tests: **94 passed**, across `codex-provider.test.ts`,
  `codex-items.test.ts`, `codex-app-server.test.ts`, and
  `codex-parity-helpers.test.ts`. The full suite was not run.
- `npm run build`: passed. This repository's standard build verifies the Claude
  bundle; a separate in-memory Codex bundle was also evaluated successfully in
  the daemon's `require`-injected factory shape (`translate-codex`).
- Read-only real CLI smoke check: initialization, `model/list` (8 models),
  `collaborationMode/list` (2 modes), and workspace configuration RPC all passed
  against Codex 0.159.3. No thread or model turn was created by that check.
- `git diff --check`: passed. Git reports its existing CRLF-to-LF normalization
  notices; no text-encoding migration was needed.

Independent reviewer: `/root/review_codex_parity`. Three rounds, all using the
same reviewer; no fallback, escalation, or false-positive exclusions.

1. Full review found eight defects plus missing workspace cwd: workflow override
   precedence; concurrent prompt admission during rewind; delayed retired-turn
   events; switching runtime before rewind hydration succeeded; interrupted async
   questions reappearing; dynamic image data entering text; mutable plan approval
   text; and child failures leaving tools running. All were accepted as real.
2. Original-reviewer incremental validation confirmed seven groups and cwd were
   fixed. Resume still bypassed normalized workflow policy, and a newly identified
   exact already-idle interrupt response left local foreground state active.
3. Original-reviewer incremental validation confirmed resume uses the common
   policy builder and definitive idle interruption settles only captured work.
   Earlier fixes remained valid; no new real defects were found. **Passed.**

The remaining validation limit is live model-turn behavior: tests exercise
controlled protocol traffic and a real read-only handshake, without changing a
running user's conversation. Plan/service-tier availability remains driven by
server capabilities. Unsupported MCP URL/required-field forms are deliberately
declined as in native Paseo.

## Changed-file inventory

- `server/codex-provider.ts`: lifecycle, settings, permissions, workflows, commands,
  persistence, replay, and atomic rewind integration.
- `server/codex-app-server.ts`: CLI version/arguments and truthful unsupported-RPC
  responses.
- `server/codex-items.ts`: terminal statuses, dynamic tools, and image projections.
- `server/codex-child-sessions.ts`: nested child routing, buffering, isolated
  usage, and terminal lifecycle.
- `server/codex-item-stream.ts`: shared per-thread streaming/tool state and legacy
  protocol normalization.
- `server/codex-history.ts`: legacy and paginated history hydration.
- `server/codex-session-settings.ts`: collaboration, service tiers, and sandbox
  normalization.
- `server/codex-commands.ts`: custom prompt discovery and argument expansion.
- `server/codex-output-schema.ts`: structured schema normalization.
- `server/codex-provider.test.ts`, `server/codex-app-server.test.ts`, and
  `server/codex-parity-helpers.test.ts`: focused regressions.
- `README.md` and this audit: supported behavior, verification, and repair record.

The unrelated `CLAUDE_SESSION_FORK_FEASIBILITY.md` was left untouched.
