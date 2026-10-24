# Validation and Definition of Done

This guide outlines testing expectations, actual verified test evidence, performance benchmarks, and the definition of done for Just Compare.

---

## Phase 1 Acceptance & Test Commands

The local Windows MVP implements complete text comparison, folder synchronization, three-way merge, CLI operations, and preferences workflows.

### Commands

Run from the repository root with Tauri native prerequisites:

```powershell
# Core Rust tests and checks
cargo test --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings

# Desktop Tauri checks
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- -D warnings

# Frontend checks
npm run check
npm run lint
npm run format:check
npm test
npm run build

# Native desktop test suites (Windows WebView2/CDP)
cargo build --workspace --locked
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --features tauri/custom-protocol
npm run test:native --workspace apps/desktop
npm run test:git --workspace apps/desktop
npm run test:acceptance --workspace apps/desktop
```

*Note: Native test suites launch owned isolated processes and write only to uniquely owned temporary directories.*

---

## Verified Evidence

| Area | Verified Implementation Evidence |
| :--- | :--- |
| **Rust Core Engine** | 21 text comparison and encoding tests, 13 filesystem and folder tests, 5 three-way merge tests, and 1 CLI integration process test. |
| **Frontend UI** | 5 Vitest tests; strict TypeScript typechecking, ESLint, and Prettier formatting checks. |
| **Text Diffing & Native UI** | Real Tauri IPC integration, ignore options (case, whitespace, EOL), input size validation, region copy/undo, intraline highlighting, and Ctrl+S CRLF saving. |
| **Data Safety & Saving** | UTF-16LE BOM and EOL retention, external modification conflict detection, no-clobber protection, read-only destination rejection, and junction reparse point rejection. |
| **Folder I/O & Sync** | Content hashing, exclusion filtering, cancellation handling, empty directory management, stale/consumed preview protection, selected copy/move/recycle, and partial failure reporting. |
| **Three-Way Merge & Git** | Base/Left/Right auto-resolution and conflict detection, unresolved save prevention, existing and new output preservation, cancellation exit code 1, and accepted save exit code 0. |
| **Git Tooling Integration** | Real invocation as `git difftool`, `git difftool --dir-diff --no-symlinks`, and `git mergetool` with index clearance in an owned test repository. |
| **Settings & Sessions** | Restart persistence, additive schema migration, and corruption recovery diagnostics without silent resets. |
| **Portable Packaging** | Unsigned Windows x64 relocatable package built, extracted, and verified launching and executing Rust IPC comparisons. |
| **Accessibility Basics** | Accessible editor and button names, full keyboard navigation and shortcuts, editable row visual alignment, and dirty-close confirmation guards. |

---

## Measured Performance & Scale

Benchmarks measured on Windows x64 (AMD Ryzen 5 7600, 31.1 GiB RAM):

- **Text Diffing:** 968,890 UTF-8 bytes / 20,000 lines per side (with single-line difference): 138–154 ms native round-trip time across five sequential runs.
- **Folder Scanning:** 1,000 files per side (4 KiB each, content-hashed): ~1.23 seconds.
- **Scan Cancellation:** Cancellation response within ~22 ms (budgeted under 2.5 seconds).
- **Visual Alignment:** Matching lines differ by 0 CSS pixels (budgeted at ≤ 2 px).
- **Native Process Memory:** Peak working set of ~55 MiB (excluding separate WebView renderer processes).
- **Frontend Bundle Size:** Largest minified chunk is ~300 kB after code splitting CodeMirror language packs.

### Operational Limits
- Text diff: Up to 1 MiB / 20,000 lines per input.
- Intraline refinement: Up to 64 KiB / 8,192 unicode scalars.
- Folder comparisons: Up to 10,000 entries per root and 100 MiB per file.
- Unimportant difference regex: Up to 16 rules, 4,096 bytes per pattern.

---

## Definition of Done

A task is considered complete when:
- **Observable Acceptance Criteria:** All requirements are satisfied with verifiable evidence.
- **Explicit Failure & Cancellation:** Error states and cancellation flows are handled gracefully and covered by tests.
- **Safety Invariants:** Changes strictly adhere to the [Data Safety Contract](data-safety.md).
- **Automated Validation:** Formatting, linting, type checks, and automated tests pass with zero regressions.
- **Documentation:** Directly affected architectural guides and documentation are updated within the same commit.
- **Platform Evidence:** Tested environments and known limitations are explicitly stated.
- **Atomic Diff:** Unrelated cleanup, secrets, and unlicensed fixtures are absent from the change.
