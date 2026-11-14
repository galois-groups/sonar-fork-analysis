import { describe, it, expect, vi, afterEach } from 'vitest'
import { answer, request } from '../__fixtures__/http.js'

vi.doMock('../src/http.js', () => ({ request }))

const {
  TESTED_LANGUAGES,
  definitions,
  languagesHost,
  serverLanguages,
  untestedLanguages
} = await import('../src/languages.js')

afterEach(() => {
  request.mockReset()
  vi.useRealTimers()
  delete process.env.SONAR_HOST_URL
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

describe('languagesHost', () => {
  it('asks the server the scanner talks to', () => {
    expect(languagesHost('', [])).toBe('https://sonarcloud.io')
    expect(languagesHost('', ['-Dsonar.region=us'])).toBe(
      'https://sonarqube.us'
    )
    process.env.SONAR_HOST_URL = 'https://env.example.com/'
    expect(languagesHost('', [])).toBe('https://env.example.com')
    expect(languagesHost('https://input.example.com', [])).toBe(
      'https://input.example.com'
    )
    // The scanner takes the last value it reads for a key.
    expect(
      languagesHost('https://input.example.com', [
        '-Dsonar.host.url=https://first.example.com',
        '-D',
        'sonar.host.url=https://last.example.com//'
      ])
    ).toBe('https://last.example.com')
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
      new Error('No answer from sonar: unable to verify the first certificate')
    )

    const failure = serverLanguages('https://sonar', 'token').catch(
      (error: unknown) => error
    )
    await vi.runAllTimersAsync()

    expect(await failure).toEqual(
      new Error(
        "Could not get the server's languages: No answer from sonar: unable to verify the first certificate"
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
