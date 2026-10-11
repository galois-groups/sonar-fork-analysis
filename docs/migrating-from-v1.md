# Migrating from v1

v1 stays on its tags but gets no more fixes, not even security fixes. Plan the
move to v2 now. If v1 has analysed pull requests from forks, also rotate your
Sonar token and delete your repository's Actions caches as a precaution. See
[security](security.md#v1) for why.

v2 also has a new home. Replace `evaristegalois11/sonar-fork-analysis` with
`galois-groups/sonar-fork-analysis` in your workflows.

In v1, the Sonar workflow analysed every build. In v2, the build analyses pushes
and your own pull requests itself. The Sonar workflow only analyses pull
requests from forks and Dependabot.

In the build workflow, the action replaces your build step and now gets the
token. Before:

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-java@v6
    with:
      distribution: temurin
      java-version: 21
  - run: mvn install
  - uses: evaristegalois11/sonar-fork-analysis@v1
```

After:

```yaml
steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: actions/setup-java@v6
    with:
      distribution: temurin
      java-version: 21
  - uses: galois-groups/sonar-fork-analysis@v2
    with:
      project-key: my-org_my-project
      sonar-organization: my-org
      sonar-token: ${{ secrets.SONAR_TOKEN }}
```

v2 runs `verify` for Maven and `check` for Gradle. It no longer needs `install`.
If your build step ran other goals or flags, move them to
[`build-goals` and `build-arguments`](configuration.md#inputs).

In the Sonar workflow, the action no longer sets up Java and needs a few more
permissions. Before:

```yaml
jobs:
  sonar:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    permissions:
      actions: read
    steps:
      - uses: evaristegalois11/sonar-fork-analysis@v1
        with:
          distribution: temurin
          java-version: 21
          github-token: ${{ secrets.GITHUB_TOKEN }}
          sonar-token: ${{ secrets.SONAR_TOKEN }}
          project-key: my-org_my-project
```

After:

```yaml
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

`sonar-organization` is new. v1 took the organization from your build, but v2's
Sonar workflow only takes it from this input. `github-token` now defaults to the
workflow's own token, so you can drop it.
