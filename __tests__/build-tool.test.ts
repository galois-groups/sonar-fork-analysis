import { describe, it, expect, afterAll, afterEach } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { windows } from '../__fixtures__/platform.js'
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

  it.skipIf(windows)(
    'runs a wrapper without the executable bit through sh',
    () => {
      const directory = project('build.gradle')
      writeFileSync(join(directory, 'gradlew'), '')
      chmodSync(join(directory, 'gradlew'), 0o644)
      expect(detectBuildTool(directory)).toEqual({
        name: 'gradle',
        executable: 'sh',
        prefix: ['gradlew']
      })
    }
  )

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

  describe('pysonar', () => {
    const path = process.env.PATH
    const pathExt = process.env.PATHEXT

    afterEach(() => {
      process.env.PATH = path
      if (pathExt === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = pathExt
    })

    function noPysonarOnPath(): void {
      process.env.PATH = project()
    }

    function venvPysonar(directory: string): string {
      const bin = windows
        ? join(directory, '.venv', 'Scripts')
        : join(directory, '.venv', 'bin')
      mkdirSync(bin, { recursive: true })
      const file = join(bin, windows ? 'pysonar.exe' : 'pysonar')
      writeFileSync(file, '')
      return file
    }

    it('runs the latest release through pipx for a project with pyproject.toml', () => {
      noPysonarOnPath()
      expect(detectBuildTool(project('pyproject.toml'))).toEqual({
        name: 'python',
        executable: 'pipx',
        prefix: ['run', 'pysonar']
      })
    })

    it("prefers the project's virtual environment, then the PATH", () => {
      const directory = project('pyproject.toml')
      const onPath = project()
      writeFileSync(join(onPath, windows ? 'pysonar.exe' : 'pysonar'), '')
      process.env.PATH = `${project()}${delimiter}${onPath}`
      process.env.PATHEXT = '.COM;.EXE'
      expect(detectBuildTool(directory).executable).toBe('pysonar')
      const venv = venvPysonar(directory)
      expect(detectBuildTool(directory).executable).toBe(venv)
    })

    it('ignores a directory named pysonar', () => {
      const onPath = project()
      mkdirSync(join(onPath, windows ? 'pysonar.exe' : 'pysonar'))
      process.env.PATH = onPath
      expect(detectBuildTool(project('pyproject.toml')).executable).toBe('pipx')
    })

    it('keeps the scanner CLI for a Python project with sonar-project.properties, unless asked', () => {
      noPysonarOnPath()
      const directory = project('pyproject.toml', 'sonar-project.properties')
      expect(detectBuildTool(directory).name).toBe('scanner')
      expect(detectBuildTool(directory, 'python').name).toBe('python')
    })

    it('prefers a Node project to pyproject.toml', () => {
      expect(
        detectBuildTool(project('package.json', 'pyproject.toml')).name
      ).toBe('npm')
    })
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
      /No Maven or Gradle build, package.json, sonar-project.properties or pyproject.toml found in .*, set the working-directory input/
    )
  })
})
