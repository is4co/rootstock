import { expect, test } from 'bun:test'
import { UnsupportedError } from './index'

test('the contract is reachable from the entry point', () => {
  expect(new UnsupportedError('resume').code).toBe('ERR_UNSUPPORTED')
})
