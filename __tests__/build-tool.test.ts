import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixIt } from '../__fixtures__/platform.js'
import { detectBuildTool } from '../src/build-tool.js'

const directories: string[] = []

function project(...files: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'build-tool-'))
  directories.push(directory)
  for (const file of files) {
    writeFileSync(join(directory, file), '')
    if (file === 'mvnw' || file === 'gradlew')
      chmodSync(join(directory, file), 0o755)
  }
  return directory
}

afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true })
})

describe('detectBuildTool', () => {
  it('prefers the Maven wrapper', () => {
    expect(detectBuildTool(project('pom.xml', 'mvnw'))).toEqual({
      name: 'maven',
      executable: './mvnw',
      prefix: []
    })
  })

  it('falls back to mvn without a wrapper', () => {
    expect(detectBuildTool(project('pom.xml'))).toEqual({
      name: 'maven',
      executable: 'mvn',
      prefix: []
    })
  })

  it('detects Gradle from a Kotlin settings file', () => {
    expect(detectBuildTool(project('settings.gradle.kts', 'gradlew'))).toEqual({
      name: 'gradle',
      executable: './gradlew',
      prefix: []
    })
  })

  it('falls back to gradle without a wrapper', () => {
    expect(detectBuildTool(project('build.gradle'))).toEqual({
      name: 'gradle',
      executable: 'gradle',
      prefix: []
    })
  })

  posixIt('runs a wrapper without the executable bit through sh', () => {
    const directory = project('build.gradle')
    writeFileSync(join(directory, 'gradlew'), '')
    chmodSync(join(directory, 'gradlew'), 0o644)
    expect(detectBuildTool(directory)).toEqual({
      name: 'gradle',
      executable: 'sh',
      prefix: ['gradlew']
    })
  })

  it('asks for build-tool when both are present', () => {
    expect(() => detectBuildTool(project('pom.xml', 'build.gradle'))).toThrow(
      /set the build-tool input/
    )
  })

  it('uses the requested tool when both are present', () => {
    expect(
      detectBuildTool(project('pom.xml', 'build.gradle'), 'gradle').name
    ).toBe('gradle')
  })

  it('runs the scanner on a project with sonar-project.properties', () => {
    expect(detectBuildTool(project('sonar-project.properties'))).toEqual({
      name: 'scanner',
      executable: '',
      prefix: []
    })
  })

  it('runs the npm scanner through npx on a Node project, which also reads the scanner settings', () => {
    const npm = {
      name: 'npm',
      executable: 'npx',
      prefix: ['--yes', '@sonar/scan']
    }
    expect(detectBuildTool(project('package.json'))).toEqual(npm)
    expect(
      detectBuildTool(project('package.json', 'sonar-project.properties'))
    ).toEqual(npm)
    expect(
      detectBuildTool(project('sonar-project.properties'), 'npm').name
    ).toBe('npm')
  })

  it('prefers the Java build to the scanner settings next to it', () => {
    expect(
      detectBuildTool(project('pom.xml', 'sonar-project.properties')).name
    ).toBe('maven')
    expect(detectBuildTool(project('build.gradle', 'package.json')).name).toBe(
      'gradle'
    )
    expect(
      detectBuildTool(project('pom.xml', 'package.json'), 'scanner').name
    ).toBe('scanner')
  })

  it('rejects an unknown build tool', () => {
    expect(() => detectBuildTool(project('pom.xml'), 'ant')).toThrow(
      /Unknown build tool 'ant'/
    )
  })

  it('points at working-directory when nothing is found', () => {
    expect(() => detectBuildTool(project('README.md'))).toThrow(
      /No Maven or Gradle build, package.json or sonar-project.properties found in .*, set the working-directory input/
    )
  })
})
