import { describe, it, expect, vi } from 'vitest'
import * as core from '../__fixtures__/core.js'

vi.doMock('@actions/core', () => core)
const { counted, resetWarnings, warn, warnLeftOut, warningCount } =
  await import('../src/warnings.js')

describe('warn', () => {
  it('counts every warning until the run starts again', () => {
    resetWarnings()
    warn('one')
    warn('two')
    expect(warningCount()).toBe(2)
    expect(core.warning).toHaveBeenCalledWith('one')
    resetWarnings()
    expect(warningCount()).toBe(0)
  })
})

describe('counted', () => {
  it('counts each kind, in the order the summary lists them', () => {
    expect(
      counted([
        { kind: 'file', names: ['a'], text: '' },
        { kind: 'setting', names: ['b', 'c'], text: '' },
        { kind: 'entry', key: 'k', entry: 'e', text: '' },
        { kind: 'entry', key: 'k', entry: 'f', text: '' },
        { kind: 'file', names: ['d'], text: '' }
      ])
    ).toBe('2 settings, 2 path entries and 2 files')
    expect(counted([{ kind: 'link', names: ['a'], text: '' }])).toBe('1 link')
    expect(
      counted([
        { kind: 'entry', key: 'k', entry: 'e', text: '' },
        { kind: 'link', names: ['a'], text: '' }
      ])
    ).toBe('1 path entry and 1 link')
  })
})

describe('warnLeftOut', () => {
  it('logs each item with workflow commands stopped, then warns once', () => {
    resetWarnings()
    warnLeftOut(
      [
        { kind: 'file', names: ['a'], text: '::error::a' },
        { kind: 'file', names: ['b'], text: 'Skipped b' }
      ],
      (counts) => `Left out ${counts}.`
    )
    const lines = core.info.mock.calls.map(([line]) => line)
    const resume = /^::stop-commands::(.+)$/.exec(lines[0] ?? '')?.[1] ?? ''
    expect(resume).toMatch(/^[0-9a-f-]{36}$/)
    expect(lines).toEqual([
      `::stop-commands::${resume}`,
      '::error::a',
      'Skipped b',
      `::${resume}::`
    ])
    expect(core.warning.mock.calls).toEqual([['Left out 2 files.']])
    expect(warningCount()).toBe(1)
  })

  it('says nothing when nothing was left out', () => {
    warnLeftOut([], () => 'never')
    expect(core.info).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })
})
