import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type BuildTool = {
  name: 'maven' | 'gradle' | 'npm' | 'python' | 'scanner'
  // For the scanner, empty: there is no build to run, the action runs the scanner CLI.
  executable: string
  // Arguments that must precede the build's own, e.g. the wrapper script run through sh.
  prefix: string[]
}

const GRADLE_BUILD_FILES = [
  'settings.gradle.kts',
  'settings.gradle',
  'build.gradle.kts',
  'build.gradle'
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function detectBuildTool(
  directory: string,
  requested = 'auto'
): BuildTool {
  const name = requested === 'auto' ? detectName(directory) : checked(requested)
  if (name === 'scanner') return { name, executable: '', prefix: [] }
  // The version the project installed, which its package.json can pin, or else the latest release.
  if (name === 'npm')
    return { name, executable: 'npx', prefix: ['--yes', '@sonar/scan'] }
  if (name === 'python') return pysonar(directory)
  const wrapper = name === 'maven' ? 'mvnw' : 'gradlew'
  if (!existsSync(join(directory, wrapper))) {
    return { name, executable: name === 'maven' ? 'mvn' : 'gradle', prefix: [] }
  }
  // Wrappers committed from Windows often lack the executable bit.
  return isExecutable(join(directory, wrapper))
    ? { name, executable: `./${wrapper}`, prefix: [] }
    : { name, executable: 'sh', prefix: [wrapper] }
}

// Like npx: the project's own copy, which its dependencies can pin, or else the latest release.
// Poetry keeps its environment outside the project by default, so its copy is found only on the PATH.
function pysonar(directory: string): BuildTool {
  const windows = process.platform === 'win32'
  const venv = windows
    ? join(directory, '.venv', 'Scripts', 'pysonar.exe')
    : join(directory, '.venv', 'bin', 'pysonar')
  if (isFile(venv)) return { name: 'python', executable: venv, prefix: [] }
  if (onPath('pysonar', windows))
    return { name: 'python', executable: 'pysonar', prefix: [] }
  return { name: 'python', executable: 'pipx', prefix: ['run', 'pysonar'] }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function onPath(command: string, windows: boolean): boolean {
  const extensions = windows
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((directory) => directory !== '')
    .some((directory) =>
      extensions.some((extension) =>
        isFile(join(directory, command + extension))
      )
    )
}

const NAMES = ['maven', 'gradle', 'npm', 'python', 'scanner'] as const

function checked(requested: string): BuildTool['name'] {
  const name = NAMES.find((known) => known === requested)
  if (name) return name
  throw new Error(
    `Unknown build tool '${requested}', expected one of: auto, ${NAMES.join(', ')}`
  )
}

function detectName(directory: string): BuildTool['name'] {
  const maven = existsSync(join(directory, 'pom.xml'))
  const gradle = GRADLE_BUILD_FILES.some((file) =>
    existsSync(join(directory, file))
  )
  if (maven && gradle)
    throw new Error(
      `Both Maven and Gradle build files found in '${directory}', set the build-tool input`
    )
  // A Java project's frontend is analysed with build-tool: npm or scanner, under its own project key.
  if (maven) return 'maven'
  if (gradle) return 'gradle'
  if (existsSync(join(directory, 'package.json'))) return 'npm'
  // Before pyproject.toml: Python projects that already have a sonar-project.properties keep the CLI.
  if (existsSync(join(directory, 'sonar-project.properties'))) return 'scanner'
  if (existsSync(join(directory, 'pyproject.toml'))) return 'python'
  throw new Error(
    `No Maven or Gradle build, package.json, sonar-project.properties or pyproject.toml found in '${directory}', set the working-directory input`
  )
}
