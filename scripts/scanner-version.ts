// Fails when Sonar has released a newer scanner CLI than the action's default, or a newer patch of
// another tested version, which nothing else would notice. With --update, checks the newest release's
// signature and makes it the default, keeping the old default among the tested versions.
//
// Usage: node scripts/scanner-version.ts [--update]

import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = 'src/scanner.ts'
const DOWNLOADS =
  'https://binaries.sonarsource.com/Distribution/sonar-scanner-cli'

async function fetched(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response
}

// Every release on Maven Central. Not its <release>, the version published last, which can be a patch
// of an old line: 5.0.2 came out after 7.1.0.
async function releases(): Promise<string[]> {
  const metadata = await (
    await fetched(
      'https://repo1.maven.org/maven2/org/sonarsource/scanner/cli/sonar-scanner-cli/maven-metadata.xml'
    )
  ).text()
  // Download names need all four parts.
  const versions = [
    ...metadata.matchAll(/<version>(\d+\.\d+\.\d+\.\d+)<\/version>/g)
  ].map(([, version]) => version as string)
  if (versions.length === 0)
    throw new Error('No scanner CLI release found on Maven Central')
  return versions
}

// Compares the numbers in a version as numbers: 8.10 comes after 8.9. Below zero when a is older.
const { compare } = new Intl.Collator('en', { numeric: true })

const newest = (start: string, versions: string[]): string =>
  versions.reduce((a, b) => (compare(a, b) >= 0 ? a : b), start)

const sameLine = (a: string, b: string): boolean =>
  a.split('.').slice(0, 2).join('.') === b.split('.').slice(0, 2).join('.')

const source = readFileSync(SOURCE, 'utf8')
const pinned = /^export const DEFAULT_VERSION = '([0-9.]+)'$/m.exec(source)?.[1]
if (!pinned) throw new Error(`No DEFAULT_VERSION found in ${SOURCE}`)
// Prettier spreads a long list over several lines.
const TESTED =
  /^(export const TESTED_VERSIONS = \[[^\]]*?)DEFAULT_VERSION(,?\s*\])/m
if (!TESTED.test(source))
  throw new Error(`No TESTED_VERSIONS ending in DEFAULT_VERSION in ${SOURCE}`)

const all = await releases()
const latest = newest(pinned, all)
if (!process.argv.includes('--update')) {
  const found: string[] = []
  if (compare(latest, pinned) > 0)
    found.push(
      `sonar-scanner-cli ${latest} is out, the action defaults to ${pinned}: run npm run scanner:update`
    )
  const others = [
    ...(TESTED.exec(source)?.[1] ?? '').matchAll(/'(\d+\.\d+\.\d+\.\d+)'/g)
  ].map(([, version]) => version as string)
  for (const version of others) {
    const patch = newest(
      version,
      all.filter((each) => sameLine(each, version))
    )
    if (compare(patch, version) > 0)
      found.push(
        `sonar-scanner-cli ${patch} is out, a newer patch of the tested ${version}: replace it in TESTED_VERSIONS and the matrices`
      )
  }
  for (const line of found) console.error(line)
  if (found.length > 0) process.exit(1)
  console.log(
    `sonar-scanner-cli ${pinned} is the latest release, and no tested version has a newer patch`
  )
  process.exit(0)
}
if (compare(latest, pinned) <= 0) {
  console.log(`sonar-scanner-cli ${pinned} is already the default`)
  process.exit(0)
}

// Only an update needs OpenPGP.js, so the weekly check runs without npm ci.
const {
  SONARSOURCE_KEY,
  checkSignature,
  keyServers,
  mergeKeys,
  readSigningKey
} = await import('../src/signature.ts')
// The plain build, the smallest: the action checks the one it runs on every download.
const name = `sonar-scanner-cli-${latest}`
const copies = await Promise.all(
  keyServers(SONARSOURCE_KEY).map(async (url) =>
    readSigningKey(await (await fetched(url)).text(), SONARSOURCE_KEY)
  )
)
const [first, second] = copies
if (!first) throw new Error("No copy of SonarSource's key")
await checkSignature(
  new Uint8Array(
    await (await fetched(`${DOWNLOADS}/${name}.zip`)).arrayBuffer()
  ),
  await (await fetched(`${DOWNLOADS}/${name}.zip.asc`)).text(),
  mergeKeys(first, second),
  name
)

const updated = source
  .replace(
    /^export const DEFAULT_VERSION = '.*'$/m,
    `export const DEFAULT_VERSION = '${latest}'`
  )
  .replace(TESTED, `$1'${pinned}', DEFAULT_VERSION$2`)
writeFileSync(SOURCE, updated)
console.log(
  `Made sonar-scanner-cli ${latest} the default, signature checked. Add ${latest} to the matrix in scanner.yml and ${pinned} to the one in fixtures.yml, then run npm run bundle and npm run test:cli`
)
