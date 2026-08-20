# Changelog

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
