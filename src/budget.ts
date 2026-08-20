// Spend caps, as a `Session` decorator (architecture §2.5.6).
//
// The split across the two repos is what makes the caps universal. The
// *mechanism* is here, at the seam every consumer already crosses, so every
// driver — including a third party's — inherits it by existing. The *policy* is
// trellis's: the dollar numbers, and per-owner aggregation across workspaces and
// sessions, arrive through `SessionOptions.budget`. Rootstock reads no
// environment variable for a budget number, keeps no ledger, and persists no
// spend; it enforces exactly what it is handed and adds what this session has
// spent to the `alreadySpentTodayUsd` the caller supplies.
//
// A budget violation is never a new event kind — the union is fixed at ten. It
// is an `error` event carrying a stable code, plus a typed rejection from the
// call that was refused.

import type { AgentEvent, DriverCapabilities, Session, SessionBudget, SessionStatus, TurnOptions, TurnUsage } from './types'

/**
 * The stable codes a budget violation is recognized by, on both the thrown
 * error and the `error` event's `detail.code`. `budget.day` refuses a new turn;
 * `budget.turn` stops one already running.
 */
export type BudgetCode = 'budget.day' | 'budget.turn'

/** Thrown by `send()` when the day's cap is already reached. Typed so a caller
 *  can tell "you are out of budget" from "the engine broke". */
export class BudgetExceededError extends Error {
  readonly code: BudgetCode
  constructor(code: BudgetCode, message: string) {
    super(message)
    this.name = 'BudgetExceededError'
    this.code = code
  }
}

/**
 * How often a running turn's spend is re-read. Small enough that a runaway turn
 * is stopped in well under a tenth of a second, cheap enough to be free:
 * `usage()` is a field read on every driver in this package.
 */
const WATCH_INTERVAL_MS = 25

/** The shape a budget violation reports itself as, so the editor can render a
 *  cap differently from a failure without parsing prose. */
interface BudgetDetail {
  code: BudgetCode
  /** Which cap: the USD figure, the turn count, or the wall clock. */
  guard: 'usd' | 'turns' | 'seconds'
}

// ---------------------------------------------------------------------------
// A relay, so the decorator can put its own events into the stream the caller
// is already reading. Deliberately a copy of the driver-side buffer rather than
// a shared export: this file adds no public surface beyond `withBudget` and its
// error type.
// ---------------------------------------------------------------------------

class Relay implements AsyncIterable<AgentEvent> {
  private readonly buffer: AgentEvent[] = []
  private waiter: (() => void) | null = null
  private closed = false

  push(event: AgentEvent): void {
    if (this.closed) return
    this.buffer.push(event)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.buffer.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

// ---------------------------------------------------------------------------
// The decorator
// ---------------------------------------------------------------------------

class BudgetedSession implements Session {
  readonly events: AsyncIterable<AgentEvent>

  private readonly relay = new Relay()
  private blocked = false
  private closed = false
  private watch: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly session: Session,
    private readonly budget: SessionBudget,
    private readonly capabilities: DriverCapabilities,
  ) {
    this.events = this.relay
    void this.pump()
  }

  /** The driver may learn its engine's real id mid-session; the decorator must
   *  not freeze a stale one, or `resume()` would be handed a placeholder. */
  get id(): string {
    return this.session.id
  }

  /**
   * The gate. A turn that would start past the day's cap never reaches the
   * driver: the caller gets a `BudgetExceededError`, the stream gets an `error`
   * event coded `budget.day`, and the session reports `blocked`.
   */
  async send(text: string, opts?: TurnOptions): Promise<void> {
    const breach = this.dayBreach()
    if (breach !== null) {
      this.blocked = true
      this.relay.push({
        kind: 'error',
        source: 'agent',
        message: breach.error.message,
        detail: breach.detail,
      })
      this.relay.push({ kind: 'status', status: 'blocked' })
      throw breach.error
    }
    await this.session.send(text, opts)
    this.startWatch()
  }

  status(): SessionStatus {
    const underlying = this.session.status()
    // A closed session is dead first and blocked second — 'dead' is terminal.
    return this.blocked && underlying !== 'dead' ? 'blocked' : underlying
  }

  interject(note: string): Promise<void> {
    return this.session.interject(note)
  }

  interrupt(): Promise<void> {
    this.stopWatch()
    return this.session.interrupt()
  }

  usage(): TurnUsage {
    return this.session.usage()
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopWatch()
    await this.session.close()
  }

  // -- the gate -------------------------------------------------------------

  /**
   * Per-day. With `costReporting: false` the USD cap is unenforceable, so it
   * degrades to the turn count rather than silently letting everything
   * through (§2.5.3). The turn-count cap is honored on both branches: a caller
   * that set one meant it.
   */
  private dayBreach(): { error: BudgetExceededError; detail: BudgetDetail } | null {
    const usage = this.session.usage()
    const { maxUsdPerDay, maxTurnsPerDay } = this.budget
    if (this.capabilities.costReporting && maxUsdPerDay !== undefined) {
      const spent = (this.budget.alreadySpentTodayUsd ?? 0) + (usage.costUsd ?? 0)
      if (spent >= maxUsdPerDay) {
        return {
          error: new BudgetExceededError(
            'budget.day',
            `daily spend cap reached: $${spent.toFixed(4)} of $${String(maxUsdPerDay)}`,
          ),
          detail: { code: 'budget.day', guard: 'usd' },
        }
      }
    }
    if (maxTurnsPerDay !== undefined && usage.turns >= maxTurnsPerDay) {
      return {
        error: new BudgetExceededError(
          'budget.day',
          `daily turn cap reached: ${String(usage.turns)} of ${String(maxTurnsPerDay)}`,
        ),
        detail: { code: 'budget.day', guard: 'turns' },
      }
    }
    return null
  }

  // -- the brake ------------------------------------------------------------

  /**
   * Per-turn, mid-flight. This is the runaway-loop brake and it cannot wait for
   * `turn.end` — a turn that never ends never reports one. The USD cap needs
   * `costReporting`; the wall-clock guard needs nothing and is what still holds
   * when cost is unavailable or arrives only at the turn's end.
   */
  private startWatch(): void {
    this.stopWatch()
    const { maxUsdPerTurn, maxTurnSeconds } = this.budget
    const watchesCost = this.capabilities.costReporting && maxUsdPerTurn !== undefined
    if (!watchesCost && maxTurnSeconds === undefined) return
    const startedAtMs = Date.now()
    const startCostUsd = this.session.usage().costUsd ?? 0
    const timer = setInterval(() => {
      if (this.closed) {
        this.stopWatch()
        return
      }
      if (watchesCost && maxUsdPerTurn !== undefined) {
        const spend = (this.session.usage().costUsd ?? 0) - startCostUsd
        if (spend >= maxUsdPerTurn) {
          this.trip(
            `turn spend $${spend.toFixed(4)} crossed the per-turn cap of $${String(maxUsdPerTurn)}`,
            { code: 'budget.turn', guard: 'usd' },
          )
          return
        }
      }
      if (maxTurnSeconds !== undefined) {
        const elapsed = (Date.now() - startedAtMs) / 1000
        if (elapsed >= maxTurnSeconds) {
          this.trip(
            `turn ran ${elapsed.toFixed(1)}s, past the ${String(maxTurnSeconds)}s guard`,
            { code: 'budget.turn', guard: 'seconds' },
          )
        }
      }
    }, WATCH_INTERVAL_MS)
    timer.unref?.()
    this.watch = timer
  }

  /**
   * Stop the turn. The error event goes out either way — an owner is owed the
   * reason their turn was cut — and the engine is only asked to stop where the
   * driver declares it can; under `interrupt: false` the declared degradation
   * is that the in-flight turn runs to its natural end.
   */
  private trip(message: string, detail: BudgetDetail): void {
    this.stopWatch()
    this.relay.push({ kind: 'error', source: 'agent', message, detail })
    if (this.capabilities.interrupt) {
      void this.session.interrupt().catch(() => undefined)
    }
  }

  private stopWatch(): void {
    if (this.watch === null) return
    clearInterval(this.watch)
    this.watch = null
  }

  // -- passthrough ----------------------------------------------------------

  /** Everything the driver emits reaches the caller untouched; the decorator
   *  only learns from `turn.end` that the brake can stand down. */
  private async pump(): Promise<void> {
    try {
      for await (const event of this.session.events) {
        if (event.kind === 'turn.end') this.stopWatch()
        this.relay.push(event)
      }
    } catch (cause) {
      this.relay.push({ kind: 'error', source: 'engine', message: String(cause) })
    } finally {
      this.stopWatch()
      this.relay.close()
    }
  }
}

/**
 * Wrap a session in its budget. Driver-agnostic by construction: it reads only
 * the `Session` surface and the driver's declared capabilities, so a driver
 * written by someone else is capped the same way the reference driver is, and
 * no driver knows budgets exist.
 *
 * Everything not named by a cap passes through untouched.
 */
export function withBudget(session: Session, budget: SessionBudget, capabilities: DriverCapabilities): Session {
  return new BudgetedSession(session, budget, capabilities)
}
