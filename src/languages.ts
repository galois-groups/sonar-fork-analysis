import { retry } from './retry.js'

// The languages whose analyzers the fixtures run under traps on both paths. iac finds some of them by
// content in YAML and JSON files, whatever their patterns: Kubernetes, GitHub Actions, CloudFormation,
// Ansible, Azure Pipelines and ARM templates. The text and secrets scanners read whatever is indexed.
export const TESTED_LANGUAGES = [
  'java',
  'kotlin',
  'js',
  'ts',
  'css',
  'web',
  'xml',
  'yaml',
  'json',
  'docker',
  'kubernetes',
  'githubactions',
  'cloudformation',
  'ansible',
  'azurepipelines',
  'azureresourcemanager',
  'terraform',
  'shell',
  'powershell',
  'text',
  'secrets'
]

// No file of a checkout can match it: /dev/null has no children. A language given only this pattern
// detects no file, so the engine never loads its analyzer. It must not be empty: the engine then uses
// the language's own suffixes.
export const NO_FILE = 'file:/dev/null/never'

// The settings build-arguments define, in order. The scanner takes -Dkey=value, and -D or --define
// with key=value as the next argument.
export function definitions(buildArguments: string[]): [string, string][] {
  const defined: [string, string][] = []
  let separate = false
  for (const arg of buildArguments) {
    let definition: string | undefined
    if (separate) definition = arg
    else if (arg.startsWith('-D') && arg !== '-D') definition = arg.slice(2)
    separate = arg === '-D' || arg === '--define'
    if (definition === undefined) continue
    const equals = definition.indexOf('=')
    if (equals > 0)
      defined.push([definition.slice(0, equals), definition.slice(equals + 1)])
  }
  return defined
}

// The server the scanner will talk to, so the languages are the ones it detects files against.
export function languagesHost(
  hostUrl: string,
  buildArguments: string[]
): string {
  const defined = definitions(buildArguments)
  const argument = (key: string): string | undefined =>
    defined.findLast(([name]) => name === key)?.[1]
  let host =
    argument('sonar.host.url') ||
    hostUrl ||
    process.env.SONAR_HOST_URL ||
    (argument('sonar.region') === 'us'
      ? 'https://sonarqube.us'
      : 'https://sonarcloud.io')
  while (host.endsWith('/')) host = host.slice(0, -1)
  return host
}

const failure = (reason: string): Error =>
  new Error(`Could not get the server's languages: ${reason}`)

// Node's errors keep the reason a request failed, such as a certificate it can't verify, in cause.
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.cause instanceof Error)
    return `${error.message} (${error.cause.message})`
  return error.message
}

export async function serverLanguages(
  host: string,
  token: string
): Promise<string[]> {
  let url: string
  try {
    url = new URL(`${host}/api/languages/list?ps=0`).href
  } catch {
    throw failure(`${host} is not a URL`)
  }
  let response: Response
  try {
    response = await retry(async () => {
      const answer = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (answer.status >= 500)
        throw new Error(`${host} answered ${answer.status}`)
      return answer
    })
  } catch (error) {
    throw failure(reasonOf(error))
  }
  if (!response.ok) throw failure(`${host} answered ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw failure(`${host} answered something other than JSON`)
  }
  const { languages } = (body ?? {}) as { languages?: unknown }
  const keys = Array.isArray(languages)
    ? languages.map((language) => (language as { key?: unknown } | null)?.key)
    : []
  // Each key becomes part of a setting's name.
  if (
    keys.length === 0 ||
    !keys.every(
      (key): key is string => typeof key === 'string' && /^\w+$/.test(key)
    )
  )
    throw failure(`${host} listed none, or a name that is not a plain word`)
  return keys
}

export function untestedLanguages(languages: string[]): string[] {
  return languages.filter((language) => !TESTED_LANGUAGES.includes(language))
}
