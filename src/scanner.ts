import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { createHash } from 'node:crypto'
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

const VERSION = '8.2.0.6438'

type Build = { suffix: string; sha256: string }

// Builds with their own Java runtime, so the analysis needs no Java on the runner.
const BUNDLED: Record<string, Build> = {
  'linux-x64': {
    suffix: '-linux-x64',
    sha256: '83257bf97a475d626b8ba2b214aeeb37334ca84db1b3e3be5105783e4facb053'
  },
  'linux-arm64': {
    suffix: '-linux-aarch64',
    sha256: '3add94b481f1d541897b8d667f4c0e86bc7855bd3eaeb1a7c9ee5f162b909e6e'
  },
  'darwin-x64': {
    suffix: '-macosx-x64',
    sha256: '6205a8add7d58fdc0a56c62fa0c8a2c52777b1bae38112b9b98ff4fc7bb9df8b'
  },
  'darwin-arm64': {
    suffix: '-macosx-aarch64',
    sha256: '72164dd87ddfe176f35859d1eed38011dd0ce9655b89243b8d3ae9b816390e29'
  },
  'win32-x64': {
    suffix: '-windows-x64',
    sha256: '897ff904608a5ec07dbff509bd1224800d524acf5559058f1c7ea85744779173'
  }
}

// Everywhere else: the plain build, which runs on the Java found on the runner.
const PLAIN: Build = {
  suffix: '',
  sha256: '2f1f412ad4c36d23266371367e13214fea03add397fb789bbb3282fdc9fb1372'
}

export function scannerBuild(platform: string, arch: string): Build {
  return BUNDLED[`${platform}-${arch}`] ?? PLAIN
}

// Where the zip is kept between runs, which self-hosted runners keep. Other jobs may have put anything
// there: it's checked on every use, and nothing runs from it.
export function keptZip(name: string): string {
  return join(
    process.env.RUNNER_TOOL_CACHE ?? tmpdir(),
    'sonar-fork-analysis',
    VERSION,
    `${name}.zip`
  )
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
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

// The zip's bytes, checked against the pinned digest: the kept copy if it matches, else a download.
export async function scannerZip(
  name: string,
  sha256: string
): Promise<Buffer> {
  const kept = keptZip(name)
  const bytes = readKept(kept)
  if (bytes && digest(bytes) === sha256) return bytes
  const download = await tc.downloadTool(
    `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/${name}.zip`
  )
  const downloaded = readFileSync(download)
  rmSync(download, { force: true })
  const actual = digest(downloaded)
  if (actual !== sha256) {
    throw new Error(
      `The downloaded scanner has SHA-256 ${actual}, expected ${sha256}`
    )
  }
  keep(kept, downloaded)
  return downloaded
}

export async function installScanner(
  platform: string = process.platform,
  arch: string = process.arch
): Promise<string> {
  const build = scannerBuild(platform, arch)
  if (build === PLAIN) {
    core.info(
      `No scanner with a bundled Java runtime for ${platform}-${arch}, using the Java on the runner`
    )
  }
  const bytes = await scannerZip(
    `sonar-scanner-cli-${VERSION}${build.suffix}`,
    build.sha256
  )
  return unpackScanner(bytes, build.suffix, platform)
}

// The bytes just checked, unpacked where only this job writes; gives the script to run.
export async function unpackScanner(
  bytes: Buffer,
  suffix: string,
  platform: string
): Promise<string> {
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-scanner-')
  )
  // PowerShell 5.1, which extracts on some Windows runners, refuses a file without the extension.
  const zip = join(directory, `sonar-scanner-cli-${VERSION}${suffix}.zip`)
  writeFileSync(zip, bytes)
  const extracted = await tc.extractZip(zip, join(directory, 'scanner'))
  const script = platform === 'win32' ? 'sonar-scanner.bat' : 'sonar-scanner'
  return join(extracted, `sonar-scanner-${VERSION}${suffix}`, 'bin', script)
}
