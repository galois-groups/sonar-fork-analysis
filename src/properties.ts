// Parses the java.util.Properties format the Sonar plugins write their simulation dump in.
export function parseProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>()
  const lines = text.split(/\r\n|\r|\n/)
  let index = 0
  const next = (): string | undefined =>
    lines[index++]?.replace(/^[ \t\f]+/, '')
  for (let first = next(); first !== undefined; first = next()) {
    if (first === '' || first.startsWith('#') || first.startsWith('!')) continue
    let line = first
    // A line ending in an odd number of backslashes continues on the next one.
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line)) {
      const following = next()
      if (following === undefined) break
      line = line.slice(0, -1) + following
    }
    const [key, value] = splitEntry(line)
    properties.set(unescape(key), unescape(value))
  }
  return properties
}

function splitEntry(line: string): [string, string] {
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '=' || c === ':' || c === ' ' || c === '\t' || c === '\f') break
    i++
  }
  const key = line.slice(0, i)
  let rest = line.slice(i).replace(/^[ \t\f]+/, '')
  if (rest.startsWith('=') || rest.startsWith(':'))
    rest = rest.slice(1).replace(/^[ \t\f]+/, '')
  return [key, rest]
}

const ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' }

function unescape(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped: string) =>
    escaped.length === 5
      ? String.fromCodePoint(Number.parseInt(escaped.slice(1), 16))
      : (ESCAPES[escaped] ?? escaped)
  )
}

// Parses the JSON the npm scanner writes in its simulation mode: the settings are a JSON string inside
// it. Anything but one string per key fails, rather than guessing.
export function parseNpmDump(text: string): Map<string, string> {
  const fail = (reason: string): never => {
    throw new Error(
      `The npm scanner's dump is not in the expected format: ${reason}`
    )
  }
  let outer: unknown
  let inner: unknown
  try {
    outer = JSON.parse(text)
  } catch {
    fail('not JSON')
  }
  const json = (outer as { propertiesJSON?: unknown } | null)?.propertiesJSON
  if (typeof json !== 'string') fail('no propertiesJSON string')
  try {
    inner = JSON.parse(json as string)
  } catch {
    fail('propertiesJSON is not JSON')
  }
  const list = (inner as { scannerProperties?: unknown } | null)
    ?.scannerProperties
  if (!Array.isArray(list)) fail('no scannerProperties list')
  const properties = new Map<string, string>()
  for (const entry of list as unknown[]) {
    const { key, value } = (entry ?? {}) as { key?: unknown; value?: unknown }
    if (typeof key !== 'string' || typeof value !== 'string')
      fail('a setting that is not a key and a string value')
    if (properties.has(key as string)) fail(`${key as string} appears twice`)
    properties.set(key as string, value as string)
  }
  return properties
}
