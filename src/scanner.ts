import * as core from '@actions/core'
import { HttpClient } from '@actions/http-client'
import * as tc from '@actions/tool-cache'
import type { PublicKey } from 'openpgp'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  SONARSOURCE_KEY,
  checkSignature,
  keyServers,
  mergeKeys,
  message,
  readSigningKey
} from './signature.js'
import { warn } from './warnings.js'

// The version that runs unless the workflow names another, and every version the checks run against.
export const DEFAULT_VERSION = '8.3.0.16463'
export const TESTED_VERSIONS = [
  '8.0.1.6346',
  '8.1.0.6389',
  '8.2.0.6438',
  DEFAULT_VERSION
]

const DOWNLOADS =
  'https://binaries.sonarsource.com/Distribution/sonar-scanner-cli'

// Builds with their own Java runtime, so the analysis needs no Java on the runner.
const BUNDLED: Record<string, string> = {
  'linux-x64': '-linux-x64',
  'linux-arm64': '-linux-aarch64',
  'darwin-x64': '-macosx-x64',
  'darwin-arm64': '-macosx-aarch64',
  'win32-x64': '-windows-x64'
}

// Everywhere else the plain build, which runs on the Java found on the runner.
export function scannerSuffix(platform: string, arch: string): string {
  return BUNDLED[`${platform}-${arch}`] ?? ''
}

// The version to run. It goes into URLs and paths, so only digits and dots get through.
export function scannerVersion(input: string): string {
  if (!input) return DEFAULT_VERSION
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(input))
    throw new Error(
      `scanner-version must be a full scanner CLI version, such as ${DEFAULT_VERSION}`
    )
  return input
}

// Where the zip is kept between runs, which self-hosted runners keep. Other jobs may have put anything
// there: it's checked on every use, and nothing runs from it.
export function keptZip(version: string, name: string): string {
  return join(
    process.env.RUNNER_TOOL_CACHE ?? tmpdir(),
    'sonar-fork-analysis',
    version,
    `${name}.zip`
  )
}

// Only a plain file of a sane size: reading a link to /dev/zero would never end.
function readKept(path: string): Buffer | undefined {
  try {
    const stats = lstatSync(path)
    return stats.isFile() && stats.size < 512 * 1024 * 1024
      ? readFileSync(path)
      : undefined
  } catch {
    // Missing, or under a file.
    return undefined
  }
}

function keep(path: string, bytes: Buffer): void {
  // A name of its own, written only if nothing is there: wx refuses any entry, links included.
  const part = `${path}.${String(process.pid)}.part`
  let written = false
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(part, bytes, { flag: 'wx' })
    written = true
    renameSync(part, path)
  } catch (error) {
    core.debug(`Not keeping the scanner in ${dirname(path)}: ${String(error)}`)
    if (written) rmSync(part, { force: true })
  }
}

async function download(url: string): Promise<Buffer> {
  let file: string
  try {
    file = await tc.downloadTool(url)
  } catch (error) {
    if (error instanceof tc.HTTPError && error.httpStatusCode === 404)
      throw new Error(
        `${url} doesn't exist. Check that scanner-version names a released scanner CLI.`,
        { cause: error }
      )
    throw new Error(`Could not download ${url}: ${message(error)}`, {
      cause: error
    })
  }
  try {
    return readFileSync(file)
  } finally {
    rmSync(file, { force: true })
  }
}

// No retries and a short timeout: the other key server is the fallback. A stalled one would hold up
// every run.
const keyClient = new HttpClient('sonar-fork-analysis', undefined, {
  socketTimeout: 30_000
})

async function keyCopy(url: string, fingerprint: string): Promise<PublicKey> {
  const response = await keyClient.get(url)
  const body = await response.readBody()
  if (response.message.statusCode !== 200)
    throw new Error(`HTTP ${String(response.message.statusCode)}`)
  return readSigningKey(body, fingerprint)
}

// The key from every key server that answers with it.
export async function signingKey(
  fingerprint: string = SONARSOURCE_KEY
): Promise<PublicKey> {
  const copies: PublicKey[] = []
  const failures: string[] = []
  await Promise.all(
    keyServers(fingerprint).map(async (url) => {
      try {
        copies.push(await keyCopy(url, fingerprint))
      } catch (error) {
        failures.push(`${url}: ${message(error)}`)
      }
    })
  )
  const [first, second] = copies
  if (!first)
    throw new Error(
      `Could not get SonarSource's key to check the scanner's signature. ${failures.join('; ')}`
    )
  for (const failure of failures)
    core.debug(`A key server didn't help: ${failure}`)
  return mergeKeys(first, second)
}

async function signed(
  bytes: Buffer,
  signature: string,
  key: PublicKey,
  name: string
): Promise<boolean> {
  try {
    await checkSignature(bytes, signature, key, name)
    return true
  } catch {
    return false
  }
}

// The zip's bytes, checked against SonarSource's signature: the kept copy if it passes, else a download.
export async function scannerZip(
  version: string,
  name: string,
  fingerprint: string = SONARSOURCE_KEY
): Promise<Buffer> {
  const [key, signature] = await Promise.all([
    signingKey(fingerprint),
    download(`${DOWNLOADS}/${name}.zip.asc`).then(String)
  ])
  const kept = keptZip(version, name)
  const bytes = readKept(kept)
  if (bytes && (await signed(bytes, signature, key, name))) return bytes
  const downloaded = await download(`${DOWNLOADS}/${name}.zip`)
  await checkSignature(downloaded, signature, key, name)
  keep(kept, downloaded)
  return downloaded
}

export async function installScanner(
  version: string = DEFAULT_VERSION,
  platform: string = process.platform,
  arch: string = process.arch
): Promise<string> {
  if (!TESTED_VERSIONS.includes(version))
    warn(
      `sonar-scanner-cli ${version} isn't one this action is tested with (${TESTED_VERSIONS.join(', ')}). Its signature is checked, but not how it reads the analysis settings or what it starts.`
    )
  const suffix = scannerSuffix(platform, arch)
  if (!suffix) {
    core.info(
      `No scanner with a bundled Java runtime for ${platform}-${arch}, using the Java on the runner`
    )
  }
  const bytes = await scannerZip(
    version,
    `sonar-scanner-cli-${version}${suffix}`
  )
  return unpackScanner(bytes, version, suffix, platform)
}

// The bytes just checked, unpacked where only this job writes; gives the script to run.
export async function unpackScanner(
  bytes: Buffer,
  version: string,
  suffix: string,
  platform: string
): Promise<string> {
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-scanner-')
  )
  // PowerShell 5.1, which extracts on some Windows runners, refuses a file without the extension.
  const zip = join(directory, `sonar-scanner-cli-${version}${suffix}.zip`)
  writeFileSync(zip, bytes)
  const extracted = await tc.extractZip(zip, join(directory, 'scanner'))
  const script = platform === 'win32' ? 'sonar-scanner.bat' : 'sonar-scanner'
  return join(extracted, `sonar-scanner-${version}${suffix}`, 'bin', script)
}
