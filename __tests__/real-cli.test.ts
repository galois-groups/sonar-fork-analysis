// Checks what the analysis assumes about the scanner CLI against the real one: SCANNER_VERSION, else
// the default. The Scanner workflow runs it for each version the action is tested with.
import { describe, it, expect, beforeAll } from 'vitest'
import { exec } from '@actions/exec'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { formatProperties } from '../src/analyze.js'
import { OFFLINE_PROXY, scannerServer } from '../src/languages.js'
import { simulationProperties } from '../src/prepare.js'
import { installScanner } from '../src/scanner.js'
import { settingsWithoutPlaceholders } from './arbitraries.js'
import { Probe, cliJar, work } from './scanner-probe.js'

// Like String.trim, which the CLI applies to every value: everything up to a space goes at both ends.
const javaTrim = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- control characters are what it trims
  text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')

describe('the scanner CLI', () => {
  let probe: Probe

  beforeAll(async () => {
    mkdirSync(work, { recursive: true })
    probe = new Probe([await cliJar()])
  }, 600_000)

  it('reads the settings file back as written, values trimmed', () => {
    const seed = Date.now()
    const samples = fc.sample(settingsWithoutPlaceholders, {
      numRuns: 1000,
      seed
    })
    const read = probe.readSettingsFiles(
      samples.map((entries) => formatProperties(new Map(entries)))
    )
    samples.forEach((entries, index) => {
      const expected = new Map(
        entries.map(([key, value]) => [key, javaTrim(value)])
      )
      expect({ seed, entries, read: read[index] }).toEqual({
        seed,
        entries,
        read: expected
      })
    })
  })

  it('expands no value the analysis lets through', () => {
    const seed = Date.now()
    const piece = fc.constantFrom(
      '$',
      '{',
      '}',
      '$$',
      'env.',
      'NAME',
      'other',
      'x',
      '.',
      '_',
      '1',
      ' ',
      '\\',
      'é',
      '${other}',
      '${env.NAME}'
    )
    // Two that expand for sure, so the check below never depends on chance.
    const samples = [
      '${other}',
      'a${env.NAME}b',
      ...fc.sample(
        fc.array(piece, { maxLength: 8 }).map((pieces) => pieces.join('')),
        { numRuns: 2000, seed }
      )
    ]
    const letThrough = (value: string): boolean => {
      try {
        formatProperties(new Map([['value', value]]))
        return true
      } catch {
        return false
      }
    }
    const read = probe.resolvePlaceholders(samples)
    const changed = samples
      .filter((value, index) => letThrough(value) && read[index] !== value)
      .map((value) => ({ value, read: read[samples.indexOf(value)] }))
    expect({ seed, changed }).toEqual({ seed, changed: [] })
    // The probe resolves: some of what the analysis refuses does get expanded.
    expect(read.some((value, index) => value !== samples[index])).toBe(true)
  })
})

describe('the scanner CLI in simulation mode', () => {
  let scanner: string
  let dir: string
  let settings: string
  const env = (
    home: string,
    extra: Record<string, string> = {}
  ): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    SONAR_USER_HOME: home,
    ...extra
  })

  beforeAll(async () => {
    scanner = await installScanner(process.env.SCANNER_VERSION || undefined)
    // scanner-probe.ts removes it after a local run.
    dir = mkdtempSync(join(process.env.RUNNER_TEMP as string, 'server-'))
    settings = join(dir, 'sonar-project.properties')
    writeFileSync(settings, 'sonar.projectKey=key\nsonar.organization=key\n')
  }, 600_000)

  it('names the server it would analyse on', async () => {
    const server = (
      args: string[],
      extra: Record<string, string> = {}
    ): Promise<string> =>
      scannerServer(
        scanner,
        [`-Dproject.settings=${settings}`, ...args],
        { cwd: dir, env: env(join(dir, 'home'), extra) },
        join(dir, 'server.properties')
      )

    expect(await server([])).toBe('https://sonarcloud.io')
    expect(await server(['-Dsonar.region=US'])).toBe('https://sonarqube.us')
    expect(await server(['-Dsonar.region='], { SONAR_REGION: 'us' })).toBe(
      'https://sonarcloud.io'
    )
    expect(
      await server([], {
        SONAR_SCANNER_JSON_PARAMS:
          '{"sonar.host.url":"https://sonar.example.com/"}'
      })
    ).toBe('https://sonar.example.com')
    await expect(server(['-Dsonar.region=xx'])).rejects.toThrow(
      'when asked which server it uses'
    )
  })

  // A build may set the region, which the scanner refuses next to an explicit host.
  it("writes prepare's dump when the build sets a region", async () => {
    for (const [args, extra] of [
      [['-Dsonar.region=us'], {}],
      [[], { SONAR_REGION: 'us' }]
    ] as const) {
      const dump = join(dir, 'prepare.properties')
      const exitCode = await exec(
        scanner,
        [
          `-Dproject.settings=${settings}`,
          ...simulationProperties(dump),
          ...args
        ],
        { cwd: dir, env: env(join(dir, 'home'), extra), ignoreReturnCode: true }
      )

      expect({ args, extra, exitCode, written: existsSync(dump) }).toEqual({
        args,
        extra,
        exitCode: 0,
        written: true
      })
    }
  })

  // What a CLI that ignored simulation mode would do with the lookup's other arguments.
  it('reaches no server through the dead proxy', async () => {
    const home = join(dir, 'offline-home')
    const exitCode = await exec(
      scanner,
      [`-Dproject.settings=${settings}`, ...OFFLINE_PROXY],
      { cwd: dir, env: env(home), ignoreReturnCode: true }
    )

    expect(exitCode).not.toBe(0)
    const downloaded = existsSync(home)
      ? readdirSync(home, { recursive: true, withFileTypes: true }).filter(
          (entry) => entry.isFile()
        )
      : []
    expect(downloaded).toEqual([])
  })
})
