// The suite, run against the scripted driver in four capability configurations
// — every flag true, every flag false, the architecture's own boundary case,
// and one mixed config — plus a lying driver that must fail.
//
// Everything scripted-specific lives here. `src/conformance/index.ts` sees only
// the public Driver/Session interface, which is what makes it valid for drivers
// that do not exist yet; the per-scenario fixtures reach it through
// `opts.makeSession`.

import { describe, expect, test } from 'bun:test'
import type {
  AgentEvent,
  Driver,
  DriverCapabilities,
  Session,
  SessionId,
  SessionOptions,
  TurnUsage,
} from '../types'
import type { ScriptedFixture, ScriptedStep } from '../drivers/scripted'
import { createScriptedDriver } from '../drivers/scripted'
import type { ConformanceOptions, ConformanceScenario } from './index'
import { CONFORMANCE_NOTE, CONFORMANCE_PROBE, CONFORMANCE_TASKS, runConformance } from './index'

/** The `stream` turn's text as one block — what a driver that does not really
 *  stream delivers, whether it declares that honestly or not. */
const STREAM_TEXT =
  'Movable type reached Europe in the 1400s. Gutenberg made it practical.' +
  ' Presses spread across the continent. Books grew cheap. Literacy followed.'

const USAGE: TurnUsage = { inputTokens: 100, outputTokens: 50, costUsd: 0.01, wallClockMs: 12, turns: 1 }
const END: AgentEvent = { kind: 'turn.end', stopReason: 'completed', usage: USAGE }

const ALL_FALSE: DriverCapabilities = {
  streamingText: false,
  fileEvents: false,
  resume: false,
  interrupt: false,
  interject: false,
  hooks: false,
  toolInjection: false,
  costReporting: false,
  modelSelection: false,
}

/** Authored steps ending, as every fixture turn must, in a turn.end. */
function ended(...events: AgentEvent[]): ScriptedStep[] {
  return [...events.map((event) => ({ event })), { event: END }]
}

/**
 * One fixture per scenario, bound to the suite's fixed task prompts with
 * `match` — which is how a replay proves text routing, including the
 * interject-as-preamble degradation whose note is observable nowhere else.
 */
function fixtureFor(scenario: ConformanceScenario, caps: DriverCapabilities): ScriptedFixture {
  switch (scenario) {
    case 'echo':
      return {
        version: 1,
        turns: [
          {
            match: CONFORMANCE_TASKS.echo,
            steps: ended(
              { kind: 'status', status: 'working' },
              { kind: 'message.delta', text: 'Ack' },
              { kind: 'message.delta', text: 'nowledged.' },
            ),
          },
          {
            // The streaming stimulus, taken as a second turn on the same
            // session. The `true` branch streams it in pieces; the `false`
            // branch delivers the identical text in exactly one delta, which
            // is what that degradation promises — coarse, never missing.
            match: CONFORMANCE_TASKS.stream,
            steps: caps.streamingText
              ? ended(
                  { kind: 'message.delta', text: 'Movable type reached Europe in the 1400s.' },
                  { kind: 'message.delta', text: ' Gutenberg made it practical.' },
                  { kind: 'message.delta', text: ' Presses spread across the continent.' },
                  { kind: 'message.delta', text: ' Books grew cheap.' },
                  { kind: 'message.delta', text: ' Literacy followed.' },
                )
              : ended({ kind: 'message.delta', text: STREAM_TEXT }),
          },
        ],
      }
    case 'fileChange':
      return {
        version: 1,
        turns: [{
          match: CONFORMANCE_TASKS.fileChange,
          steps: ended(
            { kind: 'message.delta', text: 'Editing the heading.' },
            {
              kind: 'file.edit',
              path: 'web/pages/home.tsx',
              // `range` present, so `after` is that span alone — not the file.
              before: '  return <h1>Welcome</h1>',
              after: '  return <h1>Hello</h1>',
              range: { startLine: 2, endLine: 2 },
            },
          ),
        }],
      }
    case 'toolCall':
      return {
        version: 1,
        turns: [{
          match: CONFORMANCE_TASKS.toolCall,
          steps: [
            { callTool: { name: CONFORMANCE_PROBE, input: { task: 'toolCall' } } },
            { event: END },
          ],
        }],
      }
    case 'interject':
      return {
        version: 1,
        turns: [
          {
            match: CONFORMANCE_TASKS.echo,
            steps: ended(
              { kind: 'message.delta', text: 'Working' },
              { kind: 'message.delta', text: ' on it.' },
            ),
          },
          {
            // The whole point of the degraded branch: the next turn only runs
            // if the buffered note reached its effective text.
            match: caps.interject ? CONFORMANCE_TASKS.followup : CONFORMANCE_NOTE,
            steps: ended({ kind: 'message.delta', text: 'Noted.' }),
          },
        ],
      }
    case 'interrupt':
      return {
        version: 1,
        turns: [
          {
            match: CONFORMANCE_TASKS.echo,
            steps: ended(
              { kind: 'message.delta', text: 'Starting' },
              { kind: 'message.delta', text: ' the long part.' },
            ),
          },
          // Authored so that a driver which fails to discard the queued send
          // produces a second turn.end the suite can see.
          {
            match: CONFORMANCE_TASKS.followup,
            steps: ended({ kind: 'message.delta', text: 'Should never run.' }),
          },
        ],
      }
    case 'resume':
      return {
        version: 1,
        turns: [
          { match: CONFORMANCE_TASKS.echo, steps: ended({ kind: 'message.delta', text: 'First.' }) },
          { match: CONFORMANCE_TASKS.followup, steps: ended({ kind: 'message.delta', text: 'Second.' }) },
        ],
      }
    case 'modelSelection':
      return { version: 1, turns: [{ steps: ended({ kind: 'message.delta', text: 'Unused.' }) }] }
  }
}

interface Rig {
  driver: Driver
  opts: ConformanceOptions
}

/**
 * A driver facade over one scripted driver per scenario. Sessions must not
 * share state, so each scenario gets its own driver with its own fixture;
 * `resume()` dispatches back to whichever of them minted the session.
 */
function scriptedRig(capabilities: Partial<DriverCapabilities>, wrap?: (session: Session) => Session): Rig {
  const owners = new Map<SessionId, Driver>()
  const representative = createScriptedDriver({
    fixture: { version: 1, turns: [{ steps: ended() }] },
    timeScale: 0,
    capabilities,
  })
  const caps = representative.capabilities

  const startFor = async (scenario: ConformanceScenario, options: SessionOptions): Promise<Session> => {
    const underlying = createScriptedDriver({
      fixture: fixtureFor(scenario, caps),
      timeScale: 0,
      capabilities,
    })
    const session = await underlying.start(options)
    owners.set(session.id, underlying)
    return wrap ? wrap(session) : session
  }

  const driver: Driver = {
    id: representative.id,
    capabilities: caps,
    models: () => representative.models(),
    start: (options: SessionOptions) => startFor('echo', options),
    resume: async (id: SessionId, options: SessionOptions) => {
      const underlying = owners.get(id)
      if (!underlying) throw new Error(`no such session: ${id}`)
      const session = await underlying.resume(id, options)
      return wrap ? wrap(session) : session
    },
  }

  const opts: ConformanceOptions = {
    timeoutMsPerTurn: 1_000,
    makeSession: (ctx) => startFor(ctx.scenario, {
      worktree: ctx.worktree,
      tools: ctx.tools,
      hooks: ctx.hooks,
      ...(ctx.tier === undefined ? {} : { tier: ctx.tier }),
    }),
  }

  return { driver, opts }
}

/** Declares fileEvents: false and emits a file.edit anyway. */
function leakAFileEvent(session: Session): Session {
  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<AgentEvent> {
      yield { kind: 'file.edit', path: 'leaked.ts', after: 'leaked' }
      for await (const event of session.events) yield event
    },
  }
  return {
    id: session.id,
    events,
    send: (text: string, opts?: Parameters<Session['send']>[1]) => session.send(text, opts),
    status: () => session.status(),
    interject: (note: string) => session.interject(note),
    interrupt: () => session.interrupt(),
    usage: () => session.usage(),
    close: () => session.close(),
  }
}

/**
 * Declares `streamingText: true` and batches each turn's text into a single
 * `message.delta` — exactly what a driver that does not really stream looks
 * like from outside. This is the negative that keeps `cap.streamingText`
 * honest: if the check could not fail this driver, moving the streaming proof
 * off the echo task would have quietly turned it into a check that passes
 * anything.
 */
function batchDeltas(session: Session): Session {
  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<AgentEvent> {
      let buffered = ''
      for await (const event of session.events) {
        if (event.kind === 'message.delta') {
          buffered += event.text
          continue
        }
        if (event.kind === 'turn.end' && buffered.length > 0) {
          yield { kind: 'message.delta', text: buffered }
          buffered = ''
        }
        yield event
      }
      if (buffered.length > 0) yield { kind: 'message.delta', text: buffered }
    },
  }
  return {
    id: session.id,
    events,
    send: (text: string, opts?: Parameters<Session['send']>[1]) => session.send(text, opts),
    status: () => session.status(),
    interject: (note: string) => session.interject(note),
    interrupt: () => session.interrupt(),
    usage: () => session.usage(),
    close: () => session.close(),
  }
}

const CONFIGS: { name: string; capabilities: Partial<DriverCapabilities> }[] = [
  { name: 'every capability true', capabilities: {} },
  { name: 'every capability false', capabilities: ALL_FALSE },
  {
    // §2.5.3's own boundary case: "a homegrown script satisfying only
    // streamingText and fileEvents is a legitimate driver".
    name: 'streamingText and fileEvents only',
    capabilities: { ...ALL_FALSE, streamingText: true, fileEvents: true },
  },
  {
    name: 'interrupt, interject and costReporting degraded',
    capabilities: { interrupt: false, interject: false, costReporting: false },
  },
]

describe('runConformance against the scripted driver', () => {
  for (const config of CONFIGS) {
    test(`all 18 checks pass with ${config.name}`, async () => {
      const rig = scriptedRig(config.capabilities)
      const report = await runConformance(rig.driver, rig.opts)

      expect(report.checks.filter((check) => !check.ok).map((check) => `${check.id}: ${String(check.detail)}`))
        .toEqual([])
      expect(report.ok).toBe(true)
      expect(report.checks.length).toBe(18)
      expect(report.driverId).toBe('scripted')
    })
  }

  test('the report names nine clause checks and nine capability checks', async () => {
    const rig = scriptedRig({})
    const report = await runConformance(rig.driver, rig.opts)
    const ids = report.checks.map((check) => check.id)
    expect(ids.filter((id) => id.startsWith('clause.')).length).toBe(9)
    expect(ids.filter((id) => id.startsWith('cap.')).length).toBe(9)
    expect(new Set(ids).size).toBe(18)
  })
})

describe('the suite has teeth', () => {
  test('a lying driver fails: fileEvents declared false while a file.edit still leaks out', async () => {
    const rig = scriptedRig(ALL_FALSE, leakAFileEvent)
    const report = await runConformance(rig.driver, rig.opts)

    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual(['cap.fileEvents'])
    expect(report.checks.find((check) => check.id === 'cap.fileEvents')?.detail).toContain('file.*')
  })

  test('a lying driver fails: streamingText declared true while every turn arrives in one delta', async () => {
    const rig = scriptedRig({}, batchDeltas)
    const report = await runConformance(rig.driver, rig.opts)

    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => !check.ok).map((check) => check.id)).toContain('cap.streamingText')
    expect(report.checks.find((check) => check.id === 'cap.streamingText')?.detail).toContain('produced 1')
  })
})
