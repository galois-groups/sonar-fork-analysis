import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import * as core from '../__fixtures__/core.js'
import type { LeftOut } from '../src/warnings.js'

vi.doMock('@actions/core', () => core)
const {
  analyzeSummary,
  directSummary,
  escaped,
  prepareSummary,
  readReport,
  reason,
  skippedSummary,
  writeSummary
} = await import('../src/summary.js')

const SONARCLOUD = {
  serverUrl: 'https://sonarcloud.io',
  dashboardUrl: 'https://sonarcloud.io/dashboard?id=key&pullRequest=12'
}

describe('escaped', () => {
  it('keeps letters, digits and spaces, and turns everything else into character references', () => {
    expect(escaped('Fixture 2')).toBe('Fixture 2')
    expect(escaped('[x](y)')).toBe('&#91;x&#93;&#40;y&#41;')
    expect(escaped('<b>')).toBe('&#60;b&#62;')
    expect(escaped('😀')).toBe('&#128512;')
  })

  // GitHub links an email address even after decoding the references.
  it('splits an email address so it stays text', () => {
    expect(escaped('a@b.c')).toBe('a&#64;<wbr>b&#46;c')
  })

  it('shows a bidirectional control as a replacement character', () => {
    expect(escaped('a\u202Eb\u2066c')).toBe('a&#65533;b&#65533;c')
  })

  // Only plain characters, references and <wbr> come out, so nothing in the text can be Markdown or
  // HTML syntax; and decoding the references gives the text back, without its bidirectional controls.
  it('lets no syntax through, whatever the text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const out = escaped(text)
        expect(out).toMatch(/^(?:[A-Za-z0-9 ]|&#\d+;(?:<wbr>)?)*$/)
        const decoded = out
          .replaceAll('<wbr>', '')
          .replace(/&#(\d+);/g, (_, point: string) =>
            String.fromCodePoint(Number(point))
          )
        expect(decoded).toBe(text.replace(/\p{Bidi_Control}/gu, '\uFFFD'))
      }),
      { numRuns: 1000 }
    )
  })
})

describe('readReport', () => {
  it('reads the analysis page and the server from report-task.txt', () => {
    expect(
      readReport(
        'projectKey=key\nserverUrl=https://sonarcloud.io\ndashboardUrlX\ndashboardUrl=https://sonarcloud.io/dashboard?id=key\nceTaskId=AZ-1\ndashboardUrlX\n'
      )
    ).toEqual({
      serverUrl: 'https://sonarcloud.io',
      dashboardUrl: 'https://sonarcloud.io/dashboard?id=key'
    })
  })
})

describe('directSummary', () => {
  it('names the project, the build and the analysis page', () => {
    expect(
      directSummary({
        projectKey: 'key',
        tool: 'maven',
        scannerVersion: '8.2.0.6438',
        report: SONARCLOUD,
        warnings: 0
      })
    ).toBe(
      '### ✅ Sonar analysis\n\nAnalysed <code>key</code> directly with the Maven build. <a href="https&#58;&#47;&#47;sonarcloud&#46;io&#47;dashboard&#63;id&#61;key&#38;pullRequest&#61;12">See the analysis</a>'
    )
  })

  it.each([
    ['another server', 'https://sonarcloud.io.evil.example/dashboard'],
    ['a password', 'https://user:secret@sonarcloud.io/dashboard'],
    ['a user name', 'https://user@sonarcloud.io/dashboard'],
    ['another scheme', 'javascript:alert(1)'],
    ['no URL at all', 'not a URL']
  ])('links no analysis page on %s', (_, dashboardUrl) => {
    const summary = directSummary({
      projectKey: 'key',
      tool: 'gradle',
      scannerVersion: '8.2.0.6438',
      report: { serverUrl: 'https://sonarcloud.io', dashboardUrl },
      warnings: 0
    })
    expect(summary).not.toContain('<a ')
    expect(summary).toContain('with the Gradle build.')
  })

  // Both have the same empty origin.
  it('links no script, even on a script server', () => {
    expect(
      directSummary({
        projectKey: 'key',
        tool: 'maven',
        scannerVersion: '8.2.0.6438',
        report: {
          serverUrl: 'javascript:x',
          dashboardUrl: 'javascript:alert(1)'
        },
        warnings: 0
      })
    ).not.toContain('<a ')
  })

  // A <wbr> there would be part of the URL.
  it('splits no @ in the link', () => {
    expect(
      directSummary({
        projectKey: 'key',
        tool: 'maven',
        scannerVersion: '8.2.0.6438',
        report: {
          serverUrl: 'https://sonarcloud.io',
          dashboardUrl: 'https://sonarcloud.io/x@y'
        },
        warnings: 0
      })
    ).toContain('<a href="https&#58;&#47;&#47;sonarcloud&#46;io&#47;x&#64;y">')
  })

  it('names the version of the scanner CLI it ran', () => {
    expect(
      directSummary({
        projectKey: 'key',
        tool: 'scanner',
        scannerVersion: '8.2.0.6438',
        warnings: 2
      })
    ).toBe(
      '### ✅ Sonar analysis\n\nAnalysed <code>key</code> directly with the scanner CLI 8&#46;2&#46;0&#46;6438.\n\n2 warnings: see the annotations.'
    )
  })

  it('links nothing without a server', () => {
    expect(
      directSummary({
        projectKey: 'key',
        tool: 'npm',
        scannerVersion: '8.2.0.6438',
        report: { dashboardUrl: SONARCLOUD.dashboardUrl },
        warnings: 0
      })
    ).not.toContain('<a ')
  })
})

describe('prepareSummary', () => {
  const facts = {
    artifact: 'sonar-fork-analysis-key',
    pullRequest: true,
    settings: 42,
    leftOut: [],
    outside: [],
    files: 318,
    bytes: 40_000,
    warnings: 0
  }

  it('lists what the artifact carries', () => {
    expect(prepareSummary(facts)).toBe(
      [
        '### 📦 Sonar analysis prepared',
        '',
        'The Sonar workflow analyses this pull request when this run finishes, using what this build ships:',
        '',
        '| | |',
        '|---|---|',
        '| Artifact | <code>sonar&#45;fork&#45;analysis&#45;key</code> |',
        '| Settings carried over | 42 |',
        '| Files shipped | 318 |',
        '| Size | 40 KB |'
      ].join('\n')
    )
  })

  it('adds what was left out and the warnings when there are any', () => {
    const summary = prepareSummary({
      ...facts,
      pullRequest: false,
      leftOut: ['sonar.a', 'x|y'],
      outside: [
        { kind: 'entry', key: 'sonar.sources', entry: '/etc', text: '' },
        { kind: 'entry', key: 'sonar.tests', entry: '../t', text: '' }
      ],
      warnings: 2
    })
    expect(summary).toContain('analyses this build when this run finishes')
    expect(summary).toContain(
      '| Settings left out | <code>sonar&#46;a</code>, <code>x&#124;y</code> |\n| Paths outside the workspace | <code>sonar&#46;sources</code>: <code>&#47;etc</code>, <code>sonar&#46;tests</code>: <code>&#46;&#46;&#47;t</code> |\n| Files shipped |'
    )
    expect(summary).toMatch(/\n\n2 warnings: see the annotations\.$/)
    expect(prepareSummary({ ...facts, warnings: 1 })).toMatch(
      /\n\n1 warning: see the annotations\.$/
    )
  })

  // GitHub shows at most 10 warnings of a step as annotations.
  it('sends to the log for more than 10 warnings', () => {
    expect(prepareSummary({ ...facts, warnings: 10 })).toMatch(
      /\n\n10 warnings: see the annotations\.$/
    )
    expect(prepareSummary({ ...facts, warnings: 1234 })).toMatch(
      /\n\n1,234 warnings: see the log\. GitHub shows at most 10 of them as annotations\.$/
    )
  })

  it('cuts long lists of what it leaves out', () => {
    const summary = prepareSummary({
      ...facts,
      leftOut: ['a'.repeat(10_001)],
      outside: Array.from({ length: 1000 }, (_, i) => ({
        kind: 'entry' as const,
        key: 'sonar.java.libraries',
        entry: `/cache/m2/${String(i)}.jar`,
        text: ''
      }))
    })
    expect(summary).toContain(
      '| Settings left out | Too long to show here: see the log |'
    )
    expect(summary).toMatch(
      /\| Paths outside the workspace \| .{9000,10000} and [\d,]+ more: see the log \|/
    )
  })

  it('leaves out the size when the upload gives none', () => {
    expect(prepareSummary({ ...facts, bytes: undefined })).toMatch(
      /\| Files shipped \| 318 \|$/
    )
  })

  // Rounded up, so a small artifact never reads as empty.
  it.each([
    [1, '1 KB'],
    [1023 * 1024, '1,023 KB'],
    [1_048_575, '1 MB'],
    [1_048_577, '2 MB'],
    [27 * 1_048_576, '27 MB']
  ])('gives %d bytes as %s', (bytes, shown) => {
    expect(prepareSummary({ ...facts, bytes })).toContain(`| Size | ${shown} |`)
  })
})

describe('analyzeSummary', () => {
  const facts = {
    pullRequest: '12',
    branch: 'feature/x',
    repository: 'fork/repo',
    commit: 'abcdef0123456789',
    scannerVersion: '8.2.0.6438',
    untested: [],
    turnedOn: [],
    leftOut: [],
    report: SONARCLOUD,
    warnings: 0
  }

  it('names the pull request, the commit, the fork and what stays off', () => {
    expect(analyzeSummary({ ...facts, untested: ['cpp', 'rust'] })).toBe(
      [
        '### ✅ Sonar analysis of pull request #12',
        '',
        'Analysed commit <code>abcdef0</code> on branch <code>feature&#47;x</code> of <code>fork&#47;repo</code> with the scanner CLI 8&#46;2&#46;0&#46;6438. <a href="https&#58;&#47;&#47;sonarcloud&#46;io&#47;dashboard&#63;id&#61;key&#38;pullRequest&#61;12">See the analysis</a>',
        '',
        'Turned off: dependency analysis and build-system autoconfiguration.',
        '',
        "Languages this action isn't tested with stay off: <code>cpp</code>, <code>rust</code>."
      ].join('\n')
    )
  })

  it('names a branch, the languages build-arguments turned on and the warnings', () => {
    const summary = analyzeSummary({
      ...facts,
      pullRequest: undefined,
      branch: 'release',
      turnedOn: ['sonar.lang.patterns.py'],
      warnings: 3
    })
    expect(summary).toMatch(
      /^### ✅ Sonar analysis of branch <code>release<\/code>\n/
    )
    expect(summary).not.toContain(' on branch')
    expect(summary).toContain(
      'Turned on by build-arguments: <code>sonar&#46;lang&#46;patterns&#46;py</code>.'
    )
    expect(summary).toMatch(/3 warnings: see the annotations\.$/)
  })

  it('lists what it left out by kind', () => {
    const summary = analyzeSummary({
      ...facts,
      leftOut: [
        { kind: 'link', names: ['node_modules/a'], text: '' },
        { kind: 'file', names: ['src/Evil.java'], text: '' },
        { kind: 'setting', names: ['sonar.host.url', 'sonar.x'], text: '' },
        { kind: 'entry', key: 'sonar.sources', entry: '.flat', text: '' },
        { kind: 'setting', names: ['sonar.y'], text: '' }
      ],
      warnings: 1
    })
    expect(summary).toContain(
      [
        'build-system autoconfiguration.',
        '',
        'Left out of the analysis:',
        '',
        '| | |',
        '|---|---|',
        '| Settings | <code>sonar&#46;host&#46;url</code>, <code>sonar&#46;x</code>, <code>sonar&#46;y</code> |',
        '| Path entries | <code>sonar&#46;sources</code>: <code>&#46;flat</code> |',
        '| Files | <code>src&#47;Evil&#46;java</code> |',
        '| Links | <code>node&#95;modules&#47;a</code> |',
        '',
        '1 warning'
      ].join('\n')
    )
    expect(analyzeSummary(facts)).not.toContain('Left out')
  })

  // GitHub drops a step's whole summary above 1 MiB.
  describe('a long list', () => {
    const row = (leftOut: LeftOut[]): string =>
      /\n\| Files \| (.*) \|$/m.exec(analyzeSummary({ ...facts, leftOut }))![1]
    const files = (...names: string[]): LeftOut[] => [
      { kind: 'file', names, text: '' }
    ]

    it('stops at about 10,000 characters and counts the rest', () => {
      const names = Array.from({ length: 2000 }, (_, i) => `f${String(i)}`)
      const shown = row(files(...names))
      const cut =
        /^((?:<code>f\d+<\/code>, )*<code>f\d+<\/code>) and ([\d,]+) more: see the log$/.exec(
          shown
        )
      expect(cut).not.toBeNull()
      expect(cut![1].length).toBeLessThanOrEqual(10_000)
      expect(cut![1].length).toBeGreaterThan(9_900)
      const listed = cut![1].split(', ').length
      expect(Number(cut![2].replace(',', ''))).toBe(2000 - listed)
    })

    it('measures names as written, after escaping', () => {
      expect(row(files('/'.repeat(5000)))).toBe(
        'Too long to show here: see the log'
      )
      expect(row(files('a', '/'.repeat(5000)))).toBe(
        '<code>a</code> and 1 more: see the log'
      )
    })

    it('shows nothing of a name too long by itself', () => {
      expect(row(files('a'.repeat(10_001)))).toBe(
        'Too long to show here: see the log'
      )
      expect(row(files('a', 'b'.repeat(10_001), 'c'))).toBe(
        '<code>a</code> and 2 more: see the log'
      )
      expect(row(files('a'.repeat(9_000)))).toBe(
        `<code>${'a'.repeat(9_000)}</code>`
      )
      const entry: LeftOut = {
        kind: 'entry',
        key: 'sonar.sources',
        entry: 'a'.repeat(10_000),
        text: ''
      }
      expect(analyzeSummary({ ...facts, leftOut: [entry] })).toContain(
        '| Path entries | Too long to show here: see the log |'
      )
    })

    it('keeps any list under the limit', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ unit: 'binary', maxLength: 2000 }), {
            maxLength: 100
          }),
          (names) => {
            expect(row(files(...names)).length).toBeLessThanOrEqual(10_100)
          }
        )
      )
    })
  })

  it('names neither for the default branch', () => {
    expect(
      analyzeSummary({ ...facts, pullRequest: undefined, branch: undefined })
    ).toMatch(/^### ✅ Sonar analysis\n\nAnalysed commit/)
  })
})

describe('reason', () => {
  it('quotes each value as code in the summary and as itself in the log', () => {
    const branch = '[here](x)'
    expect(reason`No ${branch} for #${12}.`).toEqual({
      text: 'No [here](x) for #12.',
      markdown: 'No <code>&#91;here&#93;&#40;x&#41;</code> for #12.'
    })
  })
})

describe('skippedSummary', () => {
  it('gives the reason under its heading', () => {
    expect(skippedSummary(reason`Nothing to analyse.`)).toBe(
      '### ⏭️ No Sonar analysis\n\nNothing to analyse.'
    )
  })
})

describe('writeSummary', () => {
  const saved = { ...process.env }
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'summary-'))
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(directory, { recursive: true, force: true })
  })

  it('appends to the job summary', () => {
    process.env.GITHUB_STEP_SUMMARY = join(directory, 'summary.md')
    writeSummary(() => 'one')
    writeSummary(() => 'two')
    expect(readFileSync(join(directory, 'summary.md'), 'utf8')).toBe(
      'one\ntwo\n'
    )
  })

  it('does nothing outside GitHub Actions', () => {
    delete process.env.GITHUB_STEP_SUMMARY
    writeSummary(() => 'one')
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('only warns when it cannot write', () => {
    process.env.GITHUB_STEP_SUMMARY = directory
    writeSummary(() => 'one')
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not write the job summary')
    )
  })

  it('only warns when it cannot build the summary', () => {
    process.env.GITHUB_STEP_SUMMARY = join(directory, 'summary.md')
    writeSummary(() => {
      throw new Error('gone')
    })
    expect(core.warning).toHaveBeenCalledWith(
      'Could not write the job summary: gone'
    )
  })
})
