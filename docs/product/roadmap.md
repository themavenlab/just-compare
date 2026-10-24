# Product Scope and Roadmap

Just Compare is an open-source, local-first file and folder comparison and merge utility built for Windows, macOS, and Linux.

---

## Vision and Core Principles

- **Local-First & Private:** Comparison happens entirely on your machine. No telemetry, background analytics, or cloud dependencies.
- **Data Integrity Above All:** Comparison is strictly read-only. File writes, synchronizations, and deletions require explicit intent, preview confirmation, and atomic operations.
- **Keyboard First:** Fully operable without a mouse, with fast navigation between differences and accessible screen-reader support.
- **Fast & Scalable:** Virtualized diff rendering and streamed comparison results to comfortably handle large files and deep directory trees.

---

## MVP Scope (Phase 1 Status: Implemented)

The Minimum Viable Product focuses on delivering rock-solid core comparison and merge features:

1. **Text Comparison:** Side-by-side and inline diffing with intraline highlighting, syntax preservation, and original line-ending (CRLF/LF) handling.
2. **Three-Way Merge:** Base/Left/Right comparison with interactive conflict resolution and merge output generation.
3. **Folder Comparison & Safe Sync:** Fast directory scanning with size/timestamp/content criteria, ignore filters, dry-run previews, and safe file synchronization.
4. **Git Integration:** Seamless invocation as a `git difftool`, `git difftool --dir-diff`, and `git mergetool`.
5. **App Preferences & Sessions:** Configurable diff algorithms, color schemes, font sizing, and saved comparison sessions.
6. **Command Line Interface:** Headless `compare diff`, `compare folder`, and `compare merge` commands.

*Note: Phase 1 local Windows acceptance and portable packaging are verified in [Validation & Testing](../engineering/validation.md).*

---

## Future Milestones

| Milestone | Key Deliverables | Verification / Done Criteria |
| :--- | :--- | :--- |
| **Phase 1: MVP Core** *(Completed)* | Text diffing, folder sync, 3-way merge, Git difftool/mergetool, settings, CLI, and portable Windows package | Automated acceptance test suite and native Windows verification |
| **Phase 2: Platform Expansion** | macOS and Linux native packaging, code signing, and distribution automation | Multi-platform CI runners and verified native desktop packages |
| **Phase 3: Specialized Viewers** | Hex diffing, image comparison, and CSV/tabular data comparison | Format-specific correctness tests and large dataset handling |
| **Phase 4: Remote Sources** | Remote filesystem providers (e.g. SFTP, S3, WebDAV, archives) | Credential security in OS keychains and network timeout resilience |
| **Phase 5: Advanced Automation** | Shell integration, batch comparison scripting, and exported diff reports | Platform-specific shell extensions and report generator tests |
| **Phase 6: Scale & Polish** | Handling even larger inputs, deeper accessibility auditing, and localization | Memory benchmarks and screen-reader accessibility certifications |
