import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../__fixtures__/exec.js'
import { answer, request } from '../__fixtures__/http.js'

vi.doMock('@actions/exec', () => ({ exec }))
vi.doMock('../src/http.js', () => ({ request }))

const {
  OFFLINE_PROXY,
  TESTED_LANGUAGES,
  definitions,
  scannerServer,
  serverLanguages,
  untestedLanguages
} = await import('../src/languages.js')

afterEach(() => {
  request.mockReset()
  exec.mockReset()
  vi.useRealTimers()
})

describe('definitions', () => {
  it('reads every form the scanner takes, in order', () => {
    expect(
      definitions([
        '-Da=1',
        '-D',
        'b=2',
        '--define',
        'c=x=y',
        '-X',
        'd=4',
        '-De',
        '-D'
      ])
    ).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', 'x=y']
    ])
  })
})

describe('scannerServer', () => {
  const options = { cwd: '/run', env: { PATH: '/bin' } }
  const dump = (): string =>
    join(mkdtempSync(join(tmpdir(), 'server-')), 'server.properties')

  it('reads the server from what the scanner writes in simulation mode', async () => {
    const file = dump()
    exec.mockImplementation(async () => {
      writeFileSync(
        file,
        'env.SONAR_TOKEN=secret\nsonar.host.url=https\\://sonarqube.us/\n'
      )
      return 0
    })

    // The analysis runs with the same arguments afterwards.
    const args = Object.freeze(['-Dsonar.region=us'])

    expect(await scannerServer('/bin/sonar-scanner', args, options, file)).toBe(
      'https://sonarqube.us'
    )
    expect(exec).toHaveBeenCalledWith(
      '/bin/sonar-scanner',
      [
        '-Dsonar.region=us',
        ...OFFLINE_PROXY,
        `-Dsonar.scanner.internal.dumpToFile=${file}`
      ],
      expect.objectContaining({ ...options, ignoreReturnCode: true })
    )
    expect(existsSync(file)).toBe(false)
  })

  it("stops with the scanner's errors when it fails", async () => {
    const file = dump()
    exec.mockImplementation(async (_tool, _args, execOptions) => {
      writeFileSync(file, 'sonar.host.url=https://sonarcloud.io\n')
      execOptions?.listeners?.stdout?.(
        Buffer.from("00:00:00.000 ERROR Invalid region 'xx'.\n")
      )
      return 1
    })

    await expect(
      scannerServer('/bin/sonar-scanner', [], options, file)
    ).rejects.toMatchObject({
      message:
        'The Sonar scanner failed with exit code 1 when asked which server it uses',
      lines: ["00:00:00.000 ERROR Invalid region 'xx'."]
    })
    expect(existsSync(file)).toBe(false)
  })

  it('stops when the scanner names no server', async () => {
    exec.mockResolvedValue(0)

    await expect(
      scannerServer('/bin/sonar-scanner', [], options, dump())
    ).rejects.toThrow(
      "The Sonar scanner didn't name its server in simulation mode"
    )
  })
})

describe('serverLanguages', () => {
  it('lists the language keys, asking with the token', async () => {
    request.mockResolvedValue(
      answer(200, { languages: [{ key: 'java' }, { key: 'py' }] })
    )

    expect(await serverLanguages('https://sonar', 'token')).toEqual([
      'java',
      'py'
    ])
    expect(request).toHaveBeenCalledWith(
      'https://sonar/api/languages/list?ps=0',
      { headers: { Authorization: 'Bearer token' } }
    )
  })

  it('refuses at once when the server turns it down', async () => {
    request.mockResolvedValue(answer(401, {}))

    await expect(serverLanguages('https://sonar', 'token')).rejects.toThrow(
      "Could not get the server's languages: https://sonar answered 401"
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('names the reason a request failed', async () => {
    vi.useFakeTimers()
    request.mockRejectedValue(
      new Error('unable to verify the first certificate')
    )

    const failure = serverLanguages('https://sonar', 'token').catch(
      (error: unknown) => error
    )
    await vi.runAllTimersAsync()

    expect(await failure).toEqual(
      new Error(
        "Could not get the server's languages: unable to verify the first certificate"
      )
    )
  })

  it('refuses a host that is no URL without asking', async () => {
    await expect(serverLanguages('sonar example', 'token')).rejects.toThrow(
      "Could not get the server's languages: sonar example is not a URL"
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses an answer that is not JSON', async () => {
    request.mockResolvedValue(answer(200, '<html>Log in</html>'))

    await expect(serverLanguages('https://sonar', 'token')).rejects.toThrow(
      "Could not get the server's languages: https://sonar answered something other than JSON"
    )
  })

  it('tries again when the server fails', async () => {
    vi.useFakeTimers()
    request
      .mockResolvedValueOnce(answer(503, {}))
      .mockResolvedValueOnce(answer(200, { languages: [{ key: 'java' }] }))

    const languages = serverLanguages('https://sonar', 'token')
    await vi.runAllTimersAsync()

    expect(await languages).toEqual(['java'])
  })

  it.each([
    { languages: [] },
    {},
    { languages: [{ key: 'py' }, { key: 'x.y' }] },
    { languages: [{ key: 'py=1' }] },
    { languages: [{ key: 7 }] },
    { languages: [null] },
    { languages: 'java' },
    null
  ])('refuses an answer it cannot trust: %j', async (body) => {
    request.mockResolvedValue(answer(200, body))

    await expect(serverLanguages('https://sonar', 'token')).rejects.toThrow(
      "Could not get the server's languages"
    )
  })
})

describe('untestedLanguages', () => {
  it('keeps every language but the tested ones', () => {
    expect(
      untestedLanguages(['java', 'py', 'ts', 'rust', 'secrets', 'go'])
    ).toEqual(['py', 'rust', 'go'])
    expect(untestedLanguages(TESTED_LANGUAGES)).toEqual([])
  })
})
