# Changelog

## v0.2.1 — 2026-09-07

**A session id this driver minted for itself is no longer accepted back as one to resume.**
A `ClaudeCodeSession` starts life carrying `claude-code-<ms>-<n>`, because the interface
requires a non-empty id before any turn is taken, and swaps it for the engine's own the
moment the engine reports one. If the first turn dies before that ever happens, the
placeholder is the only id the host has seen — and a host that persists session ids persists
that.

The next resume hands it to `--resume`, which answers `"claude-code-1787617156728-1" is not
a UUID and does not match any session title` and kills the turn before it reaches the model.
The turn costs exactly zero dollars, which is the tell. It is not a bad run to retry: the
same id is stored, so the same refusal comes back on every turn after it, forever. Measured
on three trellis workspaces on 2026-08-25 (`is4co/trellis#43`); the one that started it hit
an Anthropic key with no balance on its very first turn.

`createClaudeCodeDriver().resume()` now rejects such an id with `not a resumable session id:
<id> was minted by this driver, not by the engine`. Only the driver that mints these can
recognise one — above the driver seam a `claude-code-…` id is just a string — which is why
the guard is here rather than in the consumer.

**Rejecting, not quietly starting a fresh session.** A caller that handles a failed resume
already has the right machinery: it catches, starts fresh, and says so. Returning a fresh
session instead would hand that caller a session with no history while telling it the resume
succeeded, and the owner would be talking to an agent that had silently forgotten
everything. One lost conversation, reported, beats a conversation that cannot continue —
or one that pretends it did.

**Not `UnsupportedError`.** `ERR_UNSUPPORTED` is the contract's signal for `resume: false`,
and the conformance suite grades it as such. This driver does resume; it refuses one id.
Reusing the code would tell a caller the operation is unavailable, and a host that stops
recording session ids when `capabilities.resume` is false would stop recording them
altogether.

The pattern is exactly what `nextSessionId` builds and nothing looser — `Date.now()` and the
counter are both positive integers, so both segments are digits, and `claude-code-1-2-3` is
not a match. An engine id is a UUID and cannot collide. `src/drivers/claude-code.fixtures.test.ts`
pins the refusal, its message, that it is not an `UnsupportedError`, and that a UUID and six
near misses still resume.

No exported type changed, no capability flag changed, and `resume` stays `true`. The live
conformance suite is unaffected: its resume scenario takes a full turn before it resumes, so
the id it hands back is the engine's own.

## v0.2.0 — 2026-09-07

**A session can now be asked to think harder.** `SessionOptions` gains an optional `effort`,
and the `claude-code` driver passes it to the engine as its top-level `effort` option.

**Breaking.** `DriverCapabilities` gains a tenth required flag, `effortSelection`. Every
object typed as `DriverCapabilities` must now declare it, so this is a minor bump rather
than a patch, and a driver written against v0.1.x will not typecheck until it does. The
addition is mechanical — the compiler names every site — but it is a shape change to a
published type, which is the one thing this package does not do quietly.

Before this, the knob did not exist. The complete set of options the driver ever handed the
SDK was `cwd`, `resume`, `model`, `permissionMode`, `allowDangerouslySkipPermissions`,
`includePartialMessages`, `settingSources`, `disallowedTools`, `systemPrompt`, `mcpServers`
and `env` — nothing about reasoning depth, and no pass-through for arbitrary SDK options.
So every turn ran at whatever the engine defaulted to, and no host could change it without
changing rootstock.

The option name was confirmed against the installed SDK's own declarations and against the
Agent SDK's current published documentation, rather than inferred. It is a **top-level**
`effort` taking one of five levels, `low` through `max`. The Messages API spells the same
idea `output_config.effort`; that is a different product, and the nested shape would reach
no model while failing no typecheck — which is why the driver's tests assert its absence
rather than trusting nobody will write it. `maxThinkingTokens` is deprecated in the
installed declarations and is not this knob; `thinking` is a separate feature about
thinking blocks and is untouched.

**Rootstock picks no level.** Absent means no key is sent at all and the engine runs at its
own default — the previous behavior byte for byte, the same bargain `briefing` makes. This
is a deliberate departure from the shape the issue sketched, which put a hardcoded `high`
next to `TIER_MODELS`. A constant there applies to every tier, and `DEFAULT_TIER` is the
cheapest one, where more reasoning is precisely not the point. Which turns are worth
thinking about is something only the host knows, so the host chooses.

The level is **not gated on the tier**. It is handed over as asked and the engine resolves
it against the model actually serving the request, omitting it where that model has no such
parameter. That is the only place the decision can be made correctly, because a session can
switch tier between turns: a choice made once at session start would be wrong for every turn
after the switch, and would suppress the level in exactly the case the knob exists for — a
cheap-tier session whose owner picks a deeper model for one hard turn. This rests on the
SDK's type declarations rather than on an observed run; the live test that would settle it
is written and skips without a key.

`TurnOptions` is unchanged. The SDK does expose a mid-session path, but its precedence
against the session-level option is undocumented and its `max` is session-scoped rather than
per-turn, so per-turn effort is left for whoever can verify it against a live engine.

The new flag carries the usual promise on both branches. `effortSelection: false` means a
requested level is ignored — never an error — and the session runs at the engine's default
depth exactly as if the field were unset. The conformance suite grades that, and grows from
eighteen checks to nineteen: nine contract clauses and now ten capability flags. What the
suite can honestly grade is acceptance, since nothing in the event vocabulary can observe
that a model reasoned harder; that the value actually reaches the engine is pinned
per-driver instead, by reading the built options back.

## v0.1.3 — 2026-08-24

**A session can now be told the rules before its first turn.** `SessionOptions` gains an
optional `briefing`, and the `claude-code` driver passes it to the engine as `systemPrompt`.

Additive only — no exported type changed shape, so this is not a breaking release.

The gap it closes is not a missing convenience. Sessions are built with `settingSources: []`
by design (§2.5.5): no `CLAUDE.md`, no `.claude/`, no filesystem hooks, no skills. Combined
with the driver never having set `systemPrompt`, that left **no channel at all** for standing
context, and a host with a rule to state could only state it after the fact. Trellis enforces a
diff boundary at its deploy gate; before this field, an agent learned that boundary by having a
finished, committed edit refused — a rule you only meet by breaking it, which is a trap rather
than a rule.

Rootstock does not compose the briefing and does not know what is in it. What a boundary is,
and how to phrase it, belongs to the host. What rootstock guarantees is delivery: `briefing`
is re-applied on every `query()` call, so it survives a resume exactly as `cwd`, `model` and
the MCP wiring do.

The value goes over as a **plain string**, not `{ type: 'preset', preset: 'claude_code',
append }`. The SDK's default when `systemPrompt` is omitted is an empty custom prompt, so a
string replaces nothing; the preset form would additionally bolt the engine's own Claude Code
prompt onto every session, which is a much larger change than telling the agent the rules. An
empty or whitespace-only briefing is treated as absent, so a host with nothing to say gets the
previous behavior byte for byte. A driver that cannot carry standing context ignores the field
— the same silent degradation `tools` and `hooks` already declare (§2.5.3), never an error.

## v0.1.2 — 2026-08-25

**A turn no longer ends while its own work is still running.** The engine's subagent
dispatcher — `Agent` in the SDK this package pins, `Task` before it — runs in the background
by default; the SDK's own schema for it says so. A model that dispatches one has nothing
further to say, so the engine emits `result`, and `result` is what this driver turns into
`turn.end`. The work then lands seconds after the turn a consumer was told had finished.

That cost was paid on a live box before it was found. Trellis commits and pushes an owner's
edit on `turn.end` (`is4co/trellis#2`); on 2026-08-25 an owner's first instruction produced
two background `Agent` calls, a turn that ended in under twenty seconds saying "I'm searching
for the public home page now. Let me wait for the agent to locate it", a save that ran against
a still-clean worktree and committed nothing, and the correct edit appearing on disk twenty
seconds later with nothing left to notice it. The owner saw "Ready" and had no edit.

`buildOptions` now passes `disallowedTools: ['Agent', 'Task']`. This is the same decision as
`settingSources: []` one line above it: the bare session is declared rather than incidental,
and background subagents were only ever in it by omission. Denying a name the engine does not
have costs nothing, which is why both spellings are listed.

`DENIED_TOOLS` is exported so the deny list can be asserted rather than remembered;
`src/drivers/claude-code.tools.test.ts` pins its contents and, separately, that
`buildOptions` still hands it to the engine — a constant nothing uses is exactly what this
regression would look like.

No exported type changed and no capability flag changed. The live conformance suite was re-run
against the real engine with this in place: 18 checks, all passing.

## v0.1.1 — 2026-08-20

**Proven against a real engine.** `src/drivers/claude-code.live.test.ts` now runs clean against
the live Claude Agent SDK: all eighteen conformance checks pass, covering every one of the nine
declared capabilities, plus resume continuity, a clean mid-turn interrupt, and `file.edit`
ranges. Run twice, clean both times. No capability flag changed — the driver's declarations were
honest, and are now demonstrated rather than merely stated.

`file.edit` now carries an explicit `range`. `after` on an `Edit` has always been the replaced
span rather than the whole file, but it shipped without the `range` that says so, and
`src/types.ts` entitles a consumer receiving no `range` to read `after` as whole-file content —
so a fragment could be spliced over an entire file. The driver now derives the pre-edit span
(1-based, both endpoints inclusive) from a line index it keeps in `NormalizerState`, seeded from
`Write` content and `Read` results and kept current as each `Edit` applies, so `MultiEdit`
sub-edits report the shift the ones before them caused. `normalizeSdkMessage` stays pure — no
filesystem access was added. An `Edit` whose span cannot be located unambiguously degrades to
`tool.other` rather than emitting a range-less fragment, and `NotebookEdit` now degrades the
same way, since one cell of a JSON notebook has no line span. **This is behaviour that changed:
a consumer matching on `file.edit` for notebooks now sees `tool.other`.**

Two smaller behaviour changes fall out of the same invariant: an `Edit` carrying no
`old_string`, or an empty one, has no span to locate and now degrades to `tool.other` where it
previously produced a `file.edit`.

No exported type changed. `src/types.ts` is JSDoc-only in this release — `range` already existed
as an optional field — so this is a fix-forward tag, not a breaking one. Additive only:
`NormalizerState` gains `files`, and the conformance suite gains `CONFORMANCE_TASKS.stream`
alongside `CONFORMANCE_EDIT_FILE`, `CONFORMANCE_EDIT_CONTENT`, `CONFORMANCE_EDIT_OLD` and
`CONFORMANCE_EDIT_NEW`.

**Two conformance checks were fixed, not weakened.** `cap.streamingText` was graded on the echo
task, which asks for a *short acknowledgement* — a terse enough reply arrives in one chunk, so
the check was a coin flip on the model's brevity. It now grades a second turn asking for prose
(measured: 10-11 deltas against a floor of 2). `cap.fileEvents` was graded on "make a small edit
to a file in this workspace", which names no file and no change; a real engine answered it by
asking which file and what change, produced no edit, and so failed a driver that was working.
The suite now seeds its own target file and names the exact line to replace. Both floors are
unchanged, and a new negative test proves `cap.streamingText` still fails a driver that declares
streaming and batches every turn into one delta.

Offline: 99 passing across 7 files, 4 skipped for want of a key.

## v0.1.0 — 2026-08-20

Initial release. The driver interface and 10-kind `AgentEvent` union (`src/types.ts`), the
driver registry with budget enforcement at the seam (`src/registry.ts`, `src/budget.ts`), the
`scripted` test driver (`src/drivers/scripted.ts`), the `claude-code` reference driver
(`src/drivers/claude-code.ts`, all nine capabilities), and the conformance suite
(`src/conformance/index.ts`). Public surface — including `withBudget`, `BudgetExceededError`
and `BudgetCode` — is re-exported from `src/index.ts`, which is what the package `exports`
points at: consumers install from this tag and run the TypeScript source under bun.

First release with runtime dependencies. `@anthropic-ai/claude-agent-sdk` and `zod` arrive with
the `claude-code` driver; rootstock was dependency-free before it.

**Not yet proven against a real engine.** The suite is green offline — 91 passing across 7
files, 3 skipped for want of a key — and no part of the `claude-code` driver's session has ever
run against the live engine: no API key was reachable while it was built, so resume, interject,
interrupt and live cost metering are implemented and unit-tested but unexercised. `bun test` on
`src/drivers/claude-code.live.test.ts` with `ANTHROPIC_API_KEY` set is the run that would change
that. Two known gaps are described under "What is exercised, and what is not" in `README.md`:
the true branch of `cap.interject` has no depth assertion on any driver, and the test suite has
latent order-dependence on the process-global registry.
