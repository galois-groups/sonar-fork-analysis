// Checks what the analysis assumes about the scanner CLI against the real one: SCANNER_VERSION, else
// the default. The Scanner workflow runs it for each version the action is tested with.
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync } from 'node:fs'
import fc from 'fast-check'
import { formatProperties } from '../src/analyze.js'
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
