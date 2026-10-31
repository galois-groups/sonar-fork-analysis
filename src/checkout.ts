import * as core from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { toolEnvironment } from './environment.js'
import { realPath } from './real-path.js'
import { retry } from './retry.js'
import { warn } from './warnings.js'

// Never wait for a password, and never let the checkout's attributes send git-lfs to a server.
const QUIET_GIT = { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }

async function git(
  workspace: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return getExecOutput('git', args, {
    cwd: workspace,
    env: { ...toolEnvironment(), ...QUIET_GIT, ...env },
    ignoreReturnCode: true,
    silent: true
  })
}

async function required(
  workspace: string,
  args: string[],
  env?: Record<string, string>
): Promise<string> {
  const { exitCode, stdout, stderr } = await git(workspace, args, env)
  if (exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ''} failed with exit code ${exitCode}: ${stderr.trim()}`
    )
  }
  return stdout.trim()
}

export type Checkout = {
  serverUrl: string
  // This repository, whose branches a pull request is compared with.
  repository: string
  sha: string
  token: string
}

// Fetches the analysed commit the way a safe checkout step would: the exact commit, full history for
// blame, and credentials handed to git through its environment only, so none are written to disk.
export async function checkoutCommit(
  workspace: string,
  { serverUrl, repository, sha, token }: Checkout
): Promise<void> {
  const env: Record<string, string> = {}
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    core.setSecret(basic)
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${serverUrl}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
    })
  }
  core.info(`Checking out ${sha}`)
  await required(workspace, ['init', '--quiet'])
  // Sonar finds a pull request's base branch as origin/<base>. A fork's copy of that branch could be
  // anything. So origin is this repository.
  await required(workspace, [
    'remote',
    'add',
    'origin',
    `${serverUrl}/${repository}`
  ])
  const fetch = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules']
  // The only network operations, so the only ones worth retrying, as actions/checkout does.
  await retry(() =>
    required(
      workspace,
      [...fetch, 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      env
    )
  )
  // GitHub keeps every pull request's head here too, as refs/pull/<number>/head. It's there even when
  // the fork is private or gone. Nothing the fork controls gets contacted.
  await retry(() => required(workspace, [...fetch, 'origin', sha], env))
  await required(workspace, ['checkout', '--quiet', '--detach', sha])
}

const OWN_CHECKOUT = 'own-checkout'

const SHARED_WORKSPACE =
  'On a self-hosted runner, another job may have left its files in the workspace: empty it before the action'

// The workspace decides. Empty, the action checks out itself and cleans up after the job. A checkout
// there is the user's: the action only verifies it and leaves it alone. Resolves to whether it is
// the user's.
export async function prepareCheckout(
  workspace: string,
  checkout: Checkout
): Promise<boolean> {
  if (readdirSync(workspace).length === 0) {
    // Saved first, so the post step also cleans up after a checkout that failed half-way.
    core.saveState(OWN_CHECKOUT, 'true')
    await checkoutCommit(workspace, checkout)
    return false
  }
  const noCheckout = new Error(
    `The workspace holds files but no checkout: remove the step that writes them or check out the analysed commit there. ${SHARED_WORKSPACE}`
  )
  // Without .git, a repository further up would pass for one, with the workspace a directory in it.
  if (!existsSync(join(workspace, '.git'))) throw noCheckout
  const { exitCode, stdout, stderr } = await git(workspace, [
    'rev-parse',
    '--show-toplevel'
  ])
  // Such as dubious ownership, when an earlier job left the files of another user.
  if (exitCode !== 0) {
    throw new Error(
      `Could not tell whether the workspace holds a checkout: ${stderr.trim()}`
    )
  }
  if (!sameDirectory(stdout.trim(), workspace)) throw noCheckout
  core.info('Analysing the checkout already in the workspace')
  return true
}

// git spells paths its own way: forward slashes and, on Windows, long names where the workspace may
// have short ones such as RUNNER~1.
function sameDirectory(a: string, b: string): boolean {
  try {
    return realPath(a) === realPath(b)
  } catch {
    return false
  }
}

// The post step. An own checkout holds the pull request's code, and a self-hosted runner keeps the
// workspace for its next job, which needs it empty.
export function cleanUpCheckout(): void {
  const workspace = process.env.GITHUB_WORKSPACE
  if (core.getState(OWN_CHECKOUT) !== 'true' || !workspace) return
  let entries: string[]
  try {
    entries = readdirSync(resolve(workspace))
  } catch (error) {
    cleanUpFailed(error)
    return
  }
  // One by one, so a file that can't go doesn't keep the others.
  for (const entry of entries) {
    try {
      rmSync(join(workspace, entry), {
        recursive: true,
        force: true,
        maxRetries: 3
      })
    } catch (error) {
      cleanUpFailed(error)
    }
  }
}

function cleanUpFailed(error: unknown): void {
  warn(
    `Could not clean up the workspace: ${error instanceof Error ? error.message : String(error)}`
  )
}

// The host and path a remote's URL names. The same repository has several: https, ssh://, the
// git@host:path form, with or without .git, in any case and with any port.
function repositoryLocation(url: string): string {
  let rest = url.trim().toLowerCase()
  const scheme = rest.indexOf('://')
  if (scheme > 0) {
    rest = rest.slice(scheme + 3)
  } else {
    const colon = rest.indexOf(':')
    if (colon > 0 && !rest.slice(0, colon).includes('/'))
      rest = `${rest.slice(0, colon)}/${rest.slice(colon + 1)}`
  }
  const slash = rest.indexOf('/')
  let host = slash < 0 ? rest : rest.slice(0, slash)
  const path = slash < 0 ? '' : rest.slice(slash)
  host = host.slice(host.lastIndexOf('@') + 1)
  const port = host.lastIndexOf(':')
  if (port >= 0 && /^\d+$/.test(host.slice(port + 1)))
    host = host.slice(0, port)
  let location = host + path
  while (location.endsWith('/')) location = location.slice(0, -1)
  return location.endsWith('.git') ? location.slice(0, -4) : location
}

export function sameRepository(url: string, expected: string): boolean {
  return repositoryLocation(url) === repositoryLocation(expected)
}

// A user and password before the host: git keeps them in .git/config, next to the analysed code.
function holdsCredentials(url: string): boolean {
  const scheme = url.indexOf('://')
  if (scheme < 0 || !/^https?$/i.test(url.slice(0, scheme))) return false
  const rest = url.slice(scheme + 3)
  const slash = rest.indexOf('/')
  return (slash < 0 ? rest : rest.slice(0, slash)).includes('@')
}

export async function verifyCheckout(
  workspace: string,
  sha: string,
  repositoryUrl: string,
  adopted: boolean
): Promise<void> {
  const head = await required(workspace, ['rev-parse', 'HEAD'])
  if (head !== sha) {
    throw new Error(
      `The checkout is at ${head} but the analysis is for ${sha}: check out that commit. ${SHARED_WORKSPACE}`
    )
  }
  if (
    (await required(workspace, ['rev-parse', '--is-shallow-repository'])) ===
    'true'
  ) {
    throw new Error(
      'The checkout is shallow, so Sonar would get no history: fetch it with fetch-depth 0'
    )
  }
  // The analysed code may come from a fork; a stored token would sit right next to it. Newer
  // actions/checkout versions keep it in a file that .git/config includes.
  const { stdout } = await git(workspace, [
    'config',
    '--local',
    '--includes',
    '--get-regexp',
    String.raw`^http\..*\.extraheader$`
  ])
  if (stdout.trim() !== '') {
    throw new Error(
      'The checkout stored credentials in .git/config: check out with persist-credentials false'
    )
  }
  // The action's own checkout has the right origin and nothing else by construction. git can even
  // report its files as changed, for instance with line endings .gitattributes rewrites.
  if (adopted) await verifyAdopted(workspace, repositoryUrl)
}

async function verifyAdopted(
  workspace: string,
  repositoryUrl: string
): Promise<void> {
  // Sonar finds the base branch on origin. A fork's copy of it could be anything.
  const origin = await git(workspace, ['remote', 'get-url', 'origin'])
  const url = origin.stdout.trim()
  if (holdsCredentials(url)) {
    throw new Error(
      "The checkout's origin holds credentials: check out without them in the URL"
    )
  }
  if (origin.exitCode !== 0 || !sameRepository(url, repositoryUrl)) {
    throw new Error(
      `The checkout's origin is not ${repositoryUrl}, where Sonar looks for the base branch: check out from this repository`
    )
  }
  // Anything a step added or changed would be analysed as the pull request's code. The pull
  // request's .gitmodules could otherwise hide its submodules from the check.
  const status = await git(workspace, [
    'status',
    '--porcelain',
    '--ignored',
    '--untracked-files=all',
    '--ignore-submodules=none'
  ])
  if (status.exitCode !== 0) {
    throw new Error(
      `git status failed with exit code ${status.exitCode}: ${status.stderr.trim()}`
    )
  }
  // Each line is two status letters, a space and the path.
  const first = status.stdout.split('\n').find((line) => line !== '')
  if (first !== undefined) {
    throw new Error(
      `The checkout holds files that aren't the analysed commit's, such as ${first.slice(3)}: remove the steps that write them. ${SHARED_WORKSPACE}`
    )
  }
}
