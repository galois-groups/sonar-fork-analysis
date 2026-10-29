// Checks what the analysis assumes about the scanner engine against the real ones, which SonarCloud and
// the latest SonarQube serve and change without notice. Also SonarCloud's languages and SonarSource's
// key, as they are today. None of this depends on the scanner CLI's version.
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import fc from 'fast-check'
import { NO_FILE, TESTED_LANGUAGES } from '../src/languages.js'
import { REREAD_PATH, moduleTree } from '../src/settings.js'
import { signingKey } from '../src/scanner.js'
import { SONARSOURCE_KEY, checkSignature } from '../src/signature.js'
import type { PublicKey } from 'openpgp'
import {
  engineEntry,
  moduleSettings,
  plausibleModuleSettings,
  settingText,
  trustedKeys
} from './arbitraries.js'
import {
  Probe,
  engines,
  sonarCloudEngine,
  sonarQubeEngine
} from './scanner-probe.js'

// Sampled: about 640 trees with 2500 modules get through per 1000; well below that, the check says
// little.
const MIN_ACCEPTED = 400
const MIN_MODULES = 1500

describe.each([
  {
    name: 'SonarCloud',
    download: sonarCloudEngine,
    known: '__tests__/java/engine-processes-sonarcloud.txt'
  },
  {
    name: 'SonarQube',
    download: sonarQubeEngine,
    known: '__tests__/java/engine-processes-sonarqube.txt'
  }
])("$name's engine", ({ download, known }) => {
  let engine: string
  let probe: Probe

  beforeAll(async () => {
    mkdirSync(engines, { recursive: true })
    engine = await download(engines)
    console.info(`Checking against ${engine}`)
    probe = new Probe([engine])
  }, 600_000)

  it('splits a path list into exactly the entries the analysis checked', () => {
    const seed = Date.now()
    const lists = fc.sample(
      fc.array(
        settingText
          .map((text) => `/${text}`)
          .filter((path) => !path.includes(',') && !REREAD_PATH.test(path)),
        { minLength: 1, maxLength: 4 }
      ),
      { numRuns: 1000, seed }
    )
    const split = probe.splitLists(lists.map((list) => list.join(',')))
    lists.forEach((list, index) => {
      expect({ seed, split: split[index] }).toEqual({ seed, split: list })
    })
  })

  it('trims list entries as the model of it says', () => {
    const seed = Date.now()
    // Quotes, commas and line breaks make more entries; the model is about trimming one.
    const entries = fc.sample(
      settingText.filter((text) => !/[",\r\n]/.test(text)),
      { numRuns: 1000, seed }
    )
    const split = probe.splitLists(entries)
    entries.forEach((entry, index) => {
      const read = engineEntry(entry)
      expect({ seed, entry, split: split[index] }).toEqual({
        seed,
        entry,
        split: read === undefined ? [] : [read]
      })
    })
  })

  it('gives every setting to the module the analysis checked it for', () => {
    const seed = Date.now()
    const accepted = fc
      .sample(
        fc.oneof(
          { weight: 3, arbitrary: plausibleModuleSettings },
          { weight: 1, arbitrary: moduleSettings }
        ),
        { numRuns: 1000, seed }
      )
      .map((generated) => {
        const settings = new Map([
          ...generated,
          ...trustedKeys.map((key): [string, string] => [key, 'trusted'])
        ])
        try {
          return { settings, tree: moduleTree(settings) }
        } catch {
          return undefined
        }
      })
      .filter((tree) => tree !== undefined)
    const walks = probe.walkModules(accepted.map(({ settings }) => settings))
    const sorted = (modules: Map<string, string[]>): [string, string[]][] =>
      [...modules]
        .map(([path, keys]): [string, string[]] => [path, [...keys].sort()])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    let modules = 0
    accepted.forEach(({ settings, tree }, index) => {
      // The engine names a module by its ids joined with dots: the analysis's prefix without the dot.
      const ours = new Map(
        tree.prefixes.map((prefix): [string, string[]] => [
          prefix.slice(0, -1),
          []
        ])
      )
      for (const key of settings.keys()) {
        const { prefix, bareKey } = tree.split(key)
        ours.get(prefix.slice(0, -1))?.push(bareKey)
      }
      const walk = walks[index]
      expect({
        seed,
        settings,
        refused: walk.refused,
        modules: sorted(walk.modules)
      }).toEqual({ seed, settings, refused: undefined, modules: sorted(ours) })
      modules += ours.size - 1
    })
    // Most generated trees are refused or flat; enough must get through for this to say anything.
    expect({
      seed,
      accepted: accepted.length,
      modules,
      enough: accepted.length > MIN_ACCEPTED && modules > MIN_MODULES
    }).toMatchObject({ enough: true })
  })

  // The methods a method calls, in order: a class's own by name, others as Class.name.
  const calls = (className: string, method: string): string[] =>
    probe
      .bytecode(engine, className, method)
      .map(
        (line) =>
          /\/\/ (?:Interface)?Method (?:[\w/$]*\/)?([\w$]+\.)?(\w+):/.exec(
            line
          ) ?? []
      )
      .filter((match) => match.length > 0)
      .map(([, owner = '', name]) => `${owner}${name}`)

  // On the fork path the analysis turns untested languages off. That keeps their analyzers out of the
  // job only while the engine loads a language's analyzers once it has detected the language.
  it('loads analyzers only for the languages it detects, unless told otherwise', () => {
    const start = probe.bytecode(
      engine,
      'org.sonar.scanner.bootstrap.ScannerPluginRepository',
      'start'
    )
    // The switch and its default: SonarQube reads the first, SonarCloud the second.
    const read = start.findIndex((line) => /String sonar\.plugins\./.test(line))
    const key = /String (sonar\.plugins\.\w+)/.exec(start[read] ?? '')?.[1]
    const fallback = start
      .slice(read)
      .map((line) => /\b(iconst_[01])\b/.exec(line)?.[1])
      .find(Boolean)
    expect({ engine, key, fallback }).toMatchObject({
      key: expect.toBeOneOf([
        'sonar.plugins.downloadOnlyRequired',
        'sonar.plugins.loadAll'
      ]),
      fallback:
        key === 'sonar.plugins.downloadOnlyRequired' ? 'iconst_1' : 'iconst_0'
    })
    expect(start.join('\n')).toContain('PluginInstaller.installRequiredPlugins')
    // Later, the project's scan hands the detected languages to the repository.
    const scan = calls(
      'org.sonar.scanner.scan.SpringProjectScanContainer',
      'doBeforeStart'
    )
    expect({ engine, scan }).toMatchObject({
      scan: expect.arrayContaining([
        'LanguageDetection.getDetectedLanguages',
        'installPluginsForLanguages'
      ])
    })
    expect(scan.indexOf('installPluginsForLanguages')).toBe(
      scan.indexOf('LanguageDetection.getDetectedLanguages') + 1
    )
    expect(
      calls(
        'org.sonar.scanner.scan.SpringProjectScanContainer',
        'installPluginsForLanguages'
      )
    ).toContain('ScannerPluginRepository.installPluginsForLanguages')
    expect(
      calls(
        'org.sonar.scanner.bootstrap.ScannerPluginRepository',
        'installPluginsForLanguages'
      )
    ).toContain('PluginInstaller.installPluginsForLanguages')
  })

  // The analysis turns off a language by setting sonar.lang.patterns.<language> to a pattern no file
  // matches. That only works while the engine reads the setting before the language's own patterns,
  // and uses them only when the setting gives none.
  it("reads sonar.lang.patterns.<language> before the language's own patterns", () => {
    const order = calls(
      'org.sonar.scanner.scan.filesystem.LanguageDetection',
      'org.sonar.scanner.scan.filesystem.LanguageDetection'
    )
    const at = (name: string): number => order.indexOf(name)
    expect({ engine, order }).toMatchObject({
      order: expect.arrayContaining([
        'getFileLangPatternPropKey',
        'Configuration.getStringArray',
        'PathPattern.create',
        'getLanguagePatterns'
      ])
    })
    expect(at('getFileLangPatternPropKey')).toBeLessThan(
      at('Configuration.getStringArray')
    )
    expect(at('Configuration.getStringArray')).toBeLessThan(
      at('PathPattern.create')
    )
    expect(at('PathPattern.create')).toBeLessThan(at('getLanguagePatterns'))
    // Between the two, the check that skips the language's own patterns when the setting gives any:
    // merging both lists would keep the order above.
    const constructor = probe.bytecode(
      engine,
      'org.sonar.scanner.scan.filesystem.LanguageDetection',
      'org.sonar.scanner.scan.filesystem.LanguageDetection'
    )
    const between = constructor.slice(
      constructor.findIndex((line) => line.includes('PathPattern.create')),
      constructor.findIndex((line) => line.includes('getLanguagePatterns'))
    )
    expect({ engine, between }).toMatchObject({
      between: expect.arrayContaining([
        expect.stringMatching(/\barraylength\b/),
        expect.stringMatching(/\bifle\b/)
      ])
    })
  })

  it('matches no file of a checkout with the pattern that turns a language off', () => {
    const workspace = '/home/runner/work/repo/repo'
    // Paths a fork chooses, including ones spelled like the pattern.
    const paths = [
      'src/x.py',
      'test/evil.rs',
      'never',
      'never/never',
      'sonar-fork-analysis/never',
      '.git/sonar-fork-analysis/never',
      '.GIT/SONAR-FORK-ANALYSIS/NEVER',
      'a/.git/sonar-fork-analysis/never',
      'dev/null/never',
      'file:/dev/null/never'
    ]
    const results = probe.matches([
      // Shows the probe matches at all.
      {
        pattern: '**/*.py',
        absolute: `${workspace}/src/x.py`,
        relative: 'src/x.py'
      },
      ...paths.map((path) => ({
        pattern: NO_FILE,
        absolute: `${workspace}/${path}`,
        relative: path
      }))
    ])
    expect({ engine, results }).toEqual({
      engine,
      results: [
        { patterns: 1, matched: true },
        ...paths.map(() => ({ patterns: 1, matched: false }))
      ]
    })
  })

  // A new process start inside a listed class goes unnoticed here; Fixtures Sonar's traps catch
  // those at run time.
  it('has no class that can start a process beyond the reviewed ones', () => {
    const listed = readFileSync(known, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean)
    const unknown = probe
      .processClasses(engine)
      .filter((name) => !listed.includes(name))
    // New ones need a look: does any of them run something from the checkout, and if so, can a
    // trusted setting turn it off? Then add them to the list.
    expect({ engine, unknown }).toEqual({ engine, unknown: [] })
  })
})

// On the fork path the analysis turns off every language outside TESTED_LANGUAGES. A tested language
// SonarCloud renames or drops would be turned off with them, silently.
describe("SonarCloud's languages", () => {
  it('still include every tested language, all named as the analysis expects', async () => {
    const response = await fetch(
      'https://sonarcloud.io/api/languages/list?ps=0'
    )
    expect(response.status).toBe(200)
    const { languages } = (await response.json()) as {
      languages: { key: string }[]
    }
    const keys = languages.map(({ key }) => key)
    expect(TESTED_LANGUAGES.filter((key) => !keys.includes(key))).toEqual([])
    // The analysis refuses a list with any other key.
    expect(keys.filter((key) => !/^\w+$/.test(key))).toEqual([])
  })
})

// The signature checks on SonarSource's own key and signatures, as the key servers and Sonar serve them
// today. Only the key servers' copies carry the revocations: if they stopped serving one, the action
// would trust the revoked subkey again.
describe("SonarSource's key and signatures", () => {
  let key: PublicKey

  const signature = async (name: string): Promise<string> => {
    const response = await fetch(
      `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/${name}.zip.asc`,
      { signal: AbortSignal.timeout(60_000) }
    )
    expect(response.status).toBe(200)
    return response.text()
  }

  beforeAll(async () => {
    key = await signingKey()
  }, 120_000)

  it('come from the key the action pins', () => {
    expect(key.getFingerprint()).toBe(SONARSOURCE_KEY)
  })

  it('still mark the subkey revoked as compromised', async () => {
    const name = 'sonar-scanner-cli-7.3.0.5189'
    await expect(
      checkSignature(new Uint8Array(), await signature(name), key, name)
    ).rejects.toThrow(
      `${name} is signed with the subkey 2161D72E7DCD4258, which SonarSource revoked on 2025-11-30: key compromised`
    )
  })

  it("name the valid subkey whose signature the data doesn't match", async () => {
    const name = 'sonar-scanner-cli-8.2.0.6438'
    await expect(
      checkSignature(new Uint8Array(), await signature(name), key, name)
    ).rejects.toThrow(
      `${name} doesn't match its signature by the subkey C33B56C147B01975`
    )
  })
})
