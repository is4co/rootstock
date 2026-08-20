import { expect, test } from 'bun:test'
import { ROOTSTOCK } from './index'

test('package identity', () => {
  expect(ROOTSTOCK).toBe('@is4co/rootstock')
})
