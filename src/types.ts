// @is4co/rootstock — the public contract. Design of record:
// docs/trellis-editor-architecture.md §2.5 in is4co/adaptig.
// Drivers translate; they never pass their native events through.

export type SessionId = string

/** idle | working | waiting | blocked | dead (§2.5.1). */
export type SessionStatus = 'idle' | 'working' | 'waiting' | 'blocked' | 'dead'

/**
 * A model tier, surfaced to owners by name only: the three tier labels, spelled
 * out by the driver. NEVER a version number, and no fourth tier beyond these
 * three (architecture §9 decision 9). The tier→concrete-model mapping lives
 * inside each driver, so a model bump is a rootstock release — no concrete
 * model id appears in this type.
 */
export interface ModelTier {
  tier: 'fast' | 'balanced' | 'deep'
  /** Display name. Must contain no digits — the conformance suite checks. */
  label: string
}

/**
 * Tokens and cost. Used both per-turn (in `turn.end`) and cumulatively (from
 * `Session.usage()`). Token and cost fields are null when the driver declares
 * `costReporting: false`; wall-clock and turn count are always real, because
 * they are what budgets fall back to (§2.5.3).
 */
export interface TurnUsage {
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  wallClockMs: number
  turns: number
}

/** Why a turn stopped. Open union: drivers may report engine-specific reasons. */
export type StopReason = 'completed' | 'interrupted' | 'budget' | 'error' | (string & {})

/**
 * The normalized event stream (§2.5.2) — exactly these ten kinds. This union is
 * what the editor renders; an engine's native shapes never cross it.
 */
export type AgentEvent =
  /** Assistant text, token-wise where the driver supports it. Renders as chat. */
  | { kind: 'message.delta'; text: string }
  /**
   * The single most important event to normalize (§2.5.2): an engine that
   * reports edits as opaque tool calls forces the editor to parse diffs.
   * `after` is the new content (whole file, or the replaced span when `range`
   * is present); `before` is the prior content where the driver knows it.
   * Drives the code-scrolling animation and the per-page change summary.
   */
  | { kind: 'file.edit'; path: string; after: string; before?: string; range?: { startLine: number; endLine: number } }
  | { kind: 'file.create'; path: string; after: string }
  | { kind: 'file.delete'; path: string; before?: string }
  /** What the agent ran… */
  | { kind: 'command.run'; command: string }
  /** …and what it printed. Collapses to friendly status lines in the transcript. */
  | { kind: 'command.output'; output: string; stream?: 'stdout' | 'stderr' }
  /**
   * Anything a driver cannot map — kept opaque and collapsible rather than
   * dropped, so a new engine degrades to "working…" instead of to silence.
   */
  | { kind: 'tool.other'; name: string; payload: unknown }
  /** Status transitions, so the editor renders waiting vs working honestly. */
  | { kind: 'status'; status: SessionStatus }
  /** Closes the turn and updates metering. */
  | { kind: 'turn.end'; stopReason: StopReason; usage: TurnUsage }
  /**
   * `source` distinguishes "the agent failed" from "the engine failed" —
   * they need different owner-facing copy (§2.5.2).
   */
  | { kind: 'error'; source: 'agent' | 'engine'; message: string; detail?: unknown }

/**
 * What a driver can do, and — just as binding — what it does INSTEAD when it
 * declares `false`. Every degradation below is a contract: the conformance
 * suite (src/conformance/) grades a `false` declaration on doing exactly the
 * declared fallback, not on being skipped (§2.5.3).
 */
export interface DriverCapabilities {
  /**
   * true: `message.delta` arrives token-wise (many deltas per message).
   * false: text still arrives via `message.delta`, but coarsely — as few as
   * one delta per message. It never goes missing; chat renders in blocks.
   */
  streamingText: boolean
  /**
   * true: edits surface as `file.edit`/`file.create`/`file.delete`.
   * false: the driver emits NO `file.*` events; trellis falls back to a
   * git-diff poll on the worktree — worse UX, still correct (§2.5.3).
   */
  fileEvents: boolean
  /**
   * true: `Driver.resume(id, opts)` returns the same logical session, which
   * accepts further turns with its context intact.
   * false: `resume()` rejects with UnsupportedError; the caller starts a
   * fresh session via `start()` — continuity comes from the worktree and
   * git history, not the agent's memory.
   */
  resume: boolean
  /**
   * true: `interrupt()` cancels the in-flight turn; the stream yields a
   * `turn.end` with stopReason 'interrupted'.
   * false: `interrupt()` still resolves, the in-flight turn runs to its
   * natural end, and any turns queued behind it are discarded.
   */
  interrupt: boolean
  /**
   * true: `interject(note)` delivers the note into the in-flight turn.
   * false: the note is buffered and prepended to the next `send()`'s text —
   * "the next turn's preamble" (§2.5.3).
   */
  interject: boolean
  /**
   * true: `SessionOptions.hooks` callbacks fire in-session, and feedback a
   * hook returns reaches the agent mid-turn (hosts the lint layer, §2.5.5).
   * false: hooks passed in options are silently ignored — never an error;
   * trellis runs its lint layer as a filesystem watcher instead, and
   * feedback arrives through `interject` or, failing that, as the next
   * turn's preamble (§2.5.3).
   */
  hooks: boolean
  /**
   * true: `SessionOptions.tools` are attached (MCP or equivalent) and the
   * agent can call them.
   * false: injected tools are silently ignored; the agent works through
   * code alone, which most tasks survive (§2.5.3).
   */
  toolInjection: boolean
  /**
   * true: `usage()` and `turn.end` carry real token counts and cost.
   * false: token/cost fields are null; budgets fall back to wall-clock and
   * turn counts, which are always populated (§2.5.3).
   */
  costReporting: boolean
  /**
   * true: `models()` returns multiple tiers and the tier in Session/Turn
   * options is honored.
   * false: `models()` returns exactly one tier, and a requested tier is
   * ignored — never an error.
   */
  modelSelection: boolean
}

/** V1 has exactly one policy: the agent runs permissive inside its workspace
 *  (bypass-permissions class, §2.5.5). The type exists so a future value can
 *  be added without an interface break. */
export type ToolPolicy = 'permissive'

/** A capability tool injected into the session (MCP or equivalent), named by
 *  the target contract (§2.5.5): storage, preview navigation, route
 *  enumeration. Ignored by drivers declaring `toolInjection: false`. */
export interface InjectedTool {
  name: string
  description: string
  inputSchema: unknown
  handler: (input: unknown) => Promise<unknown>
}

/** In-session observation. A hook may return feedback that reaches the agent
 *  mid-turn — that is what makes hooks stronger than watching `events`. */
export interface SessionHooks {
  onEvent?: (event: AgentEvent) => void | { feedback: string } | Promise<void | { feedback: string }>
}

/** Spend limits. This step owns the shape; step 08 implements enforcement
 *  against it and must not redefine it. */
export interface SessionBudget {
  /** Interrupt a turn whose live spend crosses this. */
  maxUsdPerTurn?: number
  /** Refuse new turns once the day's spend crosses this. */
  maxUsdPerDay?: number
  /** Caller-supplied spend from earlier sessions today. This is how trellis's
   *  per-owner, cross-session accounting flows in without rootstock keeping a
   *  ledger — rootstock only adds what this session has spent. */
  alreadySpentTodayUsd?: number
  /** Wall-clock guard; also a fallback for drivers with costReporting: false. */
  maxTurnSeconds?: number
  /** Turn-count fallback for drivers with costReporting: false. */
  maxTurnsPerDay?: number
}

/** Carries the worktree path, the model tier, the tool policy, the capability
 *  tools to attach, and a budget (§2.5.1). */
export interface SessionOptions {
  worktree: string
  tier?: ModelTier['tier']
  toolPolicy?: ToolPolicy
  tools?: InjectedTool[]
  hooks?: SessionHooks
  budget?: SessionBudget
}

/** Owners choose per session or per turn (§2.5.4). */
export interface TurnOptions {
  tier?: ModelTier['tier']
}

export interface Session {
  id: SessionId
  /** Queue an owner turn. Resolves when queued, not when the turn ends. */
  send(text: string, opts?: TurnOptions): Promise<void>
  events: AsyncIterable<AgentEvent>
  status(): SessionStatus
  /** Mid-turn feedback (§2.5.1). See DriverCapabilities.interject. */
  interject(note: string): Promise<void>
  /** See DriverCapabilities.interrupt. */
  interrupt(): Promise<void>
  /** Tokens and cost so far, if the driver reports them. */
  usage(): TurnUsage
  close(): Promise<void>
}

export interface Driver {
  /** Stable engine id: 'scripted', 'openhands', the reference SDK driver, … */
  id: string
  capabilities: DriverCapabilities
  models(): ModelTier[]
  start(opts: SessionOptions): Promise<Session>
  resume(id: SessionId, opts: SessionOptions): Promise<Session>
}

/**
 * The one runtime export in this file. Thrown/rejected by operations a driver
 * declares unsupported where the declared degradation is "fail loudly" —
 * today that is exactly `resume()` under `resume: false`. Kept here so the
 * conformance suite and callers share one type to assert on.
 */
export class UnsupportedError extends Error {
  readonly code = 'ERR_UNSUPPORTED'
  constructor(operation: string) {
    super(`unsupported: ${operation}`)
    this.name = 'UnsupportedError'
  }
}
