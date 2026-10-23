---
name: commit-message
description: Rules and conventions for authoring structured Conventional Commits with Why, Changes, and Validation summaries. Use whenever writing git commit messages.
---

# Commit Message Conventions

This project uses structured Conventional Commits to maintain a clean, readable, and bisectable Git history.

## Commit Message Format

```text
<type>(<scope>): <imperative summary>

- Why:
  - <Problem or motivation.>
  - <User impact, when relevant.>
- Changes:
  - <Important implementation or behavior change.>
  - <Compatibility or data-safety consideration, when relevant.>
- Validation:
  - <Exact command/check and actual result.>
  - <Skipped checks, failures, or platform limitations.>

Refs: #<issue>
```

### Formatting Rules
- **Subject line:** Under 72 characters, imperative mood, lowercase, no trailing period (e.g. `feat(desktop): add side-by-side text diff viewer`).
- **Indentation:** Primary section bullets (`- Why:`, `- Changes:`, `- Validation:`) start at column 1. Secondary bullets start with exactly two spaces and `- `.
- **Footers:** Blank line before footers. Use `Refs: #123` for related issues, or `Closes #123` if the commit completes the issue.
- **Trivial changes:** Genuinely trivial changes (e.g., fixing a typo) may use just a subject line: `docs: fix typo in README`.

## Types and Scopes

| Type | When to use |
| :--- | :--- |
| `feat` | New user-facing functionality |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests and fixtures |
| `docs` | Documentation changes |
| `build` | Tooling, dependencies, or packaging |
| `ci` | CI workflows and automation |
| `chore` | Maintenance tasks |
| `revert` | Reverting a previous commit |

**Common Scopes:** `text`, `merge`, `folder`, `desktop`, `cli`, `ipc`, `docs`, `ci`.

## Atomic Commits
- Each commit must represent a single complete logical unit that can be reviewed or reverted independently.
- Include implementation, regression tests, and directly affected documentation in the same commit.
- Never include secrets, private local paths, or unverified test claims.

## Breaking Changes
Prefix type/scope with `!` and add a standalone `BREAKING CHANGE:` footer:

```text
feat(ipc)!: replace full diff payloads with paged results

- Why:
  - Full-result transport creates excessive memory pressure on large files.
- Changes:
  - Introduce bounded page requests and responses.
  - Remove full-result transport endpoint.
- Validation:
  - cargo test -p app-ipc: passed.

BREAKING CHANGE: Callers must request diff results in pages.

Refs: #126
```
