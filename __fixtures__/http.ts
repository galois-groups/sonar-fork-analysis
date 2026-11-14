import { vi } from 'vitest'
import type * as http from '../src/http.js'

export const request = vi.fn<typeof http.request>()

// A server's answer. A body that is neither text nor bytes goes as JSON.
export function answer(
  status = 200,
  body: unknown = '',
  headers: Record<string, string> = {}
): http.Answer {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(text)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: bytes,
    json: () => JSON.parse(bytes.toString()) as unknown
  }
}
