import * as core from '@actions/core'

const secrets = new Set<string>()

// The runner masks a secret in the log, but the job summary escapes its text, which hides a secret
// from that masking: the summary takes each one out itself.
export function secret(value: string): void {
  if (!value) return
  secrets.add(value)
  core.setSecret(value)
}

export function redacted(text: string): string {
  let out = text
  // Longest first, so a secret that holds another goes whole.
  for (const value of [...secrets].sort((a, b) => b.length - a.length))
    out = out.replaceAll(value, '***')
  return out
}

// An action runs once per process; the tests run it many times.
export function forgetSecrets(): void {
  secrets.clear()
}
