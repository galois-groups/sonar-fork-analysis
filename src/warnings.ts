import * as core from '@actions/core'
import { randomUUID } from 'node:crypto'

let count = 0

// Every warning goes through here, so the job summary can count them.
export function warn(message: string): void {
  count++
  core.warning(message)
}

export function warningCount(): number {
  return count
}

// An action runs once per process; the tests run it many times.
export function resetWarnings(): void {
  count = 0
}

// Something the analysis or the build left out, as the job summary names it, and the log line
// saying why.
export type LeftOut =
  | { kind: 'setting' | 'file' | 'link'; names: string[]; text: string }
  | { kind: 'entry'; key: string; entry: string; text: string }

const NOUNS: Record<LeftOut['kind'], [string, string]> = {
  setting: ['setting', 'settings'],
  entry: ['path entry', 'path entries'],
  file: ['file', 'files'],
  link: ['link', 'links']
}

// E.g. "2 settings, 6 path entries and 1 file".
export function counted(items: LeftOut[]): string {
  const parts = Object.entries(NOUNS).flatMap(([kind, [one, many]]) => {
    const total = items
      .filter((item) => item.kind === kind)
      .reduce((sum, item) => sum + ('names' in item ? item.names.length : 1), 0)
    if (total === 0) return []
    return [`${total.toLocaleString('en-GB')} ${total === 1 ? one : many}`]
  })
  const last = parts.pop() ?? ''
  return parts.length > 0 ? `${parts.join(', ')} and ${last}` : last
}

// GitHub shows only 10 warnings of a step, so all of them make one; the log says why each was left
// out. Its lines quote the artifact or the build: none of them may pass for a workflow command.
export function warnLeftOut(
  items: LeftOut[],
  warning: (counts: string) => string
): void {
  if (items.length === 0) return
  const resume = randomUUID()
  core.info(`::stop-commands::${resume}`)
  for (const item of items) core.info(item.text)
  core.info(`::${resume}::`)
  warn(warning(counted(items)))
}
