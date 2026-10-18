import assert from 'node:assert/strict'
import { test } from 'node:test'
import { size } from '../src/index.ts'

test('size', async () => {
  assert.equal((await size('package.json')) > 0, true)
})
