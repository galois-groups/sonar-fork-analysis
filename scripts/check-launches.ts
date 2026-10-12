// Fails when a fork-path analysis started a program its allowlist doesn't hold, or when anything on
// the runner started a container while it ran.
//
// Usage: node scripts/check-launches.ts <allowlist> <audit log>...
// Each audit log holds the raw kernel records of one analysis (ausearch --raw). The allowlist's
// ${NAME} patterns take their values from this environment.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { allowlist, check, type Launch } from './launches.ts'

const [list, ...logs] = process.argv.slice(2)
if (!list || logs.length === 0) {
  console.error('Usage: check-launches.ts <allowlist> <audit log>...')
  process.exit(2)
}

const allowed = allowlist(readFileSync(list, 'utf8'), process.env)
const show = (launch: Launch): string =>
  `${launch.program} in ${launch.cwd}: ${JSON.stringify(launch.argv)}`

let failed = false
for (const log of logs) {
  let result: ReturnType<typeof check>
  try {
    result = check(readFileSync(log, 'utf8'), allowed)
  } catch (error) {
    // The other fixtures' records still get checked.
    console.log(
      `::error::${log}: ${error instanceof Error ? error.message : String(error)}`
    )
    failed = true
    continue
  }
  const { started, unexpected, containers } = result
  const programs = [...new Set(started.map((launch) => launch.program))].sort(
    (a, b) => a.localeCompare(b)
  )
  // The records come from the analysed code's reach; none may pass for a workflow command.
  const resume = randomUUID()
  console.log(`::stop-commands::${resume}`)
  console.log(`${log}: ${started.length} starts of these programs:`)
  for (const program of programs) console.log(`  ${program}`)
  for (const launch of unexpected)
    console.log(`Not in the allowlist: ${show(launch)}`)
  for (const launch of containers)
    console.log(`Started a container: ${show(launch)}`)
  console.log(`::${resume}::`)
  if (unexpected.length > 0 || containers.length > 0) {
    console.log(
      `::error::${log}: the analysis started programs outside the allowlist.`
    )
    failed = true
  }
}
process.exit(failed ? 1 : 0)
