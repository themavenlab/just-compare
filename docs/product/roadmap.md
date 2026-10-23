# Product Scope and Roadmap

Just Compare is an open-source, local-first file and folder comparison and merge utility built for Windows, macOS, and Linux.

## Vision and Core Principles

- **Local-First & Private:** Comparison happens entirely on your machine. No telemetry, background analytics, or cloud dependencies.
- **Data Integrity Above All:** Comparison is strictly read-only. File writes, synchronizations, and deletions require explicit intent, preview confirmation, and atomic operations.
- **Keyboard First:** Fully operable without a mouse, with fast navigation between differences and accessible screen-reader support.
- **Fast & Scalable:** Virtualized diff rendering and streamed comparison results to comfortably handle large files and deep directory trees.

---

## MVP Scope

The Minimum Viable Product focuses on delivering rock-solid core comparison and merge features:

1. **Text Comparison:** Side-by-side and inline diffing with intraline (character/word-level) highlighting, syntax preservation, and original line-ending (CRLF/LF) handling.
2. **Three-Way Merge:** Base/Left/Right comparison with interactive conflict resolution and merge output generation.
3. **Folder Comparison & Safe Sync:** Fast directory scanning with size/timestamp/content criteria, ignore filters, dry-run previews, and safe file synchronization.
4. **Git Integration:** Seamless invocation as a `git difftool` and `git mergetool`.
5. **App Preferences & Sessions:** Configurable diff algorithms, color schemes, font sizing, and saved comparison sessions.

---

## Milestones

| Milestone | Key Deliverables | Verification / Done Criteria |
| :--- | :--- | :--- |
| **1. Foundation** | Repository setup, architectural boundaries, data safety rules, contributor workflow | Clear documentation and standards |
| **2. Scaffold & Prototypes** | Tauri v2 desktop shell, headless Rust crate, IPC bridge, editor/alignment prototype | Runnable desktop shell with native test execution |
| **3. Text Comparison** | Headless diff engine, line alignment, side-by-side React viewer, safe file saving | Text reconstruction tests, encoding/EOL preservation |
| **4. Folder Compare & Sync** | Directory scanner, filtering rules, dry-run operation previews, safe sync | Stale-preview detection, atomic replacement, error recovery |
| **5. Merge & Git Integration** | 3-way merge engine, conflict resolution UI, CLI flags for git difftool/mergetool | Merge invariant test suite, CLI exit-code verification |
| **6. MVP Hardening** | Settings management, session restore, keyboard navigation, packaging for Win/macOS/Linux | Release packaging and platform verification |
| **7. Specialized Viewers** | Hex diff, image comparison, CSV/tabular data diffs | Format-specific correctness and edge-case tests |
| **8. Remote Sources** | Remote filesystem providers (e.g. SFTP, S3, archives) | Credential safety in OS keychain, network timeout resilience |
