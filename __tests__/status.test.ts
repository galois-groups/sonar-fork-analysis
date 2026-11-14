import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'
import { answer, request } from '../__fixtures__/http.js'

vi.doMock('@actions/core', () => core)
vi.doMock('../src/http.js', () => ({ request }))

const { reportInterrupted, statusReporter, trackedReporter } =
  await import('../src/status.js')

const target = {
  apiUrl: 'https://api.github.com',
  repository: 'owner/repo',
  sha: 'head-sha',
  token: 'gh-token',
  name: 'Sonar fork analysis (acme_app)',
  url: 'https://github.com/owner/repo/actions/runs/42'
}
const saved = { ...process.env }

beforeEach(() => {
  request.mockReset()
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function sent(call = 0): Record<string, string> {
  return JSON.parse(String(request.mock.calls[call][1]!.body))
}

describe('statusReporter', () => {
  it('posts the state on the analysed commit, linking to the run', async () => {
    request.mockResolvedValue(answer(201, '{}'))

    await statusReporter(target)('success', 'Analysed')

    const [url, init] = request.mock.calls[0]
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/statuses/head-sha'
    )
    expect(init!.method).toBe('POST')
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer gh-token' })
    expect(sent()).toEqual({
      state: 'success',
      description: 'Analysed',
      context: 'Sonar fork analysis (acme_app)',
      target_url: 'https://github.com/owner/repo/actions/runs/42'
    })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('keeps descriptions within what GitHub accepts', async () => {
    request.mockResolvedValue(answer(201, '{}'))

    await statusReporter(target)('failure', 'x'.repeat(200))

    expect(sent().description).toHaveLength(140)
  })

  it('stops quietly when the token may not post statuses', async () => {
    request.mockResolvedValue(answer(403, '{}'))
    const report = statusReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(request).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('lacks statuses: write')
    )
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('keeps posting through a rate limit, which also answers 403', async () => {
    request
      .mockResolvedValueOnce(answer(403, '', { 'retry-after': '60' }))
      .mockResolvedValueOnce(answer(201, '{}'))
    const report = statusReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(request).toHaveBeenCalledTimes(2)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GitHub answered 403')
    )
  })

  it('warns, without failing, when GitHub cannot take the status', async () => {
    request
      .mockResolvedValueOnce(answer(502))
      .mockRejectedValueOnce(new Error('network down'))
    const report = statusReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GitHub answered 502')
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('network down')
    )
  })
})

describe('trackedReporter', () => {
  function note(call = -1): Record<string, string> | '' {
    const value = core.saveState.mock.calls.at(call)![1] as string
    return value && JSON.parse(value)
  }

  it('leaves the post step a failure while the analysis runs, and nothing once it ended', async () => {
    request.mockImplementation(async () => answer(201, '{}'))
    const report = trackedReporter(target)

    await report('pending', 'Analysing')
    expect(note()).toEqual({
      state: 'failure',
      description: 'The analysis ended without reporting its result'
    })
    expect(JSON.stringify(note())).not.toContain('gh-token')

    await report('success', 'Analysed')
    expect(note()).toBe('')
  })

  it('leaves the refused final status for the post step to retry', async () => {
    request
      .mockResolvedValueOnce(answer(201, '{}'))
      .mockResolvedValueOnce(answer(502))
    const report = trackedReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(note()).toMatchObject({ state: 'success', description: 'Analysed' })
  })

  it('leaves nothing once a pending status was refused', async () => {
    request
      .mockResolvedValueOnce(answer(502))
      .mockResolvedValueOnce(answer(502))
    const report = trackedReporter(target)

    await report('pending', 'Analysing')
    expect(note()).toBe('')
    await report('success', 'Analysed')

    // The final status was still tried, but there is no pending one to close.
    expect(request).toHaveBeenCalledTimes(2)
    expect(note()).toBe('')
  })

  it('leaves nothing when no status could be opened', async () => {
    request.mockResolvedValue(answer(403, '{}'))
    const report = trackedReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(request).toHaveBeenCalledTimes(1)
    expect(note()).toBe('')
  })
})

describe('the post step', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'post-'))
    const event = join(directory, 'event.json')
    writeFileSync(
      event,
      JSON.stringify({ workflow_run: { head_sha: 'head-sha' } })
    )
    Object.assign(process.env, {
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_EVENT_PATH: event,
      GITHUB_API_URL: 'https://api.github.com',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '42'
    })
    core.getInput.mockImplementation((name) =>
      name === 'project-key' ? 'acme_app' : 'input-token'
    )
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('posts the state the note says where the runner says, with the token from the inputs', async () => {
    request.mockResolvedValue(answer(201, '{}'))
    core.getState.mockReturnValue(
      JSON.stringify({
        state: 'success',
        description: 'Analysed',
        // Where to post never comes from the note.
        sha: '../../actions/runs/1/rerun',
        name: 'Faked',
        url: 'https://attacker.example'
      })
    )

    await reportInterrupted()

    expect(request.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/owner/repo/statuses/head-sha'
    )
    expect(sent()).toMatchObject({
      state: 'success',
      description: 'Analysed',
      context: 'Sonar fork analysis (acme_app)',
      target_url: 'https://github.com/owner/repo/actions/runs/42'
    })
    expect(request.mock.calls[0][1]!.headers).toMatchObject({
      Authorization: 'Bearer input-token'
    })
  })

  it.each([
    JSON.stringify({ state: 'pending', description: 'Analysing' }),
    JSON.stringify({ state: 'success' }),
    'null',
    '{ not json'
  ])('posts nothing for a damaged note: %s', async (note) => {
    core.getState.mockReturnValue(note)

    await reportInterrupted()

    expect(request).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(
      'Not posting the final status: its note is damaged'
    )
  })

  it('does nothing without a note', async () => {
    core.getState.mockReturnValue('')

    await reportInterrupted()

    expect(request).not.toHaveBeenCalled()
  })
})
