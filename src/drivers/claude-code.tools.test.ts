// `turn.end` means the turn is over — so the engine is not handed a tool that ends
// one early.
//
// The SDK's subagent dispatcher runs in the background by default. A model that
// calls it has nothing further to say, the engine emits `result`, and this driver
// turns `result` into `turn.end` — while the work is still running. A consumer that
// acts on `turn.end` acts on nothing: trellis commits and pushes an owner's edit
// there, and on 2026-08-25 that produced a turn reported "Ready" in under twenty
// seconds, a commit that never happened because the worktree was still clean, and
// the correct edit landing on disk twenty seconds later.
//
// The options object is private and holds an SDK type, which this file deliberately
// does not import — no SDK shape leaks past `claude-code.ts`. So the deny list is
// pinned two ways: its contents, and the fact that `buildOptions` still passes it to
// the engine. The second half is a source read, because a constant nothing uses is
// exactly what this regression would look like.

import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DENIED_TOOLS } from './claude-code'

const SOURCE = join(import.meta.dir, 'claude-code.ts')

test('the subagent dispatcher is denied, under both names the SDK has used', () => {
  // `Agent` is the tool in the SDK this package pins; `Task` is what it was called
  // before. Denying a tool the engine does not have costs nothing, and dropping
  // either name would reopen the hole on one SDK version or the other.
  expect([...DENIED_TOOLS].sort()).toEqual(['Agent', 'Task'])
})

test('the deny list is actually handed to the engine, not merely declared', async () => {
  const source = await readFile(SOURCE, 'utf8')
  const options = source.slice(source.indexOf('private buildOptions()'))
  expect(options).not.toBe('')
  expect(options).toContain('disallowedTools')
  expect(options).toContain('DENIED_TOOLS')
})
