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
 * All nine, matching §2.5.4. `resume`, `interrupt` and `interject` are real
 * here: resume re-opens the engine's own session by its `session_id`, interrupt
 * calls the query object's `interrupt()`, and interject feeds a note into the
 * live streaming input rather than buffering it for the next turn.
 *
 * Flipping `interject` is also what makes `hooks: true` honest — the flag
 * promises hook feedback "reaches the agent mid-turn", and until interject
 * existed that feedback could only ride out as the next turn's preamble.
 */
const CAPABILITIES: DriverCapabilities = {
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

/**
 * How long an interrupted turn is given to produce its own `result` before the
 * driver synthesizes a `turn.end` for it. An interrupt that the engine never
 * acknowledges must not lose the turn — metering and the caller's queue both
 * hang off `turn.end`.
 */
const INTERRUPT_GRACE_MS = 5_000

/** The MCP server injected tools are mounted on. The engine exposes them to the
 *  model as `mcp__<server>__<tool>`; the normalizer strips that prefix back off
 *  so callers see the tool name they registered. */
const TOOL_SERVER_NAME = 'rootstock'

const TOOL_NAME_PREFIX = `mcp__${TOOL_SERVER_NAME}__`

/**
 * The engine's subagent dispatcher, denied — because it ends a turn that has not
 * finished.
 *
 * The SDK's own schema for this tool says it plainly: "Agents run in the background
 * by default; you will be notified when one completes." A model that dispatches one
 * has nothing left to say, so the engine emits `result`, and `result` is what this
 * driver turns into `turn.end`. The work then lands seconds *after* the turn a
 * consumer was told had ended.
 *
 * That is not a hypothetical cost. Trellis commits and pushes an owner's edit on
 * `turn.end` (`is4co/trellis#2`), and on 2026-08-25 an owner's first instruction on
 * a live workbench produced exactly this: two background `Agent` calls, a turn that
 * ended in under twenty seconds saying "I'm searching for the public home page now.
 * Let me wait for the agent to locate it", a save that ran against a clean worktree
 * and committed nothing, and the correct edit appearing on disk twenty seconds
 * later with nothing left to notice it. The owner was shown "Ready" and had no
 * edit; the fix for the SECOND message would have committed it, which is worse than
 * failing, because the loop looks intermittent rather than broken.
 *
 * `turn.end` has to mean the turn is over. A driver cannot make a background agent
 * synchronous, so the honest move is to not hand the model one. Both spellings are
 * denied: the tool is `Agent` in the SDK this pins, and was `Task` before it, and a
 * deny entry for a tool the engine does not have costs nothing.
 *
 * This belongs beside `settingSources: []` in spirit — the bare session is
 * declared, not incidental (§2.5.5). Skills, project settings and hooks were all
 * excluded deliberately; background subagents are the same class of thing and were
 * only ever included by omission.
 */
export const DENIED_TOOLS: readonly string[] = ['Agent', 'Task']

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
   * Absolute path → the file's lines as the driver last knew them, dense from
   * line 1. Seeded from `Write` content and from `Read` results, and kept
   * current as each `Edit` applies — which is what lets `file.edit` carry a
   * pre-edit `range` without the normalizer ever touching the filesystem.
   *
   * A windowed `Read` pads the prefix it never showed with empty lines, so a
   * line number derived from this array is the real one either way.
   */
  readonly files: Map<string, string[]>
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
    files: new Map(),
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
 * | `assistant` `tool_use`, tools `Edit` / `MultiEdit` | `file.edit` (with `range`) |
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
      if (path !== undefined && after !== undefined) {
        // `file.create` carries the whole file, so it needs no range — but the
        // content is exactly what a later `Edit` on this path needs to locate
        // its span against.
        state?.files.set(path, after.split('\n'))
        return [{ kind: 'file.create', path, after }]
      }
      break
    }
    case 'Edit': {
      const path = str(input['file_path'])
      const edit = editEvent(path, input, state)
      if (edit !== undefined) return [edit]
      break
    }
    case 'MultiEdit': {
      const path = str(input['file_path'])
      const edits = asArray(input['edits'])
        // Sequential by construction: each sub-edit updates the tracked lines,
        // so the next one's range reflects the shift the previous one caused.
        .map((raw) => editEvent(path, asRecord(raw) ?? {}, state))
        .filter((event): event is AgentEvent => event !== undefined)
      if (edits.length > 0) return edits
      break
    }
    // `NotebookEdit` deliberately has no case: its `new_source` is one cell of
    // a JSON notebook, so neither a whole-file `after` nor a line range is
    // meaningful for it, and a `file.edit` carrying a fragment with no `range`
    // is the exact ambiguity this driver no longer emits. It falls through to
    // `tool.other` below — opaque and collapsible, never dropped.
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

/**
 * An `Edit` names the span it replaces by quoting it, not by numbering it, so
 * the range has to be recovered from the content the driver has been tracking.
 * Declining (returning undefined) is a real outcome, not a failure: the caller
 * degrades to `tool.other`, which keeps the invariant that matters — this
 * driver never emits a fragment `after` without the `range` that locates it.
 */
function editEvent(path: string | undefined, edit: Rec, state?: NormalizerState): AgentEvent | undefined {
  const after = str(edit['new_string'])
  const before = str(edit['old_string'])
  if (path === undefined || after === undefined || before === undefined) return undefined
  const range = rangeOf(state, path, before)
  if (range === undefined) return undefined
  applyEdit(state, path, before, after)
  return { kind: 'file.edit', path, after, before, range }
}

/**
 * The pre-edit span `old` occupies: 1-based, both endpoints inclusive. Undefined
 * when the driver holds no content for the path, when `old` is not in it, or
 * when it appears more than once — an ambiguous match would produce a
 * confidently wrong range, which is worse for the consumer than none.
 */
function rangeOf(
  state: NormalizerState | undefined,
  path: string,
  old: string,
): { startLine: number; endLine: number } | undefined {
  const lines = state?.files.get(path)
  if (lines === undefined || old.length === 0) return undefined
  const joined = lines.join('\n')
  const at = joined.indexOf(old)
  if (at < 0 || joined.indexOf(old, at + 1) >= 0) return undefined
  const startLine = countNewlines(joined.slice(0, at)) + 1
  return { startLine, endLine: startLine + countNewlines(old) }
}

function countNewlines(text: string): number {
  return text.split('\n').length - 1
}

/** Keeps the tracked content current, so the next sub-edit of a `MultiEdit`
 *  sees the lines the previous one shifted. */
function applyEdit(state: NormalizerState | undefined, path: string, old: string, next: string): void {
  const lines = state?.files.get(path)
  if (state === undefined || lines === undefined) return
  const joined = lines.join('\n')
  const at = joined.indexOf(old)
  if (at < 0) return
  state.files.set(path, (joined.slice(0, at) + next + joined.slice(at + old.length)).split('\n'))
}

/**
 * A `Read` result is `<line number>\t<text>` per line. Absolute numbers, so a
 * window out of a large file still yields real line numbers once the unread
 * prefix is padded.
 */
function linesFromReadResult(output: string): { first: number; lines: string[] } | undefined {
  const seen = new Map<number, string>()
  for (const raw of output.split('\n')) {
    const match = /^\s*(\d+)\t(.*)$/.exec(raw)
    if (match === null) continue
    const number = Number(match[1])
    if (!Number.isInteger(number) || number < 1) continue
    seen.set(number, match[2] ?? '')
  }
  if (seen.size === 0) return undefined
  const numbers = [...seen.keys()]
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  const lines: string[] = []
  for (let n = first; n <= last; n += 1) lines.push(seen.get(n) ?? '')
  return { first, lines }
}

/**
 * Merges a `Read` window into what the driver already knows, rather than
 * replacing it. A windowed read of lines 500-502 must not discard lines 1-499
 * the driver learned from an earlier read or from `Write` — an `Edit` in that
 * prefix would then fail to locate and degrade to `tool.other`, losing a
 * `file.edit` the driver was perfectly able to report.
 */
function mergeReadWindow(existing: string[] | undefined, window: { first: number; lines: string[] }): string[] {
  const merged = existing === undefined ? [] : [...existing]
  while (merged.length < window.first - 1) merged.push('')
  for (let offset = 0; offset < window.lines.length; offset += 1) {
    merged[window.first - 1 + offset] = window.lines[offset] ?? ''
  }
  return merged
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
    // A `Read` is how the driver learns what a file contains: Claude Code
    // requires one before it will `Edit`, so this is what makes a pre-edit
    // `range` computable in practice.
    if (record?.name === 'Read' && !failed) {
      const path = str(record.input['file_path'])
      const window = path === undefined ? undefined : linesFromReadResult(output)
      if (path !== undefined && window !== undefined && state !== undefined) {
        state.files.set(path, mergeReadWindow(state.files.get(path), window))
      }
    }
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
  /**
   * The engine's own `session_id`, as soon as the engine reports one — which is
   * what `Driver.resume()` takes back, and what makes resume survive a process
   * restart. Until the first message arrives it is a local placeholder, because
   * the interface requires a non-empty id before any turn is taken; a resumed
   * session starts out carrying the id it was asked to resume.
   */
  id: SessionId

  events: AsyncIterable<AgentEvent>

  private readonly stream = new EventStream()
  private readonly pending: PendingTurn[] = []
  private readonly preamble: string[] = []
  /** Notes to feed into the turn that is open right now (see interject). */
  private readonly interjections: string[] = []
  private readonly normalizer: NormalizerState
  private readonly hooks: SessionHooks | undefined
  private readonly tier: ModelTier['tier']

  private state: SessionStatus = 'idle'
  private handle: QueryHandle | null = null
  private inputWaiter: (() => void) | null = null
  private activeTier: ModelTier['tier']
  private turnOpen = false
  private closed = false

  // Interrupt bookkeeping.
  private interruptRequested = false
  /** After an interrupted turn.end, the engine's stragglers are dropped so
   *  nothing follows it — the contract `interrupt: true` promises. */
  private swallowing = false
  private interruptTimer: ReturnType<typeof setTimeout> | null = null

  // Running totals. `costReporting: true`, so none of these is ever null.
  private turns = 0
  private inputTokens = 0
  private outputTokens = 0
  private costUsd = 0
  private wallClockMs = 0

  // Live, mid-turn metering: what the open turn has spent so far, folded into
  // the running totals when its `result` lands so nothing is counted twice.
  private liveInputTokens = 0
  private liveOutputTokens = 0
  private turnStartedAtMs = 0
  private readonly meteredMessageIds = new Set<string>()

  constructor(
    private readonly options: SessionOptions,
    private readonly configDir: string | undefined,
    /** Set only by `Driver.resume()`: the engine session to re-open. */
    private readonly resumeFrom?: SessionId,
  ) {
    this.id = resumeFrom ?? nextSessionId()
    this.tier = options.tier ?? DEFAULT_TIER
    this.activeTier = this.tier
    this.hooks = options.hooks
    this.normalizer = createNormalizerState(options.worktree)
    this.events = this.stream
  }

  // -- the caller's surface --------------------------------------------------

  send(text: string, opts?: TurnOptions): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`session is closed: ${this.id}`))
    // A new owner turn ends the quiet period after an interrupt.
    this.swallowing = false
    this.interruptRequested = false
    // Notes taken while no turn was open have nowhere mid-turn to go, so they
    // ride out as this turn's preamble instead.
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
   * `interject: true`. The note is queued into the live streaming input — the
   * same queue `send()` uses — and delivered into the turn that is already
   * running, without waiting for it to end and without counting as an owner
   * turn: `turns` only ever moves on a `turn.end`.
   *
   * With no turn in flight there is nothing to interject *into*, so the note
   * falls back to the next turn's preamble. That is the same route the
   * `interject: false` degradation takes, used here for the one case the
   * capability cannot cover rather than as a substitute for it.
   */
  interject(note: string): Promise<void> {
    if (note.length === 0) return Promise.resolve()
    if (this.turnOpen && this.handle !== null && !this.interruptRequested) {
      this.interjections.push(note)
      this.wakeInput()
    } else {
      this.preamble.push(note)
    }
    return Promise.resolve()
  }

  /**
   * `interrupt: true`. Cancels the in-flight turn through the engine's own
   * control channel, drops everything queued behind it, and leaves the session
   * `idle` and reusable. The turn closes with `turn.end` / `interrupted` — from
   * the engine's `result` if it sends one, synthesized if it does not — and
   * nothing follows it.
   */
  async interrupt(): Promise<void> {
    this.pending.length = 0
    this.interjections.length = 0
    const handle = this.handle
    if (this.closed || handle === null || !this.turnOpen) return
    this.interruptRequested = true
    try {
      await handle.interrupt()
    } catch {
      // An engine that refuses the cancel must not leave interrupt() rejecting.
      // The fallback below is what still closes the turn.
    }
    if (this.closed) return
    this.setStatus('idle')
    this.armInterruptFallback()
  }

  /**
   * Live: answers during a turn, not only between turns. The open turn's tokens
   * come from the engine's `assistant` messages (deduplicated by message id)
   * and its wall clock from this process; its cost stays at the last figure the
   * engine reconciled, because `total_cost_usd` is only quoted on a `result`
   * and rootstock does not price tokens itself.
   */
  usage(): TurnUsage {
    const openMs = this.turnOpen && this.turnStartedAtMs > 0 ? Date.now() - this.turnStartedAtMs : 0
    return {
      inputTokens: this.inputTokens + this.liveInputTokens,
      outputTokens: this.outputTokens + this.liveOutputTokens,
      costUsd: this.costUsd,
      wallClockMs: this.wallClockMs + openMs,
      turns: this.turns + (this.turnOpen ? 1 : 0),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.pending.length = 0
    this.interjections.length = 0
    this.clearInterruptFallback()
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
   * mode where the engine's controls work. Owner turns are yielded one at a
   * time and only while no turn is open, so one send is exactly one turn.
   * Interjections are the deliberate exception: they are yielded *into* an open
   * turn, which is the whole of what `interject: true` buys, and they never
   * open a turn of their own.
   */
  private async *inputs(): AsyncGenerator<{
    type: 'user'
    message: { role: 'user'; content: string }
    parent_tool_use_id: null
  }> {
    for (;;) {
      const next = await this.nextInput()
      if (next === null) return
      if (next.owner) {
        if (next.tier !== this.activeTier) {
          this.activeTier = next.tier
          try {
            await this.handle?.setModel(TIER_MODELS[next.tier])
          } catch {
            // A tier is honored or ignored, never an error (§2.5.3).
          }
        }
        this.turnOpen = true
        this.turnStartedAtMs = Date.now()
      }
      yield { type: 'user', message: { role: 'user', content: next.text }, parent_tool_use_id: null }
    }
  }

  private async nextInput(): Promise<(PendingTurn & { owner: boolean }) | null> {
    for (;;) {
      if (this.closed) return null
      if (this.turnOpen) {
        const note = this.interjections.shift()
        if (note !== undefined) return { text: note, tier: this.activeTier, owner: false }
      } else {
        // The turn a note was meant for ended before the engine came back for
        // input. It becomes the next turn's preamble rather than a stray turn
        // of its own.
        if (this.interjections.length > 0) {
          this.preamble.push(...this.interjections.splice(0, this.interjections.length))
        }
        const next = this.pending.shift()
        if (next !== undefined) return { ...next, owner: true }
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
    this.clearInterruptFallback()
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
    this.adoptSessionId(message)
    this.meterLive(message)
    for (const event of normalizeSdkMessage(message, this.normalizer)) {
      // Everything the engine still has to say about a turn that was
      // interrupted: its spend is kept, its events are not, because
      // `interrupt: true` promises nothing follows the interrupted turn.end.
      if (this.swallowing) {
        if (event.kind === 'turn.end') this.absorbSpend(event.usage)
        continue
      }

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

      if (event.kind === 'error' && this.interruptRequested && event.source === 'agent') {
        // An interrupted turn usually comes back as an execution error. The
        // owner asked for the stop; it is not a failure to report to them.
        continue
      }

      if (event.kind === 'turn.end') {
        this.closeTurn(event.usage, this.interruptRequested ? 'interrupted' : event.stopReason)
        continue
      }

      this.emit(event)
    }
  }

  /**
   * The engine names its own session, and that name is what `resume()` takes
   * back — a locally minted id would not survive the process that minted it.
   * Every message carries it; the `result` is simply the last word.
   */
  private adoptSessionId(message: unknown): void {
    const reported = str(asRecord(message)?.['session_id'])
    if (reported !== undefined && reported.length > 0) this.id = reported
  }

  /**
   * Mid-turn token metering, deduplicated by `message.id`: while a response
   * streams, the engine emits one `assistant` message per content block and
   * several consecutive blocks share an id, so counting every message would
   * multiply the turn's tokens by its block count. Cost is not read here —
   * `usage` on an assistant message carries tokens only, and the authoritative
   * dollars arrive with the turn's `result`.
   */
  private meterLive(message: unknown): void {
    const msg = asRecord(message)
    if (msg === undefined || str(msg['type']) !== 'assistant') return
    const inner = asRecord(msg['message'])
    const id = str(inner?.['id'])
    if (id === undefined || this.meteredMessageIds.has(id)) return
    this.meteredMessageIds.add(id)
    const usage = asRecord(inner?.['usage'])
    this.liveInputTokens +=
      (num(usage?.['input_tokens']) ?? 0) +
      (num(usage?.['cache_creation_input_tokens']) ?? 0) +
      (num(usage?.['cache_read_input_tokens']) ?? 0)
    this.liveOutputTokens += num(usage?.['output_tokens']) ?? 0
  }

  /**
   * The one path that ends a turn, whether the engine's `result` ended it or an
   * unacknowledged interrupt did. Provisional mid-turn counts are dropped in
   * favour of the engine's own figures for the turn, so nothing is counted
   * twice.
   */
  private closeTurn(usage: TurnUsage, stopReason: StopReason): void {
    this.clearInterruptFallback()
    this.accumulate(usage)
    this.turnOpen = false
    this.liveInputTokens = 0
    this.liveOutputTokens = 0
    this.meteredMessageIds.clear()
    // Emitted before turn.end so that turn.end stays the turn's last event.
    this.setStatus(this.pending.length > 0 ? 'working' : 'idle')
    this.emit({ kind: 'turn.end', stopReason, usage })
    if (this.interruptRequested) {
      this.interruptRequested = false
      this.swallowing = true
    }
    this.wakeInput()
  }

  private armInterruptFallback(): void {
    if (this.interruptTimer !== null) return
    const timer = setTimeout(() => {
      this.interruptTimer = null
      if (this.closed || !this.turnOpen) return
      // The engine never acknowledged the cancel. Close the turn ourselves so
      // metering never loses one; 'interrupted' is a StopReason the contract
      // already names.
      this.closeTurn(
        {
          inputTokens: this.liveInputTokens,
          outputTokens: this.liveOutputTokens,
          costUsd: 0,
          wallClockMs: this.turnStartedAtMs > 0 ? Date.now() - this.turnStartedAtMs : 0,
          turns: 1,
        },
        'interrupted',
      )
    }, INTERRUPT_GRACE_MS)
    timer.unref?.()
    this.interruptTimer = timer
  }

  private clearInterruptFallback(): void {
    if (this.interruptTimer === null) return
    clearTimeout(this.interruptTimer)
    this.interruptTimer = null
  }

  private accumulate(usage: TurnUsage): void {
    this.turns += usage.turns
    this.absorbSpend(usage)
  }

  /** Spend without a turn count — what a straggler result contributes. The
   *  wall clock takes the longer of the engine's figure and what this process
   *  observed, so a live `usage()` never appears to go backwards. */
  private absorbSpend(usage: TurnUsage): void {
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    this.costUsd += usage.costUsd ?? 0
    const observed = this.turnOpen && this.turnStartedAtMs > 0 ? Date.now() - this.turnStartedAtMs : 0
    this.wallClockMs += Math.max(usage.wallClockMs, observed)
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
   * Hook feedback takes the interject path, which is what makes `hooks: true`
   * mean what src/types.ts says it means — feedback a hook returns reaches the
   * agent mid-turn. Between turns there is nothing to reach, and interject
   * buffers it for the next one.
   */
  private absorb(returned: void | { feedback: string }): void {
    if (returned === undefined || returned === null) return
    const feedback = str((returned as Rec)['feedback'])
    if (feedback !== undefined && feedback.length > 0) void this.interject(feedback)
  }

  /**
   * Re-built in full for every `query()` call: MCP config, settings flags and
   * extra-directory grants are not restored on resume, so nothing may be
   * assumed to have persisted (§2.5.4). Resume is therefore exactly "the same
   * options, plus `resume`".
   */
  private buildOptions(): Options {
    const tools = this.options.tools ?? []
    return {
      cwd: this.options.worktree,
      ...(this.resumeFrom === undefined ? {} : { resume: this.resumeFrom }),
      model: TIER_MODELS[this.tier],
      // The permissive session class is a decision (§2.5.5, §9): protection is
      // trellis's lint layer plus the deploy gate, not a permission prompt.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // Bare sessions, declared rather than incidental: no CLAUDE.md, no
      // .claude/, no filesystem hooks, no skills (§2.5.5) — and no background
      // subagents, which would let a turn end while its own work was still
      // running. See `DENIED_TOOLS`.
      settingSources: [],
      disallowedTools: [...DENIED_TOOLS],
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
    /**
     * `resume: true`. The engine's session JSONL lives under `CLAUDE_CONFIG_DIR`
     * — the factory's `configDir` — so a session resumes across a process
     * restart and across the workbench sleeping, which is what makes "one
     * session per workspace, resumed across days" real (§2.5.4). Like `start`,
     * this spawns nothing until the first turn.
     */
    resume: (sessionId: SessionId, sessionOpts: SessionOptions): Promise<Session> =>
      Promise.resolve(new ClaudeCodeSession(sessionOpts, opts.configDir, sessionId)),
  }
}
