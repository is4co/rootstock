# Changelog

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
