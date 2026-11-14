import { vi } from 'vitest'
import type * as http from '../src/http.js'

export const request = vi.fn<typeof http.request>()

// A server's answer. A body that is not text goes as JSON.
export function answer(
  status = 200,
  body: unknown = '',
  headers: Record<string, string> = {}
): http.Answer {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: () => JSON.parse(text) as unknown
  }
}
