import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '../__fixtures__/core.js'

vi.doMock('@actions/core', () => core)
const { ErrorLines } = await import('../src/tool-errors.js')
const { forgetSecrets, secret } = await import('../src/secrets.js')

type Tool = 'maven' | 'gradle' | 'npm' | 'scanner'

// The whole output in one chunk on one stream, as exec hands it to a listener.
function errors(
  tool: Tool,
  output: string,
  stream: 'stdout' | 'stderr' = 'stdout'
) {
  const lines = new ErrorLines(tool)
  lines[stream](Buffer.from(output))
  return lines.end()
}

// Each tool's own output, from a build that doesn't compile or a server it can't reach.
const MAVEN = `[INFO] --- compiler:3.16.0:compile (default-compile) @ x ---
[INFO] -------------------------------------------------------------
[ERROR] COMPILATION ERROR :
[INFO] -------------------------------------------------------------
[ERROR] /p/src/main/java/x/A.java:[1,39] incompatible types: java.lang.String cannot be converted to int
[INFO] 1 error
[INFO] -------------------------------------------------------------
[INFO] ------------------------------------------------------------------------
[ERROR] BUILD FAILURE
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  0.934 s
[INFO] ------------------------------------------------------------------------
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.16.0:compile (default-compile) on project x: Compilation failure
[ERROR] /p/src/main/java/x/A.java:[1,39] incompatible types: java.lang.String cannot be converted to int
[ERROR] -> [Help 1]
[ERROR]
[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.
[ERROR] Re-run Maven using the -X switch to enable full debug logging.
[ERROR]
[ERROR] For more information about the errors and possible solutions, please read the following articles:
[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException`

const GRADLE = `/p/src/main/java/x/A.java:1: error: incompatible types: String cannot be converted to int
package x; class A { int f() { return "s"; } }
                                      ^
1 error

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':compileJava'.
> Compilation failed; see the compiler output below.
  /p/src/main/java/x/A.java:1: error: incompatible types: String cannot be converted to int

* Try:
> Check your code and dependencies to fix the compilation error(s)
> Run with --scan to get full insights from a Build Scan (powered by Develocity).

BUILD FAILED in 11s`

const SCANNER = `16:44:51.518 INFO    Source paths: src
16:44:51.854 ERROR File packages/shared/src/index.ts can't be indexed twice. Please check that inclusion/exclusion patterns produce disjoint sets for main and test files
16:44:51.879 INFO  EXECUTION FAILURE
16:44:51.880 INFO  Total time: 19.680s`

const NPM = `[INFO]  Bootstrapper: Server URL: http://127.0.0.1:9
[INFO]  Bootstrapper: Version: 5.0.2
[ERROR] Bootstrapper: Failed to fetch server version: Error: connect ECONNREFUSED 127.0.0.1:9
[ERROR] Bootstrapper: Verify that http://127.0.0.1:9 is a valid SonarQube server`

describe('ErrorLines', () => {
  beforeEach(() => {
    forgetSecrets()
  })

  it("keeps Maven's failed goal and what follows, without its help", () => {
    expect(errors('maven', MAVEN)).toEqual([
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.16.0:compile (default-compile) on project x: Compilation failure',
      '[ERROR] /p/src/main/java/x/A.java:[1,39] incompatible types: java.lang.String cannot be converted to int'
    ])
  })

  it('keeps what Gradle says went wrong, without what to try', () => {
    expect(errors('gradle', GRADLE)).toEqual([
      "Execution failed for task ':compileJava'.",
      '> Compilation failed; see the compiler output below.',
      '  /p/src/main/java/x/A.java:1: error: incompatible types: String cannot be converted to int'
    ])
  })

  it("keeps the scanners' error lines", () => {
    expect(errors('scanner', SCANNER)).toEqual([
      "16:44:51.854 ERROR File packages/shared/src/index.ts can't be indexed twice. Please check that inclusion/exclusion patterns produce disjoint sets for main and test files"
    ])
    expect(errors('npm', NPM)).toEqual([
      '[ERROR] Bootstrapper: Failed to fetch server version: Error: connect ECONNREFUSED 127.0.0.1:9',
      '[ERROR] Bootstrapper: Verify that http://127.0.0.1:9 is a valid SonarQube server'
    ])
  })

  it('keeps 20 lines: the first of a block, the last of the scanners', () => {
    const block = Array.from({ length: 30 }, (_, i) => `> line ${String(i)}`)
    expect(
      errors('gradle', ['* What went wrong:', ...block].join('\n'))
    ).toEqual(block.slice(0, 20))
    const scanner = Array.from(
      { length: 30 },
      (_, i) => `16:44:51.854 ERROR line ${String(i)}`
    )
    expect(errors('scanner', scanner.join('\n'))).toEqual(scanner.slice(10))
  })

  it('cuts a long line after taking the secrets out', () => {
    const token = 'sqa_not_a_real_token'
    secret(token)
    // The token runs from character 292 to 312, across the cut at 300.
    const line = `[ERROR] Bootstrapper: ${'x'.repeat(270)}${token}${'y'.repeat(100)}`
    const [cut] = errors('npm', line)
    expect(cut).toBe(
      `[ERROR] Bootstrapper: ${'x'.repeat(270)}***${'y'.repeat(5)}…`
    )
    expect(cut).not.toContain('sqa')
  })

  it("ends Maven's block at the blank line after a goal that failed on one line", () => {
    expect(
      errors(
        'maven',
        [
          '[ERROR] Failed to execute goal org.sonarsource.scanner.maven:sonar-maven-plugin:5.1.0.4751:sonar (default-cli) on project x: Project not found -> [Help 1]',
          '[ERROR] ',
          '[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.'
        ].join('\n')
      )
    ).toEqual([
      '[ERROR] Failed to execute goal org.sonarsource.scanner.maven:sonar-maven-plugin:5.1.0.4751:sonar (default-cli) on project x: Project not found -> [Help 1]'
    ])
  })

  it('splits lines at \\n and \\r\\n, across chunks, and keeps a last line without one', () => {
    const lines = new ErrorLines('npm')
    const euro = Buffer.from('[ERROR] one €\r\n[ERR')
    // A chunk can end inside a line, and inside a character.
    lines.stdout(euro.subarray(0, 13))
    lines.stdout(euro.subarray(13))
    lines.stdout(Buffer.from('OR] two\n[ERROR] three'))
    expect(lines.end()).toEqual([
      '[ERROR] one €',
      '[ERROR] two',
      '[ERROR] three'
    ])
  })

  it('reads each stream on its own', () => {
    const lines = new ErrorLines('gradle')
    lines.stderr(Buffer.from('* What went wrong:\nExecution failed'))
    lines.stdout(Buffer.from('> Task :compileJava FAILED\n* lifecycle line\n'))
    lines.stderr(
      Buffer.from(" for task ':compileJava'.\n* Try:\n> Run with --scan\n")
    )
    expect(lines.end()).toEqual(["Execution failed for task ':compileJava'."])
    expect(errors('gradle', GRADLE, 'stderr')).toHaveLength(3)
  })

  it('cuts a line that runs over many chunks', () => {
    const lines = new ErrorLines('npm')
    lines.stdout(Buffer.from('[ERROR] '))
    for (let chunk = 0; chunk < 1_000; chunk++)
      lines.stdout(Buffer.from('x'.repeat(65_536)))
    lines.stdout(Buffer.from('\n'))
    expect(lines.end()).toEqual([`[ERROR] ${'x'.repeat(292)}…`])
  })
})
