import { HttpClient } from '@actions/http-client'

// Every request the action makes itself goes through here, on the toolkit's client: it reads the
// runner's proxy from https_proxy and no_proxy, which Node's fetch ignores.

const TIMEOUT = 30_000
const MAX_REDIRECTS = 10
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export type Request = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  // How long the server may stay silent, in milliseconds.
  timeout?: number
}

export type Answer = {
  status: number
  ok: boolean
  headers: Headers
  body: Buffer
  json: () => unknown
}

// Node gives a failed connection to a host with several addresses a code but no message.
function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message || (error as NodeJS.ErrnoException).code || error.name
}

// One request and its whole answer. The client alone would wait for ever on a server that stops in
// the middle of its answer.
async function send(
  target: URL,
  { method = 'GET', headers = {}, body, timeout = TIMEOUT }: Request
): Promise<Answer> {
  try {
    // The redirects are followed below, by stricter rules than the client's.
    const client = new HttpClient('sonar-fork-analysis', undefined, {
      allowRedirects: false,
      socketTimeout: timeout
    })
    const { message } = await client.request(
      method,
      target.href,
      body ?? null,
      headers
    )
    message.setTimeout(timeout, () =>
      message.destroy(new Error('the answer stopped half-way'))
    )
    const chunks: Buffer[] = []
    for await (const chunk of message) chunks.push(chunk as Buffer)
    const received = new Headers()
    for (let i = 0; i + 1 < message.rawHeaders.length; i += 2)
      received.append(
        message.rawHeaders[i] as string,
        message.rawHeaders[i + 1] as string
      )
    const status = message.statusCode as number
    const bytes = Buffer.concat(chunks)
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: received,
      body: bytes,
      json: () => JSON.parse(bytes.toString()) as unknown
    }
  } catch (error) {
    throw new Error(`No answer from ${target.host}: ${reason(error)}`, {
      cause: error
    })
  }
}

// Where a redirect leads, if the action follows it: never from HTTPS to anything else.
function redirected(from: URL, location: string): URL {
  const to = URL.canParse(location, from) ? new URL(location, from) : undefined
  if (
    to?.protocol !== 'https:' &&
    !(to?.protocol === 'http:' && from.protocol === 'http:')
  )
    throw new Error(
      `${from.host} redirected to an address the action doesn't follow`
    )
  return to
}

export async function request(
  url: string,
  { headers, ...rest }: Request = {}
): Promise<Answer> {
  const sent = { ...rest, headers: { ...headers } }
  let target = new URL(url)
  for (let followed = 0; ; followed++) {
    // Each request waits for the redirect before it.
    const answer = await send(target, sent) // NOSONAR
    const location = answer.headers.get('location')
    if (!REDIRECTS.has(answer.status) || location === null) return answer
    if (followed === MAX_REDIRECTS)
      throw new Error(
        `${new URL(url).host} redirected more than ${String(MAX_REDIRECTS)} times`
      )
    const next = redirected(target, location)
    // A token is for the server it was sent to: another host, port or scheme never gets it, nor does
    // any address after that.
    if (next.origin !== target.origin)
      for (const name of Object.keys(sent.headers))
        if (name.toLowerCase() === 'authorization')
          Reflect.deleteProperty(sent.headers, name)
    // The only redirect that asks for another request than the one sent.
    if (answer.status === 303) {
      sent.method = 'GET'
      delete sent.body
    }
    target = next
  }
}
