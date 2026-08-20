// Budget tests: token-free, engine-free, and driver-free.
//
// The caps are a decorator over the `Session` surface, so the thing under test
// is graded against an inline fake session rather than against any driver in
// this package. That is the point of the design — a driver written by someone
// else is capped the same way — and it is also what keeps this file from
// spending a cent or depending on step 05's fixtures.

import { describe, expect, test } from 'bun:test'

import { BudgetExceededError, withBudget } from './budget'
import { getDriver, registerDriver } from './registry'
import { createScriptedDriver } from './drivers/scripted'
import type {
  AgentEvent,
  Driver,
  DriverCapabilities,
  Session,
  SessionStatus,
  TurnUsage,
} from './types'

const WORKTREE = '/tmp/rootstock-budget-test'

const FULL: DriverCapabilities = {
  streamingText: true,
  fileEvents: true,
  resume: true,
  interrupt: true,
  interject: true,
  hooks: true,
  toolInjection: true,
  costReporting: true,
  modelSelection: true,
}

function settle(ms = 120): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function collect(session: Session): AgentEvent[] {
  const box: AgentEvent[] = []
  void (async () => {
    for await (const event of session.events) box.push(event)
  })()
  return box
}

function errorsIn(events: AgentEvent[]): Extract<AgentEvent, { kind: 'error' }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: 'error' }> => event.kind === 'error')
}

function codeOf(event: Extract<AgentEvent, { kind: 'error' }> | undefined): unknown {
  return (event?.detail as { code?: unknown } | undefined)?.code
}

function guardOf(event: Extract<AgentEvent, { kind: 'error' }> | undefined): unknown {
  return (event?.detail as { guard?: unknown } | undefined)?.guard
}

// ---------------------------------------------------------------------------
// The fake. A session with a hand-cranked turn: the test decides what the
// engine has spent and when, which is the only way to observe a mid-flight cap
// deterministically.
// ---------------------------------------------------------------------------

class FakeSession implements Session {
  readonly id = 'fake-session'
  /** How many times the decorator asked the engine to stop. */
  interrupts = 0
  /** Sends that actually reached the session, in order. */
  readonly sent: string[] = []
  costUsd = 0
  turns = 0

  private readonly buffer: AgentEvent[] = []
  private waiter: (() => void) | null = null
  private done = false
  private state: SessionStatus = 'idle'
  private turnStartedAtMs = 0

  constructor(private readonly reportsCost = true) {}

  readonly events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: async function* (this: FakeSession): AsyncGenerator<AgentEvent> {
      for (;;) {
        const next = this.buffer.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (this.done) return
        await new Promise<void>((resolve) => {
          this.waiter = resolve
        })
      }
    }.bind(this) as () => AsyncGenerator<AgentEvent>,
  }

  send(text: string): Promise<void> {
    this.sent.push(text)
    this.state = 'working'
    this.turnStartedAtMs = Date.now()
    this.emit({ kind: 'status', status: 'working' })
    return Promise.resolve()
  }

  status(): SessionStatus {
    return this.state
  }

  interject(): Promise<void> {
    return Promise.resolve()
  }

  interrupt(): Promise<void> {
    this.interrupts += 1
    this.state = 'idle'
    return Promise.resolve()
  }

  usage(): TurnUsage {
    const openMs = this.state === 'working' ? Date.now() - this.turnStartedAtMs : 0
    return {
      inputTokens: this.reportsCost ? 10 : null,
      outputTokens: this.reportsCost ? 5 : null,
      costUsd: this.reportsCost ? this.costUsd : null,
      wallClockMs: openMs,
      turns: this.turns,
    }
  }

  close(): Promise<void> {
    this.state = 'dead'
    this.done = true
    this.wake()
    return Promise.resolve()
  }

  /** End the open turn the way a driver would. */
  endTurn(): void {
    this.turns += 1
    this.state = 'idle'
    this.emit({
      kind: 'turn.end',
      stopReason: 'completed',
      usage: this.usage(),
    })
  }

  private emit(event: AgentEvent): void {
    this.buffer.push(event)
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }
}

// ---------------------------------------------------------------------------

describe('the per-day gate', () => {
  test('refuses the next send, blocks the session, and says so in the stream', async () => {
    const fake = new FakeSession()
    // $0.50 carried in from earlier sessions today plus $0.60 spent here: the
    // caller's cross-session figure is what makes this a per-OWNER cap without
    // rootstock keeping a ledger.
    fake.costUsd = 0.6
    const session = withBudget(fake, { maxUsdPerDay: 1, alreadySpentTodayUsd: 0.5 }, FULL)
    const seen = collect(session)

    await expect(session.send('another turn')).rejects.toBeInstanceOf(BudgetExceededError)
    await expect(session.send('another turn')).rejects.toMatchObject({ code: 'budget.day' })

    // The send never reached the driver, and the session says why.
    expect(fake.sent).toEqual([])
    expect(session.status()).toBe('blocked')
    await settle(10)
    expect(codeOf(errorsIn(seen)[0])).toBe('budget.day')
    expect(guardOf(errorsIn(seen)[0])).toBe('usd')
    expect(seen.some((event) => event.kind === 'status' && event.status === 'blocked')).toBe(true)
    // No eleventh event kind was invented for it.
    expect(seen.every((event) => event.kind !== ('budget.day' as AgentEvent['kind']))).toBe(true)
    await session.close()
  })

  test('lets a turn through while the day still has room', async () => {
    const fake = new FakeSession()
    fake.costUsd = 0.2
    const session = withBudget(fake, { maxUsdPerDay: 1, alreadySpentTodayUsd: 0.1 }, FULL)
    await session.send('go')
    expect(fake.sent).toEqual(['go'])
    expect(session.status()).toBe('working')
    await session.close()
  })
})

describe('the per-turn brake', () => {
  test('interrupts a turn whose live spend crosses the cap, without waiting for turn.end', async () => {
    const fake = new FakeSession()
    const session = withBudget(fake, { maxUsdPerTurn: 0.1 }, FULL)
    const seen = collect(session)

    await session.send('do something expensive')
    expect(fake.interrupts).toBe(0)

    // The runaway: spend climbs mid-turn and no turn.end is ever emitted. A cap
    // that waited for one would never fire at all.
    fake.costUsd = 0.25
    await settle()

    expect(fake.interrupts).toBe(1)
    const error = errorsIn(seen)[0]
    expect(codeOf(error)).toBe('budget.turn')
    expect(guardOf(error)).toBe('usd')
    expect(seen.some((event) => event.kind === 'turn.end')).toBe(false)
    await session.close()
  })

  test('measures each turn on its own, not against the session total', async () => {
    const fake = new FakeSession()
    const session = withBudget(fake, { maxUsdPerTurn: 0.1 }, FULL)
    await session.send('first')
    fake.costUsd = 0.09
    await settle(60)
    fake.endTurn()
    await settle(60)
    expect(fake.interrupts).toBe(0)

    // The session has now spent $0.09 in total; a second turn starts from zero.
    await session.send('second')
    fake.costUsd = 0.17
    await settle(60)
    expect(fake.interrupts).toBe(0)

    fake.costUsd = 0.2
    await settle()
    expect(fake.interrupts).toBe(1)
    await session.close()
  })

  test('the wall-clock guard fires on a turn that costs nothing and never ends', async () => {
    const fake = new FakeSession()
    // Fractions of a second are legal and keep the test honest about what it is
    // measuring: elapsed time, with no spend involved at all.
    const session = withBudget(fake, { maxTurnSeconds: 0.05 }, FULL)
    const seen = collect(session)

    await session.send('a turn that hangs')
    await settle(200)

    expect(fake.interrupts).toBe(1)
    expect(codeOf(errorsIn(seen)[0])).toBe('budget.turn')
    expect(guardOf(errorsIn(seen)[0])).toBe('seconds')
    await session.close()
  })

  test('stands down once the turn ends', async () => {
    const fake = new FakeSession()
    const session = withBudget(fake, { maxTurnSeconds: 0.05 }, FULL)
    await session.send('a turn that finishes')
    fake.endTurn()
    await settle(200)
    expect(fake.interrupts).toBe(0)
    await session.close()
  })

  test('under interrupt: false the engine is not asked to stop, but the owner is still told', async () => {
    const fake = new FakeSession()
    const session = withBudget(fake, { maxTurnSeconds: 0.05 }, { ...FULL, interrupt: false })
    const seen = collect(session)
    await session.send('a turn that hangs')
    await settle(200)
    // The declared degradation for interrupt: false is that the in-flight turn
    // runs to its natural end. The cap does not pretend otherwise; it reports.
    expect(fake.interrupts).toBe(0)
    expect(codeOf(errorsIn(seen)[0])).toBe('budget.turn')
    await session.close()
  })
})

describe('the costReporting: false degradation', () => {
  const CHEAP = { ...FULL, costReporting: false }

  test('USD caps give way to the turn-count and wall-clock guards', async () => {
    const fake = new FakeSession(false)
    const session = withBudget(
      fake,
      {
        // Numbers a cost-reporting driver would refuse everything on.
        maxUsdPerDay: 0.0001,
        maxUsdPerTurn: 0.0001,
        alreadySpentTodayUsd: 999,
        // What is actually enforceable without cost.
        maxTurnsPerDay: 2,
        maxTurnSeconds: 0.05,
      },
      CHEAP,
    )
    const seen = collect(session)

    // The USD caps are unenforceable here, so they enforce nothing — and the
    // turn is allowed rather than silently refused on a number that cannot be
    // measured.
    await session.send('first')
    expect(fake.sent).toEqual(['first'])
    expect(session.status()).not.toBe('blocked')

    // The wall clock still holds.
    await settle(200)
    expect(fake.interrupts).toBe(1)
    expect(guardOf(errorsIn(seen)[0])).toBe('seconds')

    // And so does the turn count: two taken, two allowed.
    fake.turns = 2
    await expect(session.send('third')).rejects.toMatchObject({ code: 'budget.day' })
    await settle(10)
    expect(guardOf(errorsIn(seen)[1])).toBe('turns')
    expect(session.status()).toBe('blocked')
    expect(fake.sent).toEqual(['first'])
    await session.close()
  })
})

describe('the registry seam', () => {
  // The registry is one process-global map and step 05's own test registers the
  // real 'scripted' id in it. Bun runs test files concurrently, so this file
  // registers the very same scripted driver under an id of its own rather than
  // racing that one for the name.
  const SEAM_ID = 'scripted-budget'

  test('a budget-less session is the driver\'s own, untouched', async () => {
    const scripted = createScriptedDriver({
      fixture: {
        version: 1,
        turns: [
          {
            steps: [
              { event: { kind: 'status', status: 'working' } },
              { event: { kind: 'message.delta', text: 'done' } },
              {
                event: {
                  kind: 'turn.end',
                  stopReason: 'completed',
                  usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.02, wallClockMs: 5, turns: 1 },
                },
              },
            ],
          },
        ],
      },
      timeScale: 0,
    })
    const driver: Driver = { ...scripted, id: SEAM_ID }
    registerDriver(driver)

    const direct = await driver.start({ worktree: WORKTREE })
    const throughRegistry = await getDriver(SEAM_ID).start({ worktree: WORKTREE })

    const fromDirect = collect(direct)
    const fromRegistry = collect(throughRegistry)
    await direct.send('go')
    await throughRegistry.send('go')
    await settle(40)

    expect(fromRegistry).toEqual(fromDirect)
    // Everything but the wall clock, which is a live reading on both and would
    // differ by microseconds between two calls to the same driver.
    expect({ ...throughRegistry.usage(), wallClockMs: 0 }).toEqual({ ...direct.usage(), wallClockMs: 0 })
    expect(throughRegistry.status()).toBe(direct.status())
    await direct.close()
    await throughRegistry.close()
    await settle(10)
    expect(fromRegistry).toEqual(fromDirect)
  })

  test('a session opened with a budget is capped, without the driver knowing', async () => {
    // Same driver, same call, one extra option: the caps arrive at the seam
    // every consumer already crosses, so a driver inherits them by existing.
    const capped = await getDriver(SEAM_ID).start({
      worktree: WORKTREE,
      budget: { maxUsdPerDay: 0.01, alreadySpentTodayUsd: 5 },
    })
    await expect(capped.send('go')).rejects.toMatchObject({ code: 'budget.day' })
    expect(capped.status()).toBe('blocked')
    await capped.close()
  })

  test('resume is capped the same way start is', async () => {
    const started = await getDriver(SEAM_ID).start({ worktree: WORKTREE })
    const resumed = await getDriver(SEAM_ID).resume(started.id, {
      worktree: WORKTREE,
      budget: { maxUsdPerDay: 0.01, alreadySpentTodayUsd: 5 },
    })
    await expect(resumed.send('go')).rejects.toBeInstanceOf(BudgetExceededError)
    await resumed.close()
    await started.close()
  })
})
