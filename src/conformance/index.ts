// The driver conformance suite (architecture §2.5.2, §2.5.3, §2.5.7): one check
// per contract clause and one per capability flag. It is the entry test for any
// driver — a driver that does not pass it is not finished.
//
// The rule that shapes everything below: a capability declared `false` is graded
// on performing the degradation its doc comment in src/types.ts promises, never
// on being skipped. "The failure mode to avoid is trellis assuming a capability
// and silently getting nothing" (§2.5.3), and a skipped check here becomes a
// silent lie the moment this suite is pointed at a real engine.
//
// This module sees only the public Driver/Session interface plus its own
// options. That is what makes it valid for drivers that do not exist yet:
// engine-specific wiring lives in the caller's `makeSession`, never here.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AgentEvent,
  Driver,
  InjectedTool,
  ModelTier,
  Session,
  SessionHooks,
  SessionOptions,
  SessionStatus,
  TurnUsage,
} from '../types'

// ---------------------------------------------------------------------------
// The fixed task set and the fixed vocabulary the suite drives drivers with.
// ---------------------------------------------------------------------------

/**
 * The fixed task set (§2.5.2: "a fixed set of scripted tasks"). Exported so
 * fixture authors and real-driver runs target the exact same prompts: a
 * scripted fixture binds to them with `match`; an engine driver receives them
 * as real prompts in a temp worktree.
 */
/**
 * The file the suite writes into the `fileChange` scenario's worktree, and the
 * edit it asks for. The suite seeds this itself rather than trusting the
 * caller's `makeWorkspace` to have put anything in particular there — a prompt
 * that names an exact file cannot depend on a workspace it does not control.
 */
export const CONFORMANCE_EDIT_FILE = 'conformance-target.txt'

/** Four lines and a trailing newline. `CONFORMANCE_EDIT_OLD` occurs exactly
 *  once in it, so the span it names is unambiguous. */
export const CONFORMANCE_EDIT_CONTENT = 'alpha\nbeta\ngamma\ndelta\n'

/** The line to replace, and what to replace it with. */
export const CONFORMANCE_EDIT_OLD = 'gamma'
export const CONFORMANCE_EDIT_NEW = 'gamma-edited'

export const CONFORMANCE_TASKS = {
  echo: 'conformance: reply with a short acknowledgement',
  /**
   * The streaming stimulus, deliberately separate from `echo`. A prompt that
   * asks for a *short* acknowledgement cannot also be the proof of token-wise
   * streaming: a terse enough reply arrives in one chunk and the check becomes
   * a coin flip on how brief the model felt like being. This one asks for
   * enough prose that a driver which streams produces many deltas and a driver
   * which batches still produces exactly one.
   */
  stream:
    'conformance: write a plain-prose paragraph of at least five sentences about the history of ' +
    'the printing press. Do not use any tools, and do not ask any questions.',
  /**
   * Names the file, quotes the exact line and its replacement, and forbids
   * clarifying questions. The earlier wording ("make a small edit to a file in
   * this workspace") named no file and no change, and a real engine answered it
   * by asking which file and what change — producing no edit, and so no
   * `file.*` event, which read as a driver defect rather than a vague prompt.
   */
  fileChange:
    `conformance: this workspace contains a file named ${CONFORMANCE_EDIT_FILE} in the current ` +
    `working directory. Read it, then use the Edit tool to replace the single line ` +
    `"${CONFORMANCE_EDIT_OLD}" with "${CONFORMANCE_EDIT_NEW}". Change nothing else, and do not ask ` +
    `any clarifying questions - the file and the edit are both fully specified.`,
  toolCall: 'conformance: call the injected probe tool',
  followup: 'conformance: follow-up turn',
} as const

/**
 * The note the suite interjects. Under `interject: false` the declared
 * degradation is that this text is prepended to the next send's effective
 * text, so a fixture author binds the follow-up turn to this exact string and
 * an engine driver is told to echo it back.
 */
export const CONFORMANCE_NOTE = 'conformance-note'

/** The name of the probe tool the suite injects into every session. */
export const CONFORMANCE_PROBE = 'conformance-probe'

/** What the probe handler returns, so a fixture can assert it round-tripped. */
export const CONFORMANCE_PROBE_MARKER = 'conformance-probe-ok'

/**
 * The scenarios the suite runs, each on its own session. The name is passed to
 * `makeSession` so a caller can hand each scenario its own fixture or its own
 * workspace state without depending on the order the suite happens to call in.
 */
export const CONFORMANCE_SCENARIOS = [
  'echo',
  'fileChange',
  'toolCall',
  'interject',
  'interrupt',
  'resume',
  'modelSelection',
] as const

export type ConformanceScenario = (typeof CONFORMANCE_SCENARIOS)[number]

/** Mirrors the ten kinds in src/types.ts; `satisfies` catches a kind removed
 *  from the contract while still listed here. */
const EVENT_KINDS = [
  'message.delta',
  'file.edit',
  'file.create',
  'file.delete',
  'command.run',
  'command.output',
  'tool.other',
  'status',
  'turn.end',
  'error',
] as const satisfies readonly AgentEvent['kind'][]

const SESSION_STATUSES = ['idle', 'working', 'waiting', 'blocked', 'dead'] as const satisfies readonly SessionStatus[]

const ERROR_SOURCES = ['agent', 'engine'] as const

/** How often status() is sampled while the suite is waiting on events. */
const POLL_MS = 2

/** How long the suite watches for stragglers after a turn should have ended. */
const TRAILING_WINDOW_MS = 50

const DEFAULT_TURN_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

export interface ConformanceCheck {
  /** One of the eighteen fixed ids: nine clause.* checks, nine cap.* checks. */
  id: string
  ok: boolean
  detail?: string
}

export interface ConformanceReport {
  driverId: string
  checks: ConformanceCheck[]
  /** every check ok */
  ok: boolean
}

/** The session the suite wants opened, plus which scenario wants it. */
export interface ConformanceSessionContext {
  scenario: ConformanceScenario
  worktree: string
  tools: InjectedTool[]
  hooks: SessionHooks
  tier?: ModelTier['tier']
}

export interface ConformanceOptions {
  /** Fresh workspace dir per scenario. Default: fs.mkdtemp under tmpdir. */
  makeWorkspace?: () => Promise<string>
  /** Per-turn ceiling before a check fails as 'timed out'. Default 30_000. */
  timeoutMsPerTurn?: number
  /**
   * A fresh session for each scenario. Default: driver.start({ worktree,
   * tools, hooks, tier }). The suite calls it once per scenario — scenarios
   * must not share session state. This is where a caller wires whatever its
   * driver needs per scenario; `ctx.scenario` says which one is being opened.
   */
  makeSession?: (ctx: ConformanceSessionContext) => Promise<Session>
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type TurnEnd = Extract<AgentEvent, { kind: 'turn.end' }>
type ErrorEvent = Extract<AgentEvent, { kind: 'error' }>

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  return String(cause)
}

function errorCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null
  const code: unknown = (cause as Record<string, unknown>)['code']
  return typeof code === 'string' ? code : null
}

function turnEndsIn(events: readonly AgentEvent[]): TurnEnd[] {
  return events.filter((event): event is TurnEnd => event.kind === 'turn.end')
}

function errorsIn(events: readonly AgentEvent[]): ErrorEvent[] {
  return events.filter((event): event is ErrorEvent => event.kind === 'error')
}

function fileEventsIn(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.kind.startsWith('file.'))
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isNumber(value)
}

/** The TurnUsage shape, checked structurally so any driver can be graded. */
function usageShapeProblem(usage: TurnUsage | null): string | null {
  if (usage === null || typeof usage !== 'object') return `usage() returned ${String(usage)}`
  if (!isNullableNumber(usage.inputTokens)) return 'inputTokens is neither a number nor null'
  if (!isNullableNumber(usage.outputTokens)) return 'outputTokens is neither a number nor null'
  if (!isNullableNumber(usage.costUsd)) return 'costUsd is neither a number nor null'
  if (!isNumber(usage.wallClockMs)) return 'wallClockMs is not a number'
  if (!isNumber(usage.turns)) return 'turns is not a number'
  return null
}

// ---------------------------------------------------------------------------
// One collector per session: drains `events` once and lets the suite await a
// condition on what it has seen, without ever consuming the stream twice.
// ---------------------------------------------------------------------------

class Collector {
  readonly events: AgentEvent[] = []
  completed = false

  private readonly waiters = new Set<() => void>()

  constructor(private readonly session: Session) {
    void this.pump()
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.session.events) {
        this.events.push(event)
        this.notify()
      }
    } finally {
      this.completed = true
      this.notify()
    }
  }

  private notify(): void {
    // A waiter only ever removes itself, which a Set tolerates mid-iteration.
    for (const waiter of this.waiters) waiter()
  }

  /**
   * Resolves true when `test` holds, false on timeout. `onPoll` runs on a
   * short interval for the life of the wait, which is how status() is sampled
   * while a turn is in flight.
   */
  waitFor(test: () => boolean, timeoutMs: number, onPoll?: () => void): Promise<boolean> {
    onPoll?.()
    if (test()) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let poller: ReturnType<typeof setInterval> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let waiter: (() => void) | undefined
      const finish = (value: boolean): void => {
        if (poller !== undefined) clearInterval(poller)
        if (timer !== undefined) clearTimeout(timer)
        if (waiter !== undefined) this.waiters.delete(waiter)
        resolve(value)
      }
      waiter = (): void => { if (test()) finish(true) }
      this.waiters.add(waiter)
      poller = setInterval(() => { onPoll?.() }, POLL_MS)
      timer = setTimeout(() => { finish(false) }, timeoutMs)
    })
  }
}

// ---------------------------------------------------------------------------
// Per-scenario observations. Every scenario is wrapped, so one crashing clause
// fails the checks it feeds instead of aborting the report.
// ---------------------------------------------------------------------------

interface EchoOutcome {
  error?: string
  id: unknown
  statusBeforeSend: SessionStatus | null
  sendResolved: boolean
  reachedTurnEnd: boolean
  deltas: number
  /** Deltas from the `stream` turn alone — what `cap.streamingText` grades. */
  streamDeltas: number
  streamTurnReached: boolean
  usageAfterTurn: TurnUsage | null
  hookCallsAfterTurn: number
  closeError: string | null
  closeResolved: boolean
  secondCloseResolved: boolean
  iterableCompleted: boolean
  statusAfterClose: SessionStatus | null
}

interface FileOutcome {
  error?: string
  reachedTurnEnd: boolean
  fileEvents: AgentEvent[]
}

interface ToolOutcome {
  error?: string
  reachedTurnEnd: boolean
  probeCalls: number
  sawToolOther: boolean
}

interface InterjectOutcome {
  error?: string
  inFlight: boolean
  interjectResolved: boolean
  turnEndedAfterInterject: boolean
  followupAttempted: boolean
  followupReachedTurnEnd: boolean
  followupErrors: ErrorEvent[]
}

interface InterruptOutcome {
  error?: string
  inFlight: boolean
  interruptResolved: boolean
  turnEnds: TurnEnd[]
  settled: boolean
  streamEnded: boolean
  trailingEvents: number
}

interface ResumeOutcome {
  error?: string
  attempted: boolean
  resolved: boolean
  sameId: boolean
  followupReachedTurnEnd: boolean
  rejection: string | null
  rejectionCode: string | null
}

interface ModelOutcome {
  error?: string
  tierAccepted: boolean
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class ConformanceRun {
  private readonly checks: ConformanceCheck[] = []
  private readonly collectors: Collector[] = []
  private readonly statuses: SessionStatus[] = []
  private readonly usageBySession = new Map<string, TurnUsage[]>()
  private readonly ownedWorkspaces: string[] = []
  private readonly timeout: number
  private hookCalls = 0
  private probeCalls = 0
  private sawWorking = false

  constructor(private readonly driver: Driver, private readonly opts: ConformanceOptions) {
    this.timeout = opts.timeoutMsPerTurn ?? DEFAULT_TURN_TIMEOUT_MS
  }

  async execute(): Promise<ConformanceReport> {
    try {
      const echo = await this.runEcho()
      const file = await this.runFileChange()
      const tool = await this.runToolCall()
      const interject = await this.runInterject()
      const interrupt = await this.runInterrupt()
      const resume = await this.runResume()
      const model = await this.runModelSelection()
      this.gradeClauses(echo, interject, interrupt, resume)
      this.gradeCapabilities(echo, file, tool, interject, interrupt, resume, model)
    } finally {
      await this.cleanup()
    }
    return {
      driverId: this.driver.id,
      checks: this.checks,
      ok: this.checks.every((check) => check.ok),
    }
  }

  // -- plumbing -------------------------------------------------------------

  private readonly hooks: SessionHooks = {
    onEvent: (): void => { this.hookCalls += 1 },
  }

  private readonly probe: InjectedTool = {
    name: CONFORMANCE_PROBE,
    description: 'Conformance probe: records that it ran and returns a fixed marker.',
    inputSchema: { type: 'object', additionalProperties: true },
    handler: (input: unknown): Promise<unknown> => {
      this.probeCalls += 1
      return Promise.resolve({ marker: CONFORMANCE_PROBE_MARKER, input })
    },
  }

  private async workspace(): Promise<string> {
    if (this.opts.makeWorkspace) return this.opts.makeWorkspace()
    const dir = await mkdtemp(join(tmpdir(), 'rootstock-conformance-'))
    this.ownedWorkspaces.push(dir)
    return dir
  }

  private async open(scenario: ConformanceScenario, tier?: ModelTier['tier']): Promise<{
    session: Session
    collector: Collector
    options: SessionOptions
  }> {
    const worktree = await this.workspace()
    const ctx: ConformanceSessionContext = {
      scenario,
      worktree,
      tools: [this.probe],
      hooks: this.hooks,
      ...(tier === undefined ? {} : { tier }),
    }
    const options: SessionOptions = {
      worktree,
      tools: ctx.tools,
      hooks: ctx.hooks,
      ...(tier === undefined ? {} : { tier }),
    }
    const session = this.opts.makeSession
      ? await this.opts.makeSession(ctx)
      : await this.driver.start(options)
    const collector = new Collector(session)
    this.collectors.push(collector)
    return { session, collector, options }
  }

  private note(session: Session): SessionStatus {
    const status = session.status()
    this.statuses.push(status)
    if (status === 'working') this.sawWorking = true
    return status
  }

  private snapshotUsage(session: Session): TurnUsage | null {
    let usage: TurnUsage | null = null
    try {
      usage = session.usage()
    } catch {
      return null
    }
    const series = this.usageBySession.get(session.id) ?? []
    series.push(usage)
    this.usageBySession.set(session.id, series)
    return usage
  }

  private async closeQuietly(session: Session): Promise<void> {
    try {
      await session.close()
    } catch {
      // A close that throws is graded by clause.close, not by the scenario
      // that happened to own the session.
    }
  }

  private async cleanup(): Promise<void> {
    for (const dir of this.ownedWorkspaces) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        // A workspace the suite cannot remove is not a driver defect.
      }
    }
  }

  // -- scenarios ------------------------------------------------------------

  /** start / send / status / usage / close, plus streaming, hooks and cost. */
  private async runEcho(): Promise<EchoOutcome> {
    const outcome: EchoOutcome = {
      id: undefined,
      statusBeforeSend: null,
      sendResolved: false,
      reachedTurnEnd: false,
      deltas: 0,
      streamDeltas: 0,
      streamTurnReached: false,
      usageAfterTurn: null,
      hookCallsAfterTurn: 0,
      closeError: null,
      closeResolved: false,
      secondCloseResolved: false,
      iterableCompleted: false,
      statusAfterClose: null,
    }
    try {
      const { session, collector } = await this.open('echo')
      outcome.id = session.id
      outcome.statusBeforeSend = this.note(session)

      await session.send(CONFORMANCE_TASKS.echo)
      outcome.sendResolved = true
      this.note(session)

      outcome.reachedTurnEnd = await collector.waitFor(
        () => turnEndsIn(collector.events).length >= 1,
        this.timeout,
        () => { this.note(session) },
      )
      outcome.deltas = collector.events.filter((event) => event.kind === 'message.delta').length
      outcome.usageAfterTurn = this.snapshotUsage(session)
      outcome.hookCallsAfterTurn = this.hookCalls

      // The streaming proof: a second turn on this same session, so it costs
      // one turn rather than a whole extra scenario and session. Only this
      // turn's deltas are counted, which is why the mark is taken first.
      const streamFrom = collector.events.length
      await session.send(CONFORMANCE_TASKS.stream)
      outcome.streamTurnReached = await collector.waitFor(
        () => turnEndsIn(collector.events).length >= 2,
        this.timeout,
        () => { this.note(session) },
      )
      outcome.streamDeltas = collector.events
        .slice(streamFrom)
        .filter((event) => event.kind === 'message.delta').length

      // A second snapshot on the same session, so 'never decreases' is graded
      // on every run rather than only where a scenario takes two turns.
      this.snapshotUsage(session)

      // Graded into clause.close rather than into the scenario: a driver whose
      // only defect is close() should not lose the observations already taken.
      try {
        await session.close()
        outcome.closeResolved = true
        await session.close()
        outcome.secondCloseResolved = true
      } catch (cause) {
        outcome.closeError = describeError(cause)
      }
      outcome.iterableCompleted = await collector.waitFor(() => collector.completed, this.timeout)
      outcome.statusAfterClose = this.note(session)
    } catch (cause) {
      outcome.error = describeError(cause)
    }
    return outcome
  }

  /** The fileEvents branch pair. */
  private async runFileChange(): Promise<FileOutcome> {
    const outcome: FileOutcome = { reachedTurnEnd: false, fileEvents: [] }
    try {
      const { session, collector, options } = await this.open('fileChange')
      // Seeded after the session is opened but before the turn is sent: every
      // driver here starts its engine lazily on the first send, so the file is
      // on disk before anything can look for it.
      await writeFile(join(options.worktree, CONFORMANCE_EDIT_FILE), CONFORMANCE_EDIT_CONTENT)
      await session.send(CONFORMANCE_TASKS.fileChange)
      this.note(session)
      outcome.reachedTurnEnd = await collector.waitFor(
        () => turnEndsIn(collector.events).length >= 1,
        this.timeout,
        () => { this.note(session) },
      )
      outcome.fileEvents = fileEventsIn(collector.events)
      this.snapshotUsage(session)
      await this.closeQuietly(session)
    } catch (cause) {
      outcome.error = describeError(cause)
    }
    return outcome
  }

  /** The toolInjection branch pair. */
  private async runToolCall(): Promise<ToolOutcome> {
    const outcome: ToolOutcome = { reachedTurnEnd: false, probeCalls: 0, sawToolOther: false }
    try {
      const before = this.probeCalls
      const { session, collector } = await this.open('toolCall')
      await session.send(CONFORMANCE_TASKS.toolCall)
      this.note(session)
      outcome.reachedTurnEnd = await collector.waitFor(
        () => turnEndsIn(collector.events).length >= 1,
        this.timeout,
        () => { this.note(session) },
      )
      outcome.probeCalls = this.probeCalls - before
      outcome.sawToolOther = collector.events.some((event) => event.kind === 'tool.other')
      this.snapshotUsage(session)
      await this.closeQuietly(session)
    } catch (cause) {
      outcome.error = describeError(cause)
    }
    return outcome
  }

  /**
   * Interject mid-turn. Under `interject: false` the declared degradation is
   * observable only through the NEXT turn, whose effective text must carry the
   * note — so the suite takes that turn and grades whether it landed.
   */
  private async runInterject(): Promise<InterjectOutcome> {
    const outcome: InterjectOutcome = {
      inFlight: false,
      interjectResolved: false,
      turnEndedAfterInterject: false,
      followupAttempted: false,
      followupReachedTurnEnd: false,
      followupErrors: [],
    }
    try {
      const { session, collector } = await this.open('interject')
      await session.send(CONFORMANCE_TASKS.echo)
      this.note(session)
      // Mid-turn: as soon as the turn shows any sign of life, before it ends.
      await collector.waitFor(
        () => collector.events.length >= 1 || turnEndsIn(collector.events).length >= 1,
        this.timeout,
        () => { this.note(session) },
      )
      outcome.inFlight = turnEndsIn(collector.events).length === 0
      await session.interject(CONFORMANCE_NOTE)
      outcome.interjectResolved = true
      outcome.turnEndedAfterInterject = await collector.waitFor(
        () => turnEndsIn(collector.events).length >= 1,
        this.timeout,
        () => { this.note(session) },
      )
      this.snapshotUsage(session)

      if (!this.driver.capabilities.interject) {
        outcome.followupAttempted = true
        const mark = collector.events.length
        await session.send(CONFORMANCE_TASKS.followup)
        outcome.followupReachedTurnEnd = await collector.waitFor(
          () => turnEndsIn(collector.events.slice(mark)).length >= 1,
          this.timeout,
          () => { this.note(session) },
        )
        outcome.followupErrors = errorsIn(collector.events.slice(mark))
        this.snapshotUsage(session)
      }
      await this.closeQuietly(session)
    } catch (cause) {
      outcome.error = describeError(cause)
    }
    return outcome
  }

  /**
   * Interrupt mid-turn. Capable: a turn.end with stopReason 'interrupted' and
   * nothing after it. Incapable: the in-flight turn runs to its natural end and
   * the send queued behind it is discarded — so exactly one turn.end, and
   * nothing after it either.
   */
  private async runInterrupt(): Promise<InterruptOutcome> {
    const outcome: InterruptOutcome = {
      inFlight: false,
      interruptResolved: false,
      turnEnds: [],
      settled: false,
      streamEnded: false,
      trailingEvents: 0,
    }
    try {
      const { session, collector } = await this.open('interrupt')
      await session.send(CONFORMANCE_TASKS.echo)
      this.note(session)
      await collector.waitFor(
        () => collector.events.length >= 1 || turnEndsIn(collector.events).length >= 1,
        this.timeout,
        () => { this.note(session) },
      )
      if (!this.driver.capabilities.interrupt) {
        // Queued BEFORE the interrupt, so the degradation has something to
        // discard. Its turn.end is the tell if the driver runs it anyway.
        await session.send(CONFORMANCE_TASKS.followup)
      }
      outcome.inFlight = turnEndsIn(collector.events).length === 0
      await session.interrupt()
      outcome.interruptResolved = true

      outcome.settled = await collector.waitFor(
        () => turnEndsIn(collector.events).length >= 1 || collector.completed,
        this.timeout,
        () => { this.note(session) },
      )
      const ended = collector.events.findIndex((event) => event.kind === 'turn.end')
      const seenAtEnd = ended === -1 ? collector.events.length : ended + 1
      await sleep(TRAILING_WINDOW_MS)
      outcome.trailingEvents = collector.events.length - seenAtEnd
      outcome.turnEnds = turnEndsIn(collector.events)
      outcome.streamEnded = collector.completed
      this.snapshotUsage(session)
      this.note(session)
      await this.closeQuietly(session)
    } catch (cause) {
      outcome.error = describeError(cause)
    }
    return outcome
  }

  /** resume(): the same logical session, or a loud UnsupportedError. */
  private async runResume(): Promise<ResumeOutcome> {
    const outcome: ResumeOutcome = {
      attempted: false,
      resolved: false,
      sameId: false,
      followupReachedTurnEnd: false,
      rejection: null,
      rejectionCode: null,
    }
    try {
      const { session, collector, options } = await this.open('resume')
      await session.send(CONFORMANCE_TASKS.echo)
      this.note(session)
      await collector.waitFor(
        () => turnEndsIn(collector.events).length >= 1,
        this.timeout,
        () => { this.note(session) },
      )
      this.snapshotUsage(session)

      outcome.attempted = true
      let resumed: Session | null = null
      try {
        resumed = await this.driver.resume(session.id, options)
        outcome.resolved = true
      } catch (cause) {
        outcome.rejection = describeError(cause)
        outcome.rejectionCode = errorCode(cause)
      }

      if (resumed !== null) {
        const live: Session = resumed
        outcome.sameId = live.id === session.id
        const resumedCollector = new Collector(live)
        this.collectors.push(resumedCollector)
        await live.send(CONFORMANCE_TASKS.followup)
        this.note(live)
        outcome.followupReachedTurnEnd = await resumedCollector.waitFor(
          () => turnEndsIn(resumedCollector.events).length >= 1,
          this.timeout,
          () => { this.note(live) },
        )
        this.snapshotUsage(live)
        await this.closeQuietly(live)
      }
      await this.closeQuietly(session)
    } catch (cause) {
      outcome.error = describeError(cause)
    }
    return outcome
  }

  /** A tier in SessionOptions must be accepted on both branches — never an error. */
  private async runModelSelection(): Promise<ModelOutcome> {
    const outcome: ModelOutcome = { tierAccepted: false }
    try {
      const { session } = await this.open('modelSelection', 'deep')
      outcome.tierAccepted = true
      this.note(session)
      await this.closeQuietly(session)
    } catch (cause) {
      outcome.error = describeError(cause)
    }
    return outcome
  }

  // -- grading --------------------------------------------------------------

  private grade(id: string, run: () => string | null): void {
    try {
      const detail = run()
      if (detail === null) this.checks.push({ id, ok: true })
      else this.checks.push({ id, ok: false, detail })
    } catch (cause) {
      this.checks.push({ id, ok: false, detail: `check threw: ${describeError(cause)}` })
    }
  }

  private get allEvents(): AgentEvent[] {
    return this.collectors.flatMap((collector) => collector.events)
  }

  private gradeClauses(
    echo: EchoOutcome,
    interject: InterjectOutcome,
    interrupt: InterruptOutcome,
    resume: ResumeOutcome,
  ): void {
    this.grade('clause.start', () => {
      if (echo.error !== undefined) return `start scenario failed: ${echo.error}`
      if (typeof echo.id !== 'string' || echo.id.length === 0) return `session.id is not a non-empty string: ${String(echo.id)}`
      if (echo.statusBeforeSend !== 'idle') return `status() before any send was '${String(echo.statusBeforeSend)}', expected 'idle'`
      return null
    })

    this.grade('clause.send', () => {
      if (echo.error !== undefined) return `send scenario failed: ${echo.error}`
      if (!echo.sendResolved) return 'send() did not resolve'
      if (!echo.reachedTurnEnd) return `no turn.end within ${this.timeout}ms: timed out`
      return null
    })

    this.grade('clause.events', () => {
      const events = this.allEvents
      const kinds: readonly string[] = EVENT_KINDS
      const stranger = events.find((event) => !kinds.includes(event.kind))
      if (stranger) return `event kind outside the ten-kind union: '${stranger.kind}'`
      const sources: readonly string[] = ERROR_SOURCES
      const badSource = errorsIn(events).find((event) => !sources.includes(event.source))
      if (badSource) return `error event with source '${String(badSource.source)}'`
      for (const end of turnEndsIn(events)) {
        const problem = usageShapeProblem(end.usage)
        if (problem !== null) return `turn.end carries no usable usage: ${problem}`
      }
      if (events.length === 0) return 'no events were observed at all'
      return null
    })

    this.grade('clause.status', () => {
      const known: readonly string[] = SESSION_STATUSES
      const stranger = this.statuses.find((status) => !known.includes(status))
      if (stranger !== undefined) return `status() returned '${String(stranger)}', outside the five values`
      if (!this.sawWorking) return "status() never reported 'working' during an in-flight turn"
      if (echo.error === undefined && echo.statusAfterClose !== 'dead') {
        return `status() after close() was '${String(echo.statusAfterClose)}', expected 'dead'`
      }
      return null
    })

    this.grade('clause.interject', () => {
      if (interject.error !== undefined) return `interject scenario failed: ${interject.error}`
      if (!interject.inFlight) return 'the turn ended before interject() could be called — no in-flight window to deliver into'
      if (!interject.interjectResolved) return 'interject() did not resolve'
      if (!interject.turnEndedAfterInterject) return 'the interjected turn never reached turn.end'
      return null
    })

    this.grade('clause.interrupt', () => {
      if (interrupt.error !== undefined) return `interrupt scenario failed: ${interrupt.error}`
      if (!interrupt.interruptResolved) return 'interrupt() did not resolve'
      if (!interrupt.settled) return `after interrupt() the session neither ended a turn nor ended its stream within ${this.timeout}ms: hung`
      return null
    })

    this.grade('clause.usage', () => {
      const series = [...this.usageBySession.values()]
      if (series.length === 0) return 'usage() was never observed'
      for (const snapshots of series) {
        for (const usage of snapshots) {
          const problem = usageShapeProblem(usage)
          if (problem !== null) return `usage() is not a TurnUsage: ${problem}`
        }
        const first = snapshots[0]
        if (first !== undefined && first.turns < 1) return `usage().turns was ${first.turns} after a completed turn`
        for (let i = 1; i < snapshots.length; i += 1) {
          const previous = snapshots[i - 1]
          const current = snapshots[i]
          if (previous === undefined || current === undefined) continue
          if (current.turns < previous.turns) return `usage().turns decreased across turns: ${previous.turns} then ${current.turns}`
        }
      }
      return null
    })

    this.grade('clause.resume', () => {
      if (resume.error !== undefined) return `resume scenario failed: ${resume.error}`
      if (!resume.attempted) return 'resume() was never called'
      if (this.driver.capabilities.resume) {
        if (!resume.resolved) return `resume: true but resume() rejected: ${String(resume.rejection)}`
        if (!resume.sameId) return 'the resumed session does not carry the same id'
        return null
      }
      if (resume.resolved) return 'resume: false but resume() resolved — an unsupported operation must fail loudly'
      if (resume.rejectionCode !== 'ERR_UNSUPPORTED') {
        return `resume: false must reject with UnsupportedError (code ERR_UNSUPPORTED), got ${String(resume.rejection)}`
      }
      return null
    })

    this.grade('clause.close', () => {
      if (echo.error !== undefined) return `close scenario failed: ${echo.error}`
      if (echo.closeError !== null) return `close() threw: ${echo.closeError}`
      if (!echo.closeResolved) return 'close() did not resolve'
      if (!echo.secondCloseResolved) return 'a second close() did not resolve — close must be idempotent'
      if (!echo.iterableCompleted) return 'the events iterable did not complete after close()'
      if (echo.statusAfterClose !== 'dead') return `status() after close() was '${String(echo.statusAfterClose)}', expected 'dead'`
      return null
    })
  }

  private gradeCapabilities(
    echo: EchoOutcome,
    file: FileOutcome,
    tool: ToolOutcome,
    interject: InterjectOutcome,
    interrupt: InterruptOutcome,
    resume: ResumeOutcome,
    model: ModelOutcome,
  ): void {
    const caps = this.driver.capabilities

    this.grade('cap.streamingText', () => {
      if (echo.error !== undefined) return `echo scenario failed: ${echo.error}`
      if (!echo.streamTurnReached) return `the stream task never reached turn.end within ${this.timeout}ms`
      const floor = caps.streamingText ? 2 : 1
      if (echo.streamDeltas < floor) {
        return caps.streamingText
          ? `streamingText: true promises token-wise deltas; the stream task produced ${echo.streamDeltas}`
          : `streamingText: false still promises the text arrives; the stream task produced ${echo.streamDeltas} message.delta events`
      }
      return null
    })

    this.grade('cap.fileEvents', () => {
      if (file.error !== undefined) return `fileChange scenario failed: ${file.error}`
      if (caps.fileEvents) {
        const usable = file.fileEvents.find((event) => {
          if (event.kind === 'file.edit' || event.kind === 'file.create') {
            return event.path.length > 0 && typeof event.after === 'string'
          }
          return event.kind === 'file.delete' && event.path.length > 0
        })
        if (!usable) return `fileEvents: true produced no usable file.* event (saw ${file.fileEvents.length})`
        return null
      }
      const leaked = fileEventsIn(this.allEvents)
      if (leaked.length > 0) return `fileEvents: false promises NO file.* events; saw ${leaked.length} (first: '${String(leaked[0]?.kind)}')`
      if (!file.reachedTurnEnd) return 'fileEvents: false still promises the turn completes; no turn.end arrived'
      return null
    })

    this.grade('cap.resume', () => {
      if (resume.error !== undefined) return `resume scenario failed: ${resume.error}`
      if (caps.resume) {
        if (!resume.resolved) return `resume: true but resume() rejected: ${String(resume.rejection)}`
        if (!resume.followupReachedTurnEnd) return 'the resumed session never completed a follow-up turn — identity without continuity'
        return null
      }
      if (resume.rejectionCode !== 'ERR_UNSUPPORTED') {
        return `resume: false must reject with UnsupportedError (code ERR_UNSUPPORTED), got ${String(resume.rejection)}`
      }
      return null
    })

    this.grade('cap.interrupt', () => {
      if (interrupt.error !== undefined) return `interrupt scenario failed: ${interrupt.error}`
      if (!interrupt.inFlight) return 'the turn ended before interrupt() could be called — the branch could not be observed'
      const first = interrupt.turnEnds[0]
      if (caps.interrupt) {
        if (!first) return 'interrupt: true promises a turn.end; none arrived'
        if (first.stopReason !== 'interrupted') return `interrupt: true promises stopReason 'interrupted', got '${String(first.stopReason)}'`
        if (interrupt.trailingEvents > 0) return `${interrupt.trailingEvents} further events followed the interrupted turn.end`
        return null
      }
      if (!first) return 'interrupt: false promises the in-flight turn runs to its natural end; no turn.end arrived'
      if (first.stopReason === 'interrupted') return "interrupt: false must not report stopReason 'interrupted'"
      if (interrupt.turnEnds.length > 1 || interrupt.trailingEvents > 0) {
        return `interrupt: false promises the queued send is discarded; saw ${interrupt.turnEnds.length} turn.end events and ${interrupt.trailingEvents} trailing events`
      }
      return null
    })

    this.grade('cap.interject', () => {
      if (interject.error !== undefined) return `interject scenario failed: ${interject.error}`
      if (!interject.inFlight) return 'the turn ended before interject() could be called — the branch could not be observed'
      if (caps.interject) {
        if (!interject.interjectResolved) return 'interject() did not resolve'
        if (!interject.turnEndedAfterInterject) return 'the interjected turn never completed'
        return null
      }
      if (!interject.followupAttempted) return 'the follow-up turn that observes the buffered note was never taken'
      if (interject.followupErrors.length > 0) {
        return `interject: false promises the note is prepended to the next send; the follow-up turn errored: ${String(interject.followupErrors[0]?.message)}`
      }
      if (!interject.followupReachedTurnEnd) return 'interject: false promises the next turn carries the note; it never reached turn.end'
      return null
    })

    this.grade('cap.hooks', () => {
      if (echo.error !== undefined) return `echo scenario failed: ${echo.error}`
      if (caps.hooks) {
        if (echo.hookCallsAfterTurn < 1) return 'hooks: true but the onEvent hook never fired'
        return null
      }
      if (this.hookCalls !== 0) return `hooks: false promises hooks are silently ignored; onEvent fired ${this.hookCalls} times`
      return null
    })

    this.grade('cap.toolInjection', () => {
      if (tool.error !== undefined) return `toolCall scenario failed: ${tool.error}`
      if (caps.toolInjection) {
        if (tool.probeCalls < 1) return 'toolInjection: true but the injected probe handler was never invoked'
        if (!tool.sawToolOther) return 'toolInjection: true but no tool.other event surfaced the call'
        return null
      }
      if (tool.probeCalls !== 0) return `toolInjection: false promises injected tools are ignored; the handler ran ${tool.probeCalls} times`
      if (!tool.reachedTurnEnd) return 'toolInjection: false still promises the turn completes unaffected; no turn.end arrived'
      return null
    })

    this.grade('cap.costReporting', () => {
      if (echo.error !== undefined) return `echo scenario failed: ${echo.error}`
      const usage = echo.usageAfterTurn
      const problem = usageShapeProblem(usage)
      if (problem !== null || usage === null) return `usage() after a completed turn is unusable: ${String(problem)}`
      if (caps.costReporting) {
        if (usage.costUsd === null || usage.inputTokens === null || usage.outputTokens === null) {
          return 'costReporting: true promises real tokens and cost; a field was null'
        }
        if (usage.costUsd < 0 || usage.inputTokens < 0 || usage.outputTokens < 0) return 'costReporting: true but a token or cost field is negative'
        return null
      }
      if (usage.costUsd !== null || usage.inputTokens !== null || usage.outputTokens !== null) {
        return 'costReporting: false promises null token and cost fields'
      }
      if (!(usage.wallClockMs > 0)) return 'costReporting: false promises wall-clock stays real; wallClockMs was not > 0'
      if (usage.turns < 1) return `costReporting: false promises the turn count stays real; turns was ${usage.turns}`
      return null
    })

    this.grade('cap.modelSelection', () => {
      if (model.error !== undefined) return `modelSelection scenario failed: ${model.error}`
      let tiers: ModelTier[]
      try {
        tiers = this.driver.models()
      } catch (cause) {
        return `models() threw: ${describeError(cause)}`
      }
      const numbered = tiers.find((tier) => /\d/.test(tier.label))
      if (numbered) return `tier label '${numbered.label}' carries a digit — tiers are named, never versioned`
      if (!model.tierAccepted) return 'a tier passed in SessionOptions was rejected; a tier is honored or ignored, never an error'
      if (caps.modelSelection) {
        if (tiers.length < 2) return `modelSelection: true promises multiple tiers; models() returned ${tiers.length}`
        return null
      }
      if (tiers.length !== 1) return `modelSelection: false promises exactly one tier; models() returned ${tiers.length}`
      return null
    })
  }
}

/**
 * Grade a driver against the contract: nine clause checks that run for every
 * driver, and nine capability checks that grade whichever branch the driver
 * declared. Never throws for a driver defect — a defect is a failing check.
 */
export async function runConformance(driver: Driver, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  return new ConformanceRun(driver, opts).execute()
}
