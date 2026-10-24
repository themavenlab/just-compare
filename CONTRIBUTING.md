# Contributing to Just Compare

Thank you for your interest in contributing! We welcome contributions to improve diffing performance, platform support, usability, and documentation.

## Getting Started

1. Check the [Roadmap & Scope](docs/product/roadmap.md) to understand current milestones and MVP goals.
2. Review the [Architecture Overview](docs/architecture/overview.md) to understand component boundaries (Rust domain crates vs. Tauri desktop shell vs. React UI).
3. Read [AGENTS.md](AGENTS.md) and the [Agent Workflow](docs/engineering/agent-workflow.md) for workflow guidelines and repository conventions.
4. If tackling a new feature or significant change, please open an issue using the [Engineering Task Template](.github/ISSUE_TEMPLATE/engineering-task.md) first to discuss the approach.

## Development Principles

- **Data Safety First:** Just Compare handles users' critical files. All changes must respect the [Data Safety Contract](docs/engineering/data-safety.md)—read operations are strictly read-only, and writes must be atomic, previewed, and recoverable.
- **Keep Changes Atomic:** A pull request or commit should represent a single logical unit containing the implementation, tests, and directly related documentation updates.
- **Dependencies:** Propose and discuss new third-party dependencies in an issue before introducing them. See [Dependency Review](docs/engineering/dependencies.md).
- **Cross-Platform:** Code must work consistently across Windows, macOS, and Linux without hardcoded filesystem assumptions.

## Running Locally

Follow the [README quick start](README.md#development) and the [Windows development guide](docs/engineering/validation.md#windows-local-development).
Use `npm ci` for dependency restoration and `npm run desktop:dev` to test the native application. `npm run dev` is only a browser UI preview.
On Windows, prefer the installed Rust MSVC toolchain and Visual Studio C++ SDK; the earlier session-scoped GNU compiler is an optional fallback, not required setup.
Restart terminals/VS Code after tool installation so PATH is refreshed. Run mutation or file-operation tests only against disposable copies. Native automated test suites require an embedded-assets build rather than the live development server.

## Commit Message Conventions

We use structured Conventional Commits to maintain a clear and bisectable git history. When authoring commits, follow the [commit-message skill](.agents/skills/commit-message/SKILL.md):

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
- Trivial changes (e.g. small documentation fixes) may use just a subject line (e.g. `docs: fix typo in README`).

## Submitting Pull Requests

- Use the [Pull Request Template](.github/pull_request_template.md) to record your rationale, acceptance evidence, validation results, and limitations.
- Ensure all relevant checks and tests pass as outlined in the [Validation Guide](docs/engineering/validation.md).
- Never submit copied proprietary implementations, unlicensed sample files, or credentials in fixtures or pull requests. Do not post exploit details or credentials in public issues.
