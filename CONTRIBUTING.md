# Contributing

`npm run all` formats, lints, type-checks, tests and bundles into `dist/`, which
is committed.

Three workflows besides CI check the action:

- [![Fixtures](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/fixtures.yml/badge.svg)](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/fixtures.yml)
  runs the action on sample Maven, Gradle, npm and pnpm projects. It analyses
  each one directly and through the fork path and compares the results. It also
  checks what differs on Windows and macOS: the Maven and Gradle wrappers and
  the scanner the action downloads.
- [![Scanner and engines](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/scanner.yml/badge.svg)](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/scanner.yml)
  checks what the action assumes against the real scanner and the engines
  SonarCloud and SonarQube serve. Sonar updates the engines on its own schedule,
  so the workflow also runs every week and then reports any new scanner release.
- [![CodeQL](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/codeql.yml/badge.svg)](https://github.com/galois-groups/sonar-fork-analysis/actions/workflows/codeql.yml)
  is GitHub's security analysis of the code and the workflows.

`npm run test:scanner` runs the tests against the real scanner. They download
the scanner and SonarQube's engines. They need Java and `unzip`. If Sonar ships
an engine that starts processes in new places, they fail until someone reviews
`__tests__/java/engine-processes-*.txt`.

The fixtures' fork-path analyses also record every program the scanner starts.
If Sonar adds a helper program, the check fails and shows its command line.
Review it, then add its path to `.github/fork-path-programs.txt`.

The action pins the scanner CLI by hash. When the weekly run of Scanner and
engines reports a newer one, run `npm run scanner:update`. It pins the new
scanner with the digests Sonar publishes. Then run `npm run bundle` and open a
pull request.

To run the action locally, copy `.env.example` to `.env`, edit it and run
`npm run local`.

Dependabot pull requests that update runtime dependencies fail CI until `dist/`
is rebuilt. To rebuild it, run `npm ci && npm run bundle` on the branch. You can
also commit the `dist` artifact that the failed run uploads.

Third-party actions added to a workflow must also be added to the repository's
allowed actions.

To publish a new version, create a release on GitHub with a new `vX.Y.Z` tag.
Pick a commit whose checks on `main` all passed, including Fixtures Sonar. Tick
"Publish this Action to the GitHub Marketplace" so that the Marketplace shows
the new version. Keep the release marked as the latest. The Release workflow
then points the major tag at it: `v2` for `v2.1.0`.
