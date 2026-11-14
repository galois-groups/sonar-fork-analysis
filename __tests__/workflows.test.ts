import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { TESTED_LANGUAGES } from '../src/languages.js'
import { DEFAULT_VERSION, TESTED_VERSIONS } from '../src/scanner.js'

interface Matrix {
  include?: Record<string, string>[]
  [key: string]: unknown
}

interface Job {
  strategy?: { matrix: Matrix }
  steps?: { env?: Record<string, string> }[]
}

function jobs(workflow: string): Record<string, Job> {
  const content = readFileSync(`.github/workflows/${workflow}`, 'utf8')
  return (parse(content) as { jobs: Record<string, Job> }).jobs
}

function matrix(workflow: string, job: string): Matrix {
  const strategy = jobs(workflow)[job].strategy
  if (!strategy) throw new Error(`${workflow} has no matrix in ${job}`)
  return strategy.matrix
}

function fixtures(workflow: string, job: string): string[] {
  const { include, fixture } = matrix(workflow, job)
  return (include?.map((entry) => entry.fixture) ?? fixture) as string[]
}

const sorted = (values: readonly string[]): string[] => [...values].sort()

describe('the workflows', () => {
  it('check every tested CLI', () => {
    expect(matrix('scanner.yml', 'cli').version).toEqual(TESTED_VERSIONS)
    expect(matrix('fixtures.yml', 'other-scanners').version).toEqual(
      TESTED_VERSIONS.filter((version) => version !== DEFAULT_VERSION)
    )
  })

  it('analyse every fixture', () => {
    // fixtures/node_modules holds trap packages that the JavaScript fixtures resolve.
    const folders = readdirSync('fixtures', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name)
    for (const [workflow, job] of [
      ['fixtures.yml', 'direct'],
      ['fixtures.yml', 'prepare'],
      ['fixtures.yml', 'compare'],
      ['fork-path.yml', 'analyze']
    ])
      expect(sorted(fixtures(workflow, job)), `${workflow} ${job}`).toEqual(
        sorted(folders)
      )
  })

  // A language missing from LANGUAGES fails the comparison. One left there after it stops being
  // tested would not.
  it('compare only tested languages', () => {
    const languages = jobs('fixtures.yml')
      .compare.steps?.find((step) => step.env?.LANGUAGES)
      ?.env?.LANGUAGES.split(',')
    expect(languages).toBeDefined()
    expect(TESTED_LANGUAGES).toEqual(expect.arrayContaining(languages ?? []))
  })
})
