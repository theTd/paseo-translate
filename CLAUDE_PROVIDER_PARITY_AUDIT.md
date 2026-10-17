# Claude provider parity audit

Date: 2026-10-17. Reference: local Paseo checkout `E:/misc/paseo`, commit
`5805b776c`. Plugin: current working tree, including the earlier uncommitted
main-turn lifecycle and steering fixes.

The original audit used focused in-memory SDK simulations against the provider
bundle. The user subsequently requested all findings be fixed. The implementation
now addresses A01-A12, the four additional gaps, and native Stop behavior. Original
finding locations below refer to the pre-fix tree. Nothing is committed or deployed.
No live user session has been interrupted for validation.

## Repair tracking

| Finding | Implementation | Focused validation |
| --- | --- | --- |
| A01 | Query-owned input waits after removal; EOF requires explicit close | message-input and concurrent provider parity tests |
| A02 | UUIDs and command lifecycle track SDK-queued messages; Stop withdraws them | SDK cancellation and acknowledgement-race tests |
| A03 | Reserve prompts before translation; revalidate before startup and send; release fork fence during preparation | message/command/startup cancellation tests, with and without fork coordination |
| A04 | Propagate rejected controls and report only accepted configuration | rejected mode/model/fast-mode and plan-mode tests |
| A05 | Retain permission-clearing UUIDs until Claude starts the human steer | permission-after-steer lifecycle test |
| A06 | Close each retired input and build a fresh query input | crash/resume stale-queue test and existing rewind tests |
| A07 | Capture init identity, runtime model, init/status modes and persistence immediately | crash-before-result resume and runtime-mode tests |
| A08 | Reset resumed status and background membership | repeated child completion/cancellation test |
| A09 | Enable full subagent text forwarding | query-option assertion and child conversation tests |
| A10 | New main init clears stale interruption ownership; idle Stop does not interrupt helpers | genuine wake-up and old-interrupt/new-turn race tests |
| A11 | Reject already-aborted requests and remove listeners on every resolution | expired-permission and listener cleanup tests |
| A12 | Terminalize outstanding root tools on Stop, failed turns and runtime death | dead-runtime card test and existing tool tests |
| Reply streaming | Assemble incremental text/thinking into absolute snapshots, deduplicating final frames | message-stream tests and notification-preview regressions |
| Thinking controls | SDK Max effort, Off capability checks, Ultra Code, next-query constructor changes | catalog/startup/next-query tests |
| Commands with attachments | Move typed slash command after attachment blocks | command/image ordering test |
| Workflow/child facts | Bounded workflow result reader, observed model/effort hooks, live usage and final summary; Agent names | workflow and child-presentation tests |

Protocol v1 has no mutable child-subtitle event. Model/effort/usage facts therefore
appear in the supported child timeline and usage events rather than requiring a
host change to its track-row layout. This is a presentation adaptation, not a
missing observation.

Current validation: 160 focused tests across seven named test files, TypeScript
check, build and daemon-shaped bundle loading all pass. The full
repository test suite was not run. The completed independent review record is below. A real control-only SDK/installed-CLI handshake also passed: 13 models reported
and runtime cancelAsyncMessage available with the new initialization options.
No model turn or tool was run. Full background-work end-to-end validation remains
pending.

## Changed files

- Implementation: `server/claude-provider.ts`, `server/claude-message-input.ts`,
  `server/claude-message-stream.ts`, `server/claude-subagents.ts`,
  `server/claude-workflow-output.ts`, `server/claude-model-manifest.ts`.
- Focused regressions: `server/claude-provider.test.ts`,
  `server/claude-provider-parity.test.ts`, `server/claude-message-input.test.ts`,
  `server/claude-message-stream.test.ts`, `server/claude-subagents-parity.test.ts`.
- Generated bundle: `server/claude-provider.dist.cjs`.
- Documentation: `README.md` and this audit/repair record.

## Independent review record

Round 1: independent full review found five real asynchronous lifetime defects.
All five were accepted and repaired: unbound init UUID inference, a prompt waiting
behind the fork fence, dead-query AbortController ownership, question preparation
after Stop, and delayed Stop completion canceling a newer child. Each has a new
focused regression. No findings were excluded as false positives.

Round 2: original reviewer incremental verification (channel A) closed all five
original findings and found one more A05 ordering gap: a question could finish
preparing after its superseding human steer had already started. Both ordering
variants were accepted as real and fixed with an initial clearing check and a
monotonic permission-clearing generation. Two regression cases cover them.

Round 3: the original reviewer verified the A05 repair in current code and
confirmed the original five findings remain closed. The repair diff introduced
no further real defects. The reviewer independently passed 26 provider-parity
tests in this round; earlier review checks passed 127 provider/fork tests.

Final review: **passed, 3 rounds** (full review, then original-agent incremental
validation twice; channel A, no fallback). Six review findings were fixed; no
false positives were excluded; no unresolved real findings remain. The 12 audit
findings and four additional gaps are implemented and covered as listed above.

## Original confirmed defects (repaired)

### A01 — P1: removing a queued steer can end the input stream

Plugin: `server/claude-provider.ts:308`, `:325`, `:489`.
Native: `agent.ts:6380`, `:4260`.

When a waiting input reader is awakened by a steer, Stop can remove that steer
before the reader resumes. An empty queue then returns `done: true`. A temporary
absence of messages becomes permanent end-of-input. Native input ends only when
explicitly closed and withdraws messages separately.

Reproduced by issuing Stop from the steer acknowledgement listener: the input
consumer ended, then a new prompt received a turn acknowledgement but never
reached that consumer. Fix the input iterator so removal cannot produce EOF.

### A02 — P1: Stop cannot withdraw follow-ups already handed to the SDK

Plugin: `server/claude-provider.ts:279`, `:489`.
Native: `agent.ts:2457`, `:4260`, `:4369`.

The local queue forgets a steer as soon as the SDK reads it. The SDK can still
hold it without Claude having started it. Stop only deletes local entries and
calls `interrupt`; it never invokes SDK `cancelAsyncMessage`. Native tracks
UUIDs until command lifecycle acknowledgement and explicitly withdraws them.

Simulation: the SDK read a UUID-stamped steer; Stop made one interrupt call and
zero cancellation calls. The SDK contract permits queued commands to survive an
ordinary interrupt. A stopped session can therefore resume from an old follow-up.
Foreground prompts also lack the UUID needed for this cancellation protocol.

### A03 — P1: Stop during prompt preparation does not cancel the prompt

Plugin: `server/claude-provider.ts:1114`, `:1152`, `:1183`.
Native: `agent.ts:2366`, `:2396`.

Foreground prompt translation/preparation happens before reserving an active
turn. Stop can complete while that work awaits, after which the provider still
creates and sends the turn. The steering path now revalidates after translation;
the foreground message and command paths do not have equivalent cancellation.
Native reserves the foreground turn first and checks `cancelIssued` before send.

Reproduced by delaying configuration loading inside message preparation: Stop
was acknowledged, then one prompt was delivered and its root turn started after
that acknowledgement. The same await boundary includes prompt translation.

### A04 — P1: failed control changes are reported as successful

Plugin: `server/claude-provider.ts:1666`, `:1689`, `:1711`.
Native: `agent.ts:2533`, `:2564`.

The plugin updates desired mode/model/settings and discards rejected SDK control
calls. It then publishes the changed configuration and completes the request.
Native propagates control failures and commits the mode/model only after the
SDK accepts the change.

Reproduced with a Bypass runtime whose `setPermissionMode(default)` rejects:
the plugin reported successful configuration and Always Ask, while the simulated
runtime retained Bypass. Treat this as a correctness issue, especially for modes.

### A05 — P2: a human follow-up can become blocked by another permission

Plugin: `server/claude-provider.ts:1330`, `:1874`.
Native: `agent.ts:2457`, `:4369`, `:4929`.

`clearPendingPermissions` denies existing cards only. Native remembers the human
steer's UUID until Claude starts it and also denies permissions raised in that
interval. Otherwise, the old work can create another blocking card before it
reads the user's change of direction.

Reproduced: a Write permission created after an accepted human steer remained
unresolved, with one open card and no resolution event.

### A06 — P2: a replacement runtime can receive stale queued input

Plugin: `server/claude-provider.ts:673`, `:1415`, `:2177`.
Native: `agent.ts:3239`, `:3282`.

Query teardown/death clears the query handle but retains the same input sink.
Rebuilding attaches a new query to its existing queue. Native creates a fresh
input object for each query. This also matters to rewind, which retires a query
while retaining its sink.

Reproduced under input backpressure: after runtime death, the first input read by
the next query was the old queued steer, ahead of the new user prompt.

### A07 — P2: init identity and runtime state are not adopted

Plugin: `server/claude-provider.ts:2285`, `:2286`, `:2488`.
Native: `agent.ts:4779`, `:4847`, `:4497`.

Plugin init handling only publishes commands. It does not adopt the session ID,
resolved model or permission mode; status handling also ignores permission-mode
changes. Persistence waits for a terminal result. Native adopts these init facts
and reports mode changes, including a session ID changed by a hook.

Reproduced: init announced a real session and Plan mode, but no persistence was
emitted and the reported mode stayed Bypass. After simulated death before the
first result, the next query had `resume: null`. Long first turns can thus lose
their resume binding on a runtime failure.

### A08 — P2: resumed children can remain running after completion

Plugin: `server/claude-subagents.ts:336`, `:367`, `:462`.
Native: `subagents/live-source.ts:340`, `:356`.

The existing-task branch reopens a child turn without resetting its last status
to running or updating background membership from the resumed declaration.
Native updates both. A second completion equal to the first completion is then
deduplicated against stale status, leaving the reopened turn unfinished.

Reproduced child states: `started, completed, started`; the second completion
produced no terminal event. A resumed foreground child also retains stale
foreground membership when the CLI reannounces it as backgrounded.

### A09 — P2: full child conversations are not requested

Plugin: query options in `server/claude-provider.ts:1439`.
Native: `agent.ts:3478`. SDK option documentation: `sdk.d.ts:1703`.

Native sets `forwardSubagentText: true`; the plugin omits it. The SDK documents
that its default forwards subagent tool blocks, but not the full text/thinking
conversation. The plugin has renderers for those messages yet does not request
them. This can make child panes appear silent while their tools keep working.
Confirmed from captured query options and the SDK's documented default.

### A10 — P2: stale interrupt state can suppress a genuine new wake-up turn

Plugin: `server/claude-provider.ts:467`, `:2274`.
Native: `agent.ts:4037`.

The plugin keeps `interrupted` until a result or user prompt clears it, and its
new autonomous-turn condition refuses init while that flag is set. An interrupt
that arrives between main turns may have no result. Native treats a fresh
main-session init as a new turn bracket and clears stale interrupt state.

Reproduced: finish foreground work, interrupt while idle, then emit a genuine
new `system/init` without a trailing abort result. Only one root start was
reported; there should have been two. This is a remaining lifecycle gap after
the earlier fix. Preserve valid canceled-result ownership when repairing it.

### A11 — P2: already-aborted ordinary permission requests can remain open

Plugin: `server/claude-provider.ts:1874`, `:1902`.
Native: `agent.ts:4967`.

Ordinary tool permission handling subscribes to future abort events without
first checking `signal.aborted`. The question-specific path checks it, but
the generic path does not. Native handles an already-aborted signal immediately.

Reproduced with `AbortSignal.abort()`: the permission promise stayed unresolved
and a new permission card was emitted. The listener also lacks native cleanup
after a normal resolution, retaining obsolete callbacks until signal disposal.

### A12 — P2: root tool cards are not settled when the runtime dies

Plugin: `server/claude-provider.ts:2177`, `:2209`.
Native: `agent.ts:3750`, `:4993`.

The plugin terminates child turns but does not terminalize outstanding root tool
cards. Native flushes running tool calls on turn failure/cancellation. If no tool
result arrives, a stopped or dead operation can keep appearing active.

Reproduced: emit a running Bash tool, then end the runtime stream. The plugin
emitted a runtime failure while that tool's only card status remained `running`.

## Further source-level differences

These are additional parity gaps; they were not tested against a live CLI.

- **Reply streaming:** the plugin handles `stream_event` for usage only
  (`claude-provider.ts:2301`), whereas native `TimelineAssembler`
  (`agent.ts:1158`) assembles text/thinking deltas. Plugin prose waits for
  completed assistant blocks.
- **Thinking controls:** query startup silently maps Max to xhigh
  (`claude-provider.ts:1655`); native passes the selected SDK `effort`
  (`agent.ts:3357`). The native Off/model compatibility checks and Ultracode
  configuration are also absent from the plugin's dynamic thinking catalog.
- **Slash commands with attachments:** native moves the typed command block
  behind attachments (`agent.ts:3553`); plugin `buildMessageBlocks`
  (`claude-provider.ts:1361`) retains their original order. Native documents
  that a command must be the final block for expansion.
- **Workflow completion and child metadata:** native reads completed workflow
  output files (`subagents/live-source.ts:440`) and tracks model/effort/usage
  presentation. The plugin's task notifications only update usage and status
  (`claude-subagents.ts:425`); workflow result text and much of that presentation
  are absent. Root tool-input title lookup also recognizes `Task` but not `Agent`.

## Deliberate or previously documented differences

- The earlier session-wide Stop policy has now been replaced with native parity:
  declare `perTaskStopAffordance: true`, withdraw unstarted user messages, interrupt
  only the main turn, and preserve helpers. Claude can stop an individual helper
  through TaskStop. Session closure still tears down the owned runtime.
- Translation, original-language replay restoration, notification previews,
  custom fork delivery and capability-gated archive support are plugin-specific
  behaviors, not automatically parity defects.
- Native's current stale-result suppression differs from the plugin's ordered
  canceled-result counter. A difference alone does not justify replacing that
  counter: the plugin already has regression coverage for multiple interrupted
  requests and successful trailing results. No defect in that counter was
  established by this audit, apart from the missing new-turn handling in A10.

## Recommended repair order and validation limits

Repair the input lifecycle and UUID/lifecycle tracking together (A01, A02, A06),
then prompt cancellation and truthful control results (A03, A04). Address the
permission, init, child-resume and presentation issues with focused regressions.
Use the native state model as the reference without importing its implementation
across the plugin boundary.

The reproductions used the plugin's public provider connection, asynchronous
input consumption, controlled SDK output frames and injected control failures.
They establish the listed provider behaviors, not end-to-end CLI outcomes in
every version. Real Claude/Paseo validation remains necessary before deployment.
Only the named focused checks above were run for the repairs; no full test suite was run.
