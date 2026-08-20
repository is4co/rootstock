import { describe, expect, test } from 'bun:test'
import type { AgentEvent, InjectedTool, Session, TurnUsage } from '../types'
import { UnsupportedError } from '../types'
import { getDriver, registerDriver } from '../registry'
import type { ScriptedFixture, ScriptedStep } from './scripted'
import { createScriptedDriver, loadFixture } from './scripted'

const WORKTREE = '/tmp/rootstock-scripted-test'
const FIXTURE_PATH = `${import.meta.dir}/../../fixtures/hello-edit.json`

function usage(turns = 1): TurnUsage {
  return { inputTokens: 100, outputTokens: 50, costUsd: 0.01, wallClockMs: 12, turns }
}

const END: AgentEvent = { kind: 'turn.end', stopReason: 'completed', usage: usage() }

function steps(...events: AgentEvent[]): ScriptedStep[] {
  return events.map((event) => ({ event }))
}

function settle(ms = 15): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Drain the session's events into a box for the life of the test. */
function collect(session: Session): AgentEvent[] {
  const box: AgentEvent[] = []
  void (async () => {
    for await (const event of session.events) box.push(event)
  })()
  return box
}

function deltas(events: AgentEvent[]): Extract<AgentEvent, { kind: 'message.delta' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { kind: 'message.delta' }> => e.kind === 'message.delta')
}
function turnEnds(events: AgentEvent[]): Extract<AgentEvent, { kind: 'turn.end' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { kind: 'turn.end' }> => e.kind === 'turn.end')
}
function errorsIn(events: AgentEvent[]): Extract<AgentEvent, { kind: 'error' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { kind: 'error' }> => e.kind === 'error')
}

describe('replay', () => {
  test('full-capability replay matches the fixture event-for-event', async () => {
    const authored: AgentEvent[] = [
      { kind: 'status', status: 'working' },
      { kind: 'message.delta', text: 'Sure — ' },
      { kind: 'message.delta', text: 'editing.' },
      { kind: 'file.edit', path: 'web/pages/home.tsx', after: 'after', before: 'before' },
      { kind: 'command.run', command: 'bun test' },
      { kind: 'command.output', output: 'ok', stream: 'stdout' },
      END,
    ]
    const driver = createScriptedDriver({
      fixture: { version: 1, turns: [{ steps: steps(...authored) }] },
      timeScale: 0,
    })
    const session = await driver.start({ worktree: WORKTREE })
    expect(session.status()).toBe('idle')

    const seen = collect(session)
    await session.send('go')
    expect(session.status()).toBe('working')
    await settle()

    expect(seen).toEqual(authored)
    expect(session.status()).toBe('idle')
    await session.close()
    expect(session.status()).toBe('dead')
  })

  test('a second close is a no-op and the events iterable completes', async () => {
    const driver = createScriptedDriver({
      fixture: { version: 1, turns: [{ steps: steps(END) }] },
      timeScale: 0,
    })
    const session = await driver.start({ worktree: WORKTREE })
    let completed = false
    void (async () => {
      for await (const _event of session.events) { /* drain */ }
      completed = true
    })()
    await session.close()
    await session.close()
    await settle()
    expect(completed).toBe(true)
    expect(session.status()).toBe('dead')
  })

  test('the sample JSON fixture loads and replays end to end', async () => {
    const fixture = await loadFixture(FIXTURE_PATH)
    expect(fixture.version).toBe(1)
    expect(fixture.turns.length).toBe(2)

    const driver = createScriptedDriver({ fixture, timeScale: 0 })
    const session = await driver.start({ worktree: WORKTREE })
    const seen = collect(session)
    await session.send('please say hello')
    await settle()
    await session.send('thanks')
    await settle()

    expect(turnEnds(seen).length).toBe(2)
    expect(seen.some((e) => e.kind === 'file.edit' && e.path === 'web/pages/home.tsx')).toBe(true)
    await session.close()
  })
})

describe('fixture validation', () => {
  const build = (fixture: unknown): (() => void) => () =>
    createScriptedDriver({ fixture: fixture as ScriptedFixture })

  test('a turn whose last event is not turn.end is rejected, naming the turn', () => {
    const fixture = {
      version: 1,
      turns: [{ steps: steps(END) }, { steps: steps({ kind: 'message.delta', text: 'dangling' }) }],
    }
    expect(build(fixture)).toThrow(/turn 1 must end with a turn.end event/)
  })

  test('a wrong version is rejected', () => {
    expect(build({ version: 2, turns: [] })).toThrow(/expected version 1/)
  })

  test('an empty turn is rejected', () => {
    expect(build({ version: 1, turns: [{ steps: [] }] })).toThrow(/turn 0 has no steps/)
  })

  test('loadFixture validates too', async () => {
    const path = `${import.meta.dir}/../../fixtures/hello-edit.json`
    await expect(loadFixture(path)).resolves.toBeDefined()
    await expect(loadFixture(`${import.meta.dir}/does-not-exist.json`)).rejects.toBeDefined()
  })
})

describe('turn routing', () => {
  test('a match mismatch produces an engine error event and skips the turn', async () => {
    const driver = createScriptedDriver({
      fixture: {
        version: 1,
        turns: [{ match: 'heading', steps: steps({ kind: 'message.delta', text: 'never' }, END) }],
      },
      timeScale: 0,
    })
    const session = await driver.start({ worktree: WORKTREE })
    const seen = collect(session)
    await session.send('something else entirely')
    await settle()

    const failures = errorsIn(seen)
    expect(failures.length).toBe(1)
    expect(failures[0]?.source).toBe('engine')
    expect(failures[0]?.message).toContain('heading')
    expect(failures[0]?.message).toContain('something else entirely')
    expect(deltas(seen).length).toBe(0)
    expect(turnEnds(seen).length).toBe(0)
    expect(session.usage().turns).toBe(1)
    await session.close()
  })

  test('a send past the last fixture turn reports the stream exhausted', async () => {
    const driver = createScriptedDriver({
      fixture: { version: 1, turns: [{ steps: steps(END) }] },
      timeScale: 0,
    })
    const session = await driver.start({ worktree: WORKTREE })
    const seen = collect(session)
    await session.send('one')
    await settle()
    await session.send('two')
    await settle()

    expect(errorsIn(seen).map((e) => e.message)).toEqual(['fixture exhausted'])
    expect(turnEnds(seen).length).toBe(1)
    expect(session.status()).toBe('idle')
    await session.close()
  })
})

describe('declared degradations — one per capability flag', () => {
  test('streamingText: false coalesces consecutive deltas into one', async () => {
    const authored = steps(
      { kind: 'message.delta', text: 'a' },
      { kind: 'message.delta', text: 'b' },
      { kind: 'message.delta', text: 'c' },
      END,
    )
    const fixture: ScriptedFixture = { version: 1, turns: [{ steps: authored }] }

    const coarse = createScriptedDriver({ fixture, timeScale: 0, capabilities: { streamingText: false } })
    const coarseSession = await coarse.start({ worktree: WORKTREE })
    const coarseSeen = collect(coarseSession)
    await coarseSession.send('go')
    await settle()
    expect(deltas(coarseSeen).map((e) => e.text)).toEqual(['abc'])
    await coarseSession.close()

    const fine = createScriptedDriver({ fixture, timeScale: 0 })
    const fineSession = await fine.start({ worktree: WORKTREE })
    const fineSeen = collect(fineSession)
    await fineSession.send('go')
    await settle()
    expect(deltas(fineSeen).map((e) => e.text)).toEqual(['a', 'b', 'c'])
    await fineSession.close()
  })

  test('fileEvents: false emits no file.* events at all', async () => {
    const fixture: ScriptedFixture = {
      version: 1,
      turns: [{
        steps: steps(
          { kind: 'file.create', path: 'a.ts', after: 'a' },
          { kind: 'file.edit', path: 'b.ts', after: 'b' },
          { kind: 'file.delete', path: 'c.ts' },
          { kind: 'message.delta', text: 'edited three files' },
          END,
        ),
      }],
    }
    const driver = createScriptedDriver({ fixture, timeScale: 0, capabilities: { fileEvents: false } })
    const session = await driver.start({ worktree: WORKTREE })
    const seen = collect(session)
    await session.send('go')
    await settle()

    expect(seen.some((e) => e.kind.startsWith('file.'))).toBe(false)
    expect(deltas(seen).map((e) => e.text)).toEqual(['edited three files'])
    expect(turnEnds(seen).length).toBe(1)
    await session.close()
  })

  test('resume: false throws UnsupportedError; true continues at the next turn', async () => {
    const fixture: ScriptedFixture = {
      version: 1,
      turns: [
        { steps: steps({ kind: 'message.delta', text: 'first' }, END) },
        { steps: steps({ kind: 'message.delta', text: 'second' }, END) },
      ],
    }

    const incapable = createScriptedDriver({ fixture, timeScale: 0, capabilities: { resume: false } })
    const dead = await incapable.start({ worktree: WORKTREE })
    const rejection = incapable.resume(dead.id, { worktree: WORKTREE })
    await expect(rejection).rejects.toBeInstanceOf(UnsupportedError)
    await dead.close()

    const capable = createScriptedDriver({ fixture, timeScale: 0 })
    const first = await capable.start({ worktree: WORKTREE })
    const firstSeen = collect(first)
    await first.send('one')
    await settle()
    expect(deltas(firstSeen).map((e) => e.text)).toEqual(['first'])

    const resumed = await capable.resume(first.id, { worktree: WORKTREE })
    expect(resumed.id).toBe(first.id)
    const resumedSeen = collect(resumed)
    await resumed.send('two')
    await settle()
    expect(deltas(resumedSeen).map((e) => e.text)).toEqual(['second'])

    await expect(capable.resume('no-such-session', { worktree: WORKTREE })).rejects.toBeInstanceOf(Error)
    await first.close()
    await resumed.close()
  })

  test('interrupt: true halts the turn; false lets it finish and discards the queue', async () => {
    // The authored gap is wide on purpose. The test interrupts ~20ms in, so a
    // loaded machine has 15x headroom before it would race the second delta
    // into the stream and fail for a reason that is not the driver's. A capable
    // interrupt does not wait the gap out — it wakes the pause.
    const slowTurn: ScriptedStep[] = [
      { event: { kind: 'message.delta', text: 'first' } },
      { delayMs: 300, event: { kind: 'message.delta', text: 'second' } },
      { event: END },
    ]
    const fixture: ScriptedFixture = {
      version: 1,
      turns: [{ steps: slowTurn }, { steps: steps({ kind: 'message.delta', text: 'queued' }, END) }],
    }

    const capable = createScriptedDriver({ fixture, timeScale: 1 })
    const cut = await capable.start({ worktree: WORKTREE })
    const cutSeen = collect(cut)
    await cut.send('one')
    await settle(20)
    await cut.interrupt()
    await settle(60)
    expect(cutSeen.map((e) => e.kind)).toEqual(['message.delta', 'turn.end'])
    expect(turnEnds(cutSeen)[0]?.stopReason).toBe('interrupted')
    expect(deltas(cutSeen).map((e) => e.text)).toEqual(['first'])
    await cut.close()

    const incapable = createScriptedDriver({ fixture, timeScale: 1, capabilities: { interrupt: false } })
    const runs = await incapable.start({ worktree: WORKTREE })
    const runsSeen = collect(runs)
    await runs.send('one')
    await runs.send('two')
    await settle(20)
    await runs.interrupt()
    await settle(450)
    expect(deltas(runsSeen).map((e) => e.text)).toEqual(['first', 'second'])
    expect(turnEnds(runsSeen).map((e) => e.stopReason)).toEqual(['completed'])
    await runs.close()
  })

  test('interject: false buffers the note as the next turn preamble', async () => {
    const fixture: ScriptedFixture = {
      version: 1,
      turns: [
        { steps: steps({ kind: 'message.delta', text: 'first' }, END) },
        { match: 'MIND-THE-HEADING', steps: steps({ kind: 'message.delta', text: 'second' }, END) },
      ],
    }
    const driver = createScriptedDriver({ fixture, timeScale: 0, capabilities: { interject: false } })
    const session = await driver.start({ worktree: WORKTREE })
    const seen = collect(session)
    await session.send('one')
    await settle()
    await session.interject('MIND-THE-HEADING')
    await session.send('two')
    await settle()

    expect(errorsIn(seen).length).toBe(0)
    expect(deltas(seen).map((e) => e.text)).toEqual(['first', 'second'])
    expect(turnEnds(seen).length).toBe(2)
    await session.close()
  })

  test('hooks: false never invokes onEvent; true feeds returned feedback forward', async () => {
    const fixture: ScriptedFixture = {
      version: 1,
      turns: [
        { steps: steps({ kind: 'message.delta', text: 'first' }, END) },
        { match: 'LINT-SAYS-NO', steps: steps({ kind: 'message.delta', text: 'second' }, END) },
      ],
    }

    let ignored = 0
    const deaf = createScriptedDriver({ fixture, timeScale: 0, capabilities: { hooks: false } })
    const deafSession = await deaf.start({
      worktree: WORKTREE,
      hooks: { onEvent: () => { ignored += 1 } },
    })
    await deafSession.send('one')
    await settle()
    expect(ignored).toBe(0)
    await deafSession.close()

    let heard = 0
    let fed = false
    const listening = createScriptedDriver({ fixture, timeScale: 0 })
    const session = await listening.start({
      worktree: WORKTREE,
      hooks: {
        onEvent: () => {
          heard += 1
          if (fed) return
          fed = true
          return { feedback: 'LINT-SAYS-NO' }
        },
      },
    })
    const seen = collect(session)
    await session.send('one')
    await settle()
    expect(heard).toBeGreaterThanOrEqual(1)
    await session.send('two')
    await settle()
    expect(errorsIn(seen).length).toBe(0)
    expect(deltas(seen).map((e) => e.text)).toEqual(['first', 'second'])
    await session.close()
  })

  test('toolInjection: false skips the handler; true invokes it', async () => {
    let calls = 0
    const probe = (): InjectedTool => ({
      name: 'probe',
      description: 'test probe',
      inputSchema: {},
      handler: (input: unknown) => {
        calls += 1
        return Promise.resolve({ echoed: input })
      },
    })
    const fixture: ScriptedFixture = {
      version: 1,
      turns: [{ steps: [{ callTool: { name: 'probe', input: { n: 1 } } }, { event: END }] }],
    }

    const off = createScriptedDriver({ fixture, timeScale: 0, capabilities: { toolInjection: false } })
    const offSession = await off.start({ worktree: WORKTREE, tools: [probe()] })
    const offSeen = collect(offSession)
    await offSession.send('go')
    await settle()
    expect(calls).toBe(0)
    expect(offSeen[0]).toEqual({
      kind: 'tool.other',
      name: 'probe',
      payload: { skipped: 'toolInjection: false' },
    })
    await offSession.close()

    const on = createScriptedDriver({ fixture, timeScale: 0 })
    const onSession = await on.start({ worktree: WORKTREE, tools: [probe()] })
    const onSeen = collect(onSession)
    await onSession.send('go')
    await settle()
    expect(calls).toBe(1)
    expect(onSeen[0]).toEqual({
      kind: 'tool.other',
      name: 'probe',
      payload: { input: { n: 1 }, result: { echoed: { n: 1 } } },
    })
    await onSession.close()

    const missing = createScriptedDriver({ fixture, timeScale: 0 })
    const missingSession = await missing.start({ worktree: WORKTREE })
    const missingSeen = collect(missingSession)
    await missingSession.send('go')
    await settle()
    expect(errorsIn(missingSeen)[0]?.source).toBe('engine')
    await missingSession.close()
  })

  test('costReporting: false nulls tokens and cost but keeps wall-clock and turns', async () => {
    const fixture: ScriptedFixture = { version: 1, turns: [{ steps: steps(END) }] }

    const silent = createScriptedDriver({ fixture, timeScale: 0, capabilities: { costReporting: false } })
    const silentSession = await silent.start({ worktree: WORKTREE })
    const silentSeen = collect(silentSession)
    await silentSession.send('go')
    await settle()
    const quiet = silentSession.usage()
    expect(quiet.inputTokens).toBeNull()
    expect(quiet.outputTokens).toBeNull()
    expect(quiet.costUsd).toBeNull()
    expect(quiet.turns).toBe(1)
    expect(quiet.wallClockMs).toBeGreaterThan(0)
    expect(turnEnds(silentSeen)[0]?.usage.costUsd).toBeNull()
    await silentSession.close()

    const metered = createScriptedDriver({ fixture, timeScale: 0 })
    const meteredSession = await metered.start({ worktree: WORKTREE })
    await meteredSession.send('go')
    await settle()
    const spend = meteredSession.usage()
    expect(spend.inputTokens).toBe(100)
    expect(spend.outputTokens).toBe(50)
    expect(spend.costUsd).toBe(0.01)
    expect(spend.turns).toBe(1)
    await meteredSession.close()
  })

  test('modelSelection: false returns exactly one tier; true returns three, none with digits', () => {
    const fixture: ScriptedFixture = { version: 1, turns: [{ steps: steps(END) }] }

    const one = createScriptedDriver({ fixture, capabilities: { modelSelection: false } })
    expect(one.models().length).toBe(1)

    const three = createScriptedDriver({ fixture })
    expect(three.models().map((t) => t.label)).toEqual(['Haiku', 'Sonnet', 'Opus'])
    expect(three.models().every((t) => !/\d/.test(t.label))).toBe(true)

    const ignored = createScriptedDriver({
      fixture,
      capabilities: { modelSelection: false },
      tiers: [{ tier: 'fast', label: 'Haiku' }, { tier: 'deep', label: 'Opus' }],
    })
    expect(ignored.models().length).toBe(1)

    expect(() => createScriptedDriver({ fixture, tiers: [{ tier: 'fast', label: 'Haiku 4.5' }] }))
      .toThrow(/labels carry no digits/)
  })
})

describe('the registry', () => {
  test('round-trips a driver by id, and refuses duplicates and strangers', async () => {
    const fixture = await loadFixture(FIXTURE_PATH)
    const driver = createScriptedDriver({ fixture, timeScale: 0 })

    // Importing the module must not have registered anything: registration is
    // the caller's move.
    expect(() => getDriver('scripted')).toThrow(/no driver registered as 'scripted'/)

    registerDriver(driver)
    // getDriver() hands back the registered driver behind the budget guard, so
    // what round-trips is its id, its declarations and its behaviour — not the
    // object. The guard itself is stable across lookups.
    const looked = getDriver('scripted')
    expect(looked.id).toBe('scripted')
    expect(looked.capabilities).toBe(driver.capabilities)
    expect(looked.models()).toEqual(driver.models())
    expect(getDriver('scripted')).toBe(looked)
    expect(() => registerDriver(driver)).toThrow(/driver already registered: scripted/)
    // The map is process-global and other test files register into it while
    // this one runs, so what is asserted is that the message names what IS
    // registered — not that this file is the only thing in there.
    expect(() => getDriver('nope')).toThrow(/no driver registered as 'nope' \(registered: .*scripted.*\)/)
  })
})
