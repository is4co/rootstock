// The `scripted` driver: replays a fixture file of AgentEvents with
// controllable timing and a configurable capability set. Zero tokens, zero
// network, zero subprocesses — everything downstream (the conformance suite,
// trellis's supervisor and panes) develops against it.
//
// Because every `false` flag selects the degradation written into
// DriverCapabilities' doc comments, this file doubles as the executable
// specification of architecture §2.5.3 — including the doc's own boundary
// case, "a homegrown script satisfying only streamingText and fileEvents is a
// legitimate driver".

import type {
  AgentEvent,
  Driver,
  DriverCapabilities,
  InjectedTool,
  ModelTier,
  Session,
  SessionHooks,
  SessionId,
  SessionOptions,
  SessionStatus,
  TurnOptions,
  TurnUsage,
} from '../types'
import { UnsupportedError } from '../types'

// ---------------------------------------------------------------------------
// The fixture format — JSON-serializable, so fixtures live in files. AgentEvent
// payloads are verbatim; tools are referenced by *name* rather than by value,
// which is what keeps the format free of functions and class instances.
// ---------------------------------------------------------------------------

export interface ScriptedFixture {
  version: 1
  /** Consumed strictly in order, one per send(). */
  turns: ScriptedTurn[]
}

export interface ScriptedTurn {
  /**
   * If set, the effective send() text must contain this substring; on mismatch
   * the driver emits { kind: 'error', source: 'engine' } and ends the turn.
   * This is how tests prove text routing — including the interject-as-preamble
   * degradation, whose prepended note is observable only through the effective
   * text of the next turn.
   */
  match?: string
  steps: ScriptedStep[]
}

export type ScriptedStep =
  /** Emit this event after delayMs (default 0, scaled by timeScale). */
  | { delayMs?: number; event: AgentEvent }
  /**
   * Invoke the injected tool's handler (toolInjection permitting), then emit a
   * tool.other event carrying { input, result }.
   */
  | { delayMs?: number; callTool: { name: string; input: unknown } }

export interface ScriptedDriverOptions {
  fixture: ScriptedFixture
  /**
   * Defaults: all nine true. Every `false` changes behavior to the declared
   * degradation in DriverCapabilities' doc comments.
   */
  capabilities?: Partial<DriverCapabilities>
  /**
   * Multiplies every delayMs. 0 = instant replay (what tests want); 1 =
   * authored timing (what a demo wants). Default 1.
   */
  timeScale?: number
  /**
   * Default [{ tier: 'balanced', label: 'Sonnet' }] — or, when modelSelection
   * is true, all three tiers Haiku/Sonnet/Opus.
   */
  tiers?: ModelTier[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FULL_CAPABILITIES: DriverCapabilities = {
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

const SINGLE_TIER: ModelTier[] = [{ tier: 'balanced', label: 'Sonnet' }]

const ALL_TIERS: ModelTier[] = [
  { tier: 'fast', label: 'Haiku' },
  { tier: 'balanced', label: 'Sonnet' },
  { tier: 'deep', label: 'Opus' },
]

/** Deterministic fake metering, so budget arithmetic downstream is real. */
const INPUT_TOKENS_PER_TURN = 100
const OUTPUT_TOKENS_PER_TURN = 50
const CENTS_PER_TURN = 1

let sessionCounter = 0

function nextSessionId(): SessionId {
  sessionCounter += 1
  return `scripted-${sessionCounter}-${Math.random().toString(36).slice(2, 8)}`
}

function nowMs(): number {
  return Number(Bun.nanoseconds()) / 1e6
}

// ---------------------------------------------------------------------------
// Fixture validation. Invalid fixtures throw synchronously, naming the turn.
// The driver never invents a turn.end: fixtures are explicit or rejected.
// ---------------------------------------------------------------------------

function assertFixture(value: unknown): ScriptedFixture {
  if (typeof value !== 'object' || value === null) {
    throw new Error('invalid fixture: expected an object')
  }
  const record = value as Record<string, unknown>
  if (record['version'] !== 1) {
    throw new Error(`invalid fixture: expected version 1, got ${JSON.stringify(record['version'])}`)
  }
  const turns: unknown = record['turns']
  if (!Array.isArray(turns)) {
    throw new Error('invalid fixture: `turns` must be an array')
  }
  turns.forEach((turn: unknown, index: number) => {
    const steps: unknown = typeof turn === 'object' && turn !== null
      ? (turn as Record<string, unknown>)['steps']
      : undefined
    if (!Array.isArray(steps)) {
      throw new Error(`invalid fixture: turn ${index} has no \`steps\` array`)
    }
    if (steps.length === 0) {
      throw new Error(`invalid fixture: turn ${index} has no steps`)
    }
    const events = steps
      .filter((step: unknown): step is { event: AgentEvent } =>
        typeof step === 'object' && step !== null && 'event' in step)
      .map((step) => step.event)
    const last = events.at(-1)
    if (!last) {
      throw new Error(`invalid fixture: turn ${index} emits no events, so it cannot end with turn.end`)
    }
    if (last.kind !== 'turn.end') {
      throw new Error(
        `invalid fixture: turn ${index} must end with a turn.end event, got '${last.kind}'`,
      )
    }
  })
  return value as ScriptedFixture
}

/** Read + validate a fixture from a JSON file. */
export async function loadFixture(path: string): Promise<ScriptedFixture> {
  const raw: unknown = await Bun.file(path).json()
  return assertFixture(raw)
}

// ---------------------------------------------------------------------------
// A push queue backing `Session.events`. One queue per session, shared by every
// consumer: the iterable hands out one underlying iterator, so two `for await`
// loops split the stream rather than each seeing a private copy. It completes
// once close() has been called AND everything queued has been drained.
// ---------------------------------------------------------------------------

class EventQueue {
  private readonly buffer: AgentEvent[] = []
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = []
  private closed = false

  readonly iterable: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => ({
      next: (): Promise<IteratorResult<AgentEvent>> => this.next(),
    }),
  }

  push(event: AgentEvent): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.buffer.push(event)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // Waiters only exist when the buffer is empty, so nothing queued is lost.
    while (this.waiters.length > 0) this.waiters.shift()?.({ value: undefined, done: true })
  }

  private next(): Promise<IteratorResult<AgentEvent>> {
    const queued = this.buffer.shift()
    if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }
}

// ---------------------------------------------------------------------------
// Per-session state the driver keeps, so resume() has something to replay from.
// ---------------------------------------------------------------------------

interface SessionRecord {
  id: SessionId
  /** Index of the next fixture turn this session will consume. */
  nextTurn: number
  completedTurns: number
  startedAtMs: number
  /** Notes buffered by interject(), prepended to the next send()'s text. */
  preamble: string[]
}

/** One replayable action, after capability filtering and coalescing. */
type ReplayAction =
  | { delayMs: number; event: AgentEvent }
  | { delayMs: number; callTool: { name: string; input: unknown } }

class ScriptedSession implements Session {
  readonly id: SessionId
  readonly events: AsyncIterable<AgentEvent>

  private readonly queue = new EventQueue()
  private readonly pending: string[] = []
  private state: SessionStatus = 'idle'
  private draining = false
  private interruptedTurn = false
  /** Cuts short the pause a replay is parked in, so interrupt() and close()
   *  take effect at once rather than after the authored delay expires. */
  private wake: (() => void) | null = null
  private turnStartedMs = 0
  private readonly hooks: SessionHooks | undefined
  private readonly tools: InjectedTool[]

  constructor(
    private readonly record: SessionRecord,
    private readonly fixture: ScriptedFixture,
    private readonly caps: DriverCapabilities,
    private readonly timeScale: number,
    opts: SessionOptions,
  ) {
    this.id = record.id
    this.events = this.queue.iterable
    this.hooks = opts.hooks
    this.tools = opts.tools ?? []
  }

  status(): SessionStatus {
    return this.state
  }

  /** A method, not an inline comparison: `this.state` is mutated across awaits
   *  by close(), which narrowing inside a long async body would otherwise miss. */
  private isDead(): boolean {
    return this.state === 'dead'
  }

  /**
   * Resolves once the turn is queued, not when it ends. A requested tier is
   * accepted and ignored — a replay has no model to pick — which is what both
   * branches of modelSelection allow: never an error.
   */
  async send(text: string, _opts?: TurnOptions): Promise<void> {
    if (this.isDead()) throw new Error(`session ${this.id} is closed`)
    this.pending.push(text)
    this.state = 'working'
    void this.drain()
    return Promise.resolve()
  }

  /**
   * Capable: the note lands mid-turn. A replay has no live model to deliver
   * into, so "landing" is recorded the only way a fixture can observe it —
   * on the preamble buffer — and nothing is emitted; the conformance suite's
   * capable-branch check is liveness only.
   * Incapable: the declared degradation, buffered and prepended to the next
   * send()'s effective text.
   */
  async interject(note: string): Promise<void> {
    this.record.preamble.push(note)
    return Promise.resolve()
  }

  async interrupt(): Promise<void> {
    if (this.caps.interrupt) {
      this.interruptedTurn = true
      this.wake?.()
    } else {
      // Declared degradation: resolve immediately, let the in-flight turn run
      // to its natural end, and discard anything queued behind it.
      this.pending.length = 0
    }
    return Promise.resolve()
  }

  usage(): TurnUsage {
    return this.meter(this.record.completedTurns, nowMs() - this.record.startedAtMs)
  }

  async close(): Promise<void> {
    if (this.isDead()) return Promise.resolve()
    this.state = 'dead'
    this.pending.length = 0
    this.wake?.()
    this.queue.close()
    return Promise.resolve()
  }

  // -- replay ---------------------------------------------------------------

  /**
   * Wait out a step's authored delay, but stay woken by interrupt() and
   * close(). A zero delay still yields, so a consumer always gets a chance to
   * observe 'working' and to interrupt between steps.
   */
  private pause(ms: number): Promise<void> {
    if (ms <= 0) return new Promise((resolve) => { setTimeout(resolve, 0) })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = (): void => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const next = this.pending.shift()
        if (next === undefined) break
        if (this.isDead()) break
        await this.runTurn(next)
      }
    } finally {
      this.draining = false
      if (!this.isDead()) this.state = 'idle'
    }
  }

  private async runTurn(text: string): Promise<void> {
    this.interruptedTurn = false
    this.turnStartedMs = nowMs()

    const preamble = this.record.preamble.splice(0, this.record.preamble.length)
    const effective = preamble.length > 0 ? `${preamble.join('\n\n')}\n\n${text}` : text

    const index = this.record.nextTurn
    const turn = this.fixture.turns[index]
    if (!turn) {
      // A send past the last fixture turn carries an error on the stream. No
      // synthetic turn.end is added; the turn count does not move.
      await this.emit({ kind: 'error', source: 'engine', message: 'fixture exhausted' })
      return
    }
    this.record.nextTurn = index + 1

    if (turn.match !== undefined && !effective.includes(turn.match)) {
      // The fixture's own turn.end is skipped, so tests assert on the error.
      // The turn still counts as ended for metering purposes.
      this.record.completedTurns += 1
      await this.emit({
        kind: 'error',
        source: 'engine',
        message: `turn ${index} match failed: expected text containing ${JSON.stringify(turn.match)}, got ${JSON.stringify(effective)}`,
      })
      return
    }

    for (const action of this.plan(turn.steps)) {
      if (this.isDead()) return
      if (this.interruptedTurn) break
      await this.pause(action.delayMs * this.timeScale)
      if (this.isDead()) return
      if (this.interruptedTurn) break

      if ('event' in action) await this.emitScripted(action.event)
      else await this.runTool(action.callTool)
    }

    if (this.interruptedTurn && !this.isDead()) {
      // The one turn.end this driver synthesizes, and the capability declares it.
      this.record.completedTurns += 1
      await this.emit({
        kind: 'turn.end',
        stopReason: 'interrupted',
        usage: this.meter(1, nowMs() - this.turnStartedMs),
      })
    }
  }

  /**
   * Turn authored steps into the actions this session will actually replay.
   * Capability filtering runs first (fileEvents), then coalescing over what
   * survives (streamingText) — so a dropped file event does not keep two
   * deltas apart.
   */
  private plan(steps: ScriptedStep[]): ReplayAction[] {
    const actions: ReplayAction[] = []
    for (const step of steps) {
      const delayMs = step.delayMs ?? 0
      if ('callTool' in step) {
        actions.push({ delayMs, callTool: step.callTool })
        continue
      }
      // fileEvents: false — the driver emits NO file.* events at all.
      if (!this.caps.fileEvents && step.event.kind.startsWith('file.')) continue

      const previous = actions.at(-1)
      if (
        !this.caps.streamingText &&
        step.event.kind === 'message.delta' &&
        previous !== undefined &&
        'event' in previous &&
        previous.event.kind === 'message.delta'
      ) {
        // streamingText: false — text never goes missing, it arrives coarsely.
        previous.event = { kind: 'message.delta', text: previous.event.text + step.event.text }
        previous.delayMs += delayMs
        continue
      }
      actions.push({ delayMs, event: { ...step.event } })
    }
    return actions
  }

  private async emitScripted(event: AgentEvent): Promise<void> {
    if (event.kind === 'turn.end') {
      this.record.completedTurns += 1
      // The fixture authored this event; only the degradation touches it. Under
      // costReporting: false the token and cost fields go null, which is what
      // DriverCapabilities.costReporting promises for turn.end as well as usage().
      const usage = this.caps.costReporting
        ? event.usage
        : { ...event.usage, inputTokens: null, outputTokens: null, costUsd: null }
      await this.emit({ ...event, usage })
      return
    }
    await this.emit(event)
  }

  private async runTool(call: { name: string; input: unknown }): Promise<void> {
    if (!this.caps.toolInjection) {
      // Declared degradation: injected tools are silently ignored — no handler
      // runs, and the turn is otherwise unaffected.
      await this.emit({
        kind: 'tool.other',
        name: call.name,
        payload: { skipped: 'toolInjection: false' },
      })
      return
    }
    const tool = this.tools.find((candidate) => candidate.name === call.name)
    if (!tool) {
      await this.emit({
        kind: 'error',
        source: 'engine',
        message: `no injected tool named '${call.name}'`,
      })
      return
    }
    try {
      const result = await tool.handler(call.input)
      await this.emit({
        kind: 'tool.other',
        name: call.name,
        payload: { input: call.input, result },
      })
    } catch (cause) {
      await this.emit({
        kind: 'error',
        source: 'engine',
        message: `injected tool '${call.name}' threw`,
        detail: cause,
      })
    }
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (this.isDead()) return
    this.queue.push(event)
    await this.fireHook(event)
  }

  private async fireHook(event: AgentEvent): Promise<void> {
    // hooks: false — callbacks passed in options are silently ignored, never
    // an error.
    if (!this.caps.hooks) return
    const onEvent = this.hooks?.onEvent
    if (!onEvent) return
    const returned = await onEvent(event)
    if (returned && typeof returned === 'object' && 'feedback' in returned) {
      // Feedback reaches the agent the way this driver can observe it: on the
      // preamble buffer, visible through the next turn's `match`.
      this.record.preamble.push(returned.feedback)
    }
  }

  private meter(turns: number, wallClockMs: number): TurnUsage {
    if (!this.caps.costReporting) {
      // Declared degradation: budgets fall back to wall-clock and turn counts,
      // which stay real.
      return { inputTokens: null, outputTokens: null, costUsd: null, wallClockMs, turns }
    }
    return {
      inputTokens: turns * INPUT_TOKENS_PER_TURN,
      outputTokens: turns * OUTPUT_TOKENS_PER_TURN,
      costUsd: (turns * CENTS_PER_TURN) / 100,
      wallClockMs,
      turns,
    }
  }
}

// ---------------------------------------------------------------------------
// The factory. Per-instance configuration means drivers are created here and
// registered by the caller — there is no import-time registration, so
// getDriver() never depends on import order.
// ---------------------------------------------------------------------------

export function createScriptedDriver(opts: ScriptedDriverOptions): Driver {
  const fixture = assertFixture(opts.fixture)
  const capabilities: DriverCapabilities = { ...FULL_CAPABILITIES, ...opts.capabilities }
  const timeScale = opts.timeScale ?? 1
  const authored = opts.tiers ?? (capabilities.modelSelection ? ALL_TIERS : SINGLE_TIER)
  for (const tier of authored) {
    // Haiku, Sonnet, Opus — never version numbers (architecture §9 decision 9).
    if (/\d/.test(tier.label)) {
      throw new Error(`invalid tier label '${tier.label}': labels carry no digits`)
    }
  }
  // modelSelection: false — models() returns exactly one tier and a requested
  // tier is ignored, never an error.
  const first = authored[0] ?? SINGLE_TIER[0]
  const tiers: ModelTier[] = capabilities.modelSelection
    ? [...authored]
    : first
      ? [first]
      : [...SINGLE_TIER]

  const records = new Map<SessionId, SessionRecord>()

  const open = (record: SessionRecord, sessionOpts: SessionOptions): Session =>
    new ScriptedSession(record, fixture, capabilities, timeScale, sessionOpts)

  return {
    id: 'scripted',
    capabilities,
    models: () => tiers.map((tier) => ({ ...tier })),
    start: (sessionOpts: SessionOptions): Promise<Session> => {
      const record: SessionRecord = {
        id: nextSessionId(),
        nextTurn: 0,
        completedTurns: 0,
        startedAtMs: nowMs(),
        preamble: [],
      }
      records.set(record.id, record)
      return Promise.resolve(open(record, sessionOpts))
    },
    resume: (id: SessionId, sessionOpts: SessionOptions): Promise<Session> => {
      if (!capabilities.resume) return Promise.reject(new UnsupportedError('resume'))
      const record = records.get(id)
      if (!record) return Promise.reject(new Error(`no such session: ${id}`))
      // Same id, replay continues at the recorded next-turn index.
      return Promise.resolve(open(record, sessionOpts))
    },
  }
}
