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

- **State Coordination:** `App.tsx` coordinates high-level workflow state (text diff, folder sync, 3-way merge, preferences).
- **Editor Surfaces:** `CodeEditor.tsx` lazy-loads the CodeMirror surface (`EditorSurface.tsx`) and handles loading failures gracefully without losing text edits.
- **Line Alignment:** Diff-derived block widgets align editable lines visually without adding phantom text content to documents.
- **DOM Virtualization:** A virtualized read-only overview and folder list bound DOM size when dealing with large files or deep trees.
- **Session Handles:** Rust document handles retain original bytes/encoding and reject stale saves. Sync operations use single-use preview handles; the backend never trusts an arbitrary frontend-authored operation list.

---

## IPC and Transport Conventions

- **Typed Contracts:** Requests, responses, events, and errors have explicit schemas defined and validated at the Rust boundary.
- **Asynchronous Execution:** Heavy comparison and scan operations run asynchronously off the UI thread and carry stable operation IDs.
- **Streaming & Cancellation:** Long-running operations support cooperative cancellation via `cancel_job`. Cancelling an operation is never reported as a success.
- **Mutation Safety:** Diff and scan commands are strictly read-only. File modifications require explicit write commands backed by the [Data Safety Contract](../engineering/data-safety.md).

---

## Cross-Platform Discipline

- Use platform-native filesystem APIs rather than making string assumptions about path separators, case sensitivity, symlinks, or timestamp precision.
- Account for platform differences in line endings (CRLF vs. LF), file permissions, and file locking.
- Claim release compatibility only after verification on real target environments.
