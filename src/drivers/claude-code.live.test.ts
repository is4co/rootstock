// Live conformance for the claude-code driver: the real engine, a real key,
// real money. This is the run that makes the driver's declarations true rather
// than merely stated — the fixtures test grades the normalizer, and only this
// grades the session.
//
// It skips itself when no key is present, which is what keeps `bun test` — the
// CI path — free of any need for a key or a network. A skipped run is an
// unverified driver, not a passing one; say so rather than reading a green
// suite as a green driver.
//
// Cost: one full pass is a handful of turns on the fast tier, which is cents.
// Every session runs against a throwaway git repo in a temp directory.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runConformance } from '../conformance'
import type { AgentEvent, Session } from '../types'
import { createClaudeCodeDriver } from './claude-code'

const HAS_KEY = (process.env['ANTHROPIC_API_KEY'] ?? '').length > 0

/** A real turn against a real model, so the per-turn ceiling is minutes. */
const TURN_TIMEOUT_MS = 120_000

const workspaces: string[] = []

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rootstock-claude-code-'))
  workspaces.push(dir)
  // A git repo with something in it: the fileChange task asks for a small edit,
  // and an empty directory would force the agent to invent a file instead.
  await writeFile(join(dir, 'README.md'), '# conformance workspace\n\nA file to edit.\n')
  await writeFile(join(dir, 'greeting.txt'), 'hello\n')
  const git = Bun.spawnSync(['git', 'init', '--quiet', dir])
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`)
  return dir
}

afterAll(async () => {
  for (const dir of workspaces) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe.skipIf(!HAS_KEY)('claude-code live conformance', () => {
  test(
    'passes runConformance for the capability set it declares',
    async () => {
      const driver = createClaudeCodeDriver()
      const report = await runConformance(driver, {
        makeWorkspace,
        timeoutMsPerTurn: TURN_TIMEOUT_MS,
        makeSession: (ctx) =>
          driver.start({
            worktree: ctx.worktree,
            tools: ctx.tools,
            hooks: ctx.hooks,
            // The suite names a tier only for the modelSelection scenario, which
            // opens a session and never takes a turn — so honoring it costs
            // nothing, and everything that does spend runs on the fast tier.
            tier: ctx.tier ?? 'fast',
          }),
      })

      const failures = report.checks.filter((check) => !check.ok)
      expect(failures.map((check) => `${check.id}: ${check.detail ?? ''}`)).toEqual([])
      expect(report.checks).toHaveLength(18)
      expect(report.ok).toBe(true)
    },
    900_000,
  )
})

// --- the session lifecycle, against the real engine -------------------------

function collect(session: Session): AgentEvent[] {
  const box: AgentEvent[] = []
  void (async () => {
    for await (const event of session.events) box.push(event)
  })()
  return box
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { kind: 'message.delta' }> => event.kind === 'message.delta')
    .map((event) => event.text)
    .join('')
}

function turnEnds(events: AgentEvent[]): Extract<AgentEvent, { kind: 'turn.end' }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: 'turn.end' }> => event.kind === 'turn.end')
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
  return predicate()
}

describe.skipIf(!HAS_KEY)('claude-code live session lifecycle', () => {
  test(
    'a resumed session still knows what the first one was told',
    async () => {
      // Session JSONL lands under CLAUDE_CONFIG_DIR, which is what makes resume
      // survive the workbench sleeping (§2.5.4). A temp dir here keeps the run
      // out of the developer's own ~/.claude.
      const configDir = await mkdtemp(join(tmpdir(), 'rootstock-config-'))
      workspaces.push(configDir)
      const driver = createClaudeCodeDriver({ configDir })
      const worktree = await makeWorkspace()
      const options = { worktree, tier: 'fast' as const }

      const first = await driver.start(options)
      const fromFirst = collect(first)
      await first.send('Remember this codeword and reply with just the word: mulberry-73. Do not use any tools.')
      expect(await waitFor(() => turnEnds(fromFirst).length >= 1, TURN_TIMEOUT_MS)).toBe(true)
      // The id is the engine's own session id by now, not the placeholder the
      // session opened with — that is the whole reason resume can work at all.
      const sessionId = first.id
      expect(sessionId.length).toBeGreaterThan(0)
      await first.close()

      const resumed = await driver.resume(sessionId, options)
      expect(resumed.id).toBe(sessionId)
      const fromResumed = collect(resumed)
      await resumed.send('What was the codeword I asked you to remember? Reply with just the word.')
      expect(await waitFor(() => turnEnds(fromResumed).length >= 1, TURN_TIMEOUT_MS)).toBe(true)
      expect(textOf(fromResumed).toLowerCase()).toContain('mulberry-73')
      await resumed.close()
    },
    600_000,
  )

  test(
    'an interrupt mid-turn leaves the session idle and the stream clean, not wedged',
    async () => {
      const driver = createClaudeCodeDriver()
      const worktree = await makeWorkspace()
      const session = await driver.start({ worktree, tier: 'fast' })
      const seen = collect(session)

      await session.send('Count slowly from 1 to 200, one number per line, with a short remark after each.')
      expect(await waitFor(() => seen.length >= 2, TURN_TIMEOUT_MS)).toBe(true)
      expect(turnEnds(seen)).toHaveLength(0)

      await session.interrupt()
      expect(await waitFor(() => turnEnds(seen).length >= 1, TURN_TIMEOUT_MS)).toBe(true)

      const end = turnEnds(seen)[0]
      expect(end?.stopReason).toBe('interrupted')
      expect(session.status()).toBe('idle')

      // Nothing follows the interrupted turn.end — the contract interrupt: true
      // promises — and the session is still usable rather than wedged.
      const after = seen.indexOf(end as AgentEvent) + 1
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      expect(seen.slice(after)).toEqual([])

      await session.close()
      expect(session.status()).toBe('dead')
    },
    600_000,
  )
})
