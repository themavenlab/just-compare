# Documentation

Just Compare is preparing its first free Windows Microsoft Store release.
The local Windows MVP is not a certified Store package. MIT OR Apache-2.0
licensing remains in place; the source repository is private for now.

## Using the application

- [Usage](product/usage.md): text, folders, merge, settings, CLI and Git.
- [Privacy](../PRIVACY.md): local settings, history, recovery and integrations.
- [Safety and limitations](engineering/data-safety.md): what saves and file
  operations guarantee, and what they do not.
- [Scope](product/scope.md): implemented workflows and explicit non-goals.

The public product website and Store assets are maintained in the separate
branding repository. Full public user guides are later work.

## Developing

- [Quick start](../README.md#development) and [contributing](../CONTRIBUTING.md).
- [Validation](engineering/validation.md): current commands and evidence rules.
- [Agent workflow](engineering/agent-workflow.md) and [shared rules](../AGENTS.md).
- [Architecture](architecture/overview.md), [IPC](architecture/ipc.md) and
  [decisions](decisions/README.md).
- [Dependencies and distribution obligations](engineering/dependencies.md).
- [Commit conventions](engineering/commit-messages.md).

## Preparing distribution

- [Release guide](engineering/release.md): Store identity, candidate preparation,
  compatibility, installation, legal/content review and launch gates.
- [Source publication](engineering/source-publication.md): what changes when
  the source becomes public.
- [Roadmap](product/roadmap.md): future direction, not current release status.
- [Historical validation](engineering/validation-history.md): provenance of
  previous checks, including failures and omissions.

Issues/PRs or the current task conversation hold execution progress. These guides
are reusable documentation, not a second task tracker.
