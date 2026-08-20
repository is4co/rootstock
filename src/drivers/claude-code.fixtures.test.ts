// Fixture tests for the claude-code driver: no network, no key, no engine.
// They grade the half of the driver that is a pure function — the normalizer —
// against hand-written SDK message shapes, plus the parts of the driver surface
// that can be observed without spending a token.
//
// Two properties matter most here and are asserted over the whole corpus rather
// than case by case: every emitted event is one of the ten kinds, and no
// emitted object carries an SDK-native field. A driver that leaks an engine
// shape has broken the seam rootstock exists to hold.

import { describe, expect, test } from 'bun:test'

import { getDriver, registerDriver } from '../registry'
import type { AgentEvent } from '../types'
import type { NormalizerState } from './claude-code'
import { createClaudeCodeDriver, createNormalizerState, normalizeSdkMessage } from './claude-code'

const WORKTREE = '/tmp/rootstock-fixture-worktree'

// The ten kinds, mirrored from src/types.ts so a kind removed from the contract
// shows up here as a compile error rather than as a silently weaker test.
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

/**
 * Envelope fields the SDK puts on its own messages. None of them may appear
 * anywhere in an AgentEvent — not on the event, not nested in a payload.
 */
const SDK_NATIVE_FIELDS = [
  'parent_tool_use_id',
  'session_id',
  'uuid',
  'tool_use_id',
  'is_error',
  'total_cost_usd',
  'duration_ms',
  'duration_api_ms',
  'num_turns',
  'modelUsage',
  'permission_denials',
  'api_error_status',
  'input_tokens',
  'output_tokens',
  'stop_reason',
]

function nativeFieldIn(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = nativeFieldIn(entry, `${path}[${String(index)}]`)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  for (const [key, nested] of Object.entries(value)) {
    if (SDK_NATIVE_FIELDS.includes(key)) return `${path}.${key}`
    const found = nativeFieldIn(nested, `${path}.${key}`)
    if (found !== null) return found
  }
  return null
}

// --- fixtures --------------------------------------------------------------

function streamEvent(text: string): unknown {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: 'uuid-delta',
    session_id: 'sdk-session',
  }
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'tool_use', id, name, input }],
      stop_reason: null,
    },
    parent_tool_use_id: null,
    uuid: `uuid-${id}`,
    session_id: 'sdk-session',
  }
}

function toolResult(id: string, content: unknown, isError = false): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    session_id: 'sdk-session',
  }
}

/**
 * Seeds the normalizer's line index the way a real session does: Claude Code
 * requires a `Read` before it will `Edit`, and that result carries absolute
 * line numbers as `<n>\t<text>`. Going through the public normalizer rather
 * than reaching into the state keeps these tests honest about how the index is
 * actually populated in a live run.
 */
function seededByRead(path: string, content: string): NormalizerState {
  const state = createNormalizerState(WORKTREE)
  normalizeSdkMessage(assistantToolUse('seed', 'Read', { file_path: path }), state)
  const numbered = content
    .split('\n')
    .map((line, index) => `${String(index + 1)}\t${line}`)
    .join('\n')
  normalizeSdkMessage(toolResult('seed', numbered), state)
  return state
}

function result(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 7,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'uuid-result',
    session_id: 'sdk-session',
    ...overrides,
  }
}

// --- the mapping table -----------------------------------------------------

describe('normalizeSdkMessage', () => {
  test('stream_event text_delta becomes message.delta', () => {
    expect(normalizeSdkMessage(streamEvent('Hel'))).toEqual([{ kind: 'message.delta', text: 'Hel' }])
    expect(normalizeSdkMessage(streamEvent('lo'))).toEqual([{ kind: 'message.delta', text: 'lo' }])
  })

  test('stream events that are not text deltas produce nothing', () => {
    const notText = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a"' } },
    }
    expect(normalizeSdkMessage(notText)).toEqual([])
    expect(normalizeSdkMessage({ type: 'stream_event', event: { type: 'message_stop' } })).toEqual([])
  })

  test('assistant text blocks are not re-emitted — that text already arrived as deltas', () => {
    const message = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stop_reason: null },
    }
    expect(normalizeSdkMessage(message)).toEqual([])
  })

  test('Write becomes file.create carrying the full content', () => {
    const events = normalizeSdkMessage(
      assistantToolUse('t1', 'Write', { file_path: `${WORKTREE}/a.ts`, content: 'export const a = 1\n' }),
    )
    expect(events).toEqual([{ kind: 'file.create', path: `${WORKTREE}/a.ts`, after: 'export const a = 1\n' }])
  })

  test('Edit becomes file.edit carrying the pre-edit span its after replaces', () => {
    const path = `${WORKTREE}/a.ts`
    const state = seededByRead(path, 'const a = 1\nconst b = 2\nconst c = 3\n')
    const events = normalizeSdkMessage(
      assistantToolUse('t2', 'Edit', { file_path: path, old_string: 'const b = 2', new_string: 'const b = 22' }),
      state,
    )
    expect(events).toEqual([
      { kind: 'file.edit', path, after: 'const b = 22', before: 'const b = 2', range: { startLine: 2, endLine: 2 } },
    ])
  })

  test('a multi-line Edit reports an inclusive pre-edit span', () => {
    const path = `${WORKTREE}/a.ts`
    const state = seededByRead(path, 'one\ntwo\nthree\nfour\n')
    const events = normalizeSdkMessage(
      assistantToolUse('t2b', 'Edit', { file_path: path, old_string: 'two\nthree', new_string: 'merged' }),
      state,
    )
    expect(events).toEqual([
      { kind: 'file.edit', path, after: 'merged', before: 'two\nthree', range: { startLine: 2, endLine: 3 } },
    ])
  })

  test('an Edit the driver cannot locate degrades to tool.other, never a range-less file.edit', () => {
    const path = `${WORKTREE}/never-read.ts`
    const input = { file_path: path, old_string: 'a', new_string: 'b' }
    const events = normalizeSdkMessage(assistantToolUse('t2c', 'Edit', input), createNormalizerState(WORKTREE))
    expect(events.filter((event) => event.kind === 'file.edit')).toEqual([])
    expect(events).toEqual([{ kind: 'tool.other', name: 'Edit', payload: input }])
  })

  test('an ambiguous Edit span degrades rather than guessing which occurrence moved', () => {
    const path = `${WORKTREE}/dup.ts`
    const state = seededByRead(path, 'dup\ndup\n')
    const events = normalizeSdkMessage(
      assistantToolUse('t2d', 'Edit', { file_path: path, old_string: 'dup', new_string: 'x' }),
      state,
    )
    expect(events.map((event) => event.kind)).toEqual(['tool.other'])
  })

  test('Write seeds the index, so a later Edit on that path carries a range', () => {
    const path = `${WORKTREE}/new.ts`
    const state = createNormalizerState(WORKTREE)
    normalizeSdkMessage(assistantToolUse('w1', 'Write', { file_path: path, content: 'x\ny\nz\n' }), state)
    const events = normalizeSdkMessage(
      assistantToolUse('w2', 'Edit', { file_path: path, old_string: 'y', new_string: 'yy' }),
      state,
    )
    expect(events).toEqual([
      { kind: 'file.edit', path, after: 'yy', before: 'y', range: { startLine: 2, endLine: 2 } },
    ])
  })

  test('a windowed Read still yields real line numbers', () => {
    const path = `${WORKTREE}/big.ts`
    const state = createNormalizerState(WORKTREE)
    normalizeSdkMessage(assistantToolUse('r1', 'Read', { file_path: path }), state)
    // The engine showed only lines 500-502 out of a large file.
    normalizeSdkMessage(toolResult('r1', '   500\tfoo\n   501\tbar\n   502\tbaz'), state)
    const events = normalizeSdkMessage(
      assistantToolUse('r2', 'Edit', { file_path: path, old_string: 'bar', new_string: 'BAR' }),
      state,
    )
    expect(events).toEqual([
      { kind: 'file.edit', path, after: 'BAR', before: 'bar', range: { startLine: 501, endLine: 501 } },
    ])
  })

  // Both tests below fail against a driver that replaces the whole index on
  // every Read — the bug that was actually fixed. The second additionally fails
  // against a driver that keeps the old content and ignores the window, by
  // asking for a span that straddles the retained prefix and the updated
  // window line. A merge that drops either half cannot satisfy it.
  test('a windowed Read does not discard content the driver already knew', () => {
    const path = `${WORKTREE}/big.ts`
    const state = createNormalizerState(WORKTREE)
    normalizeSdkMessage(assistantToolUse('r1', 'Read', { file_path: path }), state)
    normalizeSdkMessage(toolResult('r1', '1\tone\n2\ttwo\n3\tthree'), state)
    // A second, windowed read showing only line 3 must not forget lines 1-2.
    normalizeSdkMessage(assistantToolUse('r2', 'Read', { file_path: path }), state)
    normalizeSdkMessage(toolResult('r2', '   3\tthree-changed'), state)

    const events = normalizeSdkMessage(
      assistantToolUse('r3', 'Edit', { file_path: path, old_string: 'one', new_string: 'ONE' }),
      state,
    )
    expect(events).toEqual([
      { kind: 'file.edit', path, after: 'ONE', before: 'one', range: { startLine: 1, endLine: 1 } },
    ])
  })

  test('a windowed Read updates the lines it shows without forgetting the ones it does not', () => {
    const path = `${WORKTREE}/big.ts`
    const state = createNormalizerState(WORKTREE)
    normalizeSdkMessage(assistantToolUse('r1', 'Read', { file_path: path }), state)
    normalizeSdkMessage(toolResult('r1', '1\tone\n2\ttwo\n3\tthree'), state)
    // A window showing only line 3, changed since the full read.
    normalizeSdkMessage(assistantToolUse('r2', 'Read', { file_path: path }), state)
    normalizeSdkMessage(toolResult('r2', '   3\tthree-changed'), state)

    // The span straddles the retained prefix (line 2, known only from the first
    // read) and the updated window line (line 3, known only from the second).
    // Replacing the index loses `two`; ignoring the window loses
    // `three-changed`. Only a real merge can locate this.
    const events = normalizeSdkMessage(
      assistantToolUse('r3', 'Edit', {
        file_path: path,
        old_string: 'two\nthree-changed',
        new_string: 'merged',
      }),
      state,
    )
    expect(events).toEqual([
      {
        kind: 'file.edit',
        path,
        after: 'merged',
        before: 'two\nthree-changed',
        range: { startLine: 2, endLine: 3 },
      },
    ])
  })

  test('MultiEdit ranges account for the shift each earlier sub-edit causes', () => {
    const path = `${WORKTREE}/a.ts`
    // The first sub-edit turns one line into three, so the second sub-edit's
    // line moves from 3 to 5. A range ignoring the shift would still say 3.
    const state = seededByRead(path, 'alpha\nbeta\ngamma\n')
    const events = normalizeSdkMessage(
      assistantToolUse('t3', 'MultiEdit', {
        file_path: path,
        edits: [
          { old_string: 'alpha', new_string: 'alpha\nalpha2\nalpha3' },
          { old_string: 'gamma', new_string: 'gamma-edited' },
        ],
      }),
      state,
    )
    expect(events).toEqual([
      {
        kind: 'file.edit',
        path,
        after: 'alpha\nalpha2\nalpha3',
        before: 'alpha',
        range: { startLine: 1, endLine: 1 },
      },
      { kind: 'file.edit', path, after: 'gamma-edited', before: 'gamma', range: { startLine: 5, endLine: 5 } },
    ])
  })

  test('NotebookEdit degrades to tool.other — one cell of a JSON notebook has no line span', () => {
    const input = { notebook_path: `${WORKTREE}/n.ipynb`, old_source: 'print(1)', new_source: 'print(2)' }
    const events = normalizeSdkMessage(assistantToolUse('t4', 'NotebookEdit', input))
    expect(events).toEqual([{ kind: 'tool.other', name: 'NotebookEdit', payload: input }])
  })

  test('Bash becomes command.run', () => {
    const events = normalizeSdkMessage(assistantToolUse('t5', 'Bash', { command: 'bun test' }))
    expect(events).toEqual([{ kind: 'command.run', command: 'bun test' }])
  })

  test('a Bash tool_result becomes command.output, correlated by tool_use id', () => {
    const state = createNormalizerState(WORKTREE)
    normalizeSdkMessage(assistantToolUse('t6', 'Bash', { command: 'bun test' }), state)
    expect(normalizeSdkMessage(toolResult('t6', '30 pass, 0 fail'), state)).toEqual([
      { kind: 'command.output', output: '30 pass, 0 fail', stream: 'stdout' },
    ])
  })

  test('a failed Bash tool_result is command.output on stderr', () => {
    const state = createNormalizerState(WORKTREE)
    normalizeSdkMessage(assistantToolUse('t7', 'Bash', { command: 'exit 1' }), state)
    expect(normalizeSdkMessage(toolResult('t7', 'boom', true), state)).toEqual([
      { kind: 'command.output', output: 'boom', stream: 'stderr' },
    ])
  })

  test('without correlation state, a tool_result stays opaque rather than being dropped', () => {
    expect(normalizeSdkMessage(toolResult('t8', 'orphaned'))).toEqual([
      { kind: 'tool.other', name: 'unknown', payload: { result: 'orphaned' } },
    ])
  })

  describe('file.delete is inferred from Bash rm, best-effort only', () => {
    test('a plain rm of paths inside the worktree also emits file.delete', () => {
      const state = createNormalizerState(WORKTREE)
      const events = normalizeSdkMessage(
        assistantToolUse('t9', 'Bash', { command: `rm -f ${WORKTREE}/a.ts ${WORKTREE}/b.ts` }),
        state,
      )
      expect(events).toEqual([
        { kind: 'command.run', command: `rm -f ${WORKTREE}/a.ts ${WORKTREE}/b.ts` },
        { kind: 'file.delete', path: `${WORKTREE}/a.ts` },
        { kind: 'file.delete', path: `${WORKTREE}/b.ts` },
      ])
    })

    test('a relative rm resolves against the worktree', () => {
      const state = createNormalizerState(WORKTREE)
      const events = normalizeSdkMessage(assistantToolUse('t10', 'Bash', { command: 'rm src/a.ts' }), state)
      expect(events).toEqual([
        { kind: 'command.run', command: 'rm src/a.ts' },
        { kind: 'file.delete', path: 'src/a.ts' },
      ])
    })

    test.each([
      ['a glob', 'rm -rf src/*.ts'],
      ['a pipe', 'rm a.ts | tee log'],
      ['a second command', 'rm a.ts && echo done'],
      ['a variable', 'rm $TARGET'],
      ['an unrecognised flag', 'rm --recursive a.ts'],
      ['a path outside the worktree', 'rm /etc/passwd'],
      ['an escape above the worktree', 'rm ../../secret'],
    ])('%s stays command.run alone', (_label, command) => {
      const state = createNormalizerState(WORKTREE)
      expect(normalizeSdkMessage(assistantToolUse('t11', 'Bash', { command }), state)).toEqual([
        { kind: 'command.run', command },
      ])
    })

    test('a command that is not rm at all is untouched', () => {
      const state = createNormalizerState(WORKTREE)
      expect(normalizeSdkMessage(assistantToolUse('t12', 'Bash', { command: 'git rm a.ts' }), state)).toEqual([
        { kind: 'command.run', command: 'git rm a.ts' },
      ])
    })
  })

  test.each([['Read'], ['Grep'], ['Glob'], ['WebFetch'], ['Task']])(
    '%s is carried as tool.other rather than dropped',
    (name) => {
      const events = normalizeSdkMessage(assistantToolUse('t13', name, { pattern: 'x' }))
      expect(events).toEqual([{ kind: 'tool.other', name, payload: { pattern: 'x' } }])
    },
  )

  test('an injected tool loses its MCP prefix, and its result is carried too', () => {
    const state = createNormalizerState(WORKTREE)
    const call = normalizeSdkMessage(
      assistantToolUse('t14', 'mcp__rootstock__conformance-probe', { probe: true }),
      state,
    )
    expect(call).toEqual([{ kind: 'tool.other', name: 'conformance-probe', payload: { probe: true } }])
    expect(normalizeSdkMessage(toolResult('t14', [{ type: 'text', text: 'conformance-probe-ok' }]), state)).toEqual([
      { kind: 'tool.other', name: 'conformance-probe', payload: { result: 'conformance-probe-ok' } },
    ])
  })

  test('a known tool whose input is malformed degrades to tool.other, never to silence', () => {
    expect(normalizeSdkMessage(assistantToolUse('t15', 'Write', { file_path: '/a.ts' }))).toEqual([
      { kind: 'tool.other', name: 'Write', payload: { file_path: '/a.ts' } },
    ])
  })

  test('system messages become status', () => {
    expect(normalizeSdkMessage({ type: 'system', subtype: 'init', session_id: 's' })).toEqual([
      { kind: 'status', status: 'working' },
    ])
    expect(normalizeSdkMessage({ type: 'system', subtype: 'session_state_changed', state: 'running' })).toEqual([
      { kind: 'status', status: 'working' },
    ])
    expect(normalizeSdkMessage({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' })).toEqual([
      { kind: 'status', status: 'waiting' },
    ])
    expect(normalizeSdkMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })).toEqual([
      { kind: 'status', status: 'idle' },
    ])
  })

  test('result becomes turn.end carrying real usage', () => {
    const events = normalizeSdkMessage(result())
    expect(events).toEqual([
      {
        kind: 'turn.end',
        stopReason: 'completed',
        // input_tokens + both cache counters: they were all really billed.
        usage: { inputTokens: 112, outputTokens: 40, costUsd: 0.0123, wallClockMs: 1234, turns: 1 },
      },
    ])
  })

  test('cost is a per-turn delta, because the engine reports the total cumulatively', () => {
    const state = createNormalizerState(WORKTREE)
    const first = normalizeSdkMessage(result({ total_cost_usd: 0.01 }), state)[0]
    const second = normalizeSdkMessage(result({ total_cost_usd: 0.03 }), state)[0]
    expect(first).toMatchObject({ kind: 'turn.end', usage: { costUsd: 0.01 } })
    expect(second).toMatchObject({ kind: 'turn.end', usage: { costUsd: expect.closeTo(0.02, 10) } })
  })

  test('an engine-reported stop reason survives as-is', () => {
    expect(normalizeSdkMessage(result({ stop_reason: 'max_tokens' }))[0]).toMatchObject({ stopReason: 'max_tokens' })
  })

  test('a failed result is an agent error followed by turn.end', () => {
    const events = normalizeSdkMessage(
      result({ subtype: 'error_during_execution', is_error: true, errors: ['the agent gave up'] }),
    )
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      kind: 'error',
      source: 'agent',
      message: 'the agent gave up',
      detail: { reason: 'error_during_execution', errors: ['the agent gave up'] },
    })
    expect(events[1]).toMatchObject({ kind: 'turn.end', stopReason: 'error' })
  })

  test('a budget stop is reported as budget, not as a generic error', () => {
    const events = normalizeSdkMessage(result({ subtype: 'error_max_budget_usd', is_error: true }))
    expect(events[1]).toMatchObject({ kind: 'turn.end', stopReason: 'budget' })
  })

  test('turn.end is the last event of a turn, so nothing trails an interrupted turn', () => {
    for (const subtype of ['success', 'error_during_execution', 'error_max_budget_usd']) {
      const events = normalizeSdkMessage(result({ subtype, is_error: subtype !== 'success' }))
      expect(events.at(-1)?.kind).toBe('turn.end')
      expect(events.filter((event) => event.kind === 'turn.end')).toHaveLength(1)
    }
  })

  test('unrecognised input is ignored rather than throwing', () => {
    for (const value of [null, undefined, 42, 'text', [], {}, { type: 'nonsense' }]) {
      expect(normalizeSdkMessage(value)).toEqual([])
    }
  })

  test('it is pure: the same message normalizes identically against fresh state', () => {
    const message = assistantToolUse('t16', 'Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' })
    expect(normalizeSdkMessage(message, createNormalizerState(WORKTREE))).toEqual(
      normalizeSdkMessage(message, createNormalizerState(WORKTREE)),
    )
  })
})

// --- corpus-wide properties ------------------------------------------------

describe('the normalized corpus', () => {
  /** Every row of the mapping table, replayed through one shared state. */
  function corpus(): AgentEvent[] {
    const state = createNormalizerState(WORKTREE)
    const messages: unknown[] = [
      { type: 'system', subtype: 'init', session_id: 'sdk-session', uuid: 'u' },
      streamEvent('Hel'),
      streamEvent('lo'),
      assistantToolUse('c1', 'Write', { file_path: `${WORKTREE}/a.ts`, content: 'a' }),
      assistantToolUse('c2', 'Edit', { file_path: `${WORKTREE}/a.ts`, old_string: 'a', new_string: 'b' }),
      assistantToolUse('c3', 'MultiEdit', {
        file_path: `${WORKTREE}/a.ts`,
        edits: [{ old_string: 'b', new_string: 'c' }],
      }),
      assistantToolUse('c4', 'NotebookEdit', {
        notebook_path: `${WORKTREE}/n.ipynb`,
        old_source: 'x',
        new_source: 'y',
      }),
      assistantToolUse('c5', 'Bash', { command: 'bun test' }),
      toolResult('c5', '30 pass'),
      assistantToolUse('c6', 'Bash', { command: `rm -f ${WORKTREE}/a.ts` }),
      assistantToolUse('c7', 'Read', { file_path: `${WORKTREE}/a.ts` }),
      toolResult('c7', [{ type: 'text', text: 'contents' }]),
      { type: 'system', subtype: 'session_state_changed', state: 'requires_action', session_id: 's' },
      result({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }),
      result(),
    ]
    return messages.flatMap((message) => normalizeSdkMessage(message, state))
  }

  test('covers every one of the ten kinds', () => {
    const seen = new Set(corpus().map((event) => event.kind))
    expect([...EVENT_KINDS].filter((kind) => !seen.has(kind))).toEqual([])
  })

  test('emits nothing outside the ten-kind union', () => {
    const kinds: readonly string[] = EVENT_KINDS
    expect(corpus().filter((event) => !kinds.includes(event.kind))).toEqual([])
  })

  test('leaks no SDK-native field, at any depth', () => {
    for (const event of corpus()) {
      const leak = nativeFieldIn(event)
      expect(leak === null ? null : `${event.kind}: ${leak}`).toBeNull()
    }
  })

  test('error events only ever carry the two declared sources', () => {
    for (const event of corpus()) {
      if (event.kind === 'error') expect(['agent', 'engine']).toContain(event.source)
    }
  })
})

// --- the driver surface, without an engine ---------------------------------

describe('createClaudeCodeDriver', () => {
  test('is registered under the id trellis selects it by', () => {
    const driver = createClaudeCodeDriver()
    expect(driver.id).toBe('claude-code')
    registerDriver(driver)
    // getDriver() hands back the driver behind the registry's budget guard, so
    // the identity to assert on is the id and the declarations, not the object.
    const looked = getDriver('claude-code')
    expect(looked.id).toBe('claude-code')
    expect(looked.capabilities).toBe(driver.capabilities)
    expect(looked.models()).toEqual(driver.models())
    expect(getDriver('claude-code')).toBe(looked)
    expect(() => { registerDriver(driver) }).toThrow(/driver already registered: claude-code/)
  })

  test('declares all nine — the full capability set of §2.5.4', () => {
    expect(createClaudeCodeDriver().capabilities).toEqual({
      streamingText: true,
      fileEvents: true,
      resume: true,
      interrupt: true,
      interject: true,
      hooks: true,
      toolInjection: true,
      costReporting: true,
      modelSelection: true,
    })
  })

  test('offers three tiers, named and never versioned', () => {
    const tiers = createClaudeCodeDriver().models()
    expect(tiers).toEqual([
      { tier: 'fast', label: 'Haiku' },
      { tier: 'balanced', label: 'Sonnet' },
      { tier: 'deep', label: 'Opus' },
    ])
    for (const tier of tiers) expect(tier.label).not.toMatch(/\d/)
  })

  test('models() hands back copies, so a caller cannot mutate the driver', () => {
    const driver = createClaudeCodeDriver()
    const first = driver.models()
    const label = first[0]?.label
    if (first[0] !== undefined) first[0].label = 'mutated'
    expect(driver.models()[0]?.label).toBe(label)
  })

  test('resume hands back the same logical session, and spawns no engine to do it', async () => {
    const driver = createClaudeCodeDriver()
    // Declared resume: true. The id is the engine's own session id, so a
    // resumed session must carry it back unchanged — the conformance suite
    // grades exactly that, and trellis stores it across a workbench sleep.
    const session = await driver.resume('engine-session-abc', { worktree: WORKTREE })
    expect(session.id).toBe('engine-session-abc')
    expect(session.status()).toBe('idle')
    expect(session.usage().turns).toBe(0)
    await session.close()
  })

  test('a session that never sends starts idle, closes clean, and spawns no engine', async () => {
    // Sessions are lazy: opening one costs nothing until the first turn. The
    // conformance suite's modelSelection scenario relies on exactly this.
    const driver = createClaudeCodeDriver()
    const session = await driver.start({ worktree: WORKTREE, tier: 'deep' })
    expect(session.id).toMatch(/^claude-code-/)
    expect(session.status()).toBe('idle')
    expect(session.usage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallClockMs: 0,
      turns: 0,
    })

    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const event of session.events) seen.push(event)
    })()

    await session.close()
    await session.close() // close is idempotent
    await drained // and the iterable completes
    expect(session.status()).toBe('dead')
    expect(seen).toEqual([{ kind: 'status', status: 'dead' }])
  })

  test('a tier in SessionOptions is accepted on every tier, never an error', async () => {
    const driver = createClaudeCodeDriver()
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      const session = await driver.start({ worktree: WORKTREE, tier })
      await session.close()
    }
  })

  test('interject and interrupt resolve with no turn in flight, and start no engine', async () => {
    const driver = createClaudeCodeDriver()
    const session = await driver.start({ worktree: WORKTREE })
    // Nothing is running: there is nothing to interject into and nothing to
    // cancel. Both still resolve, neither spawns a runtime, and neither counts
    // as a turn — interjection is feedback, never an owner turn.
    await expect(session.interject('a note')).resolves.toBeUndefined()
    await expect(session.interrupt()).resolves.toBeUndefined()
    expect(session.usage().turns).toBe(0)
    expect(session.status()).toBe('idle')
    await session.close()
  })

  test('sending on a closed session rejects rather than silently queueing', async () => {
    const driver = createClaudeCodeDriver()
    const session = await driver.start({ worktree: WORKTREE })
    await session.close()
    await expect(session.send('hello')).rejects.toThrow(/closed/)
  })
})
