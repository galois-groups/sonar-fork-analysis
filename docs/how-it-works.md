# How it works

## The two workflows

On a pull request from a fork:

1. Your build workflow runs without the Sonar token. The action builds the
   project with Maven or Gradle and has Sonar's build plugin work out the
   analysis settings without running the analysis. For other projects, the
   action doesn't build anything: it runs after your own build and test steps
   and reads your `sonar-project.properties`. It uploads what the analysis needs
   as an artifact, together with those settings: compiled classes, libraries,
   coverage and test reports. For a Node project, that includes the type
   declarations from `node_modules`.
2. When the build finishes, GitHub starts your Sonar workflow through
   `workflow_run`. It runs in your repository, so it has the Sonar token.
3. The action checks out the pull request, checks the artifact's settings
   against an allowlist and runs the Sonar scanner on the sources and the build
   output. It never runs the build or anything else from the pull request. Sonar
   shows the results on the pull request as usual.

On pushes and pull requests from your own repository, the build has the token,
so the action analyses straight away, as Sonar's own plugins and scanner would.
The Sonar workflow still starts after the build but has nothing to do.

Dependabot's pull requests run without your Actions secrets, like forks, so they
take the fork path too.

You don't have to pick any of this. The `mode` input defaults to `auto`, which
chooses the right part from where the action runs and whether it has a token.

## Settings from the build

- On the fork path, the build collects its settings with simulation mode
  (`sonar.scanner.internal.dumpToFile`), a feature of the Sonar plugins for
  Maven and Gradle and of the pinned scanner. Sonar uses it in its own tests but
  doesn't document it, so a release could change it. If it stops working, the
  build fails with a message that no analysis settings were written. This
  project's tests keep up with the latest plugins, so such a change should show
  up here first.

## What the Sonar workflow does

It never runs Maven, Gradle, npm or a wrapper script. It checks out the pull
request, unpacks the artifact and runs the Sonar scanner, which reads the pull
request's files but never runs them.

**The checkout.** The action checks out the pull request itself, without ever
writing the GitHub token to disk. `origin` points at your repository, because
that's where Sonar looks for the base branch. The pull request's commit comes
from your repository too. GitHub keeps a copy of every pull request's head
there. The action never contacts the fork. Then it removes two kinds of files
the scanner would otherwise trust:

- Links that lead outside the checkout. The scanner follows them, so a link to
  `/proc/self` would get the scanner's own environment, token included, indexed
  and sent to Sonar. A link could hide behind a file name that isn't valid
  UTF-8, so the action refuses such names.
- `sonar-project.properties` files, which the scanner would read as
  configuration.

**The artifact.** The action refuses an artifact with links, special files or
file names that aren't valid UTF-8 in it. It unpacks the build output next to
the sources, never over an existing file or through a link. Into the source
directories it only adds report files that the settings name and type
information in `node_modules` (declaration, `package.json` and `tsconfig`
files). Through a link or a report setting, a fork can still add files that
Sonar analyses as part of its code. That only changes its own pull request's
results, as committing those files would. The analyzers read the type
information to learn the types the code uses and by default never report on it
as part of the project. The action also recreates the links a Node project had
in `node_modules`. It only recreates links that sit in a `node_modules`
directory and lead to a directory in the checkout, never into `.git`. A fork
could commit links like these itself.

**The settings.** The build's settings go through the same
[allowlist](#what-the-fork-path-carries) again, and every path in them must lead
inside the checkout or the action's private home. That's where the action puts
libraries from the build's home, such as Maven's `~/.m2`. The action also drops
any value the scanner might read differently from how it was checked. The main
example is a `${…}` placeholder: the scanner expands those, so
`${env.SONAR_TOKEN}` would turn into the token. Quotes, control characters, path
patterns and stray spaces are dropped for the same reason. Modules are worked
out the same way the scanner's engine does it, and each one needs its own base
directory inside the checkout.

Then the action sets the settings that matter for safety itself, whatever the
artifact says: the project key, the analysed commit, the working directory, the
languages it analyses and the
[features that stay off](security.md#what-stays-off-on-the-fork-path).

**The analyzers.** On the fork path, only the analyzers of the
[languages the sample projects test](../README.md#languages-on-pull-requests-from-forks)
run. Sonar's engine only runs a language's analyzer on files of that language.
It loads most analyzers only once it finds such a file. So the action asks the
server which languages it knows. For each of the others, it sets
`sonar.lang.patterns.<language>` to a pattern no file can match. Files of those
languages are still indexed, but with no language. Their analyzers never run in
the job that has the token. If the server doesn't list its languages, the
analysis stops. The tests check the engine habits this relies on. They run
against SonarQube Cloud's engine and SonarQube's.

The always-loaded `iac` plugin also sorts YAML and JSON files by their content.
For example, it finds CloudFormation and Ansible files that way. Turning
languages off doesn't stop that. Those sensors only read files.

The analyzers of the tested languages only read files. For JavaScript and
TypeScript, this was tested against Sonar's real analyzer with a project that
tried every way to get its own code run. The analyzer used its own Node.js and
TypeScript. It ran none of the project's configuration files (ESLint, Babel,
TypeScript and others) and loaded no code from its `node_modules`. It only read
`tsconfig` files and type declarations as data. Two Node test fixtures, one
installed with npm and one with pnpm, keep checking this against SonarQube
Cloud's analyzer, see
[keeping up with the scanner](#keeping-up-with-the-scanner). Analyzers for other
languages haven't been checked. Some might start other programs. If you turn
their language on with `build-arguments`, the action guarantees nothing for
them.

**The scanner.** It runs in an empty directory of its own. Its environment holds
the Sonar token, but not the action's inputs, the runner's own tokens or
variables like `GITHUB_ENV`. That limits what a mistake can reach, but it isn't
a security boundary: a program running there could still read the action's own
environment.

## What the fork path carries

The build only passes on the settings an analysis needs, picked by name. These
are the project's structure (modules, sources, tests, binaries, libraries),
report paths for coverage, tests and external issues, per-language settings and
exclusions. Everything else stays behind. That includes the server, the token
and the project key, scanner and branch settings, and anything that would start
a program, like a JDBC driver or Node.js. It also includes the settings that
decide each file's language: file suffixes and patterns, and
`sonar.lang.patterns.*`. The Sonar workflow sets its own. See
[the analyzers](#what-the-sonar-workflow-does).

Reports are recognised by their name (`…reportPaths` and similar), so a report
from a tool Sonar adds later works without a new release of this action.
Settings ending in `Paths` are checked one entry at a time, on the assumption
that the scanner reads them as lists. Every documented one is.

The filtering can produce two warnings:

- _The analysis of pull requests leaves out these settings_, from the build,
  when it leaves something behind. If the analysis needs it, pass it with
  `build-arguments` in the Sonar workflow. That's your own configuration, so
  it's trusted.
- _Dropped settings a build never ships_, from the Sonar workflow, when the
  artifact holds a setting no build would produce. Either someone tampered with
  the artifact, or the two workflows run different versions of the action.

## Keeping up with the scanner

Sonar updates its scanner on its own schedule, and some updates matter here.
Dependency analysis, build-system autoconfiguration and the engine's habit of
running `dotnet` to collect analytics all arrived that way.

So this project tests against the real thing, on every pull request and once a
week: the scanner CLI it pins, together with the engines that SonarQube Cloud
and the latest SonarQube Community Build currently serve. The tests check that
the scanner reads settings exactly as the action checked them, that the engine
builds the same modules and that no part of the engine beyond the reviewed ones
can start a program. They also check three habits of the engine. A language's
`sonar.lang.patterns` setting replaces its own patterns. The pattern that turns
a language off matches no file. The engine loads analyzers only for the
languages it finds.

The analysis of the test fixtures also sets traps. Fake build tools on the
`PATH` fail the run if the analysis ever starts one. The fixtures' Maven and
Gradle wrappers need Java, `wget` and `curl`. Fakes of these fail the run too.
So do booby-trapped Gradle settings in the fixtures. The Node fixtures add
booby-trapped configuration files and packages, which fail the run if the
JavaScript analyzer ever loads them. One fixture also holds a Python file. The
direct analysis must report its issue. The fork path must not analyse it.

Older SonarQube Server versions and commercial editions aren't tested.
