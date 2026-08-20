import { describe, expect, test } from 'bun:test'
import type { AgentEvent, DriverCapabilities, SessionStatus } from './types'
import { UnsupportedError } from './types'

const EVENT_KINDS = [
  'message.delta', 'file.edit', 'file.create', 'file.delete',
  'command.run', 'command.output', 'tool.other', 'status', 'turn.end', 'error',
] as const satisfies readonly AgentEvent['kind'][]

const CAPABILITY_FLAGS = [
  'streamingText', 'fileEvents', 'resume', 'interrupt', 'interject',
  'hooks', 'toolInjection', 'costReporting', 'modelSelection',
] as const satisfies readonly (keyof DriverCapabilities)[]

// Compile-time: adding an 11th kind or a 10th flag without updating these
// lists breaks the assertions below, not just this test at runtime. The
// `satisfies` lists above catch the other direction — a kind or flag REMOVED
// from the contract while still listed here.
type MissingKind = Exclude<AgentEvent['kind'], (typeof EVENT_KINDS)[number]>
type MissingFlag = Exclude<keyof DriverCapabilities, (typeof CAPABILITY_FLAGS)[number]>

// `T extends never` is what makes the check bite: an `Exclude<...>[]` variable
// annotation does not, because `[]` is assignable to every array type.
type Exhaustive<T extends never> = T
export type _NoMissingKind = Exhaustive<MissingKind>
export type _NoMissingFlag = Exhaustive<MissingFlag>

const noMissingKind: MissingKind[] = []
const noMissingFlag: MissingFlag[] = []

describe('the contract', () => {
  test('exactly 10 event kinds', () => {
    expect(EVENT_KINDS.length).toBe(10)
    expect(noMissingKind.length).toBe(0)
  })
  test('exactly 9 capability flags', () => {
    expect(CAPABILITY_FLAGS.length).toBe(9)
    expect(noMissingFlag.length).toBe(0)
  })
  test('exactly 5 session statuses', () => {
    const statuses: SessionStatus[] = ['idle', 'working', 'waiting', 'blocked', 'dead']
    expect(statuses.length).toBe(5)
  })
  test('UnsupportedError is assertable by code', () => {
    const e = new UnsupportedError('resume')
    expect(e.code).toBe('ERR_UNSUPPORTED')
    expect(e.message).toBe('unsupported: resume')
  })
})
