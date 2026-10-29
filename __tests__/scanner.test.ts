import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi
} from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as openpgp from 'openpgp'
import { windows } from '../__fixtures__/platform.js'

const downloadTool = vi.fn<(url: string) => Promise<string>>()
const extractZip =
  vi.fn<(file: string, destination?: string) => Promise<string>>()
vi.doMock('@actions/tool-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@actions/tool-cache')>()),
  downloadTool,
  extractZip
}))
// The key servers, asked through the HTTP client.
const keyServer = vi.fn<(url: string) => Promise<[number, string]>>()
vi.doMock('@actions/http-client', () => ({
  HttpClient: class {
    async get(url: string): Promise<object> {
      const [statusCode, body] = await keyServer(url)
      return { message: { statusCode }, readBody: async () => body }
    }
  }
}))
const { HTTPError } = await import('@actions/tool-cache')
const warning = vi.fn<(message: string) => void>()
vi.doMock('@actions/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  warning
}))

const {
  DEFAULT_VERSION,
  TESTED_VERSIONS,
  installScanner,
  keptZip,
  scannerSuffix,
  scannerVersion,
  scannerZip,
  unpackScanner
} = await import('../src/scanner.js')

describe('scannerSuffix', () => {
  it('picks the build with a bundled Java runtime where one exists', () => {
    expect(scannerSuffix('linux', 'x64')).toBe('-linux-x64')
    expect(scannerSuffix('linux', 'arm64')).toBe('-linux-aarch64')
    expect(scannerSuffix('darwin', 'arm64')).toBe('-macosx-aarch64')
    expect(scannerSuffix('win32', 'x64')).toBe('-windows-x64')
  })

  it('falls back to the plain build elsewhere', () => {
    expect(scannerSuffix('linux', 'ppc64')).toBe('')
  })
})

describe('scannerVersion', () => {
  it('runs the newest tested version unless told otherwise', () => {
    expect(scannerVersion('')).toBe(DEFAULT_VERSION)
    expect(TESTED_VERSIONS.at(-1)).toBe(DEFAULT_VERSION)
    expect(scannerVersion('8.0.1.6346')).toBe('8.0.1.6346')
  })

  it.each([
    '8.2.0',
    'latest',
    '8.2.0.6438/../x',
    ' 8.2.0.6438',
    '8.2.0.6438\n'
  ])('refuses %j', (input) => {
    expect(() => scannerVersion(input)).toThrow(
      'scanner-version must be a full scanner CLI version'
    )
  })
})

// SonarSource's servers, played by a key of the test's own: the key servers answer with its public
// key, the downloads with the zip and its signature.
describe('scannerZip', () => {
  const KEY_SERVERS = ['keys.openpgp.org', 'keyserver.ubuntu.com']
  const zip = Buffer.from('the scanner')
  let key: openpgp.PrivateKey
  let fingerprint: string
  let root: string
  let served: Buffer
  let signature: string
  let keyAnswer: string
  const saved = { ...process.env }

  const sign = async (content: Buffer): Promise<string> =>
    openpgp.sign({
      message: await openpgp.createMessage({ binary: content }),
      signingKeys: key,
      detached: true
    })

  beforeAll(async () => {
    ;({ privateKey: key } = await openpgp.generateKey({
      userIDs: [{ name: 'Test' }],
      subkeys: [{ sign: true }],
      format: 'object'
    }))
    fingerprint = key.getFingerprint()
  })

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'scanner-'))
    process.env.RUNNER_TOOL_CACHE = join(root, 'cache')
    served = zip
    signature = await sign(zip)
    keyAnswer = key.toPublic().armor()
    keyServer.mockImplementation(async (url) => {
      if (!KEY_SERVERS.includes(new URL(url).hostname))
        throw new Error(`Unexpected key server ${url}`)
      return [200, keyAnswer]
    })
    let downloads = 0
    downloadTool.mockImplementation(async (url) => {
      const file = join(root, `download-${String(++downloads)}`)
      if (url.endsWith('.zip.asc')) writeFileSync(file, signature)
      else if (url.endsWith('.zip')) writeFileSync(file, served)
      else throw new Error(`Unexpected download ${url}`)
      return file
    })
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(root, { recursive: true, force: true })
  })

  const zipDownloads = (): number =>
    downloadTool.mock.calls.filter(([url]) => url.endsWith('.zip')).length

  it('downloads, checks and keeps the zip, then uses the kept copy', async () => {
    expect(await scannerZip('1.0', 'cli', fingerprint)).toEqual(zip)
    expect(readFileSync(keptZip('1.0', 'cli'))).toEqual(zip)
    expect(zipDownloads()).toBe(1)
    downloadTool.mockClear()

    expect(await scannerZip('1.0', 'cli', fingerprint)).toEqual(zip)
    expect(zipDownloads()).toBe(0)
  })

  it('downloads again over a kept copy that fails the check', async () => {
    mkdirSync(dirname(keptZip('1.0', 'cli')), { recursive: true })
    writeFileSync(keptZip('1.0', 'cli'), 'tampered')

    expect(await scannerZip('1.0', 'cli', fingerprint)).toEqual(zip)
    expect(zipDownloads()).toBe(1)
    expect(readFileSync(keptZip('1.0', 'cli'))).toEqual(zip)
  })

  it('refuses a download its signature does not cover, and keeps nothing', async () => {
    served = Buffer.from('not the scanner')

    await expect(scannerZip('1.0', 'cli', fingerprint)).rejects.toThrow(
      "cli doesn't match its signature"
    )
    expect(existsSync(keptZip('1.0', 'cli'))).toBe(false)
  })

  it('refuses key servers answering with another key', async () => {
    keyAnswer = (
      await openpgp.generateKey({
        userIDs: [{ name: 'Other' }],
        format: 'object'
      })
    ).privateKey
      .toPublic()
      .armor()

    await expect(scannerZip('1.0', 'cli', fingerprint)).rejects.toThrow(
      "Could not get SonarSource's key"
    )
    expect(zipDownloads()).toBe(0)
  })

  it('works with one key server down', async () => {
    const answer = keyServer.getMockImplementation()
    keyServer.mockImplementation(async (url) => {
      if (new URL(url).hostname === 'keys.openpgp.org')
        throw new Error('Request timeout')
      return answer?.(url) ?? [500, '']
    })

    expect(await scannerZip('1.0', 'cli', fingerprint)).toEqual(zip)
  })

  it('takes no error page for a key', async () => {
    keyServer.mockResolvedValue([404, keyAnswer])

    await expect(scannerZip('1.0', 'cli', fingerprint)).rejects.toThrow(
      "Could not get SonarSource's key"
    )
  })

  it('points at scanner-version when the version does not exist', async () => {
    downloadTool.mockRejectedValue(new HTTPError(404))

    await expect(scannerZip('1.0', 'cli', fingerprint)).rejects.toThrow(
      "cli.zip.asc doesn't exist. Check that scanner-version names a released scanner CLI."
    )
  })

  it('names the download that failed', async () => {
    downloadTool.mockRejectedValue(new HTTPError(503))

    await expect(scannerZip('1.0', 'cli', fingerprint)).rejects.toThrow(
      /^Could not download https:\/\/\S+\/cli\.zip\.asc: Unexpected HTTP response: 503$/
    )
  })

  it.skipIf(windows)(
    'reads and writes through no link where the zip is kept',
    async () => {
      const kept = keptZip('1.0', 'cli')
      mkdirSync(dirname(kept), { recursive: true })
      // Endless to read, and a file elsewhere to write to.
      symlinkSync('/dev/zero', kept)
      const target = join(root, 'target')
      symlinkSync(target, `${kept}.${String(process.pid)}.part`)

      expect(await scannerZip('1.0', 'cli', fingerprint)).toEqual(zip)
      expect(existsSync(target)).toBe(false)
    }
  )

  it("works where the zip can't be kept", async () => {
    writeFileSync(join(root, 'cache'), 'a file, not a directory')

    expect(await scannerZip('1.0', 'cli', fingerprint)).toEqual(zip)
    expect(lstatSync(join(root, 'cache')).isFile()).toBe(true)
  })
})

describe('installScanner', () => {
  beforeEach(() => {
    keyServer.mockRejectedValue(new Error('offline'))
    downloadTool.mockRejectedValue(new Error('offline'))
  })

  it('warns about a version the checks never ran against', async () => {
    await expect(installScanner('9.9.9.1')).rejects.toThrow()
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "sonar-scanner-cli 9.9.9.1 isn't one this action is tested with"
      )
    )
  })

  it('runs a tested version without a warning', async () => {
    await expect(installScanner(TESTED_VERSIONS[0])).rejects.toThrow()
    expect(warning).not.toHaveBeenCalled()
  })
})

describe('unpackScanner', () => {
  let root: string
  const saved = { ...process.env }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scanner-'))
    process.env.RUNNER_TEMP = root
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(root, { recursive: true, force: true })
  })

  it('unpacks exactly the checked bytes into a directory of its own', async () => {
    let unpacked: Buffer | undefined
    extractZip.mockImplementation(async (file, destination) => {
      expect(file.startsWith(root)).toBe(true)
      expect(file.endsWith('.zip')).toBe(true)
      unpacked = readFileSync(file)
      return destination ?? ''
    })

    const script = await unpackScanner(
      Buffer.from('checked'),
      '8.2.0.6438',
      '-linux-x64',
      'linux'
    )

    expect(unpacked).toEqual(Buffer.from('checked'))
    expect(script.startsWith(root)).toBe(true)
    expect(script).toMatch(
      /sonar-scanner-8\.2\.0\.6438-linux-x64[/\\]bin[/\\]sonar-scanner$/
    )
    expect(
      await unpackScanner(
        Buffer.from('checked'),
        '8.2.0.6438',
        '-windows-x64',
        'win32'
      )
    ).toMatch(/sonar-scanner\.bat$/)
  })
})
