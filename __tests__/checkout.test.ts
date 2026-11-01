import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import * as core from '../__fixtures__/core.js'
import { windows } from '../__fixtures__/platform.js'

vi.doMock('@actions/core', () => core)

const {
  checkoutCommit,
  cleanUpCheckout,
  prepareCheckout,
  sameRepository,
  verifyCheckout
} = await import('../src/checkout.js')
const { redacted } = await import('../src/secrets.js')

let root: string
let server: string
let workspace: string
let first: string
let second: string
let forked: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'checkout-'))
  // Serves owner/repo from disk, standing in for https://github.com/owner/repo.
  server = join(root, 'server')
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(source, 'App.java'), 'class App {}')
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'first')
  first = git(source, 'rev-parse', 'HEAD')
  writeFileSync(join(source, 'App.java'), 'class App { int x; }')
  git(source, 'commit', '--quiet', '-am', 'second')
  second = git(source, 'rev-parse', 'HEAD')
  git(root, 'clone', '--quiet', '--bare', source, join(server, 'owner', 'repo'))
  // A fork whose main is the pull request's head, the usual shape of a fork's pull request.
  writeFileSync(join(source, 'App.java'), 'class App { int y; }')
  git(source, 'commit', '--quiet', '-am', 'fork change')
  forked = git(source, 'rev-parse', 'HEAD')
  git(
    root,
    'clone',
    '--quiet',
    '--bare',
    source,
    join(server, 'forker', 'repo')
  )
  workspace = join(root, 'workspace')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.GITHUB_WORKSPACE
})

// Built the way the action builds it: the server's URL, then the repository.
function origin(): string {
  return `file://${server}/owner/repo`
}

describe('checkoutCommit', () => {
  const checkout = { repository: 'owner/repo', token: 'a-token' }

  it('checks out the exact commit with its history and no stored credentials', async () => {
    await checkoutCommit(workspace, {
      ...checkout,
      serverUrl: `file://${server}`,
      sha: first
    })

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(first)
    expect(git(workspace, 'rev-parse', '--is-shallow-repository')).toBe('false')
    // The header git sends, which a failure's summary must not show either.
    const header = Buffer.from('x-access-token:a-token').toString('base64')
    expect(core.setSecret).toHaveBeenCalledWith(header)
    expect(redacted(`basic ${header}`)).toBe('basic ***')
    await expect(
      verifyCheckout(workspace, first, origin(), false)
    ).resolves.toBeUndefined()
  })

  it("takes a fork's commit from this repository, along with its branches", async () => {
    // GitHub keeps a copy of every pull request's head in the base repository.
    git(
      root,
      '--git-dir',
      join(server, 'forker', 'repo'),
      'push',
      '--quiet',
      join(server, 'owner', 'repo'),
      `${forked}:refs/pull/1/head`
    )
    rmSync(join(server, 'forker'), { recursive: true })

    await checkoutCommit(workspace, {
      ...checkout,
      serverUrl: `file://${server}`,
      sha: forked
    })

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(forked)
    expect(git(workspace, 'rev-parse', 'refs/remotes/origin/main')).toBe(second)
  })

  it('never fetches from the fork', async () => {
    await expect(
      checkoutCommit(workspace, {
        ...checkout,
        serverUrl: `file://${server}`,
        sha: forked
      })
    ).rejects.toThrow(/git fetch failed/)
  })
})

describe('prepareCheckout', () => {
  const checkout = { repository: 'owner/repo', token: 'a-token' }

  it('checks out an empty workspace itself, and notes it for the clean-up', async () => {
    await expect(
      prepareCheckout(workspace, {
        ...checkout,
        serverUrl: `file://${server}`,
        sha: first
      })
    ).resolves.toBe(false)

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(first)
    expect(core.saveState).toHaveBeenCalledWith('own-checkout', 'true')
  })

  it('takes the checkout already in the workspace as it is', async () => {
    git(root, 'clone', '--quiet', origin(), workspace)

    await expect(
      prepareCheckout(workspace, {
        ...checkout,
        serverUrl: `file://${server}`,
        sha: first
      })
    ).resolves.toBe(true)

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(second)
    expect(core.saveState).not.toHaveBeenCalled()
  })

  it('refuses files without a checkout', async () => {
    writeFileSync(join(workspace, 'pom.xml'), '')

    await expect(
      prepareCheckout(workspace, {
        ...checkout,
        serverUrl: `file://${server}`,
        sha: first
      })
    ).rejects.toThrow(/holds files but no checkout/)
  })

  it('refuses a workspace that is only a directory in a repository further up', async () => {
    git(root, 'init', '--quiet')
    writeFileSync(join(workspace, 'pom.xml'), '')

    await expect(
      prepareCheckout(workspace, {
        ...checkout,
        serverUrl: `file://${server}`,
        sha: first
      })
    ).rejects.toThrow(/holds files but no checkout/)
  })
})

describe('cleanUpCheckout', () => {
  beforeEach(() => {
    process.env.GITHUB_WORKSPACE = workspace
    git(root, 'clone', '--quiet', origin(), workspace)
    mkdirSync(join(workspace, 'target', 'classes'), { recursive: true })
    writeFileSync(join(workspace, 'target', 'classes', 'App.class'), '')
  })

  it('empties the workspace after its own checkout', () => {
    core.getState.mockReturnValue('true')

    cleanUpCheckout()

    expect(existsSync(workspace)).toBe(true)
    expect(readdirSync(workspace)).toEqual([])
  })

  it.skipIf(windows)('removes what it can when an entry resists', () => {
    core.getState.mockReturnValue('true')
    const locked = join(workspace, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'file'), '')
    chmodSync(locked, 0o555)
    try {
      cleanUpCheckout()
    } finally {
      chmodSync(locked, 0o755)
    }

    expect(readdirSync(workspace)).toEqual(['locked'])
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not clean up the workspace')
    )
  })

  it("leaves a checkout that isn't its own", () => {
    core.getState.mockReturnValue('')

    cleanUpCheckout()

    expect(readdirSync(workspace).sort()).toEqual([
      '.git',
      'App.java',
      'target'
    ])
  })
})

describe('verifyCheckout', () => {
  function clone(...args: string[]): void {
    git(root, 'clone', '--quiet', ...args, origin(), workspace)
  }

  it('rejects a checkout of another commit', async () => {
    clone()
    await expect(
      verifyCheckout(workspace, first, origin(), true)
    ).rejects.toThrow(/check out that commit/)
  })

  it('rejects a shallow checkout', async () => {
    clone('--depth=1')
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, origin(), true)
    ).rejects.toThrow(/fetch-depth 0/)
  })

  it('rejects persisted credentials', async () => {
    clone()
    git(
      workspace,
      'config',
      'http.https://github.com/.extraheader',
      'AUTHORIZATION: basic secret'
    )
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, origin(), true)
    ).rejects.toThrow(/persist-credentials false/)
  })

  it('rejects credentials in an included config file', async () => {
    clone()
    const included = join(root, 'credentials.config')
    writeFileSync(
      included,
      '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic secret\n'
    )
    git(workspace, 'config', 'include.path', included)
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, origin(), true)
    ).rejects.toThrow(/persist-credentials false/)
  })

  it('accepts the origin with .git or in another case', async () => {
    clone()
    git(
      workspace,
      'remote',
      'set-url',
      'origin',
      `${origin().toUpperCase()}.git`
    )
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, origin(), true)
    ).resolves.toBeUndefined()
  })

  it('rejects a checkout whose origin is another repository', async () => {
    clone()
    git(
      workspace,
      'remote',
      'set-url',
      'origin',
      `file://${join(server, 'forker', 'repo')}`
    )
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, origin(), true)
    ).rejects.toThrow(/origin is not/)
  })

  it.each([
    [
      'an added file',
      () => {
        writeFileSync(join(workspace, 'extra.txt'), '')
      },
      'extra.txt'
    ],
    [
      'an ignored file',
      () => {
        writeFileSync(
          join(workspace, '.git', 'info', 'exclude'),
          'ignored.txt\n'
        )
        writeFileSync(join(workspace, 'ignored.txt'), '')
      },
      'ignored.txt'
    ],
    [
      'a changed file',
      () => {
        writeFileSync(join(workspace, 'App.java'), 'class Changed {}')
      },
      'App.java'
    ]
  ])('rejects %s', async (_name, change, file) => {
    clone()
    change()
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, origin(), true)
    ).rejects.toThrow(`such as ${file}`)
  })

  it('trusts its own checkout to hold the commit alone', async () => {
    clone()
    writeFileSync(join(workspace, 'extra.txt'), '')
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, origin(), false)
    ).resolves.toBeUndefined()
  })

  it.each([
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo',
    'ssh://git@github.com:22/Owner/Repo.git/'
  ])('takes %s for the repository', async (url) => {
    clone()
    git(workspace, 'remote', 'set-url', 'origin', url)
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, 'https://github.com/owner/repo', true)
    ).resolves.toBeUndefined()
  })

  it.each([
    'git@github.com:forker/repo.git',
    'https://github.example.com/owner/repo'
  ])("doesn't take %s for the repository", async (url) => {
    clone()
    git(workspace, 'remote', 'set-url', 'origin', url)
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, 'https://github.com/owner/repo', true)
    ).rejects.toThrow(/origin is not/)
  })

  it('rejects credentials in the origin URL', async () => {
    clone()
    git(
      workspace,
      'remote',
      'set-url',
      'origin',
      'https://x-access-token:secret@github.com/owner/repo'
    )
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(
      verifyCheckout(workspace, head, 'https://github.com/owner/repo', true)
    ).rejects.toThrow(/origin holds credentials/)
  })
})

describe('sameRepository', () => {
  type Repository = { host: string; owner: string; name: string }

  const repository: fc.Arbitrary<Repository> = fc.record({
    host: fc.domain(),
    owner: fc.stringMatching(/^[a-z\d][a-z\d-]{0,15}$/),
    name: fc
      .stringMatching(/^[\w.-]{1,15}$/)
      .filter((name) => !/^\.{1,2}$/.test(name) && !/\.git$/i.test(name))
  })

  // How git may hold a repository's URL: any of these forms, case, port, .git and trailing slashes.
  function written({ host, owner, name }: Repository): fc.Arbitrary<string> {
    const path = `${owner}/${name}`
    return fc
      .record({
        form: fc.constantFrom(
          `https://${host}/${path}`,
          `git@${host}:${path}`,
          `ssh://git@${host}/${path}`
        ),
        port: fc.option(fc.integer({ min: 1, max: 65_535 }), {
          nil: undefined
        }),
        dotGit: fc.boolean(),
        slashes: fc.integer({ min: 0, max: 2 }),
        upper: fc.array(fc.boolean(), { minLength: 64, maxLength: 64 })
      })
      .map(({ form, port, dotGit, slashes, upper }) => {
        let url =
          port === undefined || form.startsWith('git@')
            ? form
            : form.replace(host, `${host}:${port}`)
        url += (dotGit ? '.git' : '') + '/'.repeat(slashes)
        return url.replace(/./g, (char, offset: number) =>
          upper[offset % upper.length] ? char.toUpperCase() : char
        )
      })
  }

  const expected = ({ host, owner, name }: Repository) =>
    `https://${host}/${owner}/${name}`

  it('takes every form of the repository for it', () => {
    fc.assert(
      fc.property(
        repository.chain((repo) => written(repo).map((url) => ({ repo, url }))),
        ({ repo, url }) => {
          expect(sameRepository(url, expected(repo))).toBe(true)
        }
      ),
      { numRuns: 1000 }
    )
  })

  it('never takes another repository for it, in any form', () => {
    // Another repository differs in one part only: random pairs differ in all three, and would pass
    // even with a comparison that ignored one of them.
    const neighbour = fc
      .tuple(
        repository,
        repository,
        fc.constantFrom('host', 'owner', 'name') as fc.Arbitrary<
          keyof Repository
        >
      )
      .filter(([a, b, part]) => a[part].toLowerCase() !== b[part].toLowerCase())
      .map(([a, b, part]) => ({ a, other: { ...a, [part]: b[part] } }))
    fc.assert(
      fc.property(
        neighbour.chain(({ a, other }) =>
          written(other).map((url) => ({ a, url }))
        ),
        ({ a, url }) => {
          expect(sameRepository(url, expected(a))).toBe(false)
        }
      ),
      { numRuns: 1000 }
    )
  })
})
