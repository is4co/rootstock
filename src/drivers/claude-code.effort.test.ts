// The reasoning knob (SessionOptions.effort) → the engine's top-level `effort`.
//
// Before this field there was no way to ask for more reasoning at all: the whole
// set of options the driver ever built was fixed, and nothing in it was about
// thinking depth (is4co/trellis#51). These tests pin the wire, and the two
// things about it that are easy to get wrong.
//
// The FIRST is the option's name and shape. It is `effort`, top-level on the
// query options, taking one of five strings. That was confirmed against the
// installed SDK's own declarations rather than inferred — `Options.effort`,
// typed `EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'` — and
// separately against the Agent SDK's current published documentation. The trap
// worth naming: the Messages API spells the same idea `output_config.effort`.
// That is a different product, and a nested shape here would reach no model and
// fail no typecheck — so its absence is asserted rather than assumed.
//
// The SECOND is that unset means unset. A host with no opinion must get the
// previous behavior byte for byte, which means no key in the object at all —
// not `undefined`, and not a level rootstock picked on the host's behalf.
//
// The options object is read back through a cast rather than an exported seam,
// for the reason claude-code.briefing.test.ts gives: no SDK type may appear in
// an exported signature, and `buildOptions(): Options` is exactly such a
// signature. `start()` builds no engine until something is sent, so none of this
// needs a key or a network.
//
// One constraint on how this file is written, which is not obvious and is worth
// keeping: it opens as few sessions as the assertions allow, and the five levels
// share one test rather than getting one each. While this was being written,
// adding it made `scripted.test.ts` fail intermittently — in tests about delta
// coalescing and event-for-event replay, which have nothing to do with effort.
// The cause was over there: `settle()` gave its replay assertions a single 15ms
// timer with nothing synchronizing it, so under load the consuming `for await`
// could simply never be scheduled inside the window. That helper now yields
// repeatedly instead of once, which is the actual fix. Opening few sessions here
// is belt to that braces, and cheap: nothing in this file needs more.

import { test, expect } from 'bun:test'
import { createClaudeCodeDriver } from './claude-code'
import type { ReasoningEffort, SessionOptions } from '../types'

/** The private builder, reached the one way that does not widen the public API. */
async function builtOptions(opts: SessionOptions): Promise<Record<string, unknown>> {
  const session = await createClaudeCodeDriver().start(opts)
  const built = (session as unknown as { buildOptions(): Record<string, unknown> }).buildOptions()
  await session.close()
  return built
}

const WORKTREE = '/tmp/rootstock-effort-test'

const ALL_LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

test('every level reaches the engine as a top-level effort string, unchanged', async () => {
  for (const level of ALL_LEVELS) {
    const built = await builtOptions({ worktree: WORKTREE, effort: level })
    expect(built['effort']).toBe(level)
    expect(typeof built['effort']).toBe('string')
    // The neighbouring knobs are not what was asked for and must not be
    // smuggled in: `thinking` is a separate feature that produces thinking
    // blocks, and `maxThinkingTokens` is deprecated in the installed SDK's own
    // declarations. `output_config` is the Messages API's nesting and would be
    // silently inert here.
    expect('thinking' in built).toBe(false)
    expect('maxThinkingTokens' in built).toBe(false)
    expect('output_config' in built).toBe(false)
  }
})

test('no effort means no effort key at all — today\'s behavior, untouched', async () => {
  const built = await builtOptions({ worktree: WORKTREE })
  expect('effort' in built).toBe(false)
})

test('the effort survives a resume — options are rebuilt per query', async () => {
  const driver = createClaudeCodeDriver()
  const session = await driver.resume('sess-effort', { worktree: WORKTREE, effort: 'max' })
  const built = (session as unknown as { buildOptions(): Record<string, unknown> }).buildOptions()
  await session.close()
  expect(built['effort']).toBe('max')
  expect(built['resume']).toBe('sess-effort')
})

// The pass-through decision, pinned. A session may switch tier between turns, so
// the driver does not second-guess the level against the tier it started on: the
// engine resolves the parameter against the model actually serving each request
// and omits it where that model has none. Gating here would silently disarm the
// case the knob exists for — a cheap-tier session whose owner picks a deeper
// model for one hard turn.
test('the effort is not gated on the tier — a fast-tier session still carries it', async () => {
  const built = await builtOptions({ worktree: WORKTREE, tier: 'fast', effort: 'high' })
  expect(built['effort']).toBe('high')
  expect(built['model']).toBeDefined()
})
