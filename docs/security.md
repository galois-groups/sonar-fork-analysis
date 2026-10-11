# Security

Code in a pull request from a fork hasn't been reviewed, so GitHub builds it
without your secrets. This action keeps it that way. The build runs without the
Sonar token. A build can read anything in its job, so the action refuses to
prepare when you pass it the token. The Sonar workflow has the token but never
runs anything from the pull request.

Everything the Sonar workflow gets from the pull request could be hostile: the
files in the checkout and the artifact the pull request's build left behind. So
the Sonar workflow checks all of it before the scanner runs. It removes links
that lead out of the checkout. It only keeps the build's settings that are on an
allowlist. It turns off the analyzers of the languages this action isn't tested
with. [How it works](how-it-works.md#what-the-sonar-workflow-does) has the
details, and how this project tests them against Sonar's real scanner.

This page covers what's left for you to decide.

## What stays off on the fork path

Two Sonar features work by running the project's own build tools. On the fork
path those tools come from the pull request, so the Sonar workflow always turns
the features off:

- **Dependency analysis** (SCA, part of Sonar's Advanced Security) runs `mvnw`,
  `gradlew` or `npm` to list dependencies. Fork pull requests don't get it, but
  your own pushes and pull requests still do, because the build analyses them
  directly. For fork pull requests, GitHub's
  [dependency review action](https://github.com/actions/dependency-review-action)
  can check dependencies without any secrets.
- **Build-system autoconfiguration**, in SonarQube Cloud's engine, can run
  `mvnw` to configure the project.

Don't turn either back on with `build-arguments` in the Sonar workflow, for
example with `-Dsonar.sca.enabled=true`. That would run the pull request's build
tools with your token.

## What a fork can still influence

A fork controls its own pull request's code and build, so it also controls that
pull request's analysis. It can fake coverage and test results, exclude files,
ignore issues or skip the analysis, and nothing will show it. It can't affect
other pull requests or your branches. So take a fork's Sonar result as
information about the pull request, not as a review of it.

## Hardening your setup

- Don't run fork builds on self-hosted runners that also run the Sonar workflow.
  A fork's build could leave something behind on the machine, such as tampered
  tools or a tampered Sonar cache. GitHub
  [advises against self-hosted runners for public repositories](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)
  anyway.
- Pin the action to a commit SHA.
- Give the Sonar job only the permissions from the [setup](../README.md#setup),
  and no extra secrets or steps.
- Don't add caching to the Sonar job or give it write access to the cache with
  `cache-mode`. The one exception is
  [the Sonar scanner's directory](configuration.md#caching-the-sonar-scanner):
  the action checks the scanner against its checksum every time.
  [By default](https://github.blog/changelog/2026-06-26-read-only-actions-cache-for-untrusted-triggers/),
  GitHub only lets `workflow_run` jobs read the default branch's cache, so they
  can't poison later builds.
- Keep the Sonar token away from builds of pull requests from forks and from
  Dependabot. GitHub withholds it from those builds unless you change one of two
  settings. Leave both alone: don't let a private repository send secrets to
  pull requests from forks, and don't add `SONAR_TOKEN` to Dependabot's secrets.
- Use a dedicated Sonar token, as the [setup](../README.md#setup) describes.
- If you want an extra layer, require approval before workflows from outside
  contributors run (Settings → Actions → General). The analysis is safe without
  it.

If you use `checkout: false`, CodeQL may flag your checkout step with
`actions/untrusted-checkout`, which warns about pull request code checked out in
a privileged job. Nothing in that job runs the checked-out code, so you can
dismiss the alert. Just make sure any step you add doesn't run it either.

## v1

v1 runs Maven or Gradle on the pull request's checkout in the job that holds the
Sonar token, so a fork's code can run with the token. Until June 2026 that code
could also save entries in your default branch's Actions cache, which later
builds restore.

v1 gets no more fixes, so plan the move to v2 now. If v1 has analysed pull
requests from forks, also rotate your Sonar token and delete your repository's
Actions caches as a precaution. Your repository's **Actions** tab lists them
under **Caches** in its sidebar. Delete each one there, or all at once with
`gh cache delete --all`.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
