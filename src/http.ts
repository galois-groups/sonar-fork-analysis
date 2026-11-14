import { HttpClient } from '@actions/http-client'

export type Request = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export type Answer = {
  status: number
  ok: boolean
  headers: Headers
  json: () => unknown
}

// On the toolkit's client: it reads the runner's proxy settings (https_proxy, no_proxy), which
// Node's fetch ignores.
export async function request(
  url: string,
  { method = 'GET', headers, body }: Request = {}
): Promise<Answer> {
  // One client per request: a client reuses its first agent, so one that began with HTTP fails on
  // HTTPS.
  const client = new HttpClient('sonar-fork-analysis')
  const answer = await client.request(method, url, body ?? null, headers)
  const text = await answer.readBody()
  const { rawHeaders, statusCode } = answer.message
  const received = new Headers()
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    received.append(rawHeaders[i] as string, rawHeaders[i + 1] as string)
  const status = statusCode as number
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: received,
    json: () => JSON.parse(text) as unknown
  }
}
