# Contributing to Just Compare

Thank you for your interest in contributing! We welcome contributions to improve diffing performance, platform support, usability, and documentation.

## Getting Started

1. Check the [Roadmap](docs/product/roadmap.md) to see current goals and milestone priorities.
2. Review the [Architecture Overview](docs/architecture/overview.md) to understand component boundaries (Rust domain crates vs. Tauri desktop shell vs. React UI).
3. If tackling a new feature or significant change, please open an issue using the [Engineering Task Template](.github/ISSUE_TEMPLATE/engineering-task.md) first to discuss the approach.

## Development Principles

- **Data Safety First:** Just Compare handles users' critical files. All changes must respect the [Data Safety Contract](docs/engineering/data-safety.md)—read operations are strictly read-only, and writes must be atomic, previewed, and recoverable.
- **Keep Changes Atomic:** A pull request or commit should represent a single logical unit containing the implementation, tests, and directly related documentation updates.
- **Dependencies:** Propose and discuss new third-party dependencies in an issue before introducing them.
- **Cross-Platform:** Code must work consistently across Windows, macOS, and Linux without hardcoded filesystem assumptions.

## Commit Message Conventions

We use structured Conventional Commits to maintain a clear and bisectable git history:

```text
<type>(<scope>): <imperative summary>

- Why:
  - Motivation or problem solved.
- Changes:
  - Concrete implementation details or behavior changes.
- Validation:
  - Tests run and actual results observed.

Refs: #123
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
- **Common scopes:** `text`, `merge`, `folder`, `desktop`, `cli`, `ipc`, `docs`.
- Trivial changes (e.g. documentation typos) may use just a subject line (e.g. `docs: fix typo in README`).

## Submitting Pull Requests

- Use the [Pull Request Template](.github/pull_request_template.md) to document your rationale, validation steps, and observed test results.
- Ensure all relevant checks and tests pass as outlined in the [Validation Guide](docs/engineering/validation.md).
- Never include proprietary code, unlicensed sample files, or credentials in fixtures or pull requests.
