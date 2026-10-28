# Product Scope and Roadmap

This document provides the durable implementation direction for developers and AI agents, not a live task tracker. Issues and PRs track execution and acceptance. Future capabilities remain conditional on feasibility, licensing, and validation. Planning a feature here does not authorize implementation, dependencies, commits, or publication. Implement one approved work package at a time.

Phase 1's local Windows acceptance is recorded in the [Validation Guide](../engineering/validation.md). This is a bounded MVP, with a verified unsigned portable package and configured but unexecuted macOS/Linux CI. Public release, signing, broader OS certification, and specialized formats remain later work, not implied by MVP completion.

| Milestone | Deliverables | Exit evidence |
| --- | --- | --- |
| Engineering foundation | Agent rules, architecture, safety, commit and contribution guides | Consistent guidance, usable templates, no assumed build tooling |
| Scaffold and risk prototypes | Desktop shell, first Rust crate, approved toolchain, CI; editor/alignment and IPC prototypes | A runnable shell; platform checks; documented prototype conclusions |
| Text comparison | Decoding, line/intraline comparison, aligned editing, save behavior | Reconstruction tests, encoding/EOL tests, real save-flow evidence |
| Folder comparison and sync | Local scan, criteria, filters, progress/cancellation, previewed operations | Stale-preview, failure, path, and partial-operation tests |
| Merge and Git integration | Three-way merge/output, conflict resolution, CLI, Git integration | Merge invariants, unresolved-conflict behavior, process/exit-code tests |
| MVP hardening | Settings/sessions, packaging, accessibility, regression coverage | Documented supported-platform matrix and release acceptance evidence |
| Compact local workbench | Home-first startup, dense paired views, display filters, Rules and previewed recursive local actions | Native geometry, source-preserving folds, rules precedence, selected refresh, stale/batch action tests |
| Advanced local matching | CRC, Unicode normalization, executable-version metadata and native disk-space display | Scoped dependency approval, capability failures and method-specific platform tests |
| Specialized viewers | Hex, images, CSV/TSV/XLSX, document extraction, media metadata | Each format's own correctness, limits, and license evidence |
| Additional sources | Archives and SFTP/FTP/FTPS/S3/WebDAV | Provider capabilities, credential safety, remote failure tests |
| Integration and automation | OS shell integration, scripting, reports | Platform-specific tests and explicit script safety policy |
| Expanded scale and polish | Larger inputs, deeper accessibility, localization | Reproducible benchmarks and expanded compatibility evidence |

Accessibility and performance work begin with the MVP, not only in the last milestone.
Remote writes and archive mutation require separate safety designs; read support does not imply write support.

Before adding each major capability, approve its scope and dependencies. Do not scaffold all future crates in advance or adopt speculative library names as decisions. Native E2E availability must be verified separately on each OS.

---

## Incremental Delivery Plan

Goal: a dependable daily-use workbench first, broader format/source coverage second. Preserve original design and familiar workflows, not proprietary artwork, branding, pixel identity, or undocumented compatibility.

### Starting Baseline

Phase 1 already provides Home, independent tabs, named sessions, compact text/folder/merge views, rules and display filters, plain-text editors, region copy, Undo, automatic comparison after open/copy/Undo/Save/Reload, aligned scroll, folder hierarchy/selection, safe previewed local operations, CLI/Git integration, CRC/NFC matching, and Windows-specific metadata capabilities.

Do not rebuild these as new features. Inspect their current behavior and extend them. In particular:

- Path fields have a basic datalist backed by mixed recent paths; Home opens an individual path into a chosen workflow/side. This is not a complete folder history picker or recent-comparison launcher.
- Text comparison has a selected-region first-line summary, an expandable aligned view, and explicit intraline refinement. This is not the docked, selected-line inspector required below.
- Folder navigation/history, progress/cancellation, sync plans, and intraline engine ranges exist. Improve their usability instead of duplicating engines.

### Delivery Order and Dependencies

| Stage | Objective | Entry/dependencies |
| --- | --- | --- |
| Phase 1 closeout | Verify the current release candidate and record remaining platform gaps | Current implementation; no feature expansion |
| Phase 2A | Daily-use reliability and compact interaction | Closeout evidence recorded; unresolved failures explicitly scoped |
| Phase 2B | Folder productivity and desktop access | Relevant 2A lifecycle, selection and settings contracts stable |
| Phase 2C | Read-only archives and specialized viewers | Relevant opening/navigation contracts stable; per-format scope approved |
| Phase 3 | Richer formats, remote sources and automation | Separate designs, dependencies and safety approval |

Within a stage, follow the package dependencies below, not merely table order. The first requested implementation packages are **2A-01 and 2A-02**. They need not wait for unrelated 2A features. Closeout must not be misrepresented as macOS/Linux certification or public release approval.

### Phase 1 Closeout

- Build and smoke-test a fresh relocatable release package containing the latest fixes; previous package evidence does not cover subsequent commits.
- Run realistic text/folder/merge/Git acceptance using disposable inputs.
- Check native file dialogs, keyboard navigation, focus, screen-reader behavior, light/dark themes, and display scaling; record actual results and omissions.
- Execute configured macOS/Linux checks before making platform-support claims; retain explicit unverified status until evidence exists.

### Phase 2A: Must-Have Daily-Use Workbench

| ID | Bounded work package | Acceptance contract |
| --- | --- | --- |
| 2A-01 | Recent-folder path dropdowns and useful Home history | Implement the detailed contract below; choosing a folder loads/compares without Refresh. |
| 2A-02 | Docked line-by-line detail inspector | Implement the detailed contract below; selection changes update detail without mutating either draft. |
| 2A-03 | Windows Explorer comparison commands | Implement the detailed contract below; single-instance handoff to running app without losing drafts. |
| 2A-04 | Consistent comparison lifecycle | Open, Browse, Reload, Save, Undo and Redo use actual current snapshots; preserve rules, filters, viewport and aligned scrolling; stale async results never replace newer results. Extend existing behavior, including failure/cancellation tests. |
| 2A-05 | Complete Undo/Redo | Typing and region copies have predictable history through pane controls, menus and shortcuts; refresh diffs automatically. Draft history never silently reverses filesystem writes. Depends on 2A-04 lifecycle contract. |
| 2A-06 | Find, Replace and Go to Line | Search either/both panes; next/previous, case, whole-word and bounded regex options; show replace scope/preview before bulk replacement, support Undo, and navigate valid source lines. Invalid patterns/line numbers report errors. Depends on 2A-05 for replacement. |
| 2A-07 | Named-session identity and updates | Named tabs, Save versus Save As, rename and organization; explicit duplicate/overwrite handling; persist failures without losing input. Keep definitions separate from drafts, recovery and recent history. |
| 2A-08 | Draft crash recovery | Explicitly opt into local recovery with documented retention, storage/privacy and discard behavior; simulate interrupted writes/restart. Offer recovery without overwriting sources or automatically reopening private drafts; follow the conservative safety contract below. |
| 2A-09 | External-change handling | Detect source changes; offer Reload, Keep Draft or Compare with Disk; mark folder results stale. Preserve drafts and reject stale saves. Define watching versus explicit recheck before implementation; never silently overwrite. |
| 2A-10 | Keyboard, accessibility and visual consistency | All essential actions keyboard-accessible; visible focus, semantic labels, consistent shortcuts, tooltips and disabled reasons. Validate dialogs, trees, menus and panes in light/dark, high contrast and scaling; no essential mouse-only action. |
| 2A-11 | Text/merge navigation improvements | Extend existing intraline ranges into editable panes; whitespace/EOL visibility, manual alignment anchors and moved-block detection. Add unresolved-conflict navigation, accept left/right/both and resolution Undo/Redo without bypassing merge validation. Split into individual issues; alignment/move algorithms require their own correctness fixtures. |
| 2A-12 | Optional live comparison | Debounced comparison for bounded inputs; cancel obsolete work and reject stale results while retaining responsive typing. Explicit Compare remains available. Depends on 2A-04; benchmark before selecting debounce/size thresholds. |

#### 2A-08: Draft Crash Recovery

- Recovery is disabled by default. Enabling it requires confirmation that draft text, merge output, and conflict choices are stored locally, unencrypted, in the app configuration directory; no draft is uploaded or reopened automatically.
- Persist dirty Text Compare and non-Git 3-Way Merge tabs as atomic, versioned, size-bounded snapshots. Retain each snapshot for at most seven days; support restoring one as an unsaved tab or explicitly discarding it. Disabling recovery requires confirmation and deletes all stored snapshots.
- Restored panes have no native document handles. Saving them uses Save As and never overwrites the source paths that are retained only as labels.
- Validate schema, interrupted or corrupt state, expiry, bounds, opt-in migration, restart and restore, source preservation, explicit discard, and disabling. Report storage errors; do not silently erase drafts or fall back to source contents.

#### 2A-01: Recent Folders Where Users Choose Paths

- Add a visible dropdown affordance to each Folder Compare path field, including when empty. Keep typing, paste, and native Browse available.
- Offer recent **folders**, not unrelated file entries; share useful history across sides while applying a selection only to its intended side. Show full paths accessibly, support filtering and keyboard selection/Escape, and keep the compact layout usable for long paths.
- Selecting a history entry follows the same loading path as Browse: list a single root immediately, compare automatically when both roots are valid, preserve the selected Diffs predicate, and start newly loaded trees collapsed. Do not scan on every typed character; explicit path submission commits typing.
- Record successfully opened roots in bounded, deduplicated most-recent-first history and persist through Rust. Define the bound, platform path-identity semantics, and migration of existing mixed history before coding. Do not assume all stored paths still exist or indiscriminately lowercase filesystem paths.
- Invalid or unavailable paths show actionable errors without silently falling back, clearing the other root, or destroying the last usable result. Mark retained results stale when their roots no longer match.
- Provide remove/clear history controls that affect history only, never files; treat local paths as private. Report persistence failures cleanly.
- Replace or repurpose Home's low-value single-path list with recent **comparisons**: explicit workflow plus left/right (and merge base where applicable). Reopen the pair/tuple and compare automatically; retain named sessions separately. Never infer an old pair from unrelated recent paths. Existing legacy single paths can remain in appropriate input pickers.
- Tests: empty history, typed/pasted/Browse/history paths, either-side selection, one/two roots, duplicate ordering, missing roots, restart/migration, failed persistence, keyboard use, Diffs/collapse preservation, and complete Home tuples.

#### 2A-02: Bottom Line-by-Line Comparison Inspector

- Provide a compact docked pane below the text editors, with stacked left/right versions of the selected aligned line and character-level changed spans. Reuse Rust comparison/refinement results; do not add a frontend diff engine.
- Follow caret/row selection and previous/next difference navigation. A selected multi-line region must allow inspecting every aligned line, not only its first line. Display source side/line numbers and explicit missing-line placeholders.
- Preserve whitespace, tabs, Unicode, and source coordinates; show additions, deletions, replacements, minor differences, and equal/no-selection states clearly. Plain text remains the default; do not reintroduce syntax coloring.
- Support horizontal scrolling for long lines and a keyboard-accessible resize/collapse control. Retain user layout preferences without restoring private text. Hidden detail must not alter source filtering or alignment.
- Selecting detail is read-only. If copy arrows are provided, only explicit arrows perform the existing draft-copy action; clicking a line never copies. Label whether an action copies a line or a region and retain Undo behavior.
- Keep detail synchronized after edits, copy, Undo/Redo, Save, Reload, and tab changes; clear or mark it stale on invalidation/error. Preserve editor focus and scroll, and reject outdated asynchronous refinement results.
- Tests: selected lines across multi-line regions, insert/delete/missing lines, Unicode/whitespace/long lines, navigation, refresh/history, collapse/resize, keyboard/focus, no accidental mutation, and stable paired scrolling.

#### 2A-03: Windows Explorer Comparison Commands

- Explicitly enable or remove per-user commands from the Integration menu; no elevation, default file associations, Explorer DLL, or automatic registration.
- Register type-specific Select as left file/folder for compare and a selection-aware Compare to name command for files and directories. Hide the compare command without a left selection or on the opposite item kind. Static verbs appear in Windows 11's Show more options menu; there is no always-visible one-sided Compare verb. Multi-select invocation and top-level Windows 11 COM commands are not included.
- Validate absolute existing regular files and directories in Rust; reject mixed file/folder pairs, missing paths, links, and unsupported arguments explicitly. Preserve Unicode and quote executable and path arguments without a command shell.
- Retain one private selected path locally across restarts, never file contents; clear it explicitly or when removing integration. Revalidate on every use.
- Shell launches append a tab in the running normal app, preserving all drafts. Queue requests during startup or active work and focus the window. Git launches remain separate waiting processes with unchanged completion and exit contracts.
- Registration owns only application-specific keys. Refuse to replace or remove another executable's entries. Remove before relocating a portable executable, then re-enable at its new location. Report partial registration failures cleanly.
- Tests: isolated registry enable/query/remove and ownership, Unicode/spaces/shell metacharacters, startup/restart and running-instance delivery, invalid/missing inputs, preserved dirty tabs, and unchanged Git process behavior.
- See [Explorer usage](usage.md#8-windows-explorer-integration) and [ADR 0003](../decisions/0003-windows-explorer-integration.md). Other OS shell integrations remain separate certification work under 2B-04.

### Phase 2B: Folder Productivity and Desktop Access

| ID | Work package | Acceptance contract and dependencies |
| --- | --- | --- |
| 2B-01 | Folder navigation and selection polish | Extend per-side navigation with breadcrumbs, enter/back/forward and linked navigation with explicit missing-counterpart behavior. Retain predictable range/toggle selection, select differences/orphans, counts, action targets, columns/order/widths/sorting and tree/flat preferences. Depends on 2A-01 and 2A-10. |
| 2B-02 | Incremental comparison and trustworthy status | Refresh changed entries without treating cached rows as write authority. Distinguish metadata-equal, content-verified, not-compared and failed. Show enumeration/content progress, current file/counts and cancellation; test stale snapshots and partial failures. Depends on 2A-04 and 2A-09. |
| 2B-03 | Dedicated Folder Sync workspace | Reuse Rust plans: per-entry direction/action, skips/overwrites, exclusions, final preview, cancellation and per-item outcomes. Keep update/mirror/custom semantics explicit. True bidirectional sync needs a prior-sync baseline, deletion/conflict policy and separate safety approval; two one-way copies are not bidirectional sync. |
| 2B-04 | Additional OS shell integration | Extend the Windows 2A-03 baseline with separately designed/certified macOS/Linux integration and, if approved, modern Windows 11 app-identity/COM packaging. Preserve safe argument delivery and Git wait semantics. |
| 2B-05 | Consistent drag/drop and external tools | Extend current drop support to appropriate Home/tab/path/row targets with explicit destinations and dirty-state protection. Configure editor/terminal launching without shell interpolation of untrusted paths. |
| 2B-06 | Command palette | Search available actions with shortcuts and disabled explanations; reuse existing command handlers, respect active workspace and keyboard/focus contracts from 2A-10. |
| 2B-07 | Comparison reports | Export HTML/text with rules, scope, source identity and verified-versus-unknown status; escape content, allow path redaction and never upload. Preview/approve overwrite targets. |
| 2B-08 | Portable session definitions | Import/export versioned session definitions, with validation and machine-path remapping. No draft/recovery contents or credentials; duplicates and unsupported versions require explicit handling. Depends on 2A-07. |

### Phase 2C: New Viewers, Read-Only First

Recommended order is ZIP browsing, hex, then CSV/TSV. Each is independently scoped and approved; do not add all libraries or empty viewer modules together.

| ID | Work package | Acceptance contract |
| --- | --- | --- |
| 2C-01 | Read-only ZIP browsing | Compare archive entries with a folder or another archive; open supported contained text without manual extraction. Bound decompressed bytes, nesting and entry counts; reject unsafe names/traversal and unsupported/encrypted formats explicitly. Archive mutation is excluded. |
| 2C-02 | Read-only hex comparison | Paired byte/text columns, offsets, byte differences and offset navigation. Explicitly offer hex for binary/undecodable input rather than silently treating it as text. Test byte fidelity and bounded rendering. |
| 2C-03 | CSV/TSV table comparison | Delimiter/encoding/quoting handling, selected key columns, row alignment, cell differences and ignored columns. Define duplicate/empty keys, missing columns and malformed-row behavior; never claim line diff is table comparison. |

All viewers need typed Rust results, source-preserving navigation, cancellation, declared limits, license review, and synthetic correctness/performance fixtures. Do not raise existing text/folder limits without measured evidence.

### Phase 3: Broader Parity and Differentiators

- **Image comparison:** Synchronized zoom/pan, side-by-side, overlay, and difference heatmap; define dimension, alpha, and color-space handling.
- **XLSX, PDF/Office extraction and media metadata:** Separate format issues, dependency/license reviews, and fidelity tests. Label extracted-text comparison honestly; it does not imply visual document equivalence.
- **Remote providers:** SFTP/FTP/FTPS/S3/WebDAV in independently approved slices, capability-driven UI, secure credential storage, connection recovery, bounded caching, and explicit unsupported operations. Read access never implies writes.
- **Automation:** Reports/CLI first; scheduled/unattended sync and scripting later with exit codes, dry runs, conflict/overwrite policies, logs, and secret safety. No proprietary script-language compatibility promise.
- **Separate high-risk designs:** Archive writes, true bidirectional sync, and remote writes require preview/revalidation, failure/recovery, and consent rules.
- **Scale and broader polish:** Benchmark-driven larger-input support, deeper accessibility, localization, and expanded OS certification; no huge-file editing or cross-platform claims from a single-machine result.

---

## Implementing a Package in a Fresh Session

1. Read [Product Roadmap & Scope](roadmap.md), [Architecture Overview](../architecture/overview.md), [Agent Workflow](../engineering/agent-workflow.md), and [Validation Guide](../engineering/validation.md); inspect current code and worktree.
2. Select one package ID. Create an issue/task with objective, non-goals, dependencies, affected components, and measurable acceptance criteria. Split broad rows into cohesive subissues; record decisions, not assumed APIs.
3. Inspect relevant existing surfaces: Home/shared settings in `App.tsx` and `HomeScreen.tsx`; path fields/detail in `ComparisonWorkspace.tsx`; editor interaction in `EditorSurface.tsx`; folder presentation in `FolderView.tsx`; Rust document/settings/folder code in `compare-fs` and diff in `compare-text`. These are starting points, not permission for a broad refactor.
4. Resolve material UX/persistence ambiguity and obtain scoped approvals before adding dependencies, changing major contracts, or adopting migrations. Rust owns filesystem/comparison/persistence; React owns presentation.
5. Wire every relevant entry point and test success, invalid/stale input, cancellation, persistence failures, and no unintended writes. Extend existing interaction/session native suites for UI/IPC regressions; use owned fixtures.
6. Set measurable responsiveness/scale budgets with declared fixture sizes and hardware before performance work. Test the exact acceptance outcome, not screenshots or implementation strings alone.
7. Run focused checks, update usage/contracts/validation evidence, and report completed versus omitted checks and platforms. Follow the existing definition of done and structured handoff; track progress in issues/PRs, not this roadmap.

Next-session starting task: scope **2A-01**, confirm history retention/migration and Home recent-comparison behavior, then implement/test it before **2A-02**.
