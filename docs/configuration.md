# Configuration

Everything beyond the [setup](../README.md#setup): the inputs, build tools,
required checks, the job summary, recipes for common setups, supported runners
and limitations.

## Inputs

| Input                | Required              | Default            | Description                                                                                                                                                                                             |
| -------------------- | --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-key`        | Yes                   |                    | The Sonar project key. Use the same one in the build and the Sonar workflow.                                                                                                                            |
| `sonar-organization` | For SonarQube Cloud   |                    | The Sonar organization. Set it in both workflows, even if your build sets it. Direct analyses need it. The Sonar workflow never takes it from the build.                                                |
| `sonar-token`        | In the Sonar workflow |                    | The Sonar token. It's empty on pull requests from forks, which makes the action take the fork path.                                                                                                     |
| `sonar-host-url`     | For SonarQube Server  |                    | The server URL. Leave it empty for SonarQube Cloud or to use the `SONAR_HOST_URL` environment variable. Direct analyses also fall back to the build's own `sonar.host.url`. The Sonar workflow doesn't. |
| `mode`               | No                    | `auto`             | `auto` picks the mode, see [how it works](how-it-works.md#the-two-workflows). `direct`, `prepare` or `analyze` forces one.                                                                              |
| `working-directory`  | No                    | `.`                | The directory holding the project.                                                                                                                                                                      |
| `build-tool`         | No                    | `auto`             | `auto` picks one from the project's files, see [build tools](#build-tools). `maven`, `gradle`, `npm` or `scanner` forces one.                                                                           |
| `build-goals`        | No                    | `verify` / `check` | Maven goals or Gradle tasks to run. Not with `npm` or `scanner`.                                                                                                                                        |
| `build-arguments`    | No                    |                    | Extra build flags. In the Sonar workflow they're passed to the scanner instead, for example `-Dsonar.projectName=App`. The scanner doesn't run in the checkout there, so use absolute paths.            |
| `github-token`       | No                    | `github.token`     | Used to download the build's artifact, look up the pull request, check it out and post the status.                                                                                                      |
| `scanner-version`    | No                    | newest tested      | The version of Sonar's scanner CLI, such as `8.1.0.6389`. See [the scanner CLI](#the-scanner-cli).                                                                                                      |

`build-goals` and `build-arguments` take one entry per line, so write several as
a YAML block:

```yaml
build-goals: |
  clean
  install
build-arguments: |
  -Pci
  -DskipITs
```

## Build tools

The action picks the build tool from the files in the working directory. Maven
or Gradle come first, then the npm scanner for a `package.json`, then Sonar's
scanner for a `sonar-project.properties`. [`build-tool`](#inputs) forces one.

### Maven and Gradle

The action runs the build. [`build-goals`](#inputs) changes what it runs.

Gradle builds need version 2.1 or later of the `org.sonarqube` plugin. Maven
builds need nothing. The action runs the version of `sonar-maven-plugin` that
your pom pins in `<plugins>` or `<pluginManagement>`. That version must be 3.2
or later. If your pom pins none, the action runs the latest. Dependabot can keep
either up to date.

### Node

The action runs Sonar's npm scanner (`@sonar/scan`) with `npx`. If your
`package.json` lists `@sonar/scan`, the action runs that version. Otherwise it
runs the latest. With Yarn's Plug'n'Play there's no `node_modules` for `npx` to
look in, so the latest version runs too.

The action needs `@sonar/scan` 4.2.7 or later, but 5.0.0 or later works best.
Before 5.0.0, the scanner first downloads Sonar's engine, which slows it down.
On SonarQube Server, that download even fails unless the server allows access
without a token.

The action also passes the type declarations in your `node_modules` to the Sonar
workflow. It passes the links your package manager makes there too. Rules that
need types then work on pull requests from forks as well, even across the
packages of a monorepo.

## The scanner CLI

The Sonar workflow always analyses with Sonar's scanner CLI. So does the build
with `build-tool: scanner`. Maven, Gradle and npm builds use Sonar's plugin or
npm package instead, so `scanner-version` doesn't apply to them.

The action runs the newest scanner CLI it's tested with, unless
`scanner-version` names another one. The tested versions are in
[`TESTED_VERSIONS`](../src/scanner.ts). Any other version runs with a warning
because this project hasn't checked how it reads the analysis settings or which
programs it starts.

The action checks every scanner it downloads against SonarSource's signature. It
gets SonarSource's key from keys.openpgp.org and keyserver.ubuntu.com, so the
runner must reach at least one of them. Versions before 8.0.1 fail the check
because SonarSource revoked the key that signed them as compromised.

## Commit statuses and required checks

Sonar posts its own check on every analysed pull request, such as _SonarCloud
Code Analysis_. On pull requests from forks, it arrives once the Sonar workflow
has run. That's a little after the build's own checks. To block merging until
the analysis passes, require that check in your branch rules, with the Sonar app
as its source. If the fork path fails, the check never arrives, so merging stays
blocked.

The Sonar workflow also posts a status called _Sonar fork analysis (your project
key)_ when it has `statuses: write`. It shows why a check is missing and links
to the run. It stays pending while the analysis runs and then turns to success
or failure. It's posted for pull requests that take the fork path. It's also
posted as a failure when the Sonar workflow finds nothing to analyse, for
example after a push the build didn't analyse. Don't require it: pull requests
from your own repository normally don't get it, so requiring it would block
them.

## The job summary

Each run also writes a short summary on the run's summary page:

- A direct analysis shows the project, the build and a link to the analysis.
- The build of a pull request from a fork lists what it ships to the Sonar
  workflow: the artifact, how many settings it carries, any settings or paths it
  leaves out, the number of files and the size of the artifact.
- The Sonar workflow shows the pull request, the commit and the fork it
  analysed, a link to the analysis, what stays off and anything it left out.
- A run with nothing to analyse says why.
- A failed run shows what went wrong. If the build or the scanner failed, the
  summary adds the lines of its output that say why. If the fork path left
  anything out before the failure, the summary lists that too. The log has the
  whole output.

Branch names, repository names, settings and errors can come from a fork, so the
summary shows them as plain text, never as links or formatting. It also takes
the tokens out of the errors it shows. The warnings stay annotations on the same
page, so the summary only counts them. What the fork path left out is the
exception. One warning counts it and the summary lists each item. GitHub shows
at most 10 warnings as annotations. With more, the summary points to the log
instead. GitHub also drops a summary larger than 1 MiB, so a long list stops
after about 10,000 characters. The log has every item.

## Languages on pull requests from forks

Pull requests from forks only get the
[tested languages](../README.md#languages-on-pull-requests-from-forks) analysed.
To turn a language on, set its file patterns in `build-arguments` in the Sonar
workflow. For Python:

```yaml
build-arguments: |
  -Dsonar.lang.patterns.py=**/*.py
```

The setting names the language by its Sonar key. Keys aren't always the
language's name: Python is `py`, HTML is `web` and C# is `cs`. The Sonar
workflow's log lists the key of each language it turns off. SonarQube Cloud
[lists all its keys](https://sonarcloud.io/api/languages/list). For SonarQube
Server, the same list is at `<your server>/api/languages/list`.

A language you turn on is untested: use it at your own risk.

COBOL is tested, but it has no default file suffixes. The fork path never
carries suffixes from the build. So a COBOL project sets them in the Sonar
workflow too:

```yaml
build-arguments: |
  -Dsonar.cobol.file.suffixes=cbl,cpy
```

## Which commit the build tests

On a pull request, `actions/checkout` checks out a merge of the pull request
into the base branch. The Sonar workflow analyses the pull request's head
instead. Usually this only matters when a file changed both in the pull request
and on the base branch since the pull request branched off. Its binaries and
coverage then come from slightly different code. Usually the only sign is a
scanner warning such as _Cannot import coverage information for file_. It can
also stop the analysis. When the base branch gains a module or a source
directory, the build names a directory that the head doesn't have. The Sonar
workflow then fails with _The artifact gives … no base directory in the
checkout_.

The simplest fix is to bring the pull request up to date with its base branch.
Rebase it or use the **Update branch** button on the pull request. The merge and
the head then hold the same code.

If you want the two to always match, check out the head in the build:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
    ref: ${{ github.event.pull_request.head.sha }}
```

This changes what your whole build tests on pull requests. Only do it if you're
happy with that.

## Recipes

### Several projects

Run the action once per project, each with its own project key and
`working-directory`, for example with a matrix. In the build workflow:

```yaml
jobs:
  build:
    strategy:
      matrix:
        include:
          - project-key: my-org_service-a
            working-directory: service-a
          - project-key: my-org_service-b
            working-directory: service-b
    runs-on: ubuntu-latest
    steps:
      # Your existing checkout and Java setup.
      - uses: galois-groups/sonar-fork-analysis@v2
        with:
          project-key: ${{ matrix.project-key }}
          working-directory: ${{ matrix.working-directory }}
          sonar-organization: my-org
          sonar-token: ${{ secrets.SONAR_TOKEN }}
```

The Sonar workflow only needs the project keys. Its matrix runs each project in
a job of its own. That matters here: as two steps of one job, the second
analysis would find the first one's checkout and stop.

```yaml
jobs:
  sonar:
    if: github.event.workflow_run.conclusion == 'success'
    strategy:
      matrix:
        project-key: [my-org_service-a, my-org_service-b]
    runs-on: ubuntu-latest
    # Same permissions as for a single project.
    steps:
      - uses: galois-groups/sonar-fork-analysis@v2
        with:
          project-key: ${{ matrix.project-key }}
          sonar-organization: my-org
          sonar-token: ${{ secrets.SONAR_TOKEN }}
```

The build may skip a project when none of its files changed. That project's
Sonar job then ends without doing anything. This works as long as the build ran
the action for at least one other project. If the build skips them all, see
[builds that don't always run the action](#builds-that-dont-always-run-the-action).

### Skipping runs with nothing to do

The Sonar workflow runs after every build and stops straight away when the build
analysed directly. To skip it completely, run its job only for forks and
Dependabot:

```yaml
if: >
  github.event.workflow_run.conclusion == 'success' &&
  (github.event.workflow_run.head_repository.full_name != github.repository ||
   github.event.workflow_run.actor.login == 'dependabot[bot]')
```

### Builds that don't always run the action

GitHub starts the Sonar workflow whenever the build workflow completes. It does
so even when the build skipped the job or step that runs the action. The Sonar
workflow then finds nothing to analyse and says so in a notice. It also posts a
failed status if it has `statuses: write`. There are two ways to avoid this.

Skip the whole build workflow in its trigger. Then neither the build nor the
Sonar workflow runs. For example, to ignore changes to the docs:

```yaml
on:
  pull_request:
    paths-ignore: ['docs/**']
```

If the build skips only the job or step that runs the action, skip the Sonar job
on the same events instead. For example, when scheduled builds don't run the
action:

```yaml
if: >
  github.event.workflow_run.conclusion == 'success' &&
  github.event.workflow_run.event != 'schedule'
```

### Only for forks, next to another Sonar setup

You may already analyse your own pull requests and pushes another way, such as
with Sonar's own action. You can then use this action only for forks and
Dependabot. In the build, run it only on those pull requests and without a
token, so it always takes the fork path:

<!-- prettier-ignore -->
```yaml
- uses: galois-groups/sonar-fork-analysis@v2
  if: >
    github.event_name == 'pull_request' &&
    (github.event.pull_request.head.repo.full_name != github.repository ||
    github.actor == 'dependabot[bot]')
  with:
    project-key: my-org_my-project
    sonar-organization: my-org
```

In the Sonar workflow, use the job condition from
[skipping runs](#skipping-runs-with-nothing-to-do).

### Your own checkout

The action checks out the analysed commit itself when the workspace is empty. It
deletes that checkout at the end of the job. To check out yourself, for example
to get submodules or Git LFS files, add a checkout step before the action. The
action then uses your checkout and leaves it in place. Your checkout must:

- be at the analysed commit, with full history;
- have no persisted credentials;
- have `origin` pointing at your repository, because Sonar finds the base branch
  there;
- hold nothing else. A step that adds or changes files would have them analysed
  as the pull request's code, so the action refuses them.

For pull requests from forks, `actions/checkout` refuses this checkout unless
you set `allow-unsafe-pr-checkout: true`. The refusal protects workflows that
run the checked-out code. The action never runs anything from your checkout: the
scanner only reads the files.

```yaml
- uses: actions/checkout@v7
  with:
    ref: ${{ github.event.workflow_run.head_sha }}
    fetch-depth: 0
    persist-credentials: false
    allow-unsafe-pr-checkout: true
    submodules: true
- uses: galois-groups/sonar-fork-analysis@v2
  with:
    # …
```

Be careful with private submodules. Checking them out needs a token that can
read your other repositories. A fork can change `.gitmodules` to point a
submodule at any of them. The checkout then fetches that repository. Its code
goes to Sonar with the analysis. If your Sonar project is public, anyone can
read that code there.

### Self-hosted runners

GitHub's hosted runners give every job a fresh workspace. A self-hosted runner
gives all jobs of a repository the same workspace and keeps it between jobs. The
action deletes its own checkout at the end of the job, but other jobs leave
their files. If the Sonar workflow shares a runner with your build, empty the
workspace before the action:

```yaml
# Unlike rm -rf with *, this also removes .git. It keeps the folder the runner expects.
- run: find "$GITHUB_WORKSPACE" -mindepth 1 -delete
- uses: galois-groups/sonar-fork-analysis@v2
  with:
    # …
```

Don't let that runner build pull requests from forks, though. See
[hardening your setup](security.md#hardening-your-setup).

## Supported runners

| Runner      | Build workflow | Sonar workflow |
| ----------- | -------------- | -------------- |
| Linux x64   | Tested         | Tested         |
| Windows x64 | Tested¹        | Untested       |
| macOS ARM64 | Tested¹        | Untested       |
| Linux ARM64 | Untested       | Untested       |
| macOS Intel | Untested       | Untested       |

¹ Only the build's preparation runs there: Maven, Gradle and npm on Windows, npm
on macOS. Nothing analyses those artifacts.

Tested and untested mean the same as for
[projects](../README.md#supported-projects).

## Limitations

- On pull requests from forks, only the analyzers of tested languages run. See
  [languages on pull requests from forks](#languages-on-pull-requests-from-forks).
- Dependency analysis (SCA) and the engine's build-system autoconfiguration are
  off on pull requests from forks, because both run the project's build tools.
  See [what stays off](security.md#what-stays-off-on-the-fork-path).
- Settings about the server, the scanner or the branch never reach the Sonar
  workflow. Neither do settings that would start a program. The build warns
  about most of them. It drops the ones about the server and the scanner without
  a warning, such as the server's URL or a proxy. The Sonar workflow sets those
  itself. See
  [what the fork path carries](how-it-works.md#what-the-fork-path-carries).
- On the fork path, the build collects its settings with Sonar's simulation
  mode. Sonar doesn't document it, so a release could change it. See
  [settings from the build](how-it-works.md#settings-from-the-build).
- On self-hosted Windows runners whose workspace is on a RAM disk, the action
  can fail with `EISDIR` while it resolves paths. Use a regular disk.
- The build's `sonar.region` isn't carried. For SonarQube Cloud's US region, add
  `-Dsonar.region=us` to `build-arguments` in the Sonar workflow.
- The action looks for `mvnw` and `gradlew` only in `working-directory`, not in
  parent directories.
- On platforms where Sonar ships no scanner with Java bundled, the scanner needs
  Java on the `PATH`. Alpine images can't run the bundled Java. Projects on a
  newer Java than the scanner's may need `setup-java` and `-Dsonar.java.jdkHome`
  in `build-arguments`.
- The scanner's signature check needs keys.openpgp.org or keyserver.ubuntu.com.
  A runner that reaches neither can't analyse.
- SonarQube Server needs an edition that supports pull request analysis. The
  action is tested against SonarQube Cloud and the latest SonarQube Community
  Build.
