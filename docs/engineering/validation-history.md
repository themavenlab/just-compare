# Historical validation evidence

This is preserved evidence from earlier work, not a fresh release-candidate
test report. Toolchain, packaging and workflow descriptions below reflect their
recorded context and may be superseded. Use the
[current validation guide](validation.md) for commands and the
[release guide](release.md) for distribution gates.

## Release-preparation checks (Windows MSVC)

The release-preparation work passed application TypeScript checking, ESLint,
Prettier, all 21 frontend tests, the frontend production build, Rust workspace
tests, strict workspace/native Clippy and standalone embedded-assets debug
builds. Native Git, folder-save, workflow, keyboard, recovery, alignment/merge
and editing regressions passed sequentially. Three Node packaging regressions
passed, covering versions, manifest resources/identity and runtime payload errors.

Shared Windows runtime/notice staging was exercised with the real Windows SDK
MakeAppx pack/unpack tools using a test-only debug payload. The unpacked package
contained both executables, project licenses, 499 resolved notice entries and
covered MPL source. This test used version 1.0.0 only to validate packaging; it
does not choose the release version, create a production candidate or establish
installation/Store compatibility. The production packaging command correctly
rejects the current 0.1.0 version rather than silently changing it.

`cargo fmt --all -- --check` failed on existing formatting in
`crates/compare-fs/src/shell.rs`, inside
`scoped_registration_is_quoted_owned_and_removable`; that unrelated source was
not changed. This remains a release gate even though strict Clippy passed.

The separate branding website passed Astro checking, static build, four Node
content/asset/availability tests and a zero-advisory npm audit using its pinned
Node 22.22.0/npm 10.9.4 stack. Browser checks covered desktop/mobile overflow,
screenshot dialog Escape/focus restoration, FAQ, support/privacy navigation,
and content/image links without JavaScript. Four synthetic native screenshots
were captured at 1920x1080 with development-build provenance. Requested
300x300, 150x150 and 71x71 Store PNGs and manifest PNG dimensions were verified.

Clean Windows 10/11 installations, production MSIX, upgrade/uninstall, installed
CLI/Git/Explorer, WACK, real native-dialog/screen-reader checks, hosted Pages
headers/HTTPS and Store delivery remain unverified. No certificate trust,
registration, upload, deployment, commit or publication was performed.

## Phase 1 acceptance

The local Windows MVP implements text/folder/merge/CLI/settings workflows.
The tested machine is Windows build 10.0.26300, x64, AMD Ryzen 5 7600, 31.1 GiB RAM,
with installed WebView2, Node 22.17.0, npm 11.7.0 and Rust 1.99.0 GNU.
macOS/Linux CI is configured but has not executed. No public release or signing
is implied by local packaging.

## Windows local development

### Standard installed toolchain

Use Node 22.17.0, npm 11.7.0, rustup/Rust 1.99.0, WebView2 Evergreen, and
Visual Studio's **Desktop development with C++** workload with MSVC x64/x86
tools and a Windows SDK. Visual Studio Community 2026 with MSVC 14.51 and
SDK 10.0.26100.0 was detected after the owner's installation; Visual Studio
Build Tools also works without installing the full IDE.
The installed MSVC setup was verified with `npm run desktop:dev`: Vite returned
HTTP 200 on port 1420, native compilation completed, and the desktop process
launched. The initial native build took about 91 seconds after dependency
restoration. Earlier package and headless-suite evidence below uses GNU.
The workbench UI regression below additionally verifies native suites on MSVC;
it does not imply a new release package or a complete MSVC headless-suite run.

Restart VS Code after installing tools. Existing terminals and background agents
inherit old PATH and can incorrectly report that Rust is missing. In fresh
PowerShell, from the repository root:

```powershell
Set-Location 'C:\parag_data\GitHub\beyond-compare'
node --version
npm --version
rustup show active-toolchain
rustc -vV
cargo --version
npm ci
npm run desktop:dev
```

Run commands sequentially and stop on an error. `rustc -vV` should report
`host: x86_64-pc-windows-msvc` for standard Windows development. The repository's
toolchain file selects 1.99.0 with rustfmt/Clippy; if the pinned toolchain is
missing, restore it explicitly with `rustup toolchain install 1.99.0`.
The first Cargo build downloads dependencies and can take several minutes.
Tauri starts Vite at `http://127.0.0.1:1420`, compiles Rust, then opens the native
window. Keep that terminal open; Ctrl+C stops development. Frontend changes
reload and Rust changes trigger a rebuild/restart. No separate Vite command is
needed. Use disposable fixtures for all write/sync tests.

### Troubleshooting

- **Rust installed but command not found:** restart VS Code, or in the current
  PowerShell only, run
  `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`.
- **Old scoped GNU setup:** use a fresh standard terminal. Remove only overrides
  you previously set for the fallback (`RUSTUP_TOOLCHAIN`, `CARGO_HOME`,
  `RUSTUP_HOME`, `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER`); do not erase a
  deliberate custom Rust installation. Do not combine GNU libraries with MSVC.
  Switching hosts requires a separate initial native dependency compilation.
- **Missing linker/SDK:** modify Visual Studio's C++ workload. If automatic
  discovery fails, use its Developer PowerShell or x64 Native Tools terminal.
- **Port 1420 occupied:** stop your earlier development terminal with Ctrl+C.
  Do not terminate unrelated processes. Vite uses a strict port and cannot
  silently choose another.
- **Browser opens but native operations fail:** use `npm run desktop:dev`, not
  `npm run dev`. Comparison and filesystem commands require Tauri.
- **Direct debug executable cannot load the UI:** development builds depend on
  the running Vite server. For standalone launch/native smoke, build embedded
  frontend assets using the commands below.

### Automated checks versus manual launch

`cargo test --workspace --locked`, `npm run check`, `npm run lint`, and `npm test`
cover headless/frontend behavior. Native smoke/Git/acceptance scripts require:

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
npm run test:keyboard --workspace apps\desktop
npm run test:auto-compare --workspace apps\desktop
npm run test:sessions --workspace apps\desktop
npm run test:recovery --workspace apps\desktop
npm run test:folder-save --workspace apps\desktop
node apps\desktop\scripts\editing-regression.mjs
```

The native compact-workbench regression checks that Text Compare and Folder
Compare action bars wrap without horizontal scrolling at a narrow test
viewport. The Tauri window starts maximized with a 1280 px minimum width;
browser-only viewport emulation does not verify native window sizing, so confirm
startup behavior in the native desktop app when validating a release build.

Stop the live development terminal before preparing an embedded-assets build.
These scripts own temporary fixtures and processes; manual tests should use
disposable copies too. Screen-reader and platform file-dialog UX still require
manual checks.

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
npm run test:keyboard --workspace apps/desktop
npm run test:auto-compare --workspace apps/desktop
npm run test:sessions --workspace apps/desktop
node apps/desktop/scripts/editing-regression.mjs
```

Use `npm ci` for a fresh checkout. Native suites require an embedded-assets debug
build, launch only owned processes, and write only owned temporary fixture trees.
They are Windows WebView2/CDP tests, not browser mocks or other-platform evidence.
Run native suites sequentially: the current harness shares the app's WebView2
profile, so simultaneous launches can fail or connect to the wrong WebView.
Native runners also honor `COMPARE_TEST_DESKTOP` for an alternate embedded-assets
executable; this permits testing a separate debug profile without replacing a
running developer build.

### Optimized local package

```text
npm run build
cargo build --workspace --release --locked
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --release --locked --features tauri/custom-protocol
npm run package:windows --workspace apps/desktop
```

The local ZIP includes both executables, the GNU WebView2 loader and its reviewed
license, project licenses/lockfiles, third-party license/attribution files, resolved
graph metadata and MPL package source. It normalizes copied timestamps into ZIP's
supported range, extracts to a different directory, and verifies release launch
and real Rust comparison. Artifact paths and SHA-256 values print on success.
Tauri installer bundling remains disabled; the verified delivery is the unsigned
relocatable ZIP. Installed WebView2 Evergreen is required. Distribution approval
and a final shipped-source/notice review remain separate from local MVP acceptance.

### Scoped Windows GNU environment

During initial development the machine lacked MSVC. Scoped Rust GNU plus LLVM-MinGW 20261006
(publisher archive digest verified) built the app without system-wide changes.
MSVC remains the conventional Windows build prerequisite.

```powershell
$env:CARGO_HOME = '<scoped cargo home>'
$env:RUSTUP_HOME = '<scoped rustup home>'
$env:PATH = '<llvm-mingw bin>;' + "$env:CARGO_HOME\bin;$env:PATH"
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'rust-lld'
```

The scoped stable toolchain used here reports 1.99.0. Reproduction should select
`1.99.0-x86_64-pc-windows-gnu` rather than allowing stable to drift; install rustfmt
and Clippy for that toolchain. Do not install system-wide tools without approval.

## Verified evidence

### Phase 2A-01 recent history

Windows MSVC: settings migration/restart/bounds tests, TypeScript, frontend
tests, lint, production frontend and embedded-assets native build passed.
`node apps\desktop\scripts\history-regression.mjs` verifies empty history,
typed submission without per-keystroke scans, single/two-root loading, collapsed
trees, keyboard filtering/selection, missing-root retained results, deduplication,
complete Home tuple reopening after restart and real failed persistence.
The existing native session suite also passed. Native Browse uses the same scan
path; OS dialog interaction and screen-reader announcement were not automated.
No macOS/Linux certification is implied.

### Phase 2A-02 line inspector

Windows MSVC: TypeScript, ESLint, 16 frontend tests, settings tests, production
frontend and embedded-assets native builds passed.
`node apps\desktop\scripts\inspector-regression.mjs` passed multiline detail
navigation, missing lines, Unicode/tabs/long-line horizontal overflow, caret
selection with retained editor focus, no draft mutation, invalidation, Undo/copy
refresh, resize/collapse and layout-only persistence across restart.
The inspector alignment regression also passed on a separate embedded-assets
debug profile: both source text starts share the same column (within one CSS
pixel), including missing-side rows, with no duplicate coordinate header.
The native interaction suite passed Browse/filter/collapse, plain-text theme,
copy/Undo, repeated Reload and Save with stable aligned two-way scrolling.
Scroll restoration uses the shared viewport rather than transient CodeMirror
block-height anchor offsets during asynchronous result/persistence updates.
Screen-reader behavior, manual scaling and macOS/Linux remain unverified.

#### Compact detail, recent-path dropdowns and pane fit

Windows MSVC: TypeScript, ESLint, source/script Prettier, all 21 frontend tests
and embedded-assets native builds passed. The inspector, history, compact,
keyboard, workflow, interaction, auto-compare, editing, session, recovery,
alignment-merge and explorer native scripts passed. The inspector regression
now covers the two-line panel (no Previous/Next or height selector, horizontal
overflow only) and hover-only tooltips on a focused, clicked tool. The history
regression covers unclipped, hit-testable folder options and the recent-file
dropdown; compact geometry asserts both editor panes end above line detail and
reach their last line at 1280x800 and 1024x768. `native-smoke`
(copy-arrow focus), `workbench-regression` (stale folder summary) and
`acceptance` (comparison cancellation timing) failed identically or
independently of this UI change; the first two also failed on a HEAD baseline.
macOS/Linux remain unverified.

#### Manual-edit refresh regression

Windows MSVC: TypeScript, ESLint, source/script Prettier, all 16 frontend tests,
production frontend and embedded-assets debug/release builds passed.
`node apps\desktop\scripts\editing-regression.mjs` passed actual keyboard typing,
automatic localized CRLF differences and explicit recompare, CR/mixed-EOL
restoration, significant real EOL differences, serialized superseded responses,
retained alignment with stale copy arrows unavailable, insertion gaps, Undo,
explicit refresh failure/recovery, invalid document handles and unchanged source
bytes. The inspector, native smoke, interaction and Git suites also passed.
The smoke/inspector assertions now expect automatic refresh instead of manual
edit invalidation. No macOS/Linux or screen-reader verification is implied.

### Phase 2A-06 find, replace and line navigation

Windows MSVC: `cargo test -p compare-text --locked` passed 27 tests, including
bounded regex parsing, case/whole-word behavior, UTF-16 editor offsets aligned
to normalized EOLs, empty match rejection and the 10,000-result limit. The Tauri command compiled with
`cargo check --manifest-path apps\desktop\src-tauri\Cargo.toml --locked`.
TypeScript, all 16 frontend tests, ESLint, Prettier and the production frontend
build passed. `node apps\desktop\scripts\editing-regression.mjs` verified native
search across both panes, Replace All preview and explicit confirmation,
per-pane Undo/Redo without writing source files, valid/invalid line navigation,
and regex errors. Other OSes and assistive-technology behavior remain unverified.

### Phase 2A-03 Windows Explorer integration

Windows MSVC core suite: 74 filesystem/settings/shell tests, 22 text tests,
5 merge tests and 1 CLI process test passed (102 total). The CLI regression
also verifies its waiting child flag and actual child lifetime.
TypeScript, ESLint, Prettier, 16 frontend tests, core/native Clippy and
production frontend/embedded-assets native builds passed.
Production-mode native `cargo check --release --locked` also passed; this is
compilation evidence, not a release package or live Explorer registration test.

`node apps\desktop\scripts\explorer-regression.mjs` exercises explicit
enable/cancel/remove with isolated HKCU keys, real secondary-process handoff,
a copied executable in a Unicode/spaced directory, the registered quoted command
with raw Windows arguments, Unicode/metacharacter input paths, files/folders,
missing/mixed inputs, preserved dirty tabs, queued requests, cold startup,
persisted selection, a Git-launched window receiving shell launches as tabs
while a second Git launch stays independent, and removal cleanup. Tests never
register live Explorer associations. Core tests additionally verify ownership
refusal and quoted values.

Native smoke, history, inspector, interaction and Git suites passed.
The smoke suite exposed and now covers history overwriting unrelated stored
profiles; history/layout commands now update only their persisted fields.
History tests explicitly verify preserving another stored preference.
Git merge still waits for save and exits 0, cancellation exits 1, and diff
closes with 0. Waiting CLI directory comparisons remain isolated so Git cannot
remove temporary inputs early.

Actual Explorer menu rendering/OS menu clicks, screen readers, signing and a
fresh release ZIP are not verified here. Static verbs intentionally target
Windows 11 Show more options, not its modern COM/app-identity menu.
macOS/Linux integration remains unavailable/unverified.

#### Explorer launch and selection-menu regression

The updated Explorer runner passed Windows Shell activation (`Start-Process`)
using the executable and quoted arguments read from the isolated registry, not
only direct process creation. It verifies no device-prefix launch path, hidden
compare commands with no selection, type-specific left-selection labels, named
compare visibility for matching files/folders, selection changes/clear and the
existing handoff/restart/data-preservation cases.
Core coverage additionally verifies drive/UNC conversion, ampersand labels,
owned legacy-verb removal and foreign-owner refusal. The workspace suite passed
(75 filesystem/settings/shell tests, 22 text tests, 5 merge tests and the CLI
process test); filesystem/native Clippy and Rust formatting passed.
The existing opt-in release registration was repaired through the rebuilt app
and queried successfully: its launch target exists, device prefixes and legacy
one-sided verbs are absent, and no-selection visibility matches the contract.
The selected-path state and source contents were not changed by that repair.
Actual Explorer menu clicks/rendering, other OSes and a fresh release ZIP remain
unverified.

| Area                 | Evidence                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust core            | 21 text tests, 13 Windows filesystem/settings/folder tests, 5 merge tests and 1 CLI process test                                                                    |
| Frontend             | 12 Vitest tests; strict TypeScript, ESLint, Prettier and production build                                                                                           |
| Text UI/native       | Real IPC, ignore options, invalidation/limit errors, open/edit, region copy/undo, intraline marks and Ctrl+S CRLF save                                              |
| Save safety          | UTF-16LE BOM/EOL retention, external modification, no-clobber, read-only destinations, hard-link replacement, junction ancestors                                    |
| Folder IO            | Scan/filters/cancellation, empty directories/collisions, stale/consumed previews, selected copy, move/recycle, unavailable-trash injection and partial cancellation |
| Merge/Git            | Auto-resolution/conflicts, unresolved save disabled, native acceptance guard, existing/new output, cancellation exit 1, accepted save exit 0                        |
| Actual Git           | File difftool, `--dir-diff --no-symlinks`, mergetool and unmerged-index clearance in an owned repository; no fixture commits                                        |
| Settings             | Restart persistence, additive version-1 profile migration, retained corruption diagnostics                                                                          |
| Packaging            | Optimized extracted Windows x64 executable launched with loader and performed Rust IPC comparison                                                                   |
| Accessibility basics | Accessible editor/button/region names, native keyboard save/compare/navigation, editable row alignment, explicit live errors and dirty-close prevention             |

Unix-specific symlink/backslash tests are configured but not run on Windows.
Native screen-reader behavior, exhaustive assistive-technology/contrast auditing,
and other OS builds remain unverified. Automated acceptance verifies that a
dirty-close request leaves the app alive without confirmation. Accepting/dismissing
every discard/regenerate prompt and native file dialog still needs manual UX
regression testing. The tabbed-workbench runner exercises actual workbench modal
approval/cancellation in the native WebView.
Filesystem race/metadata restrictions are documented
in [data safety](data-safety.md#implemented-local-backend).

### Workbench UI regression (Windows/MSVC)

The Phase 1 UI refresh was verified locally with Rust 1.99.0 MSVC and embedded
frontend assets. TypeScript/production build, ESLint, Prettier, five Vitest tests,
and all three native smoke/acceptance/Git runners passed.

Native UI coverage includes visible replacement/insertion/deletion highlights,
invalidation after edits, next/previous selection, reselecting the active workflow
without losing results, collapsed advanced controls, and aligned pane headers
at 1100/900 CSS pixels even when one pane's file options expand.
Folder and merge layouts have automated no-horizontal-overflow checks at
1100/900/640 CSS pixels. Light/dark native screenshots were inspected locally;
this is not exhaustive contrast or screen-reader certification.
The native acceptance run measured 0 CSS pixels of editable line misalignment
(budget at most 2 px). Existing save/sync/Git safety regressions remained passing.

The inline text-copy follow-up extends native smoke coverage to region-specific
gutter arrows in both directions, including nonselected regions, insertions,
deletions, start/end gaps, and empty inputs. Enter/Space activation, destination
focus, unchanged source/on-disk files, Undo, and automatic removal of resolved
differences are checked.
The interactive gutter is exposed to accessibility tools while decorative gutters
remain hidden; full screen-reader behavior still needs manual verification.

Paired folder filename coverage verifies same/different/left-only/right-only/error
entries using synthetic files and an owned junction fixture, explicit missing-side
labels, distinct filename colors in both themes, and measured filename contrast
of at least 4.5:1 against the list background. Filter changes and stale selection
clearing are checked. The existing 1100/900/640 CSS-pixel overflow checks now cover
the paired columns. Git directory acceptance targets the left filename explicitly.

`test:workflows` reproduces folder-to-text-to-folder pair opening with Windows
extended paths and nested entries. Folder roots/listing remain independent of
opened documents. It also checks repeated region copies without manual comparison,
retained highlights, no implicit saves, and editor/page scroll movement at most
2 CSS pixels on a 200-line synthetic input. Automatic refresh failures retain the
copied draft and clear unusable ranges rather than reporting comparison success.

### Independent compact tabs (Windows/MSVC)

The tabbed Phase 1 workbench was verified on the same Windows machine with
Rust 1.99.0 MSVC, an embedded-assets build, strict TypeScript, ESLint,
Prettier and 12 Vitest tests. All five native runners passed sequentially:
`test:native`, `test:workflows`, `test:workbench`, `test:acceptance`, `test:git`.
No Rust domain algorithm changed; the full headless suite was not rerun for this
UI pass. No new release package or other-platform execution is implied.
The read-only native root-normalization adapter reuses existing checked-path
validation; native tests cover its typed output and invalid root failures.

`test:workbench` checks independent drafts/rules/Undo/scroll, dirty-close
cancellation, keyboard menus, tree collapse/sorting/selection, repeated pair tabs,
both confirmed copy directions with exact-byte preservation, stale plans,
cross-tab preview replacement, background scan ownership and document-capacity
failures. Multiple merge outputs remain independent; the Git runner verifies that
saving an unrelated text tab cannot accept the designated Git merge, nor can
another merge replace its conflict snapshot. Git acceptance asks before discarding
other tabs' unsaved drafts; cancelling leaves the output file unchanged.
Cross-tab stale notices persist across comparison and clear on reopening/rescanning,
including Windows short-to-canonical path aliases.
Pure presentation tests include a 10,000-entry folder tree.

At 1280x800 the actual CodeMirror scrolling body measured 489 CSS pixels tall,
exceeding the 480-pixel acceptance target. At 1024x768 it measured 457 pixels.
Both had 0-pixel pane misalignment and no page overflow. Native light/dark
screenshots were captured and inspected locally; this is not a complete
assistive-technology or contrast audit.

The final acceptance run measured 149-172 ms for five warm 20,000-line native
comparisons, 1.182 s for 1,000 files/root, 16.8 ms scan cancellation, and 0-pixel
editable alignment. Peak native-process working set was 54,603,776 bytes,
excluding separate WebView processes. These remain single-machine debug results.

### Home-first compact workbench (Windows/MSVC)

The current implementation passed strict TypeScript, ESLint, production frontend
and embedded-assets native builds, 14 Vitest tests, Rust formatting and strict
Clippy for both manifests. The complete MSVC headless suite passed: 70 filesystem,
22 text, 5 merge and 1 CLI process tests. All six native suites passed sequentially:
`test:compact`, `test:native`, `test:workflows`, `test:workbench`, `test:git`,
and `test:acceptance`.

`test:compact` verifies zero-tab Home startup, blank new drafts, explicit Git
startup, source-preserving filters for insert/delete/unequal/equal inputs, minor
classification, all ten Diffs entries, the visible folder context inventory,
Rules Cancel and invalid-glob Apply, enabled CRC/NFC/version controls,
selected CRC content/results, native CRC differences, canonical Unicode
pairing, explicit missing-version errors, real available disk space,
confirmed rename
and multi-selection replacement copies, selected refresh, complete preview
entries, consumed-plan rejection and CRC/NFC/version settings across restart. It captures
synthetic-fixture Home/text/folder screenshots under ignored
`artifacts/compact-workbench`; set `COMPARE_SCREENSHOT_DIR` to override.

Measured native layout: 18-pixel folder rows, a 515-pixel folder viewport
(28 complete rows at 1420x800 with the activity log visible); text scrolling
bodies of 588 pixels at 1280x800 and 556 pixels at 1024x768. Both paired layouts
had zero-pixel top misalignment and no page overflow. Responsive folder interaction
also passes the prior 1100/900/640-pixel smoke checks.

A native acceptance run measured 139-150 ms for five 20,000-line text
comparisons, 1.255 s for 1,000 files per root, 22 ms cancellation and zero-pixel
editable alignment. Native-process peak working set was 53,043,200 bytes,
excluding separate WebView processes. These are single-machine debug results,
not general performance guarantees.

This does not verify macOS/Linux, a new release package, screen-reader operation,
every native file-dialog interaction, or external-application UX.

The owner approved crc32fast 1.5.2, unicode-normalization 0.1.25 and Windows-only
windows-sys 0.61.2 on 2026-10-16. Both lockfiles now include the pinned dependencies.
Focused tests verify the IEEE CRC-32 known vector/empty input, later-chunk
differences, stale snapshots, cancellation and file-size bounds; exact-first NFC
pairing and non-equivalent compatibility/case/parent keys; Windows file/product
versions using original resources injected only into owned test-executable
copies; version differences and invalid-resource errors; real disk capacity and
invalid-path failures; and preferences restart. Missing version resources cannot
certify equality. CRC and normalization do not weaken operation snapshots.
The extended compact suite and existing native/workflow suites were rerun after
adoption. The other three native suites' preceding results remain the evidence
for their broader workflows; no new cross-platform or release claim is made.

### Interaction regression follow-up (Windows/MSVC)

`test:interactions` verifies that ordinary source-row clicks leave both drafts
unchanged, while the explicit gutter arrow copies only to the other draft and
never saves. Pane, Edit-menu and keyboard Undo restore the previous draft and
automatically restore difference markers after a copy or manual edit, without
writing either file. It drives the production Browse handlers with a simulated OS
chooser response (all other native IPC remains real), testing immediate
single-root listing and two-root comparison, Diffs predicates preserved across
Browse/Refresh, initially collapsed folders, expansion retained across refresh,
double-clicked pairs compared automatically, and plain theme-colored source
text in dark mode. This is not manual certification of the OS chooser UI.
The root-listing Rust test verifies both sides, unknown/not-compared results,
invalid roots and selected-comparison rejection. All 71 filesystem tests and
14 frontend tests pass, along with frontend/native builds, strict Clippy,
ESLint and formatting. All six existing Windows native suites were rerun
successfully after these fixes, in addition to the new interaction suite.
No macOS/Linux or new release package was tested.

### Reload, Save and folder-tree follow-up (Windows/MSVC)

All 16 frontend tests, ESLint, formatting, production frontend and embedded-assets
native builds pass. The six existing native suites passed serially after the
tree/selection and editor changes. The expanded `test:interactions` also passes.
No Rust domain code/dependencies changed; the preceding Rust suite evidence
remains historical. No macOS/Linux, screen-reader certification or new release
package was tested.

Regression coverage for the reported session bugs:

| Reported behavior                                          | Automated regression                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup must not contain dummy comparisons                 | `test:compact`: zero-tab Home and blank new drafts                                                                                                                                                                                 |
| Source-row clicks must not copy                            | `test:interactions`: clicks in both panes leave both drafts and disk sources unchanged; explicit arrow copies                                                                                                                      |
| Browse must immediately list/compare folders               | `test:interactions`: one-sided listing then two-root comparison through production Browse handlers                                                                                                                                 |
| Diffs configuration must be respected                      | `folderPresentation.test.ts`: all ten predicates; `test:interactions`: preservation across Browse/Refresh                                                                                                                          |
| Folders must start collapsed                               | `test:interactions` / `test:workbench`: initial child absence, expansion, refresh retention                                                                                                                                        |
| Double-clicked file pairs must compare automatically       | `test:interactions`: changed-region markers appear without another Compare                                                                                                                                                         |
| Source text must not have language syntax colors           | `test:interactions`: dark-theme token colors match plain source text                                                                                                                                                               |
| Undo must retain comparison results                        | `test:interactions`: pane, Edit-menu and keyboard Undo after copies/manual edits                                                                                                                                                   |
| Reload/Save must refresh diffs and keep scrolling stable   | `test:interactions`: 500-line sources with a 20-line gap, three Reloads, edited and copied saves, toolbar/keyboard save, 36-frame scroll samples and at-most-1px matching-line misalignment                                        |
| Folder tree needs connectors/icons and row-based selection | `folderPresentation.test.ts`: sibling/ancestor guides after filtering/sorting/collapse; `test:interactions`: SVG icons, connectors, no checkboxes, Ctrl/Shift/Space selection; `test:compact`: actual batch-copy preview/execution |
| Help content must be scannable and separate from status   | `test:keyboard`: Help menu destinations, section navigation, Escape dismissal, and no help text in the top status banner                                                                                                          |

The long-file test reproduced scroll feedback with invalidated results and a
360px CodeMirror anchor jump before the fixes. Native light/dark tree screenshots
are captured under ignored `artifacts/compact-workbench`. Browse only simulates
the OS chooser response; all domain IPC remains native.

### Session navigation and saving follow-up (Windows/MSVC)

`test:sessions` runs real native settings writes and verifies the compact
switch/create menu, in-app Save Session dialog, empty/duplicate names, whitespace
trimming, Cancel/Escape, immediate persistence across restart, folder-rule
retention, draft-preserving session switches, separate profile controls and
confirmed removal. Home additions/removals also persist immediately. A
test-owned directory at the settings-file destination forces a real write failure:
the name remains editable, no session is added, and an error is visible.
The test checks that no browser dialog was invoked. Synthetic screenshots are
captured under ignored `artifacts/compact-workbench`.

The new suite and `test:native`, `test:compact`, `test:workbench`, and
`test:interactions` passed sequentially, along with all 16 frontend tests,
frontend/native builds, ESLint and formatting. The running release app initially
blocked the shared WebView profile; the owner closed it before testing.
No Rust domain changes/dependencies were introduced. The Git/workflow/acceptance
suites were not rerun for this change; their earlier results remain historical.
No macOS/Linux, release packaging or full screen-reader audit was performed.

### Phase 2A-11 text and merge navigation

Windows MSVC: the Rust workspace tests, strict Clippy and formatting passed;
the compare-text crate has 29 passing tests, including alignment-anchor and
moved-block fixtures. TypeScript, ESLint, Prettier, 17 frontend tests, the
production frontend build and the Tauri adapter check passed.
`test:alignment-merge` passed native checks for editable-pane intraline/EOL
marks, manual-anchor lifecycle, moved-block markers, unresolved-conflict
navigation, duplicate-preserving left-then-right resolution, and resolution
Undo/Redo. `editing-regression.mjs` passed its native text/editing checks.
Screen-reader behavior and macOS/Linux execution remain unverified.

### Phase 2A-12 optional live comparison

Automatic text comparison uses a 150 ms debounce, cancels superseded jobs,
rejects stale results, and is limited to 256 KiB and 5,000 logical lines per
pane. Unit tests exercise the exact byte/line boundaries. The native acceptance
runner passed the 250,000-byte / 5,000-line candidate benchmark in 50.6-54.8 ms
across five warm comparisons, well below the existing two-second compare budget.
Its UI path verifies automatic updates, clearing obsolete difference markers
when an oversized draft skips live comparison, explicit Compare after skipping,
and native compare cancellation. The 20,000-line benchmark measured
194.6-228.2 ms; the 1,000-file folder scan measured 1.42 s and cancellation
14.7 ms. Editable line alignment measured 0 CSS-pixel difference. These are
single-machine Windows debug observations, not performance guarantees.
Screen-reader behavior and macOS/Linux execution remain unverified.

### Phase 2A-08 opt-in draft recovery

The Windows native `test:recovery` run passed after an abrupt process
termination and restart. It verifies recovery is opt-in, text contents persist,
workspaces are not auto-opened, explicit restore retains text and merge conflict
choices/output, original source files remain unchanged, and confirmed close,
discard and disabling remove the intended snapshots. `compare-fs` tests cover
atomic replacement, corruption/unsupported versions, expiry, duplicate IDs,
path validation and size/count limits.

The compare-fs tests and strict Clippy passed (81 tests); frontend type-check,
ESLint, Prettier, build and all 17 frontend tests passed. This is Windows native
validation only; macOS/Linux, power-loss durability and screen-reader behavior
remain unverified.

## Measured scale

`test:acceptance` performs five sequential warm native IPC comparisons, a content
scan and cooperative cancellation, reporting actual machine metadata and timings.
A recent Windows debug run on the machine above:

- Text: 968,890 UTF-8 bytes / 20,000 lines per side, one changed line:
  194.6-228.2 ms native round-trip across five runs.
- Live-comparison candidate: 250,000 UTF-8 bytes / 5,000 lines:
  50.6-54.8 ms native round-trip across five runs.
- Folders: 1,000 files per side, 4 KiB each, content-hashed:
  approximately 1.42 s.
- Scan cancellation: approximately 14.7 ms; automated budget below 2.5 s.
- Editable alignment: matching rows differ by 0 CSS pixels; budget at most 2 px.
- Native process peak working set: 55,840,768 bytes (about 53 MiB).
  This excludes separate WebView/browser processes and is not total app memory.
- Largest frontend chunk after editor/syntax splitting: about 300 kB minified;
  production build no longer emits the 500 kB chunk warning.

These measurements are single-machine, warm/debug observations, not SLA claims,
cold-disk benchmarks or supported huge-file promises. CPU diff has a two-second
budget and cooperative checks; a single library call cannot be interrupted
immediately. Text is limited to 1 MiB/20,000 lines; intraline to 64 KiB/8,192 scalars;
folder entries to 10,000/root and 100 MiB/file. Regex uses at most 16 patterns,
4,096 bytes/pattern and bounded compiled/DFA budgets.

### Save refresh and folder-list profiling (Windows)

`npm run test:folder-save --workspace apps/desktop` passed on a synthetic
1,001-row pair. Saving one compared file dispatched one selected-row refresh
and no full scan across two runs. Those runs measured 2,555-2,566 ms initial
full scans, 22-24 ms path mapping calls and 371-437 ms selected-refresh
round trips. The selected refresh hashes only requested rows, but currently
transports the complete previous presentation to Rust; that makes refresh IPC
cost grow with the full listing and is a candidate for a backend-owned
snapshot/delta contract.

A standalone Node measurement of `folderRows` over 10,000 synthetic rows took
45.9-58.8 ms across seven runs (51.8 ms median after the first run). This
projects and sorts the full filtered tree even though `VirtualList` limits DOM
row rendering to the viewport. It is a profiling candidate, not an end-to-end
WebView latency measurement. Full content scans also hash every file; the
existing 1,000-file-per-side benchmark measured about 1.42 s. These are
single-run observations on one Windows machine, not performance guarantees.
Safe snapshot reuse, incremental invalidation and reducing full-list IPC remain
unimplemented follow-up candidates; no new caching or watcher behavior is
claimed.

## Definition of done

- Acceptance criteria are observable and satisfied by evidence.
- Every scoped surface is wired; errors and cancellation remain explicit.
- Changed behavior has regression and applicable failure coverage.
- Data-safety requirements and typed internal contracts are preserved.
- Relevant format/lint/type/build/test checks pass.
- Directly affected docs and ADRs reflect actual implementation/limitations.
- Dependencies and destructive testing have scoped approval.
- Actual platform coverage and omitted manual checks are stated honestly.
- Unrelated changes, secrets, unauthorized commits and uploads are absent.

Run focused checks first, escalating when integration requires it. Do not equate
configured CI with executed tests, virtualization with unlimited scale, or a local
unsigned package with a production release. Future viewers/providers need their
own correctness, invalid-input, license, capability and resource evidence.
