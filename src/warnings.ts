import * as core from '@actions/core'

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
