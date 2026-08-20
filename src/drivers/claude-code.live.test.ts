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
