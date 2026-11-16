# Architecture Overview

This document outlines the system architecture, component boundaries, directory layout, and technical conventions for Just Compare.

## Technology Stack

- **Desktop Shell:** [Tauri v2](https://v2.tauri.app/) (native window management, system permissions, and desktop capabilities)
- **Core Engine:** Rust (headless diffing, three-way merge, encoding detection, and filesystem operations)
- **Frontend UI:** TypeScript, React, modern CSS, and [CodeMirror 6](https://codemirror.net/) (virtualized text editing and alignment)
- **Target Platforms:** Windows, macOS, and Linux (Phase 1 currently verified on Windows x64)

---

## Directory Structure

```text
apps/
  desktop/
    src/                          React UI components, hooks, CodeMirror surfaces, and presentation state
    src-tauri/                    Tauri configuration, plugins, window capabilities, and IPC commands
    scripts/                      Native smoke tests, Git integration tests, acceptance benchmarks, packaging
crates/
  compare-text/                   Headless text diff, line alignment, and encoding detection
  compare-fs/                     Safe document I/O, folder comparison scanning, sync planning/execution, settings
  compare-merge/                  Conservative three-way merge engine and conflict resolution
  compare-cli/                    Headless CLI and waiting desktop/Git difftool/mergetool adapter
docs/
  architecture/                   System design and IPC contracts
  engineering/                    Engineering practices, data safety, validation, and dependencies
  product/                        Usage guide, roadmap, and milestone definitions
.agents/
  skills/                         Agent workflows and task skills
```

---

## Component Boundaries & Dependency Flow

```text
React UI  ──>  Tauri IPC Commands  ──>  Rust Domain Engine  ──>  Filesystem / OS
```

- **Rust Domain Crates (`crates/*`):** Own line and intraline diffing, merge resolution, encoding detection, and operation planning. They are headless libraries with zero UI dependencies, allowing CLI reuse.
- **Filesystem & IO (`crates/compare-fs`):** Operations are planned before they are executed. Planning is strictly decoupled from filesystem writes to allow safe previews and testability without touching user files.
- **Tauri Bridge (`apps/desktop/src-tauri`):** Thin adapter layer translating UI invocations into domain calls and managing native desktop capabilities. It does not duplicate diff algorithms.
- **Frontend (`apps/desktop/src`):** Owns UI state, keyboard navigation, viewport virtualization, and user interactions. No duplicate diff engine is implemented in TypeScript.
- **CLI (`crates/compare-cli`):** Reuses the domain crates directly for headless diff/merge/folder operations, and launches/waits on the desktop app when invoked as a Git difftool or mergetool.
- **Dependency Direction:** Adapters depend on Domain APIs. Domain crates never import desktop or frontend adapters.

---

## Desktop Architecture

- **State Coordination & Tab Ownership:** `App.tsx` coordinates top-level tab ownership, shared preferences, native listeners, and confirmation dialogs. Each mounted `ComparisonWorkspace` independently manages its own drafts, document handles, comparison rules, results, and scroll viewports. Inactive workspaces remain mounted to preserve layout and state but are inert and hidden from assistive tools.
- **Editor Surfaces:** `CodeEditor.tsx` lazy-loads the plain-text CodeMirror surface (`EditorSurface.tsx`) and handles loading failures gracefully without losing text edits. Editor containers are non-label elements to prevent text clicks from triggering unintended actions.
- **Line Alignment:** Diff-derived block widgets align editable lines visually without adding phantom text content to documents.
- **Folder Navigation & Region Copies:** Folder roots are independent of opened document paths; opening file pairs creates separate text tabs and automatically compares the loaded contents. Browsing or navigating folders loads selected roots immediately, supporting one-sided listings until both counterparts are selected. Region copies recompare the edited snapshot through Rust, retaining the viewport and updating remaining actions. Undo and Redo restore draft-history snapshots and recompute text differences through the same native comparison path; pane, menu, and editor keyboard controls (`Ctrl+Z` / `Ctrl+Y`) share this behavior without reversing filesystem writes. Saving a text draft automatically rescans affected open folder comparisons after the save operation finishes; unrelated disk changes remain marked stale for explicit refresh.
- **DOM Virtualization:** A virtualized folder tree and read-only overview bound DOM size when dealing with large files or deep trees. Tree connectors derive from the filtered and sorted hierarchy; inline SVG icons distinguish files and folders, and row/keyboard multi-selection replaces checkboxes without changing safety targets. Synthetic tree ancestors provide visual hierarchy but cannot trigger filesystem actions directly.
- **Icon Catalog & Shared Renderers:** The desktop's named SVG path definitions, toolbar glyphs, and shared renderers live in `apps/desktop/src/icons.tsx`; feature components select icons by name rather than duplicating path data or glyph characters.
- **Session Handles & Previews:** Rust document handles retain original bytes/encoding and reject stale saves. Across all tabs, exactly one pending folder preview is retained; replacing it requires explicit confirmation, and execution requires user approval.
- **Session Management & Persistence:** The toolbar Sessions dropdown only opens saved definitions or creates supported workflows. The top Session menu owns save, management, and profile commands. Save and management use modal in-app dialogs rather than browser prompts or workspace panels. Named-session mutations (including from the Home screen) write settings through Rust before publishing the updated shared list; persistence failures retain entered input and report clear errors. Per-tab comparison-rule defaults are not overwritten by saving a named session, and other preference or profile edits retain their explicit Save preferences workflow; recovery authorization persists immediately. Opt-in draft recovery stores bounded text/non-Git merge snapshots through `compare-fs`; the Home UI lists them for explicit restore/discard and never reopens them at startup. Restored workspaces are unsaved drafts without native document handles.
- **Recent Folder and Comparison History:** Folder path inputs offer keyboard-filterable recent folders persisted through the `remember_history` IPC command. Version-1 `recentFolders` and `recentComparisons` are additive and bounded to 20 most-recent-first entries each. Folder identity uses the exact canonical path without global lowercasing. Legacy mixed recent paths migrate only existing, safe directories into folder history, while missing, inaccessible, or file entries remain in legacy file pickers. Complete workflow tuples (mode, left/right, and merge base) allow reopening comparisons from Home without reopening private drafts. History saves and removals persist immediately through Rust.
- **Docked Line-by-Line Detail Inspector:** A docked bottom inspector pane displays stacked left and right versions of the currently selected aligned line with intraline difference highlighting. Optional version-1 `lineDetail` settings persist only layout state (`collapsed` and `height`, bounded to 80-320 CSS pixels). `height` is still validated and preserved for compatibility, but the UI no longer applies it: the inspector fits two lines. The inspector is strictly read-only, reusing `refine_text` UTF-8 byte ranges from Rust. Selection effects discard obsolete asynchronous replies and do not mutate drafts or alter source filtering. Viewport scroll restoration uses the authoritative paired viewport to keep aligned two-way scrolling stable during async saves and refreshes.
- **Windows Explorer Integration:** Windows Explorer integration is opt-in and removable through the Integration menu, registering static per-user Select as left file/folder for compare and a selection-aware Compare to name verb for single files and directories under HKCU. Left selection runs before Tauri startup and exits without a window. Single-instance argument handoffs queue launches to the running application and open new tabs without replacing dirty drafts. CLI waiting and Git launches never forward their arguments; when no primary exists they register as the receiver under a startup gate so Explorer launches still become tabs. Shell registration commands use standard drive/UNC paths rather than device-namespace prefixes.
- **Manual-Edit Comparison Refresh:** Manual text edits debounce a serialized background comparison after the initial comparison, retaining prior alignment while disabling stale range actions. Revision checks discard superseded replies. These read-only refreshes neither lock typing nor write history or settings. Optional document handles allow Rust to restore editor-normalized EOLs using the same document policy as Save, ensuring genuine cross-document EOL differences remain significant.

---

## IPC and Transport Conventions

- **Typed Contracts:** Requests, responses, events, and errors have explicit schemas defined and validated at the Rust boundary. Folder scans return typed `FolderStatus` (`same`, `different`, `leftOnly`, `rightOnly`, `error`) and `ComparisonImportance` (`equal`, `unimportant`, `important`, `unknown`) values, with nullable fields consistently present across rows. `counts` (`different`, `leftOnly`, `rightOnly`, `error`) tallies descendant files only and is zero on file rows; descendant errors appear in `counts.error` without changing folder status.
- **Asynchronous Execution:** Heavy comparison and scan operations run asynchronously off the UI thread and carry stable operation IDs.
- **Streaming & Cancellation:** Long-running operations support cooperative cancellation via `cancel_job`. Cancelling an operation is never reported as a success.
- **Document EOL Policy Restoration:** `compare_text` optionally accepts `documents: { left, right }` containing opaque document handles. Rust restores each associated editor draft's line endings with the document's Save policy before comparing, while callers without handles compare original strings exactly.
- **Mutation Safety:** Diff and scan commands are strictly read-only. File modifications require explicit write commands backed by the [Data Safety Contract](../engineering/data-safety.md). The desktop grants `core:path:allow-join` only for native, platform-aware folder-entry path composition; this does not grant general filesystem I/O permissions.

---

## Cross-Platform Discipline

- Use platform-native filesystem APIs rather than making string assumptions about path separators, case sensitivity, symlinks, or timestamp precision.
- Account for platform differences in line endings (CRLF vs. LF), file permissions, and file locking.
- Claim release compatibility only after verification on real target environments.
