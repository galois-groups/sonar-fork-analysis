import { exec } from '@actions/exec'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { request, type Answer } from './http.js'
import { parseProperties } from './properties.js'
import { retry } from './retry.js'
import { ErrorLines, ToolFailure } from './tool-errors.js'

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
  'groovy',
  'r',
  'gosu',
  'dataweave',
  'postgres',
  'abap',
  'cobol',
  'jcl',
  'pli',
  'rpg',
  'plsql',
  'tsql',
  'vb',
  'flex',
  'text',
  'secrets'
]

// No file of a checkout can match it. The engine matches it against each file's path from the base
// directory, which never holds an empty segment like //. Were the slashes collapsed, it would still
// name a file in .git, which no commit can hold and the action never unpacks into. A language given
// only this pattern detects no file, so the engine never loads its analyzer. It must not be empty: the
// engine then uses the language's own suffixes. A file: pattern would work too, but the engine warns
// that those are deprecated.
export const NO_FILE = '.git//sonar-fork-analysis/never'

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

// A CLI that ignored simulation mode would analyse with every language on. Through a proxy that refuses
// connections, it fails at its first request instead. The proxy doesn't change the server it names.
export const OFFLINE_PROXY = [
  '-Dsonar.scanner.proxyHost=127.0.0.1',
  '-Dsonar.scanner.proxyPort=9'
]

// The server the scanner will talk to, so the languages are the ones it detects files against. The
// scanner reads it from many places, even its JSON parameters and SONAR_SCANNER_OPTS, so the action
// asks the scanner itself. In simulation mode it writes the settings it resolved and stops before it
// contacts a server. That file lists the whole environment, so it never stays.
export async function scannerServer(
  scanner: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
  dump: string
): Promise<string> {
  const errors = new ErrorLines('scanner')
  try {
    const exitCode = await exec(
      scanner,
      [
        ...args,
        ...OFFLINE_PROXY,
        `-Dsonar.scanner.internal.dumpToFile=${dump}`
      ],
      {
        ...options,
        ignoreReturnCode: true,
        listeners: { stdout: errors.stdout, stderr: errors.stderr }
      }
    )
    if (exitCode !== 0)
      throw new ToolFailure(
        `The Sonar scanner failed with exit code ${exitCode} when asked which server it uses`,
        errors.end()
      )
    let host = existsSync(dump)
      ? parseProperties(readFileSync(dump, 'utf8')).get('sonar.host.url')
      : undefined
    if (!host)
      throw new Error(
        "The Sonar scanner didn't name its server in simulation mode, so the action can't tell which languages to turn off"
      )
    while (host.endsWith('/')) host = host.slice(0, -1)
    return host
  } finally {
    rmSync(dump, { force: true })
  }
}

const failure = (reason: string): Error =>
  new Error(`Could not get the server's languages: ${reason}`)

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
  let response: Answer
  try {
    response = await retry(async () => {
      const answer = await request(url, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (answer.status >= 500)
        throw new Error(`${host} answered ${answer.status}`)
      return answer
    })
  } catch (error) {
    throw failure((error as Error).message)
  }
  if (!response.ok) throw failure(`${host} answered ${response.status}`)
  let body: unknown
  try {
    body = response.json()
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
