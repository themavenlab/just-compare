# Validation and Quality Standards

This guide outlines testing expectations, platform verification requirements, and the definition of done.

## Current Tooling State

The repository is currently establishing foundational documentation. Pinned toolchains, Cargo manifests, test suites, and CI pipelines will be introduced during the scaffolding phase.

Once tools are configured (Cargo tests, rustfmt, Clippy, TypeScript checks, and native smoke tests), copy/paste commands and CI status badges will be documented here.

---

## Definition of Done

A task is considered complete when:
- **Observable Acceptance Criteria:** All functional requirements are satisfied with verifiable evidence.
- **Contract & Edge Case Coverage:** Error, boundary, and cancellation paths are covered by tests.
- **Data Safety Guarantees:** File operations strictly adhere to the [Data Safety Contract](data-safety.md).
- **Code Quality Checks:** Formatting, linting, type checks, and automated tests pass without regressions.
- **Documentation:** Directly affected architectural guides, READMEs, and APIs are updated in the same change.
- **Platform Reality:** Tested environments (OS, architectures) and known limitations are explicitly documented.
- **Atomic Diff:** Changes are focused and contain zero extraneous edits or sensitive test fixtures.

---

## Planned Test Coverage by Subsystem

| Area | Required Verification When Implemented |
| :--- | :--- |
| **Text Diff** | Unit/property tests for diff algorithms; applying patches reconstructs the target exactly; encoding (UTF-8, UTF-16) and line-ending (CRLF/LF) preservation tests. |
| **Three-Way Merge** | Base/Left/Right invariant tests; conflict marker generation; clean resolution handling. |
| **Filesystem & Sync** | Isolated filesystem integration tests; stale-preview detection; symlink handling; permission preservation; dry-run rollback. |
| **Frontend UI** | Component/interaction tests for keyboard navigation, focus preservation, diff scrolling, and virtualized large-file rendering. |
| **IPC Bridge** | Schema validation, cancellation handling, stale operation suppression, and memory disposal on window closure. |
| **CLI & Git Integration** | Process exit codes, wait semantics for external editors (`git difftool` / `git mergetool`), file argument parsing. |
| **Desktop Application** | Native smoke tests and launch validation on Windows, macOS, and Linux. |

---

## Cross-Platform Verification

- Windows, macOS, and Linux are target platforms. Native features (e.g. system keychains, filesystem events, dark mode integration) must be verified on each OS.
- Mocked browser tests validate UI presentation, but cannot substitute for native filesystem or desktop shell testing.
- Platform-specific quirks (e.g. case-preserving vs. case-sensitive filesystems, path length limits, line endings) must be covered with targeted test fixtures.

---

## Accessibility and Performance

- **Accessibility:** Keyboard accessibility (Tab navigation, shortcut triggers), readable contrast ratios, and screen-reader announcements for diff counts must be built into UI components from the start.
- **Performance:** Diffing benchmarks must report input size, line counts, peak memory usage, and execution latency under reproducible hardware conditions. Avoid speculative performance claims without measurement.
