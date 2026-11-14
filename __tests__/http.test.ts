import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach
} from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
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

// Answers with what it was asked, or refuses.
const target = createServer((asked, answer) => {
  let body = ''
  asked.on('data', (chunk: Buffer) => (body += chunk.toString()))
  asked.on('end', () => {
    answer.writeHead(asked.url === '/refused' ? 403 : 201, {
      'retry-after': '60'
    })
    answer.end(
      JSON.stringify({
        method: asked.method,
        authorization: asked.headers.authorization,
        agent: asked.headers['user-agent'],
        body
      })
    )
  })
})
let port: number

beforeAll(async () => {
  port = await listening(target)
})

afterAll(async () => {
  await closed(target)
})

describe('request', () => {
  it('sends the request and reads the answer', async () => {
    const answer = await request(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: '{"state":"success"}'
    })

    expect(answer.status).toBe(201)
    expect(answer.ok).toBe(true)
    expect(answer.headers.get('retry-after')).toBe('60')
    expect(answer.json()).toEqual({
      method: 'POST',
      authorization: 'Bearer token',
      // On GitHub's runners the toolkit's client adds the run's id.
      agent: expect.stringMatching(/^sonar-fork-analysis(?: |$)/),
      body: '{"state":"success"}'
    })
  })

  it('gives a refusal as an answer, not an error', async () => {
    const answer = await request(`http://127.0.0.1:${port}/refused`)

    expect(answer.status).toBe(403)
    expect(answer.ok).toBe(false)
    expect(answer.json()).toMatchObject({ method: 'GET', body: '' })
  })
})

describe('behind a proxy', () => {
  // Tunnels every request to the target and notes the host the request named.
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

  it.each(['http_proxy', 'HTTP_PROXY'])(
    'sends requests through the proxy in %s',
    async (name) => {
      process.env[name] = `http://127.0.0.1:${proxyPort}`

      const answer = await request('http://sonar.example/api', {
        headers: { Authorization: 'Bearer token' }
      })

      expect(answer.json()).toMatchObject({ authorization: 'Bearer token' })
      expect(tunnelled).toEqual(['sonar.example:80'])
    }
  )

  it('sends HTTPS requests through the proxy in https_proxy', async () => {
    process.env.https_proxy = `http://127.0.0.1:${proxyPort}`

    // The target speaks no TLS, so the request fails once it is through the proxy.
    await expect(request('https://sonar.example/api')).rejects.toThrow()

    expect(tunnelled).toEqual(['sonar.example:443'])
  })

  it('keeps this machine off the proxy', async () => {
    process.env.http_proxy = `http://127.0.0.1:${proxyPort}`

    expect((await request(`http://127.0.0.1:${port}/`)).status).toBe(201)
    expect(tunnelled).toEqual([])
  })
})
