# Architecture Overview

This document outlines the system architecture, component boundaries, and technical conventions for Just Compare.

## Technology Stack

- **Desktop Shell:** [Tauri v2](https://v2.tauri.app/) (native window management, system permissions, and desktop capabilities)
- **Core Engine:** Rust (headless diffing, three-way merge, encoding detection, and file operations)
- **Frontend UI:** TypeScript, React, and modern CSS
- **Target Platforms:** Windows, macOS, and Linux

Specific editor components, diff algorithms, and support libraries will be selected during initial prototyping and scaffolding.

---

## Intended Directory Structure

```text
apps/
  desktop/
    src/                          React UI components, hooks, and presentation state
    src-tauri/                    Tauri configuration, plugins, and command handlers
crates/
  compare-text/                   Headless text diff, line alignment, and 3-way merge engine
docs/
  architecture/                   System design and IPC contracts
  engineering/                    Engineering practices, data safety, and validation
  product/                        Roadmap and milestone definitions
tests/
  fixtures/                       Synthetic test files and sample comparisons
  integration/                    Cross-component integration tests
.agents/
  skills/                         Agent workflows and task skills
```

*Note: Code directories will be created as components are implemented.*

---

## Component Boundaries & Dependency Flow

```text
React UI  ──>  Tauri IPC Commands  ──>  Rust Domain Engine  ──>  Filesystem / Providers
```

- **Rust Domain Crates (`crates/*`):** Own line and intraline diffing, merge resolution, encoding detection, and operation planning. They are headless libraries with zero UI dependencies, allowing future CLI reuse.
- **Filesystem & IO:** Operations are planned before they are executed. Planning is strictly decoupled from filesystem writes to allow safe previews and testability without touching user files.
- **Tauri Bridge (`apps/desktop/src-tauri`):** Thin adapter layer translating UI invocations into domain calls and managing native desktop capabilities. It does not duplicate diff algorithms.
- **Frontend (`apps/desktop/src`):** Owns UI state, keyboard navigation, viewport virtualization, and user interactions. No duplicate diff engine is implemented in TypeScript.
- **Dependency Rule:** Adapters depend on Domain APIs. Domain crates never import desktop or frontend adapters.

---

## IPC and Transport Conventions

Communication between the Tauri backend and React frontend follows these guidelines:

### Typed Contracts
- All requests, responses, events, and errors have explicit schemas.
- Validation is performed strictly at the Rust boundary; frontend validation alone is never assumed sufficient.
- Return structured domain errors rather than empty successful responses. Diagnostics must never log user credentials or private paths.
- Avoid transporting arbitrary 64-bit integers as JavaScript numbers where precision could be lost.

### Long-Running Operations & Streaming
- Heavy comparison and scan operations run asynchronously off the UI thread and carry stable session/operation IDs.
- Results for large files or folder trees must be paged or streamed with bounded buffers—never serialize an entire massive comparison into a single payload.
- Progress events are throttled to preserve UI responsiveness.
- Cancellation is explicit and acknowledged; cancelling an operation must never be reported as a successful completion.

### Mutation Safety
- Comparison and scan requests are strictly read-only.
- Modifying, saving, or deleting files requires separate explicit commands backed by the [Data Safety Contract](../engineering/data-safety.md).

---

## Cross-Platform Discipline

- Use platform-native filesystem APIs rather than making string assumptions about path separators, case sensitivity, symlinks, or timestamp precision.
- Account for platform differences in line endings (CRLF vs. LF), file permissions, and file locking.
- Claim release compatibility only after verification on real target environments.
