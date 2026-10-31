<div align="center">

![Sonar Fork Analysis](docs/images/logo.svg)

[![Release](https://img.shields.io/github/v/release/galois-groups/sonar-fork-analysis)](https://github.com/galois-groups/sonar-fork-analysis/releases/latest)
[![CI](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/ci.yml/badge.svg)](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=galois-groups_sonar-fork-analysis&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=galois-groups_sonar-fork-analysis)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=galois-groups_sonar-fork-analysis&metric=coverage)](https://sonarcloud.io/summary/new_code?id=galois-groups_sonar-fork-analysis)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/galois-groups/sonar-fork-analysis/badge)](https://scorecard.dev/viewer/?uri=github.com/galois-groups/sonar-fork-analysis)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15534/badge)](https://www.bestpractices.dev/projects/15534)

</div>

---

Runs Sonar analysis on pull requests from forks, with coverage and test results.

GitHub doesn't give secrets to workflows triggered by a fork, so the usual Sonar
setup can't analyse their pull requests. This action splits the work in two. The
build workflow builds the pull request without the Sonar token. A second
workflow then analyses the result with the token. It never runs any of the pull
request's code. This is the split
[Sonar's documentation describes for forks](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/ci-based-analysis/github-actions-for-sonarcloud#analyzing-fork-pull-requests),
packaged as one action. It works with Maven, Gradle and any other project
Sonar's scanner analyses, such as JavaScript, TypeScript or Python. Binaries,
libraries, coverage, test reports and the settings your build defines all carry
over. Your own pushes and pull requests have the token, so the build analyses
them directly.

SonarQube Cloud's
[Automatic Analysis](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/automatic-analysis/)
also handles pull requests from forks, with no setup. It gives no coverage,
doesn't support monorepos and analyses some languages in less depth. If those
limits don't matter to you, it's the simpler choice.

Coming from v1? It no longer gets fixes, not even security fixes. See
[migrating from v1](docs/migrating-from-v1.md).

## Documentation

- [Configuration](docs/configuration.md): inputs, required checks, the job
  summary, recipes and limitations.
- [Security](docs/security.md): what stays off, what a fork can still influence
  and how to harden your setup.
- [How it works](docs/how-it-works.md): what the Sonar workflow does with the
  pull request and how this project tests it.
- [Troubleshooting](docs/troubleshooting.md): what each message means.
- [Contributing](CONTRIBUTING.md)

## Supported projects

| Project                                                      | What the action does                                 | Tested |
| ------------------------------------------------------------ | ---------------------------------------------------- | ------ |
| Maven, Gradle                                                | [Runs the build](#maven-and-gradle)                  | Yes    |
| npm, pnpm                                                    | [Runs after your build and tests](#everything-else)  | Yes    |
| Yarn with `nodeLinker: node-modules`, Bun                    | [Runs after your build and tests](#everything-else)  | No     |
| Yarn Plug'n'Play                                             | [Runs after your build and tests](#everything-else)¹ | No     |
| Python, Go, PHP and others with a `sonar-project.properties` | [Runs after your build and tests](#everything-else)² | No     |
| .NET, C, C++ and Objective-C                                 | Not supported³                                       |        |

¹ Rules that need types find fewer issues because there's no `node_modules` to
read the types from. Setting `nodeLinker: node-modules` avoids this.

² On pull requests from forks, these languages are only analysed once you
[turn them on](docs/configuration.md#languages-on-pull-requests-from-forks).

³ They need Sonar's scanner for .NET or Sonar's build wrapper.

<!-- prettier-ignore -->
> [!NOTE]
> Tested means this repository's workflows test it on every change. Each sample
> project in `fixtures/` is analysed twice: directly and through the fork path.
> Both analyses must find the same issues, coverage and tests. The sample
> projects hold every language the fork path analyses.
>
> Untested means the action doesn't guarantee that the token stays safe on pull
> requests from forks. Use it at your own risk. That includes languages you turn
> on yourself.

The action is tested on GitHub's Linux x64 runners. The build's preparation is
also tested on Windows x64 and macOS ARM64. See
[supported runners](docs/configuration.md#supported-runners).

### Languages on pull requests from forks

Sonar checks each language with its own analyzer. On pull requests from forks,
the Sonar workflow only runs the analyzers of the languages the sample projects
test:

- Java and Kotlin;
- JavaScript, TypeScript and Vue;
- CSS, SCSS and HTML;
- XML, YAML and JSON: Maven POMs, GitHub Actions workflows, Kubernetes
  manifests, Helm charts, CloudFormation templates, Ansible playbooks, Azure
  Pipelines, ARM templates, Mule applications and more;
- Dockerfiles and Containerfiles;
- Shell scripts, PowerShell, Terraform and Bicep.

Files in other languages get no issues from their own analyzer on pull requests
from forks. For example, a Maven project's Python files get none. So these pull
requests may show fewer issues than your own. You can
[turn a language on](docs/configuration.md#languages-on-pull-requests-from-forks)
at your own risk. [How it works](docs/how-it-works.md#the-analyzers) explains
why the others stay off.

## Setup

### 1. Create a Sonar token

Create a Sonar token and save it as the repository secret `SONAR_TOKEN`.
SonarQube Cloud's free plan only has personal tokens, so use a dedicated one
named after your repository. Paid plans can use a
[scoped organization token](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-organization/scoped-organization-tokens)
with only _Execute analysis_ on the project. An expiry date is optional, but a
token without one is removed after 60 days without use.

### 2. Add the action to your build workflow

Your build workflow must run on `pull_request`, not `pull_request_target`. With
`pull_request_target`, a fork's code would run with your secrets, so the action
refuses to run there. Run the build workflow on pushes to your default branch
too. Sonar compares each pull request with that branch's analysis.

#### Maven and Gradle

Put the action in place of your build step. It runs `verify` for Maven and
`check` for Gradle.

```yaml
steps:
  # Your existing checkout and Java setup. Sonar needs the full history.
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: actions/setup-java@v6
    with:
      distribution: temurin
      java-version: 21
  # Add this in place of your build step.
  - uses: galois-groups/sonar-fork-analysis@v2
    with:
      project-key: my-org_my-project
      sonar-organization: my-org
      sonar-token: ${{ secrets.SONAR_TOKEN }}
```

#### Everything else

Add the action after your build and test steps. A Node project needs nothing
more:

```yaml
steps:
  # Your existing checkout and Node setup. Sonar needs the full history.
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: actions/setup-node@v7
    with:
      node-version: 24
  - run: npm ci
  - run: npm test -- --coverage
  # Add this after your tests.
  - uses: galois-groups/sonar-fork-analysis@v2
    with:
      project-key: my-org_my-project
      sonar-organization: my-org
      sonar-token: ${{ secrets.SONAR_TOKEN }}
```

Other projects also need a `sonar-project.properties`, such as:

```properties
sonar.sources=src
sonar.python.coverage.reportPaths=coverage.xml
```

See [configuration](docs/configuration.md) for the inputs, the versions the
action needs and how it picks the build tool.

### 3. Add the Sonar workflow

The Sonar workflow is the same for every project. It runs after the build:

```yaml
name: Sonar
on:
  workflow_run:
    workflows: [Build]
    types: [completed]
jobs:
  sonar:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      pull-requests: read
      statuses: write
    steps:
      - uses: galois-groups/sonar-fork-analysis@v2
        with:
          project-key: my-org_my-project
          sonar-organization: my-org
          sonar-token: ${{ secrets.SONAR_TOKEN }}
```

Put your build workflow's name in `workflows`, here `Build`. Use the same
`project-key` and `sonar-organization` in both workflows. The project key also
names the artifact. The permissions are for:

- `actions: read`: downloading the build's artifact;
- `contents: read`: fetching the pull request's commit from your repository;
- `pull-requests: read`: looking up the pull request through GitHub's API,
  instead of trusting the artifact;
- `statuses: write`: posting a status on the pull request. It's optional.

### 4. Require Sonar's check

To block merging until the analysis passes, require Sonar's own check. See
[required checks](docs/configuration.md#commit-statuses-and-required-checks).

Then read [security](docs/security.md). It lists what a fork can still influence
and how to harden your setup.

## Real-world examples

These projects analyse their pull requests from forks with the action:

- [Instancio](https://github.com/instancio/instancio): a Maven build with 38
  modules. See its
  [build workflow](https://github.com/instancio/instancio/blob/main/.github/workflows/build.yml)
  and
  [Sonar workflow](https://github.com/instancio/instancio/blob/main/.github/workflows/sonar.yml).
- This repository: a TypeScript project, analysed by the npm scanner after its
  tests. See its [build workflow](.github/workflows/ci.yml) and
  [Sonar workflow](.github/workflows/sonar.yml).

## Reporting vulnerabilities

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).

This project is not affiliated with or endorsed by SonarSource. Sonar, SonarQube
and SonarCloud are trademarks of SonarSource.
