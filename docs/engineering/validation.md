# Validation and Definition of Done

## Phase 1 Acceptance

The local Windows MVP implements text/folder/merge/CLI/settings workflows. The tested machine is Windows build 10.0.26300, x64, AMD Ryzen 5 7600, 31.1 GiB RAM, with installed WebView2, Node 22.17.0, npm 11.7.0, and Rust 1.99.0 GNU. macOS and Linux CI is configured but has not executed. No public release or signing is implied by local packaging.

## Windows Local Development

### Standard Installed Toolchain

Use Node 22.17.0, npm 11.7.0, rustup/Rust 1.99.0, WebView2 Evergreen, and Visual Studio's **Desktop development with C++** workload with MSVC x64/x86 tools and a Windows SDK. Visual Studio Community 2026 with MSVC 14.51 and SDK 10.0.26100.0 was detected after the owner's installation; Visual Studio Build Tools also works without installing the full IDE. The installed MSVC setup was verified with `npm run desktop:dev`: Vite returned HTTP 200 on port 1420, native compilation completed, and the desktop process launched. The initial native build took about 91 seconds after dependency restoration. Earlier full native regression and package evidence below uses GNU; the MSVC launch check does not imply that the entire test suite was rerun on MSVC.

Restart VS Code after installing tools. Existing terminals and background agents inherit the old PATH and can incorrectly report that Rust is missing. In a fresh PowerShell window, from the repository root:

```powershell
Set-Location 'C:\parag_data\GitHub\just-compare'
node --version
npm --version
rustup show active-toolchain
rustc -vV
cargo --version
npm ci
npm run desktop:dev
```

Run commands sequentially and stop on an error. `rustc -vV` should report `host: x86_64-pc-windows-msvc` for standard Windows development. The repository's toolchain file selects 1.99.0 with rustfmt and Clippy; if the pinned toolchain is missing, restore it explicitly with `rustup toolchain install 1.99.0`. The first Cargo build downloads dependencies and can take several minutes. Tauri starts Vite at `http://127.0.0.1:1420`, compiles Rust, then opens the native window. Keep that terminal open; Ctrl+C stops development. Frontend changes reload and Rust changes trigger a rebuild/restart. No separate Vite command is needed. Use disposable fixtures for all write and sync tests.

### Troubleshooting

- **Rust installed but command not found:** Restart VS Code, or in the current PowerShell terminal only, run `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`.
- **Old scoped GNU setup:** Use a fresh standard terminal. Remove only overrides you previously set for the fallback (`RUSTUP_TOOLCHAIN`, `CARGO_HOME`, `RUSTUP_HOME`, `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER`); do not erase a deliberate custom Rust installation. Do not combine GNU libraries with MSVC. Switching hosts requires a separate initial native dependency compilation.
- **Missing linker/SDK:** Modify Visual Studio's C++ workload. If automatic discovery fails, use its Developer PowerShell or x64 Native Tools terminal.
- **Port 1420 occupied:** Stop your earlier development terminal with Ctrl+C. Do not terminate unrelated processes. Vite uses a strict port and cannot silently choose another.
- **Browser opens but native operations fail:** Use `npm run desktop:dev`, not `npm run dev`. Comparison and filesystem commands require Tauri IPC.
- **Direct debug executable cannot load the UI:** Development builds depend on the running Vite dev server. For standalone launch and native smoke tests, build embedded frontend assets using the commands below.

### Automated Checks Versus Manual Launch

`cargo test --workspace --locked`, `npm run check`, `npm run lint`, and `npm test` cover headless and frontend behavior. Native smoke, Git, and acceptance scripts require:

```powershell
npm run build
cargo build --workspace --locked
cargo build --manifest-path apps\desktop\src-tauri\Cargo.toml --locked --features tauri/custom-protocol
npm run test:native --workspace apps\desktop
npm run test:git --workspace apps\desktop
npm run test:acceptance --workspace apps\desktop
npm run test:workflows --workspace apps\desktop
npm run test:workbench --workspace apps\desktop
npm run test:compact --workspace apps\desktop
npm run test:interactions --workspace apps\desktop
```

Stop the live development terminal before preparing an embedded-assets build. These scripts own temporary fixtures and processes; manual tests should use disposable copies too. Screen-reader and native confirmation UX still require manual checks.

### Commands

From the repository root with Tauri native prerequisites:

```text
cargo test --workspace --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- -D warnings
npm run check
npm run lint
npm run format:check
npm test
npm run build
cargo build --workspace --locked
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --features tauri/custom-protocol
npm run test:native --workspace apps/desktop
npm run test:git --workspace apps/desktop
npm run test:acceptance --workspace apps/desktop
npm run test:workflows --workspace apps/desktop
npm run test:workbench --workspace apps/desktop
npm run test:compact --workspace apps/desktop
npm run test:interactions --workspace apps/desktop
npm run test:sessions --workspace apps/desktop
npm run test:history --workspace apps/desktop
npm run test:inspector --workspace apps/desktop
npm run test:explorer --workspace apps/desktop
node apps/desktop/scripts/editing-regression.mjs
```

Use `npm ci` for a fresh checkout. Native suites require an embedded-assets debug build, launch only owned processes, and write only owned temporary fixture trees. They are Windows WebView2/CDP tests, not browser mocks or other-platform evidence. Native runners also honor `COMPARE_TEST_DESKTOP` for an alternate embedded-assets executable.

### Optimized Local Package

```text
npm run build
cargo build --workspace --release --locked
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --release --locked --features tauri/custom-protocol
npm run package:windows --workspace apps/desktop
```

The local ZIP includes both executables, the GNU WebView2 loader and its reviewed license, project licenses and lockfiles, third-party license and attribution files, resolved graph metadata, and MPL package source. It normalizes copied timestamps into ZIP's supported range, extracts to a different directory, and verifies release launch and real Rust comparison. Artifact paths and SHA-256 values print on success. Tauri installer bundling remains disabled; the verified delivery is the unsigned relocatable ZIP. Installed WebView2 Evergreen is required. Distribution approval and a final shipped-source notice review remain separate from local MVP acceptance.

### Scoped Windows GNU Environment

During initial development the machine lacked MSVC. Scoped Rust GNU plus LLVM-MinGW 20261006 (publisher archive digest verified) built the app without system-wide changes. MSVC remains the conventional Windows build prerequisite.

```powershell
$env:CARGO_HOME = '<scoped cargo home>'
$env:RUSTUP_HOME = '<scoped rustup home>'
$env:PATH = '<llvm-mingw bin>;' + "$env:CARGO_HOME\bin;$env:PATH"
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'rust-lld'
```

The scoped stable toolchain used here reports 1.99.0. Reproduction should select `1.99.0-x86_64-pc-windows-gnu` rather than allowing stable to drift; install rustfmt and Clippy for that toolchain. Do not install system-wide tools without approval.

## Verified Evidence

### Phase 2A-01 Recent History (Windows/MSVC)

Windows MSVC: settings migration/restart/bounds tests, TypeScript check, all 16 Vitest frontend tests, ESLint, production frontend build, and embedded-assets native build passed. `node apps/desktop/scripts/history-regression.mjs` verifies empty history, typed path submission without per-keystroke scans, single- and two-root loading, collapsed initial trees, keyboard filtering and selection, retained results on missing roots, deduplication, complete Home tuple reopening across restart, and real failed persistence.

### Phase 2A-02 Line Inspector (Windows/MSVC)

Windows MSVC: TypeScript, ESLint, 16 frontend Vitest tests, settings unit tests, production frontend build, and embedded-assets native build passed. `node apps/desktop/scripts/inspector-regression.mjs` verifies multiline detail navigation, missing lines, Unicode/tabs/long-line horizontal overflow, caret selection with retained editor focus, zero draft mutation, invalidation, Undo/copy refresh, resize/collapse, and layout-only persistence across restart. The inspector alignment regression also passed on a separate embedded-assets debug profile: both source text starts share the same column (within one CSS pixel), including missing-side rows, with no duplicate coordinate header. Native interaction tests passed with stable aligned two-way scrolling during asynchronous result and persistence updates.

### Phase 2A-03 Windows Explorer Commands (Windows/MSVC)

`node apps/desktop/scripts/explorer-regression.mjs` verifies owned HKCU registration, removal, single-item commands, private selection state across restart, argument handoff to the running instance without losing tabs, missing/linked/mixed path rejection, and isolated test-registry safety. The updated Explorer suite also passed Windows Shell activation (`Start-Process`) using the executable and quoted arguments read from the isolated registry. It verifies standard drive/UNC launch paths without filesystem device prefixes, hidden compare commands without a selection, type-specific left-selection labels, named compare visibility for matching files/folders, selection updates and clear, owned legacy-verb removal, and refusal of foreign-owned registrations. CLI waiting launches and native smoke tests also passed.

### Phase 2A-04 Manual-Edit Comparison Refresh (Windows/MSVC)

Windows MSVC: TypeScript, ESLint, Prettier, all 16 frontend Vitest tests, production frontend build, and embedded-assets debug and release builds passed. `node apps/desktop/scripts/editing-regression.mjs` verifies actual keyboard typing, automatic localized CRLF differences and explicit recompare, CR and mixed-EOL restoration, significant real EOL differences, serialized superseded responses, retained alignment with stale copy arrows unavailable, insertion gaps, Undo, explicit refresh failure and recovery, invalid document handles, and unchanged source bytes on disk. Native inspector, smoke, interaction, and Git suites also passed. Smoke and inspector assertions now expect automatic refresh instead of manual edit invalidation.

| Area | Evidence |
| :--- | :--- |
| **Rust core** | 21 text tests, 13 Windows filesystem/settings/folder tests, 5 merge tests and 1 CLI process test |
| **Frontend** | 5 Vitest tests; strict TypeScript, ESLint, Prettier and production build |
| **Text UI/native** | Real IPC, ignore options, invalidation/limit errors, open/edit, region copy/undo, intraline marks and Ctrl+S CRLF save |
| **Save safety** | UTF-16LE BOM/EOL retention, external modification, no-clobber, read-only destinations, hard-link replacement, junction ancestors |
| **Folder IO** | Scan/filters/cancellation, empty directories/collisions, stale/consumed previews, selected copy, move/recycle, unavailable-trash injection and partial cancellation |
| **Merge/Git** | Auto-resolution/conflicts, unresolved save disabled, native acceptance guard, existing/new output, cancellation exit 1, accepted save exit 0 |
| **Actual Git** | File difftool, `--dir-diff --no-symlinks`, mergetool and unmerged-index clearance in an owned repository; no fixture commits |
| **Settings** | Restart persistence, additive version-1 profile migration, retained corruption diagnostics |
| **Packaging** | Optimized extracted Windows x64 executable launched with loader and performed Rust IPC comparison |
| **Accessibility basics** | Accessible editor/button/region names, native keyboard save/compare/navigation, editable row alignment, explicit live errors and dirty-close prevention |

Unix-specific symlink and backslash tests are configured but not run on Windows. Native screen-reader behavior, exhaustive assistive-technology and contrast auditing, and other OS builds remain unverified. Automated acceptance verifies that a dirty-close request leaves the app alive without confirmation. Accepting or dismissing every native discard/regenerate prompt still needs manual UX regression testing. Filesystem race and metadata restrictions are documented in the [Data Safety Contract](data-safety.md#implemented-local-backend).

## Measured Scale

`test:acceptance` performs five sequential warm native IPC comparisons, a content scan, and cooperative cancellation, reporting actual machine metadata and timings. A representative debug run on the reference machine:

- **Text:** 968,890 UTF-8 bytes / 20,000 lines per side, one changed line: 138-154 ms native round-trip across five runs.
- **Folders:** 1,000 files per side, 4 KiB each, content-hashed: approximately 1.23 s.
- **Scan cancellation:** Approximately 22 ms; automated budget below 2.5 s.
- **Editable alignment:** Matching rows differ by 0 CSS pixels; budget at most 2 px.
- **Native process peak working set:** 57,679,872 bytes (about 55 MiB). This excludes separate WebView/browser processes and is not total app memory.
- **Largest frontend chunk:** About 300 kB minified after editor and syntax code splitting; production build no longer emits the 500 kB chunk warning.

These measurements are single-machine, warm/debug observations, not SLA claims, cold-disk benchmarks, or supported huge-file promises. CPU diff has a two-second budget and cooperative checks; a single library call cannot be interrupted immediately. Text is limited to 1 MiB / 20,000 lines; intraline to 64 KiB / 8,192 scalars; folder entries to 10,000 per root and 100 MiB per file. Regex uses at most 16 patterns, 4,096 bytes per pattern, and bounded compiled/DFA budgets.

## Definition of Done

- Acceptance criteria are observable and satisfied by evidence.
- Every scoped surface is wired; errors and cancellation remain explicit.
- Changed behavior has regression and applicable failure coverage.
- Data-safety requirements and typed internal contracts are preserved.
- Relevant format, lint, type, build, and test checks pass.
- Directly affected documentation and architecture guides reflect actual implementation and limitations.
- Dependencies and destructive testing have scoped approval.
- Actual platform coverage and omitted manual checks are stated honestly.
- Unrelated changes, secrets, unauthorized commits, and uploads are absent.

Run focused checks first, escalating when integration requires it. Do not equate configured CI with executed tests, virtualization with unlimited scale, or a local unsigned package with a production release. Future viewers and providers need their own correctness, invalid-input, license, capability, and resource evidence.
