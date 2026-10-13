import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'

export type BuildTool = {
  name: 'maven' | 'gradle' | 'npm' | 'scanner'
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
  const wrapper = name === 'maven' ? 'mvnw' : 'gradlew'
  if (!existsSync(join(directory, wrapper))) {
    return { name, executable: name === 'maven' ? 'mvn' : 'gradle', prefix: [] }
  }
  // Wrappers committed from Windows often lack the executable bit.
  return isExecutable(join(directory, wrapper))
    ? { name, executable: `./${wrapper}`, prefix: [] }
    : { name, executable: 'sh', prefix: [wrapper] }
}

function checked(requested: string): BuildTool['name'] {
  if (
    requested === 'maven' ||
    requested === 'gradle' ||
    requested === 'npm' ||
    requested === 'scanner'
  )
    return requested
  throw new Error(
    `Unknown build tool '${requested}', expected one of: auto, maven, gradle, npm, scanner`
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
  if (existsSync(join(directory, 'sonar-project.properties'))) return 'scanner'
  throw new Error(
    `No Maven or Gradle build, package.json or sonar-project.properties found in '${directory}', set the working-directory input`
  )
}
