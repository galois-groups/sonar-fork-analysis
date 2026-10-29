// Fails when Sonar has released a newer scanner CLI than the action's default, which nothing else
// would notice. With --update, checks the new release's signature and makes it the default, keeping
// the old default among the tested versions.
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

async function latestRelease(): Promise<string> {
  const metadata = await (
    await fetched(
      'https://repo1.maven.org/maven2/org/sonarsource/scanner/cli/sonar-scanner-cli/maven-metadata.xml'
    )
  ).text()
  // Download names need all four parts.
  const latest = /<release>(\d+\.\d+\.\d+\.\d+)<\/release>/.exec(metadata)?.[1]
  if (!latest) throw new Error('No scanner CLI release found on Maven Central')
  return latest
}

const source = readFileSync(SOURCE, 'utf8')
const pinned = /^export const DEFAULT_VERSION = '([0-9.]+)'$/m.exec(source)?.[1]
if (!pinned) throw new Error(`No DEFAULT_VERSION found in ${SOURCE}`)
// Prettier spreads a long list over several lines.
const TESTED =
  /^(export const TESTED_VERSIONS = \[[^\]]*?)DEFAULT_VERSION(,?\s*\])/m
if (!TESTED.test(source))
  throw new Error(`No TESTED_VERSIONS ending in DEFAULT_VERSION in ${SOURCE}`)

const latest = await latestRelease()
if (!process.argv.includes('--update')) {
  if (latest !== pinned) {
    console.error(
      `sonar-scanner-cli ${latest} is out, the action defaults to ${pinned}: run npm run scanner:update`
    )
    process.exit(1)
  }
  console.log(`sonar-scanner-cli ${pinned} is the latest release`)
  process.exit(0)
}
if (latest === pinned) {
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
