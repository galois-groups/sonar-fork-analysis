# Security policy

This action analyses pull requests from forks with a Sonar token, so its whole
purpose is to keep that token away from code the fork controls. Reports of
anything that weakens that are very welcome.

## Supported versions

| Version | Supported                                         |
| ------- | ------------------------------------------------- |
| v2      | Yes                                               |
| v1      | No: v2 replaces it and fixes its known weaknesses |

## Reporting a vulnerability

Please report it privately, through
[GitHub's vulnerability reporting](https://github.com/galois-groups/sonar-fork-analysis/security/advisories/new),
not in a public issue or pull request.

In your report, include:

- what an attacker controls, such as a fork's branch name, its build or its
  artifact;
- what they gain;
- the steps or a workflow that reproduce it.

Replies are best effort because this is a personal project, but security reports
always come first.

## Out of scope

- Workflows that run a fork's code with secrets despite the documentation, for
  example a build on `pull_request_target`.
- Self-hosted runners shared by the builds of forks and the analysis. GitHub
  advises against them for public repositories, because a fork's code can take
  over the machine for good
  ([Hardening for self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)).
