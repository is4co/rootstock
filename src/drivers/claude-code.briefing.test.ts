// The launch briefing (SessionOptions.briefing) → the engine's `systemPrompt`.
//
// This is the only channel a host has for standing context: `buildOptions` sets
// `settingSources: []`, so no CLAUDE.md, no `.claude/` and no skill file in the
// worktree is ever read. A boundary the host enforces but cannot state at launch
// is a rule the agent only learns by being refused afterwards, which is a trap;
// these tests pin the wire that stops that.
//
// The options object is read back through a cast rather than an exported seam on
// purpose: this file's header rule is that no SDK type may appear in an exported
// signature, and `buildOptions(): Options` is exactly such a signature.

import { test, expect } from 'bun:test'
import { createClaudeCodeDriver } from './claude-code'
import type { SessionOptions } from '../types'

/** The private builder, reached the one way that does not widen the public API. */
async function builtOptions(opts: SessionOptions): Promise<Record<string, unknown>> {
  const session = await createClaudeCodeDriver().start(opts)
  const built = (session as unknown as { buildOptions(): Record<string, unknown> }).buildOptions()
  await session.close()
  return built
}

const WORKTREE = '/tmp/rootstock-briefing-test'

test('a briefing reaches the engine as a plain-string systemPrompt', async () => {
  const briefing = 'You may edit anything except .github/**.'
  const built = await builtOptions({ worktree: WORKTREE, briefing })
  expect(built['systemPrompt']).toBe(briefing)
  // A string, never the preset envelope: the preset form would bolt the engine's
  // own Claude Code prompt on top, which is a behavior change beyond adding text.
  expect(typeof built['systemPrompt']).toBe('string')
})

test('no briefing means no systemPrompt key at all — today\'s behavior, untouched', async () => {
  const built = await builtOptions({ worktree: WORKTREE })
  expect('systemPrompt' in built).toBe(false)
})

test('a whitespace-only briefing is treated as absent', async () => {
  const built = await builtOptions({ worktree: WORKTREE, briefing: '   \n  ' })
  expect('systemPrompt' in built).toBe(false)
})

test('the briefing is trimmed, and survives a resume — options are rebuilt per query', async () => {
  const driver = createClaudeCodeDriver()
  const session = await driver.resume('sess-abc', { worktree: WORKTREE, briefing: '  edit anything  ' })
  const built = (session as unknown as { buildOptions(): Record<string, unknown> }).buildOptions()
  await session.close()
  expect(built['systemPrompt']).toBe('edit anything')
  expect(built['resume']).toBe('sess-abc')
  // The bare-session guarantee is unchanged: the briefing is the channel, not a
  // door back to filesystem settings.
  expect(built['settingSources']).toEqual([])
})
