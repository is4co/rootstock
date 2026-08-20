# rootstock

One interface over any code-editing agent. Rootstock is a library plus a driver registry: a
driver turns some engine's native stream into one normalized event union, declares what it
can and cannot do, and gets budget enforcement for free at the registry seam. It knows
nothing about trellis — there are no workspaces here, no previews, no deploy gates, no
editor concepts of any kind. Anything that wants to drive a coding agent programmatically
can use it.

## Install

There is no npm registry. Consumers install from a git tag and run the TypeScript source
directly under bun:

```sh
bun add "git+ssh://git@github.com/is4co/rootstock.git#v0.1.0"
```

The repo is private, so the ssh form is the one that works wherever your clone does. Trellis
pins it from its supervisor app as:

```json
"@is4co/rootstock": "github:is4co/rootstock#v0.1.0"
```

`exports`, `module` and `types` all point at `src/index.ts` — bun consumes the source, and
`dist/` is a compile gate rather than the shipped artifact. Everything public is re-exported
from that one entry point.

Two runtime dependencies come with the package: `@anthropic-ai/claude-agent-sdk` and `zod`,
both pulled in by the `claude-code` driver. They install whichever driver you actually use,
because the entry point re-exports both. Before v0.1.0 rootstock had no runtime dependencies
at all; the reference driver is what ended that.

## Quickstart

Token-free — the `scripted` driver replays a fixture, so this costs nothing and needs no key:

```ts
import { createScriptedDriver, getDriver, loadFixture, registerDriver } from '@is4co/rootstock'

registerDriver(createScriptedDriver({
  fixture: await loadFixture('node_modules/@is4co/rootstock/fixtures/hello-edit.json'),
  timeScale: 0,
}))

const session = await getDriver('scripted').start({ worktree: process.cwd() })
await session.send('hello')
for await (const event of session.events) {
  if (event.kind === 'message.delta') process.stdout.write(event.text)
  if (event.kind === 'turn.end') break
}
await session.close()
```

## The interface

`src/types.ts` is the source of truth and the published contract. Trellis pins this repo by
tag, so changing an exported type is a breaking change; adding to it is cheap.

The event stream is exactly ten kinds, and no more — a driver that cannot express something
maps it to `tool.other` rather than widening the union:

`message.delta`, `file.edit`, `file.create`, `file.delete`, `command.run`,
`command.output`, `tool.other`, `status`, `turn.end`, `error`

The capability declaration is exactly nine flags:

`streamingText`, `fileEvents`, `resume`, `interrupt`, `interject`, `hooks`,
`toolInjection`, `costReporting`, `modelSelection`

Both counts are held in place by a type-level exhaustiveness assertion in `src/types.test.ts`,
so adding an eleventh kind or a tenth flag fails the typecheck rather than drifting quietly.

## Capability degradation

A `false` flag is not a hole. It is a promise about what happens instead, and the conformance
suite grades the `false` branch on performing exactly that fallback rather than on being
skipped.

| Flag | `false` means |
| --- | --- |
| `streamingText` | Text still arrives as `message.delta`, just coarsely — as few as one delta per message. It never goes missing; chat renders in blocks. |
| `fileEvents` | No `file.*` events at all. The consumer falls back to polling `git diff` on the worktree: worse UX, still correct. |
| `resume` | `resume()` rejects with `UnsupportedError`. The caller starts a fresh session; continuity comes from the worktree and git history, not the agent's memory. |
| `interrupt` | `interrupt()` still resolves, the in-flight turn runs to its natural end, and turns queued behind it are discarded. |
| `interject` | The note is buffered and prepended to the next `send()` — the next turn's preamble. |
| `hooks` | Hooks passed in options are silently ignored, never an error. Run the lint layer as a filesystem watcher instead, and feed results back through `interject` or the next turn's preamble. |
| `toolInjection` | Injected tools are silently ignored. The agent works through code alone, which most tasks survive. |
| `costReporting` | Token and cost fields are null. Budgets fall back to wall-clock and turn counts, which are always populated. |
| `modelSelection` | `models()` returns exactly one tier and a requested tier is ignored, never an error. |

The punchline: a homegrown script that satisfies only `streamingText` and `fileEvents` is a
legitimate driver. Everything else degrades to something a consumer can live with, as long as
the declaration is honest.

## Writing a driver

1. Implement `Driver` from `src/types.ts`. Nothing else is the contract.
2. Translate the engine's native events into the ten-kind union. Never pass a native event
   through, and never leak an SDK-shaped payload out through `tool.other` because mapping it
   properly was harder. `file.edit` is the one that matters most: an engine that reports
   edits as opaque tool calls forces the consumer to parse diffs.
3. Declare `DriverCapabilities` **honestly**. A `false` flag on a working feature is as broken
   as a `true` flag on a missing one, because a consumer degrades on the declaration, not on
   the behavior.
4. Register it: `registerDriver(driver)`. There is no import-time registration anywhere in this
   package, so `getDriver()` never depends on import order.
5. Grade it: `runConformance(driver, opts)` from `src/conformance/index.ts`. A green run is the
   entry bar — a driver that does not pass it is not finished. The suite runs eighteen checks:
   nine contract clauses and nine capability flags, each flag graded on whichever branch you
   declared. It sees only the public interface, so engine-specific wiring lives in your
   `makeSession`, never in the suite.
6. Do not implement spend caps. Budgets come free — the registry wraps every session that was
   opened with a budget, so a third-party driver inherits enforcement by existing.
7. Record the engine's licensing position in this README, next to the driver. Whether an
   engine may be run on behalf of end users is a fact about the engine, and it belongs where
   someone choosing a driver will read it.

## Budgets

`SessionBudget` is the shape; `withBudget` in `src/budget.ts` is the mechanism. The split is
deliberate: rootstock enforces caps but sets none. It reads no environment variable for a
dollar figure, keeps no ledger, and persists no spend. The numbers — and any per-owner
aggregation across sessions — arrive from the caller through `SessionOptions.budget`, with
prior spend passed as `alreadySpentTodayUsd`; rootstock adds only what this session has spent.

Two caps, two behaviors. The per-day cap refuses a new turn: `send()` rejects with
`BudgetExceededError`. The per-turn cap stops a turn already running: the decorator watches
live usage and interrupts mid-flight. Either way the session's stream carries an `error` event
whose `detail.code` is `budget.day` or `budget.turn` — a budget violation is deliberately not
an eleventh event kind. `maxTurnSeconds` and `maxTurnsPerDay` are the fallbacks that keep caps
meaningful on a driver declaring `costReporting: false`, where token and cost fields are null.
Enforcement sits at the `getDriver()` seam, wrapping only sessions whose options carry a
budget; a session opened without one is handed through exactly as the driver made it.

## Drivers

### `claude-code` — the reference driver

`src/drivers/claude-code.ts`. In-process on `@anthropic-ai/claude-agent-sdk`, declaring all
nine capabilities. It is the driver the conformance suite was written against and the one to
read when writing another.

Sessions run bare and permissive by design: no setting sources are loaded (`settingSources: []`),
so a user's or a repo's local configuration cannot change how a session behaves, and tool
permissions run at the bypass class. Safety is the caller's lint layer and deploy gate, not a
per-tool prompt nobody is there to answer. Engine session state goes wherever the factory's
`configDir` points (`CLAUDE_CONFIG_DIR`); rootstock hardcodes no path, and leaving it unset uses
the engine's own default. Model tiers are surfaced by name only — Haiku, Sonnet, Opus — with the
tier-to-model mapping inside the driver, where a vendor bump is a rootstock release rather than a
type change.

**Licensing.** This driver runs on an organization API key, or on Bedrock or Vertex. Delegating a
Claude.ai Pro or Max subscription to end users is explicitly not permitted, so a deployment
serving other people meters each session against an org key rather than borrowing a seat.

### `scripted` — the test driver

`src/drivers/scripted.ts`. Replays a JSON fixture: events verbatim, tools referenced by name, so
fixtures live in files and cost nothing. Every capability can be flipped false individually, and
each false flag performs its declared degradation for real — which is what makes it the driver
that develops the conformance suite itself. Token-free, network-free, no licensing surface.

## What is exercised, and what is not

Everything in v0.1.0 is proven **offline only**. The test suite runs in-process against fixtures
and fakes, with no network and no key: 91 passing tests across 7 files, plus 3 tests skipped for
want of a key.

- **Exercised offline:** the event normalizer (`normalizeSdkMessage` is pure and graded directly
  on SDK-shaped inputs), the registry and its budget seam, both budget caps and their fallbacks,
  the full conformance suite against the `scripted` driver on both branches of all nine flags.
- **Never run against a real engine:** the `claude-code` driver's session. Its resume, interject,
  interrupt and live cost metering are implemented and unit-tested, but no API key has been
  reachable at any point in this repo's history — zero live tokens, zero dollars spent. Reading
  the green suite as a green driver would be a mistake. The live pass is
  `src/drivers/claude-code.live.test.ts`, which skips itself without `ANTHROPIC_API_KEY`; running
  it once against a real key is what would make the driver's declarations true rather than merely
  stated.

Two known gaps, recorded rather than papered over:

1. **`cap.interject`'s true branch has no depth assertion.** The suite grades it on two things:
   that `interject()` resolved, and that the turn ended afterwards. Neither distinguishes a note
   actually delivered mid-turn from one silently dropped. The assertion that would close it needs
   a live key — interject a token mid-turn and assert the same turn's `message.delta` echoes it
   before `turn.end`.
2. **The test suite has latent order-dependence on the registry.** `registerDriver` keeps a
   process-global map and refuses a duplicate id, so a future test file registering under an id
   another file already claimed will fail depending on file order. Register under a distinct id
   per test file until the registry grows a test-scoped reset.

## Versioning

Plain git tags on this repo. No npm, no registry, no published artifact — the tag is the whole
distribution mechanism, and consumers pin one. Changing an exported type in `src/types.ts` is a
breaking change and is called out in the commit that does it. A model-id bump inside a tier is a
rootstock release too: the mapping lives in the driver, so moving it means cutting a tag.
