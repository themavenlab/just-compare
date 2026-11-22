# Validation and definition of done

## Current evidence

The local Windows MVP has recorded native MSVC and earlier GNU evidence.
Configured macOS/Linux CI does not establish executed or certified support.
No clean Windows 10/11 installation matrix or Store-delivered release is
established by that history. See [historical evidence](validation-history.md)
for exact checks, failures, hardware and omissions, and the
[release guide](release.md) for candidate-specific gates.

## Phase 8 verification (Windows, 2026-10-21)

Executed on Windows x64 with MSVC Rust 1.99.0 and npm 11.7.0. The installed Node.js was v24.22.0; the repository pins v22.17.0, which was not installed. Therefore the frontend and native results below are evidence for the installed runtime, not the pinned Node runtime.

Passed:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets --locked -- -D warnings`
- `cargo test --workspace --locked` (173 passed, 1 ignored)
- Desktop-manifest `cargo fmt --check` and strict all-target Clippy
- `cargo build --workspace --locked` and desktop embedded-assets build using an isolated Cargo target directory
- `npm run check`, `npm test` (4 files, 44 tests), and `npm run build`
- Native `test:git`, `test:workflows`, `test:auto-compare`, `test:keyboard`, `test:recovery`, `test:alignment-merge`, `test:folder-copy`, `test:folder-link-copy`, `test:delete`, `test:one-step-actions`, `test:preview-maps`, `test:folder-exclude`, `test:folder-save`, and `editing-regression`
- `test:sessions` after updating its obsolete assertion from the previous binary-content default to the current no-content default

Failures and omissions:

- `npm run lint` reports two existing React hook diagnostics in `ComparisonWorkspace.tsx` (effect state update at line 306 and ref access at line 5023).
- `npm run format:check` reports formatting differences in `ComparisonWorkspace.tsx`, `folderPresentation.test.ts`, `folderPresentation.ts`, `FolderView.tsx`, and `folder-copy-regression.mjs`.
- Native `test:native` fails because Copy leaves focus on “Left text” rather than the expected “Right text”.
- Native `test:acceptance` fails its cancel-race assertion: the benchmark scan resolves instead of rejecting as cancelled.
- Native `test:workbench` times out after 30 seconds at its 1024x768 layout check.
- Native `test:compact` observes 788 px of content in a 758 px viewport.
- Native `test:interactions` observes `false` where the regression expects `true`.

The default embedded-assets build could not replace the executable while the user's Just Compare window was running. It was not stopped; native checks used an isolated build and `COMPARE_TEST_DESKTOP`. These are Windows-native results only. macOS/Linux CI was not run, and no release or clean-install claim follows.

## Windows local development

Use the repository-pinned Node/npm and Rust versions, Visual Studio's
**Desktop development with C++** workload with MSVC and a Windows SDK, and
WebView2 Evergreen. Inspect `.node-version`, `package.json` and
`rust-toolchain.toml` rather than assume globally installed versions.

In a fresh PowerShell at the repository root, run sequentially:

```powershell
node --version
npm --version
rustup show active-toolchain
rustc -vV
cargo --version
npm ci
npm run desktop:dev
```

Use `npm ci` for a fresh checkout or missing dependencies, not before every
check. `rustc -vV` should report `x86_64-pc-windows-msvc` for standard Windows
development. The first native build can take several minutes. Wait for the
native Just Compare window; a browser Vite preview cannot verify Rust IPC.
Keep the owning terminal open and stop it before preparing standalone builds.

If tools installed recently are missing, restart VS Code/terminals. The current
terminal can use `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`.
Check installed Visual Studio C++/SDK components before declaring them absent.
Remove only overrides you deliberately set for a historical GNU fallback;
never mix GNU libraries with MSVC or change machine-wide environment variables.
Use the Visual Studio developer terminal if linker/SDK discovery fails.

Port 1420 is strict. Stop only an earlier process you own if it is occupied.
Development executables need the live Vite server; use embedded assets below
for standalone testing.

## Commands

Run the smallest checks covering the change; escalate for integrated releases:

```powershell
cargo test --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --manifest-path apps\desktop\src-tauri\Cargo.toml -- --check
cargo clippy --manifest-path apps\desktop\src-tauri\Cargo.toml --locked -- -D warnings
npm run check
npm run lint
npm run format:check
npm test
npm run build
```

### Automated checks versus manual launch

For native suites, build standalone debug executables first:

```powershell
npm run build
cargo build --workspace --locked
cargo build --manifest-path apps\desktop\src-tauri\Cargo.toml --locked --features tauri/custom-protocol
```

Run native scripts sequentially: they share a WebView2 profile and simultaneous
launches can attach to the wrong process. The maintained package scripts include
`test:native`, `test:git`, `test:acceptance`, `test:workflows`, `test:workbench`,
`test:compact`, `test:interactions`, `test:auto-compare`, `test:keyboard`,
`test:sessions`, `test:recovery`, `test:alignment-merge`, `test:folder-copy`, `test:preview-maps`, `test:folder-exclude` and `test:folder-save`:

```powershell
npm run test:native --workspace apps\desktop
node apps\desktop\scripts\editing-regression.mjs
node apps\desktop\scripts\history-regression.mjs
node apps\desktop\scripts\inspector-regression.mjs
node apps\desktop\scripts\explorer-regression.mjs
```

Select other suite names from `apps/desktop/package.json` as appropriate.
`npm run test:preview-maps --workspace apps\desktop` verifies that a later tab's preview does not evict an earlier tab's native plan.
`npm run test:folder-copy --workspace apps\desktop` exercises direct-target folder copy when the destination parent folders do not yet exist.
`npm run test:delete --workspace apps\desktop` covers the folder Delete flow: one folder dialog, one Start, no second confirmation, and an automatic refresh.
`npm run test:one-step-actions --workspace apps\desktop` applies the same one-Start flow to rename, New Folder, Attributes, and Touch.
`npm run test:folder-exclude --workspace apps\desktop` runs the focused native folder exclusion regression independently of the broader native smoke flow.
`COMPARE_TEST_DESKTOP` permits an alternate embedded-assets test executable.
These are Windows native WebView2/CDP tests, not packaged-release or other-OS
evidence. Use owned temporary fixtures. Real native dialogs, Explorer menu
interaction, screen readers and display scaling still need manual checks.

### Optimized local package

```powershell
npm run build
cargo build --workspace --release --locked
cargo build --manifest-path apps\desktop\src-tauri\Cargo.toml --release --locked --features tauri/custom-protocol
npm run package:windows --workspace apps\desktop
```

The portable packager includes both executables, notices and applicable covered
source, handles the loader according to the toolchain, and verifies extracted
launch. It produces an unsigned local ZIP, not Store certification.
`npm run package:msix` is the separate Store path; follow the release guide.

## Verified evidence

Preserved detailed results live in [validation history](validation-history.md#verified-evidence).
Do not copy historical passes into a new release report without rerunning them.

## Measured scale

See [historical measurements](validation-history.md#measured-scale).
They are single-machine warm/debug observations, not performance guarantees.
Current enforced limits and filesystem behavior are documented in
[usage](../product/usage.md) and [data safety](data-safety.md).

## Performance

Reproducible fixture: `cargo test -p compare-fs --release -- --ignored perf --nocapture` (`perf_default_scan_50k_files_in_2k_folders` in `crates/compare-fs/src/folder_rules.rs`). It builds 2,000 folders × 25 files on each side (50,000 matched file pairs plus 2,000 folder rows = 52,000 rows), then runs a default scan twice in one process.

| Run | Elapsed (release) |
| --- | --- |
| cold (first scan after fixture writes; OS cache not dropped) | ~700–810 ms |
| warm (second scan) | ~290–310 ms |

Machine: Windows 11 Pro, AMD Ryzen 5 7600 (6 cores), 31.1 GB RAM, CT1000P3PSSD8 SSD. Single-machine observations, not guarantees. The UI-side (folder view, select-all) check with this fixture is manual and is recorded in the phase handoff.

## Definition of done

- Observable acceptance criteria and applicable failure paths are verified.
- All scoped surfaces preserve typed contracts and data-safety behavior.
- Relevant format/lint/type/build/regression checks pass.
- Docs and actual supported-platform evidence agree with implementation.
- Dependencies, destructive testing and publication have scoped approval.
- Actual results, known failures and omitted manual checks are stated.
- No unrelated edits, private data, secrets or unauthorized uploads/commits occur.

A local package, browser preview or configured CI is not a public release.
