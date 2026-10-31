// One job summary per run, as Markdown for the run's summary page. Names, paths and messages may come
// from a fork's build, its artifact or its pull request: they reach the summary only through escaped().
import { appendFileSync } from 'node:fs'
import { warn, type LeftOut } from './warnings.js'

// Every other character becomes a character reference, which Markdown and HTML both show as itself:
// no link, image, emphasis, table cell or tag can start from it, nor an autolink from a dot or colon.
// GitHub still links an email address after decoding them, so a <wbr> after each @ splits it.
// Bidirectional controls would reorder the text after them, so they show as U+FFFD.
const PLAIN = /^[A-Za-z0-9 ]$/u
const BIDI = /^\p{Bidi_Control}$/u

function references(text: string, split: boolean): string {
  let out = ''
  for (const character of text) {
    const shown = BIDI.test(character) ? '\uFFFD' : character
    if (PLAIN.test(shown)) out += shown
    else out += `&#${String(shown.codePointAt(0))};`
    if (split && shown === '@') out += '<wbr>'
  }
  return out
}

export const escaped = (text: string): string => references(text, true)

const code = (text: string): string => `<code>${escaped(text)}</code>`

const list = (items: string[]): string => items.map(code).join(', ')

function table(rows: [string, string][]): string {
  const body = rows.map(([name, value]) => `| ${name} | ${value} |`).join('\n')
  return `| | |\n|---|---|\n${body}`
}

const shown = (item: LeftOut): string =>
  'names' in item ? list(item.names) : `${code(item.key)}: ${code(item.entry)}`

const LEFT_OUT: [LeftOut['kind'], string][] = [
  ['setting', 'Settings'],
  ['entry', 'Path entries'],
  ['file', 'Files'],
  ['link', 'Links']
]

function leftOutRows(items: LeftOut[]): [string, string][] {
  return LEFT_OUT.flatMap(([kind, name]): [string, string][] => {
    const ofKind = items.filter((item) => item.kind === kind)
    return ofKind.length > 0 ? [[name, ofKind.map(shown).join(', ')]] : []
  })
}

const count = (value: number): string => value.toLocaleString('en-GB')

// Rounded up, so a small artifact never reads as empty.
function size(bytes: number): string {
  const kilobytes = Math.ceil(bytes / 1024)
  return kilobytes < 1024
    ? `${count(kilobytes)} KB`
    : `${count(Math.ceil(bytes / 1_048_576))} MB`
}

// Only a web page on the server the scanner reported: the build in direct mode could write
// report-task.txt itself.
function link(report: Report | undefined): string {
  if (!report?.dashboardUrl || !report.serverUrl) return ''
  let page: URL
  try {
    page = new URL(report.dashboardUrl)
    if (page.origin !== new URL(report.serverUrl).origin) return ''
  } catch {
    return ''
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return ''
  // The origin leaves out a user name and password, which the page would show.
  if (page.username || page.password) return ''
  // A <wbr> in an attribute would be part of the URL.
  return ` <a href="${references(page.href, false)}">See the analysis</a>`
}

// GitHub shows at most 10 warnings of a step as annotations.
function warned(warnings: number): string {
  if (warnings === 0) return ''
  if (warnings === 1) return '\n\n1 warning: see the annotations.'
  if (warnings <= 10)
    return `\n\n${count(warnings)} warnings: see the annotations.`
  return `\n\n${count(warnings)} warnings: see the log. GitHub shows at most 10 of them as annotations.`
}

export type Report = { dashboardUrl?: string; serverUrl?: string }

// The analysis page and its server, from the report-task.txt the scanner writes after each upload.
export function readReport(text: string): Report {
  const report: Report = {}
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at < 0) continue
    const key = line.slice(0, at)
    // Plain key=value lines, as SonarSource's own quality gate action reads them.
    const value = line.slice(at + 1)
    if (key === 'dashboardUrl') report.dashboardUrl = value
    if (key === 'serverUrl') report.serverUrl = value
  }
  return report
}

const TOOLS: Record<string, string> = {
  maven: 'the Maven build',
  gradle: 'the Gradle build',
  npm: 'the npm scanner'
}

export function directSummary(facts: {
  projectKey: string
  tool: string
  scannerVersion: string
  report?: Report | undefined
  warnings: number
}): string {
  const build =
    facts.tool === 'scanner'
      ? `the scanner CLI ${escaped(facts.scannerVersion)}`
      : (TOOLS[facts.tool] ?? escaped(facts.tool))
  return `### ✅ Sonar analysis\n\nAnalysed ${code(facts.projectKey)} directly with ${build}.${link(facts.report)}${warned(facts.warnings)}`
}

export function prepareSummary(facts: {
  artifact: string
  pullRequest: boolean
  settings: number
  leftOut: string[]
  outside: LeftOut[]
  files: number
  // The zip's size, as the run's artifact list shows it; the upload may not report one.
  bytes?: number | undefined
  warnings: number
}): string {
  const rows: [string, string][] = [
    ['Artifact', code(facts.artifact)],
    ['Settings carried over', count(facts.settings)]
  ]
  if (facts.leftOut.length > 0)
    rows.push(['Settings left out', list(facts.leftOut)])
  if (facts.outside.length > 0)
    rows.push([
      'Paths outside the workspace',
      facts.outside.map(shown).join(', ')
    ])
  rows.push(['Files shipped', count(facts.files)])
  if (facts.bytes !== undefined) rows.push(['Size', size(facts.bytes)])
  const next = facts.pullRequest ? 'this pull request' : 'this build'
  return `### 📦 Sonar analysis prepared\n\nThe Sonar workflow analyses ${next} when this run finishes, using what this build ships:\n\n${table(rows)}${warned(facts.warnings)}`
}

export function analyzeSummary(facts: {
  pullRequest?: string | undefined
  branch?: string | undefined
  repository: string
  commit: string
  scannerVersion: string
  untested: string[]
  turnedOn: string[]
  leftOut: LeftOut[]
  report?: Report | undefined
  warnings: number
}): string {
  let what = ''
  if (facts.pullRequest)
    what = ` of pull request #${escaped(facts.pullRequest)}`
  else if (facts.branch) what = ` of branch ${code(facts.branch)}`
  const onBranch =
    facts.pullRequest && facts.branch ? ` on branch ${code(facts.branch)}` : ''
  const untested =
    facts.untested.length > 0
      ? `\n\nLanguages this action isn't tested with stay off: ${list(facts.untested)}.`
      : ''
  const on =
    facts.turnedOn.length > 0
      ? `\n\nTurned on by build-arguments: ${list(facts.turnedOn)}.`
      : ''
  const left =
    facts.leftOut.length > 0
      ? `\n\nLeft out of the analysis:\n\n${table(leftOutRows(facts.leftOut))}`
      : ''
  return `### ✅ Sonar analysis${what}\n\nAnalysed commit ${code(facts.commit.slice(0, 7))}${onBranch} of ${code(facts.repository)} with the scanner CLI ${escaped(facts.scannerVersion)}.${link(facts.report)}\n\nTurned off: dependency analysis and build-system autoconfiguration.${untested}${on}${left}${warned(facts.warnings)}`
}

export type Reason = { text: string; markdown: string }

// Why a run had nothing to do: the action's own words as Markdown, and each value it quotes from the
// run or the artifact as code. Numbers stay plain text.
export function reason(
  words: TemplateStringsArray,
  ...values: (string | number)[]
): Reason {
  let text = words[0] ?? ''
  let markdown = text
  values.forEach((value, at) => {
    const next = words[at + 1] ?? ''
    text += `${String(value)}${next}`
    markdown += `${typeof value === 'number' ? escaped(String(value)) : code(value)}${next}`
  })
  return { text, markdown }
}

export function skippedSummary(why: Reason): string {
  return `### ⏭️ No Sonar analysis\n\n${why.markdown}`
}

// A summary is a courtesy: failing to build or write one must never fail the analysis.
export function writeSummary(build: () => string): void {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  try {
    appendFileSync(path, `${build()}\n`)
  } catch (error) {
    warn(
      `Could not write the job summary: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
