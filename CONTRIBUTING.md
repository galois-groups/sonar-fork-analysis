# Contributing

`npm run all` formats, lints, type-checks, tests and bundles into `dist/`, which
is committed.

New behaviour comes with tests. SonarCloud's quality gate fails a pull request
whose new code has less than 80% coverage.

Three workflows besides CI check the action:

- [![Fixtures](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/fixtures.yml/badge.svg)](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/fixtures.yml)
  runs the action on sample Maven, Gradle, npm, pnpm and Python projects.
  Another one, `infra`, has no build and holds a sample of every other file type
  the action analyses. Fixtures analyses each one directly and through the fork
  path and compares the results. It also checks what differs on Windows and
  macOS: the Maven and Gradle wrappers, the scanner the action downloads and the
  stand-in for Java that pysonar starts.
- [![Scanner and engines](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/scanner.yml/badge.svg)](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/scanner.yml)
  checks what the action assumes against the real scanner and the engines
  SonarCloud and SonarQube serve. Sonar updates the engines on its own schedule,
  so the workflow also runs every week and then reports any new scanner release.
- [![Code scanning](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/code-scanning.yml/badge.svg)](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/code-scanning.yml)
  runs GitHub's CodeQL on the code and the workflows, and zizmor on the
  workflows.

`npm run test:engines` checks what the action assumes against the engines
SonarCloud and SonarQube serve. `npm run test:cli` does the same against the
scanner CLI in `SCANNER_VERSION`, else the default. Both download what they
check from Sonar and need Java. `test:cli` also needs `unzip`. If Sonar ships an
engine that starts processes in new places, the engine checks fail until someone
reviews `__tests__/java/engine-processes-*.txt`.

The fixtures' fork-path analyses also record every program the scanner starts.
If Sonar adds a helper program, the check fails and shows its command line.
Review it, then add its path to `.github/fork-path-programs.txt`.

The action runs the newest scanner CLI in `TESTED_VERSIONS` (`src/scanner.ts`),
unless a workflow sets `scanner-version`. When the weekly run of Scanner and
engines reports a newer release, run `npm run scanner:update`. It checks the new
release's signature and makes it the default. The old default stays in the list.
The workflows list the versions too: add the new one to the matrix in
`scanner.yml` and the old default to the one in `fixtures.yml`. `npm test` fails
until the lists match. Then run `npm run bundle` and open a pull request. Its
checks run the real scanner and the fixtures with every version in the list.

The weekly run also reports a newer patch of an older tested version, such as
8.1.1 for 8.1.0. Replace that version by hand in `TESTED_VERSIONS` and in both
matrices.

To run the action locally, copy `.env.example` to `.env`, edit it and run
`npm run local`.

Dependabot puts the runtime dependencies and the bundler in a pull request of
their own. It fails CI until `dist/` is rebuilt. To rebuild it, run
`npm ci && npm run bundle` on the branch. You can also commit the `dist`
artifact that the failed run uploads.

Dependabot updates indirect dependencies only for security fixes. Otherwise they
stay at the versions in `package-lock.json` until someone refreshes them. Before
each release, or about once a month, run `npm update --min-release-age=7` in the
root and in `fixtures/npm`. It takes only versions at least 7 days old, the same
wait as Dependabot's cooldown. npm stops with "No matching version found … with
a date before" when `package.json` already requires a younger version, usually
after a security update. Exempt that package with
`--min-release-age-exclude=<package>`. Both options need a recent npm 11 or 12.
The pnpm fixture needs no refresh: its only indirect dependency comes with
`@types/node`, which Dependabot updates. The Python fixture's `requirements.txt`
pins every package with its hashes, so Dependabot updates all of them. To add
one, rerun the command at the top of the file. Then run `npm run all` and open a
pull request of its own. The changes to `dist/licenses.md` show which bundled
packages changed.

Third-party actions added to a workflow must also be added to the repository's
allowed actions.

Every workflow that runs on pull requests ends with a summary job, such as
"Every CI check passed". The branch ruleset requires these instead of each job.
Add a new job to the `needs` of its workflow's summary job. Otherwise its
failure won't block a merge. Code scanning is the exception: the ruleset
requires the results of CodeQL and zizmor instead.

To publish a new version, create a release on GitHub with a new `vX.Y.Z` tag on
a commit of `main` whose checks all passed, Fixtures Sonar included. A ruleset
refuses the tag if they didn't. Tick "Publish this Action to the GitHub
Marketplace" so that the Marketplace shows the new version. Keep the release
marked as the latest. The Release workflow then points the major tag at it: `v2`
for `v2.1.0`. It refuses a commit that isn't on `main`.
