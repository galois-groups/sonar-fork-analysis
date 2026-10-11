import * as core from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { toolEnvironment } from './environment.js'
import { retry } from './retry.js'

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

// The workspace decides. Empty, the action checks out itself and cleans up after the job. A checkout
// there is the user's: the action only verifies it and leaves it alone.
export async function prepareCheckout(
  workspace: string,
  checkout: Checkout
): Promise<void> {
  if (readdirSync(workspace).length === 0) {
    // Saved first, so the post step also cleans up after a checkout that failed half-way.
    core.saveState(OWN_CHECKOUT, 'true')
    await checkoutCommit(workspace, checkout)
    return
  }
  const { exitCode, stdout } = await git(workspace, [
    'rev-parse',
    '--show-toplevel'
  ])
  // A repository further up would pass for one, with the workspace as just a directory in it.
  if (exitCode !== 0 || !sameDirectory(stdout.trim(), workspace)) {
    throw new Error(
      'The workspace holds files but no checkout: remove the step that writes them or check out the analysed commit there'
    )
  }
  core.info('Analysing the checkout already in the workspace')
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// The post step. An own checkout holds the pull request's code, and a self-hosted runner keeps the
// workspace for its next job, which needs it empty.
export function cleanUpCheckout(): void {
  const workspace = process.env.GITHUB_WORKSPACE
  if (core.getState(OWN_CHECKOUT) !== 'true' || !workspace) return
  try {
    for (const entry of readdirSync(resolve(workspace)))
      rmSync(join(workspace, entry), {
        recursive: true,
        force: true,
        maxRetries: 3
      })
  } catch (error) {
    core.warning(
      `Could not clean up the workspace: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// GitHub accepts a repository's URL with or without .git, and in any case.
function sameRepository(url: string, expected: string): boolean {
  const normal = (value: string) => {
    let result = value.toLowerCase()
    while (result.endsWith('/')) result = result.slice(0, -1)
    return result.endsWith('.git') ? result.slice(0, -4) : result
  }
  return normal(url) === normal(expected)
}

export async function verifyCheckout(
  workspace: string,
  sha: string,
  repositoryUrl: string
): Promise<void> {
  const head = await required(workspace, ['rev-parse', 'HEAD'])
  if (head !== sha) {
    throw new Error(
      `The checkout is at ${head} but the analysis is for ${sha}: check out that commit. On a self-hosted runner, an interrupted earlier run may have left its checkout: clean the workspace`
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
  // Sonar finds the base branch on origin. A fork's copy of it could be anything.
  const origin = await git(workspace, ['remote', 'get-url', 'origin'])
  if (
    origin.exitCode !== 0 ||
    !sameRepository(origin.stdout.trim(), repositoryUrl)
  ) {
    throw new Error(
      `The checkout's origin is not ${repositoryUrl}, where Sonar looks for the base branch: check out from this repository`
    )
  }
  // Anything a step added or changed would be analysed as the pull request's code.
  const status = await git(workspace, [
    'status',
    '--porcelain',
    '--ignored',
    '--untracked-files=all'
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
      `The checkout holds files that aren't the analysed commit's, such as ${first.slice(3)}: remove the steps that write them`
    )
  }
}
