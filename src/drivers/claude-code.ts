// The `claude-code` driver: the reference engine (architecture §2.5.4). It runs
// the Claude Agent SDK in-process — the supervisor embeds `query()` and never
// parses `stream-json` itself; that the TypeScript SDK manages its own bundled
// agent runtime as a child process is the SDK's business, not ours.
//
// The normalizer is the bulk of this file and the part that earns rootstock its
// own repo. Drivers translate; they never pass their native events through. No
// SDK shape may leak past this file: nothing below puts an SDK type in an
// exported signature, and no `AgentEvent` payload carries an SDK envelope field
// (`session_id`, `uuid`, `parent_tool_use_id`, …). The fixtures test enforces
// both.

import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk'
// Type-only, and only ever used on a private member: the engine's option shape
// never reaches an exported signature, but a typo in buildOptions() must fail
// the typecheck rather than the live run.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import * as z from 'zod'

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
  StopReason,
  TurnOptions,
  TurnUsage,
} from '../types'
import { UnsupportedError } from '../types'

// ---------------------------------------------------------------------------
// Tier → model. The whole point of this mapping living in a driver is that a
// model bump is a rootstock release, not a trellis change (§9 decision 9).
// ---------------------------------------------------------------------------

/**
 * The pin. Owners never see these strings — `models()` surfaces the tier labels
 * Haiku, Sonnet and Opus, and never a version number. Bump this constant, tag a
 * rootstock release; nothing downstream changes. Fable-class models are not
 * offered: there is no fourth tier.
 *
 * Pinned 2026-08-20 against the current Anthropic model list.
 */
const TIER_MODELS: Record<ModelTier['tier'], string> = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-5',
  deep: 'claude-opus-5',
}

/** Haiku, Sonnet, Opus — labels carry no digits. */
const TIERS: ModelTier[] = [
  { tier: 'fast', label: 'Haiku' },
  { tier: 'balanced', label: 'Sonnet' },
  { tier: 'deep', label: 'Opus' },
]

/**
 * A caller that does not name a tier gets the cheapest and quickest one. That
 * is the right default while trellis is being built and tested — most turns are
 * throwaway, and a Haiku turn costs a fraction of a Sonnet one. One constant to
 * change when owners are doing real work; callers may still name any tier per
 * session or per turn.
 */
const DEFAULT_TIER: ModelTier['tier'] = 'fast'

/**
 * What this step ships. `resume`, `interrupt` and `interject` are step 08's
 * work: their `Session` methods exist because the interface requires them, and
 * each performs the degradation its doc comment in src/types.ts promises rather
 * than pretending to work. Step 08 flips the three flags as it implements them.
 */
const CAPABILITIES: DriverCapabilities = {
  streamingText: true,
  fileEvents: true,
  resume: false,
  interrupt: false,
  interject: false,
  hooks: true,
  toolInjection: true,
  costReporting: true,
  modelSelection: true,
}

/** The MCP server injected tools are mounted on. The engine exposes them to the
 *  model as `mcp__<server>__<tool>`; the normalizer strips that prefix back off
 *  so callers see the tool name they registered. */
const TOOL_SERVER_NAME = 'rootstock'

const TOOL_NAME_PREFIX = `mcp__${TOOL_SERVER_NAME}__`

let sessionCounter = 0

function nextSessionId(): SessionId {
  sessionCounter += 1
  return `claude-code-${String(Date.now())}-${String(sessionCounter)}`
}

// ---------------------------------------------------------------------------
// Structural readers. The normalizer takes `unknown` rather than an SDK type,
// which is what keeps SDK shapes out of this module's public signature and lets
// the fixtures test feed it hand-written message literals.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  return String(cause)
}

// ---------------------------------------------------------------------------
// Normalizer state. `normalizeSdkMessage` performs no I/O and reads no module
// state, but two of the mappings are inherently cross-message: a `tool_result`
// only becomes `command.output` if the matching `tool_use` was a Bash call, and
// a turn's cost is a delta against the running total the engine reports. Both
// live in a state object the caller owns and passes in, so the function stays
// testable from fixtures and two sessions never share bookkeeping.
// ---------------------------------------------------------------------------

export interface NormalizerState {
  /** tool_use id → the tool that issued it, so its result can be classified. */
  readonly toolUses: Map<string, { name: string; input: Rec }>
  /**
   * The engine reports `total_cost_usd` cumulatively across a streaming-input
   * session, so a turn's own cost is the delta against the previous result.
   */
  totalCostUsd: number
  /** When set, `file.delete` is only inferred for paths inside this directory. */
  readonly worktree?: string
}

export function createNormalizerState(worktree?: string): NormalizerState {
  return {
    toolUses: new Map(),
    totalCostUsd: 0,
    ...(worktree === undefined ? {} : { worktree }),
  }
}

// ---------------------------------------------------------------------------
// The normalizer
// ---------------------------------------------------------------------------

/**
 * Turn one SDK message into zero or more `AgentEvent`s. Pure: no I/O, no module
 * state, no clock — everything cross-message it needs comes from `state`, which
 * it may update. Accepts `unknown` deliberately (see the file header).
 *
 * Mapping (architecture §2.5.2):
 *
 * | SDK message | AgentEvent |
 * | --- | --- |
 * | `stream_event` → `content_block_delta` / `text_delta` | `message.delta` |
 * | `assistant` `tool_use`, tool `Write` | `file.create` |
 * | `assistant` `tool_use`, tools `Edit` / `MultiEdit` / `NotebookEdit` | `file.edit` |
 * | `assistant` `tool_use`, tool `Bash` | `command.run` (+ best-effort `file.delete`) |
 * | `user` `tool_result` for a Bash `tool_use` | `command.output` |
 * | any other `tool_use` and its results | `tool.other` — opaque but carried, never dropped |
 * | `system` state transitions | `status` |
 * | `result` | `turn.end`, preceded by `error` when the agent failed |
 */
export function normalizeSdkMessage(message: unknown, state?: NormalizerState): AgentEvent[] {
  const msg = asRecord(message)
  if (msg === undefined) return []
  switch (str(msg['type'])) {
    case 'stream_event':
      return normalizeStreamEvent(msg)
    case 'assistant':
      return normalizeAssistant(msg, state)
    case 'user':
      return normalizeUser(msg, state)
    case 'system':
      return normalizeSystem(msg)
    case 'result':
      return normalizeResult(msg, state)
    default:
      // Only those five envelope types carry agent activity. The rest is
      // transport bookkeeping, and a `status` event per bookkeeping message
      // would be noise, not signal.
      return []
  }
}

function normalizeStreamEvent(msg: Rec): AgentEvent[] {
  const event = asRecord(msg['event'])
  if (event === undefined || str(event['type']) !== 'content_block_delta') return []
  const delta = asRecord(event['delta'])
  if (delta === undefined || str(delta['type']) !== 'text_delta') return []
  const text = str(delta['text'])
  return text === undefined || text.length === 0 ? [] : [{ kind: 'message.delta', text }]
}

function normalizeAssistant(msg: Rec, state?: NormalizerState): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const raw of asArray(asRecord(msg['message'])?.['content'])) {
    const block = asRecord(raw)
    // Assistant *text* blocks are deliberately skipped: the driver always sets
    // `includePartialMessages`, so that same text already arrived as
    // `message.delta`s and emitting it again would double every line of chat.
    if (block === undefined || str(block['type']) !== 'tool_use') continue
    const name = stripToolPrefix(str(block['name']) ?? 'unknown')
    const id = str(block['id'])
    const input = asRecord(block['input']) ?? {}
    if (state !== undefined && id !== undefined) state.toolUses.set(id, { name, input })
    events.push(...toolUseEvents(name, input, state))
  }
  return events
}

function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : name
}

function toolUseEvents(name: string, input: Rec, state?: NormalizerState): AgentEvent[] {
  switch (name) {
    case 'Write': {
      const path = str(input['file_path'])
      const after = str(input['content'])
      if (path !== undefined && after !== undefined) return [{ kind: 'file.create', path, after }]
      break
    }
    case 'Edit': {
      const path = str(input['file_path'])
      const edit = editEvent(path, input)
      if (edit !== undefined) return [edit]
      break
    }
    case 'MultiEdit': {
      const path = str(input['file_path'])
      const edits = asArray(input['edits'])
        .map((raw) => editEvent(path, asRecord(raw) ?? {}))
        .filter((event): event is AgentEvent => event !== undefined)
      if (edits.length > 0) return edits
      break
    }
    case 'NotebookEdit': {
      const path = str(input['notebook_path']) ?? str(input['file_path'])
      const after = str(input['new_source'])
      const before = str(input['old_source'])
      if (path !== undefined && after !== undefined) {
        return [{ kind: 'file.edit', path, after, ...(before === undefined ? {} : { before }) }]
      }
      break
    }
    case 'Bash': {
      const command = str(input['command'])
      if (command !== undefined) {
        const events: AgentEvent[] = [{ kind: 'command.run', command }]
        for (const path of deletedPaths(command, state?.worktree)) events.push({ kind: 'file.delete', path })
        return events
      }
      break
    }
    default:
      break
  }
  // Read, Grep, Glob, WebFetch, Task, MCP tools — and any known tool whose input
  // did not carry what its mapping needs. Opaque but carried, never dropped.
  return [{ kind: 'tool.other', name, payload: input }]
}

function editEvent(path: string | undefined, edit: Rec): AgentEvent | undefined {
  const after = str(edit['new_string'])
  const before = str(edit['old_string'])
  if (path === undefined || after === undefined) return undefined
  return { kind: 'file.edit', path, after, ...(before === undefined ? {} : { before }) }
}

/**
 * Claude Code has no dedicated delete tool, so deletions arrive as Bash `rm`.
 * Coverage is therefore inherently partial, and that is the intended behaviour
 * rather than a gap to close with a shell parser: anything with a glob, a
 * redirect, a pipe, a variable or a second command stays `command.run` alone.
 */
function deletedPaths(command: string, worktree?: string): string[] {
  if (/[|&;<>$`(){}[\]*?~\n]/.test(command)) return []
  const tokens = command.trim().split(/\s+/)
  if (tokens[0] !== 'rm') return []
  const paths: string[] = []
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) {
      // Only the flags that do not change which paths are named.
      if (!/^-[rRf]+$/.test(token)) return []
      continue
    }
    if (worktree !== undefined && !isInside(token, worktree)) return []
    paths.push(token)
  }
  return paths
}

function isInside(path: string, worktree: string): boolean {
  if (path.startsWith('/')) return path.startsWith(worktree.endsWith('/') ? worktree : `${worktree}/`)
  // A relative path is resolved against the worktree, which is the session cwd.
  return !path.split('/').includes('..')
}

function normalizeUser(msg: Rec, state?: NormalizerState): AgentEvent[] {
  const events: AgentEvent[] = []
  // A turn's own prompt arrives as a `user` message with string content; only
  // block content carries tool results.
  for (const raw of asArray(asRecord(msg['message'])?.['content'])) {
    const block = asRecord(raw)
    if (block === undefined || str(block['type']) !== 'tool_result') continue
    const id = str(block['tool_use_id'])
    const record = id === undefined ? undefined : state?.toolUses.get(id)
    const output = resultText(block['content'])
    const failed = block['is_error'] === true
    if (record?.name === 'Bash') {
      events.push({ kind: 'command.output', output, stream: failed ? 'stderr' : 'stdout' })
    } else {
      events.push({
        kind: 'tool.other',
        name: record?.name ?? 'unknown',
        payload: { result: output, ...(failed ? { failed: true } : {}) },
      })
    }
  }
  return events
}

function resultText(content: unknown): string {
  const direct = str(content)
  if (direct !== undefined) return direct
  if (Array.isArray(content)) {
    return content
      .map((raw) => str(asRecord(raw)?.['text']) ?? '')
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

function normalizeSystem(msg: Rec): AgentEvent[] {
  switch (str(msg['subtype'])) {
    case 'init':
      return [{ kind: 'status', status: 'working' }]
    case 'session_state_changed': {
      switch (str(msg['state'])) {
        case 'idle':
          return [{ kind: 'status', status: 'idle' }]
        case 'requires_action':
          return [{ kind: 'status', status: 'waiting' }]
        default:
          return [{ kind: 'status', status: 'working' }]
      }
    }
    default:
      // Other system messages are engine chatter, not state transitions.
      return []
  }
}

/**
 * A `result` closes a turn. Its subtype separates "the agent failed" from "the
 * engine failed" — the latter is a thrown error, handled in the read loop —
 * because the editor needs different owner-facing copy for each (§2.5.2).
 *
 * `turn.end` is always last: the conformance suite grades a declared
 * `interrupt: false` on nothing following the turn it let run to completion.
 */
function normalizeResult(msg: Rec, state?: NormalizerState): AgentEvent[] {
  const subtype = str(msg['subtype'])
  const failed = msg['is_error'] === true || (subtype !== undefined && subtype !== 'success')
  const events: AgentEvent[] = []
  if (failed) {
    const errors = asArray(msg['errors'])
      .map((entry) => str(entry) ?? '')
      .filter((entry) => entry.length > 0)
    events.push({
      kind: 'error',
      source: 'agent',
      message: errors[0] ?? str(msg['result']) ?? `the turn failed: ${subtype ?? 'unknown'}`,
      detail: { reason: subtype ?? 'unknown', errors },
    })
  }
  events.push({ kind: 'turn.end', stopReason: stopReasonOf(subtype, msg, failed), usage: turnUsageOf(msg, state) })
  return events
}

function stopReasonOf(subtype: string | undefined, msg: Rec, failed: boolean): StopReason {
  if (subtype === 'error_max_budget_usd') return 'budget'
  if (failed) return 'error'
  const reported = str(msg['stop_reason'])
  return reported === undefined || reported === 'end_turn' ? 'completed' : reported
}

function turnUsageOf(msg: Rec, state?: NormalizerState): TurnUsage {
  const usage = asRecord(msg['usage'])
  // Cache reads and writes are input tokens that were really billed, so they
  // belong in the input count a budget is measured against.
  const inputTokens =
    (num(usage?.['input_tokens']) ?? 0) +
    (num(usage?.['cache_creation_input_tokens']) ?? 0) +
    (num(usage?.['cache_read_input_tokens']) ?? 0)
  const cumulative = num(msg['total_cost_usd']) ?? 0
  let costUsd = cumulative
  if (state !== undefined) {
    costUsd = Math.max(0, cumulative - state.totalCostUsd)
    state.totalCostUsd = cumulative
  }
  return {
    inputTokens,
    outputTokens: num(usage?.['output_tokens']) ?? 0,
    costUsd,
    wallClockMs: num(msg['duration_ms']) ?? 0,
    turns: 1,
  }
}

// ---------------------------------------------------------------------------
// Injected tools. The engine wants MCP; `InjectedTool` is engine-agnostic, so
// the driver mounts every injected tool on one in-process MCP server.
// ---------------------------------------------------------------------------

/**
 * The SDK builds a tool's wire schema by converting a Zod schema, so a caller's
 * JSON Schema cannot be handed over verbatim. A permissive object schema is
 * what keeps the caller's arguments intact — an empty Zod shape silently
 * *strips* every argument — and the declared schema travels to the model in the
 * description, where it still tells the model how to call the tool.
 */
function buildToolServer(tools: readonly InjectedTool[]): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: tools.map((injected) =>
      // The SDK's published types accept only a raw Zod shape here, while its
      // runtime accepts a Zod schema too — and only a schema can be permissive.
      ({
        name: injected.name,
        description: describeTool(injected),
        inputSchema: z.looseObject({}),
        handler: async (args: unknown): Promise<{ content: { type: 'text'; text: string }[] }> => {
          const result = await injected.handler(args)
          return { content: [{ type: 'text', text: str(result) ?? safeJson(result) }] }
        },
      }) as never,
    ),
  })
}

function describeTool(tool: InjectedTool): string {
  const schema = tool.inputSchema === undefined ? undefined : safeJson(tool.inputSchema)
  return schema === undefined ? tool.description : `${tool.description}\n\nArguments (JSON Schema):\n${schema}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// The event stream handed to callers as `Session.events`.
// ---------------------------------------------------------------------------

class EventStream {
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
// The session
// ---------------------------------------------------------------------------

interface PendingTurn {
  text: string
  tier: ModelTier['tier']
}

/** What `query()` hands back: an async iterable of messages plus controls. Kept
 *  local so no SDK type reaches an exported signature. */
type QueryHandle = ReturnType<typeof query>

class ClaudeCodeSession implements Session {
  readonly id: SessionId = nextSessionId()

  events: AsyncIterable<AgentEvent>

  private readonly stream = new EventStream()
  private readonly pending: PendingTurn[] = []
  private readonly preamble: string[] = []
  private readonly normalizer: NormalizerState
  private readonly hooks: SessionHooks | undefined
  private readonly tier: ModelTier['tier']

  private state: SessionStatus = 'idle'
  private handle: QueryHandle | null = null
  private inputWaiter: (() => void) | null = null
  private activeTier: ModelTier['tier']
  private turnOpen = false
  private closed = false

  // Running totals. `costReporting: true`, so none of these is ever null.
  private turns = 0
  private inputTokens = 0
  private outputTokens = 0
  private costUsd = 0
  private wallClockMs = 0

  constructor(
    private readonly options: SessionOptions,
    private readonly configDir: string | undefined,
  ) {
    this.tier = options.tier ?? DEFAULT_TIER
    this.activeTier = this.tier
    this.hooks = options.hooks
    this.normalizer = createNormalizerState(options.worktree)
    this.events = this.stream
  }

  // -- the caller's surface --------------------------------------------------

  send(text: string, opts?: TurnOptions): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`session is closed: ${this.id}`))
    // Buffered notes and hook feedback ride out as the next turn's preamble —
    // the declared degradation for `interject: false` (§2.5.3).
    const notes = this.preamble.splice(0, this.preamble.length)
    this.pending.push({
      text: notes.length === 0 ? text : [...notes, text].join('\n\n'),
      tier: opts?.tier ?? this.tier,
    })
    // Emitted before the engine has said anything, so a caller watching the
    // stream can see the turn exists the moment it is queued.
    this.setStatus('working')
    this.ensureStarted()
    this.wakeInput()
    return Promise.resolve()
  }

  status(): SessionStatus {
    return this.state
  }

  /**
   * `interject: false`. The note is buffered and prepended to the next send's
   * text — "the next turn's preamble" (§2.5.3). Step 08 delivers it into the
   * in-flight turn and flips the flag.
   */
  interject(note: string): Promise<void> {
    if (note.length > 0) this.preamble.push(note)
    return Promise.resolve()
  }

  /**
   * `interrupt: false`. Resolves, the in-flight turn runs to its natural end,
   * and turns queued behind it are discarded. Step 08 calls the engine's own
   * `interrupt()` and flips the flag.
   */
  interrupt(): Promise<void> {
    this.pending.length = 0
    return Promise.resolve()
  }

  usage(): TurnUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      wallClockMs: this.wallClockMs,
      turns: this.turns,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.pending.length = 0
    this.setStatus('dead')
    this.stream.close()
    // Let the input generator return, which is how the engine learns the
    // conversation is over, then make sure the query itself is torn down.
    this.wakeInput()
    const handle = this.handle
    this.handle = null
    if (handle !== null) {
      try {
        await handle.return()
      } catch {
        // A teardown that fails is not something a caller can act on, and
        // close() must stay idempotent and quiet.
      }
    }
  }

  // -- the engine ------------------------------------------------------------

  private ensureStarted(): void {
    if (this.handle !== null || this.closed) return
    // Started lazily: a session that never takes a turn never spawns a runtime
    // and never costs anything.
    this.handle = query({ prompt: this.inputs(), options: this.buildOptions() })
    void this.readLoop(this.handle)
  }

  /**
   * Streaming input mode — the stable long-lived multi-turn shape, and the only
   * mode where the engine's controls work. Nothing is yielded while a turn is
   * open, so one send is exactly one turn: that is what makes discarding a
   * queued turn (the `interrupt: false` degradation) meaningful rather than a
   * race against the engine's own batching.
   */
  private async *inputs(): AsyncGenerator<{
    type: 'user'
    message: { role: 'user'; content: string }
    parent_tool_use_id: null
  }> {
    for (;;) {
      const turn = await this.nextTurn()
      if (turn === null) return
      if (turn.tier !== this.activeTier) {
        this.activeTier = turn.tier
        try {
          await this.handle?.setModel(TIER_MODELS[turn.tier])
        } catch {
          // A tier is honored or ignored, never an error (§2.5.3).
        }
      }
      this.turnOpen = true
      yield { type: 'user', message: { role: 'user', content: turn.text }, parent_tool_use_id: null }
    }
  }

  private async nextTurn(): Promise<PendingTurn | null> {
    for (;;) {
      if (this.closed) return null
      if (!this.turnOpen) {
        const next = this.pending.shift()
        if (next !== undefined) return next
      }
      await new Promise<void>((resolve) => {
        this.inputWaiter = resolve
      })
    }
  }

  private wakeInput(): void {
    const waiter = this.inputWaiter
    this.inputWaiter = null
    waiter?.()
  }

  private async readLoop(handle: QueryHandle): Promise<void> {
    try {
      for await (const message of handle) this.receive(message)
      if (!this.closed) this.die()
    } catch (cause) {
      if (!this.closed) {
        // The engine failed, as distinct from the agent failing — the editor
        // needs different copy for each (§2.5.2).
        this.emit({ kind: 'error', source: 'engine', message: describeError(cause) })
        this.die()
      }
    }
  }

  /** Ends the session's stream, leaving `turn.end` last if a turn was open. */
  private die(): void {
    this.state = 'dead'
    this.emit({ kind: 'status', status: 'dead' })
    if (this.turnOpen) {
      this.turnOpen = false
      this.emit({
        kind: 'turn.end',
        stopReason: 'error',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallClockMs: 0, turns: 1 },
      })
      this.turns += 1
    }
    this.stream.close()
  }

  private receive(message: unknown): void {
    if (this.closed) return
    for (const event of normalizeSdkMessage(message, this.normalizer)) {
      // Nothing is emitted outside a turn. The engine may still send
      // informational messages after a result, and the contract for a driver
      // declaring `interrupt: false` is that nothing follows the turn it let
      // run to completion.
      if (!this.turnOpen) continue

      if (event.kind === 'status') {
        // 'idle' is not the engine's to declare: a result ends a turn, and what
        // follows is decided by this session's own queue.
        if (event.status !== 'idle') this.setStatus(event.status)
        continue
      }

      if (event.kind === 'turn.end') {
        this.accumulate(event.usage)
        this.turnOpen = false
        // Emitted before turn.end so that turn.end stays the turn's last event.
        this.setStatus(this.pending.length > 0 ? 'working' : 'idle')
        this.emit(event)
        this.wakeInput()
        continue
      }

      this.emit(event)
    }
  }

  private accumulate(usage: TurnUsage): void {
    this.turns += usage.turns
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    this.costUsd += usage.costUsd ?? 0
    this.wallClockMs += usage.wallClockMs
  }

  private setStatus(next: SessionStatus): void {
    if (this.state === next) return
    this.state = next
    this.emit({ kind: 'status', status: next })
  }

  private emit(event: AgentEvent): void {
    this.stream.push(event)
    const onEvent = this.hooks?.onEvent
    if (onEvent === undefined) return
    try {
      const returned = onEvent(event)
      if (returned instanceof Promise) {
        void returned.then((resolved) => { this.absorb(resolved) }).catch(() => undefined)
      } else {
        this.absorb(returned)
      }
    } catch {
      // A hook that throws must never break the stream it is watching.
    }
  }

  /**
   * Hook feedback. With `interject: false` it cannot reach the agent mid-turn,
   * so it takes the same route a buffered note does — the next turn's preamble,
   * which is exactly the fallback §2.5.3 names. Step 08 makes it mid-turn.
   */
  private absorb(returned: void | { feedback: string }): void {
    if (returned === undefined || returned === null) return
    const feedback = str((returned as Rec)['feedback'])
    if (feedback !== undefined && feedback.length > 0) this.preamble.push(feedback)
  }

  /**
   * Re-built in full for every `query()` call: MCP config and settings are not
   * restored on resume, so nothing may be assumed to have persisted (§2.5.4).
   */
  private buildOptions(): Options {
    const tools = this.options.tools ?? []
    return {
      cwd: this.options.worktree,
      model: TIER_MODELS[this.tier],
      // The permissive session class is a decision (§2.5.5, §9): protection is
      // trellis's lint layer plus the deploy gate, not a permission prompt.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // Bare sessions, declared rather than incidental: no CLAUDE.md, no
      // .claude/, no filesystem hooks, no skills (§2.5.5).
      settingSources: [],
      ...(tools.length === 0 ? {} : { mcpServers: { [TOOL_SERVER_NAME]: buildToolServer(tools) } }),
      // Session JSONL lands where the caller says. Rootstock hardcodes no
      // volume path; trellis points this at its workbench volume (§2.2.4).
      ...(this.configDir === undefined ? {} : { env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDir } }),
    }
  }
}

// ---------------------------------------------------------------------------
// The factory. Per-instance configuration, so drivers are created here and
// registered by the caller — the same house pattern as `scripted`, and the
// reason getDriver() never depends on import order.
// ---------------------------------------------------------------------------

export interface ClaudeCodeDriverOptions {
  /**
   * Where the engine keeps its session state (`CLAUDE_CONFIG_DIR`). Trellis
   * points this at the workbench volume so sessions survive the machine
   * sleeping; rootstock itself hardcodes no path, and leaving it unset uses the
   * engine's own default.
   */
  configDir?: string
}

export function createClaudeCodeDriver(opts: ClaudeCodeDriverOptions = {}): Driver {
  return {
    id: 'claude-code',
    capabilities: { ...CAPABILITIES },
    models: () => TIERS.map((tier) => ({ ...tier })),
    start: (sessionOpts: SessionOptions): Promise<Session> =>
      Promise.resolve(new ClaudeCodeSession(sessionOpts, opts.configDir)),
    // `resume: false` — fails loudly rather than handing back a session with no
    // memory. Continuity comes from the worktree and git history until step 08
    // implements resume against the engine's own session ids.
    resume: (): Promise<Session> => Promise.reject(new UnsupportedError('resume')),
  }
}
