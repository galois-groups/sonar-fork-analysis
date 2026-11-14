import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi
} from 'vitest'
import { HttpClient } from '@actions/http-client'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { request } from '../src/http.js'

function listening(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function closed(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })
}

// Answers with what it was asked.
function echo(asked: IncomingMessage, answer: ServerResponse): void {
  let body = ''
  asked.on('data', (chunk: Buffer) => (body += chunk.toString()))
  asked.on('end', () => {
    answer.writeHead(201, { 'retry-after': '60' })
    answer.end(
      JSON.stringify({
        method: asked.method,
        authorization: asked.headers.authorization,
        agent: asked.headers['user-agent'],
        body
      })
    )
  })
}

// Two servers on one host: another port is another origin.
let port: number
let otherPort: number
const redirects: Partial<Record<string, () => [number, string?]>> = {
  '/moved': () => [302, '/'],
  '/kept': () => [307, '/'],
  '/see-other': () => [303, '/'],
  '/elsewhere': () => [307, `http://127.0.0.1:${otherPort}/`],
  '/there-and-back': () => [302, `http://127.0.0.1:${otherPort}/back`],
  '/loop': () => [302, '/loop'],
  '/files': () => [302, 'ftp://files.example/scanner.zip'],
  '/nowhere': () => [302, 'http://['],
  '/unchanged': () => [304],
  '/refused': () => [403]
}
const target = createServer((asked, answer) => {
  if (asked.url === '/silent') return
  if (asked.url === '/half') {
    answer.writeHead(200, { 'content-length': '10' })
    answer.write('half')
    return
  }
  const [status, location] = redirects[asked.url ?? '']?.() ?? []
  if (status === undefined) {
    echo(asked, answer)
    return
  }
  asked.resume()
  answer.writeHead(status, location === undefined ? {} : { location })
  answer.end()
})
const other = createServer((asked, answer) => {
  if (asked.url !== '/back') {
    echo(asked, answer)
    return
  }
  answer.writeHead(302, { location: `http://127.0.0.1:${port}/` })
  answer.end()
})

beforeAll(async () => {
  port = await listening(target)
  otherPort = await listening(other)
})

afterAll(async () => {
  await closed(target)
  await closed(other)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const here = (path: string): string => `http://127.0.0.1:${port}${path}`
const token = { Authorization: 'Bearer token' }

describe('request', () => {
  it('sends the request and reads the whole answer', async () => {
    const answer = await request(here('/'), {
      method: 'POST',
      headers: token,
      body: '{"state":"success"}'
    })

    expect(answer.status).toBe(201)
    expect(answer.ok).toBe(true)
    expect(answer.headers.get('retry-after')).toBe('60')
    expect(answer.json()).toEqual({
      method: 'POST',
      authorization: 'Bearer token',
      agent: 'sonar-fork-analysis',
      body: '{"state":"success"}'
    })
    expect(JSON.parse(answer.body.toString())).toEqual(answer.json())
  })

  it.each([
    ['a refusal', '/refused', 403],
    ['a redirect to nowhere', '/unchanged', 304]
  ])('gives %s as an answer, not an error', async (_, path, status) => {
    const answer = await request(here(path))

    expect(answer.status).toBe(status)
    expect(answer.ok).toBe(false)
    expect(answer.body).toHaveLength(0)
  })

  it.each([
    ['/silent', 'Request timeout: /silent'],
    ['/half', 'the answer stopped half-way']
  ])('gives up on a server that stops answering: %s', async (path, why) => {
    await expect(request(here(path), { timeout: 200 })).rejects.toThrow(
      `No answer from 127.0.0.1:${port}: ${why}`
    )
  })

  it('names the server that refused the connection', async () => {
    const gone = createServer()
    const free = await listening(gone)
    await closed(gone)

    await expect(request(`http://127.0.0.1:${free}/`)).rejects.toThrow(
      new RegExp(`^No answer from 127\\.0\\.0\\.1:${free}: .*ECONNREFUSED`)
    )
  })

  it.each([
    ["the error's message", new Error('socket hang up'), 'socket hang up'],
    [
      'the code of an error without a message',
      Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }),
      'ECONNREFUSED'
    ],
    [
      'the name of an error with neither',
      new AggregateError([], ''),
      'AggregateError'
    ],
    ['anything else thrown', 'offline', 'offline']
  ])('says why no answer came: %s', async (_, thrown, why) => {
    vi.spyOn(HttpClient.prototype, 'request').mockRejectedValue(thrown)

    await expect(request('https://sonar.example/api')).rejects.toThrow(
      `No answer from sonar.example: ${why}`
    )
  })
})

describe('redirects', () => {
  it.each(['/moved', '/kept'])(
    'follows %s on the same server with the token and the request as sent',
    async (path) => {
      const answer = await request(here(path), {
        method: 'POST',
        headers: token,
        body: 'sent'
      })

      expect(answer.json()).toMatchObject({
        method: 'POST',
        authorization: 'Bearer token',
        body: 'sent'
      })
    }
  )

  it('asks again without a body when the server says to see another address', async () => {
    const answer = await request(here('/see-other'), {
      method: 'POST',
      headers: token,
      body: 'sent'
    })

    expect(answer.json()).toMatchObject({
      method: 'GET',
      authorization: 'Bearer token',
      body: ''
    })
  })

  it.each([
    ['another port', '/elsewhere', 'POST'],
    ['another port and back', '/there-and-back', 'GET']
  ])('keeps the token from %s', async (_, path, method) => {
    const answer = await request(here(path), {
      method: method as 'GET' | 'POST',
      // However the caller spells it.
      headers: { authorization: 'Bearer token', Accept: 'application/json' }
    })

    expect(answer.status).toBe(201)
    expect(answer.json()).toMatchObject({ method })
    expect(answer.json()).not.toHaveProperty('authorization')
  })

  it('gives up on a server that redirects in circles', async () => {
    await expect(request(here('/loop'))).rejects.toThrow(
      `127.0.0.1:${port} redirected more than 10 times`
    )
  })

  it.each(['/files', '/nowhere'])(
    'follows no redirect to an address it can not ask: %s',
    async (path) => {
      await expect(request(here(path))).rejects.toThrow(
        `127.0.0.1:${port} redirected to an address the action doesn't follow`
      )
    }
  )

  it('follows no redirect from HTTPS to HTTP', async () => {
    // A server with a certificate, played by the client itself.
    const asked = vi
      .spyOn(HttpClient.prototype, 'request')
      .mockImplementation(async () => {
        const message = Object.assign(Readable.from([]), {
          statusCode: 302,
          rawHeaders: ['Location', 'http://sonar.example/api'],
          setTimeout: () => message
        })
        return { message } as never
      })

    await expect(
      request('https://sonar.example/api', { headers: token })
    ).rejects.toThrow(
      "sonar.example redirected to an address the action doesn't follow"
    )
    expect(asked).toHaveBeenCalledTimes(1)
  })
})

describe('behind a proxy', () => {
  // Tunnels every request to the target, whatever host it names, and notes that host.
  const proxy = createServer()
  const tunnelled: string[] = []
  proxy.on('connect', (asked, socket) => {
    tunnelled.push(asked.url ?? '')
    const upstream = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  })
  let proxyPort: number
  const saved = { ...process.env }

  beforeAll(async () => {
    proxyPort = await listening(proxy)
  })

  afterAll(async () => {
    await closed(proxy)
  })

  beforeEach(() => {
    tunnelled.length = 0
    // Without the proxy of the machine the tests run on.
    process.env = Object.fromEntries(
      Object.entries(saved).filter(
        ([name]) => !/^(?:https?|no)_proxy$/i.test(name)
      )
    )
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it.each([
    ['http_proxy', (at: number) => `http://127.0.0.1:${at}`],
    ['HTTP_PROXY', (at: number) => `http://127.0.0.1:${at}`],
    ['http_proxy', (at: number) => `127.0.0.1:${at}`]
  ])('sends requests through the proxy in %s', async (name, address) => {
    process.env[name] = address(proxyPort)

    const answer = await request('http://sonar.example/api', {
      headers: token
    })

    expect(answer.json()).toMatchObject({ authorization: 'Bearer token' })
    expect(tunnelled).toEqual(['sonar.example:80'])
  })

  it('keeps this machine off the proxy', async () => {
    process.env.http_proxy = `http://127.0.0.1:${proxyPort}`

    expect((await request(here('/'))).status).toBe(201)
    expect(tunnelled).toEqual([])
  })
})
