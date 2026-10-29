import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { windows } from '../__fixtures__/platform.js'

// Dependabot regenerates the fixtures' wrappers, so Fixtures Sonar can't put traps in them. It traps
// what they need instead: Java on the PATH and in JAVA_HOME, and the wget and curl that mvnw uses to
// download Maven. If a wrapper update gets past these traps, this test fails.
describe('the fixture build wrappers', () => {
  it.skipIf(windows).each(['fixtures/maven/mvnw', 'fixtures/gradle/gradlew'])(
    '%s springs the traps',
    (wrapper) => {
      const directory = mkdtempSync(join(tmpdir(), 'trap-'))
      try {
        const sprung = join(directory, 'sprung')
        const jdk = join(directory, 'jdk', 'bin')
        mkdirSync(jdk, { recursive: true })
        for (const tool of ['java', 'javac', 'wget', 'curl']) {
          for (const where of [directory, jdk]) {
            writeFileSync(
              join(where, tool),
              `#!/bin/sh\necho "$0 $*" >> "${sprung}"\nexit 1\n`,
              { mode: 0o755 }
            )
          }
        }
        const run = spawnSync('sh', [wrapper, '--version'], {
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
            JAVA_HOME: join(directory, 'jdk'),
            // Not a Maven the machine already downloaded.
            MAVEN_USER_HOME: join(directory, 'm2')
          },
          encoding: 'utf8'
        })
        expect(run.status).not.toBe(0)
        expect(readFileSync(sprung, 'utf8')).not.toBe('')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
