import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '../__fixtures__/core.js'

vi.doMock('@actions/core', () => core)
const { forgetSecrets, redacted, secret } = await import('../src/secrets.js')

describe('secrets', () => {
  beforeEach(() => {
    forgetSecrets()
  })

  it('masks each secret in the log and takes it out of text', () => {
    secret('sqa_token')
    expect(core.setSecret).toHaveBeenCalledWith('sqa_token')
    expect(redacted('token sqa_token, again sqa_token')).toBe(
      'token ***, again ***'
    )
  })

  it('takes out a secret that holds another whole', () => {
    secret('abc')
    secret('abcdef')
    expect(redacted('abcdef abc')).toBe('*** ***')
  })

  it('ignores an empty secret', () => {
    secret('')
    expect(core.setSecret).not.toHaveBeenCalled()
    expect(redacted('text')).toBe('text')
  })

  it('forgets them between runs', () => {
    secret('abc')
    forgetSecrets()
    expect(redacted('abc')).toBe('abc')
  })
})
