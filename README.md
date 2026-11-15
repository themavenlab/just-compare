# Just Compare

A modern, fast, local-first file and folder comparison and merge utility for Windows, macOS, and Linux.

**Status:** Phase 1 local Windows MVP. macOS and Linux build checks are configured, but those platforms have not yet been executed or certified. The implementation stack is Tauri v2, Rust, TypeScript, and React. Built with npm, Vite, pinned tool versions, and licensed under MIT OR Apache-2.0.

## Project Vision

- **Local-First & Private:** All comparison logic runs locally on your machine. No cloud dependencies, no analytics, no telemetry.
- **Data Integrity Above All:** Diffing is strictly read-only. File synchronizations, replacements, and deletions require preview confirmation and atomic writes.
- **Native Performance:** Built with [Tauri v2](https://v2.tauri.app/), a headless [Rust](https://www.rust-lang.org/) comparison engine (`compare-text`, `compare-folder`, `compare-merge`), [CodeMirror 6](https://codemirror.net/), and a modern [React](https://react.dev/) / TypeScript UI.
- **Original Implementation:** Built with original code and artwork; it does not promise exact feature parity with other comparison tools.

## Phase 1 Features

The headless Rust engine preserves UTF-8 line contents, LF/CRLF/CR line endings, and byte offsets, producing line-diff ranges using histogram comparison. Ignore options affect comparison keys rather than original input text. The engine provides strict BOM-aware UTF-8 and UTF-16 decoding, explicit legacy encoding selection, lossless re-encoding, bounded regex rules, Unicode-scalar intraline ranges, and cooperative cancellation with deadlines.

- **Text:** Aligned editable CodeMirror panes, syntax coloring for JS/TS/JSON, navigation and overview diff markers, region copy, undo, intraline difference highlighting, drag-and-drop file opening, encoding selection, safe atomic save, and no-clobber Save As.
- **Folders:** Content, size, and timestamp comparison criteria, path exclusions, virtualized file trees, concurrent root scans, progress reporting and cancellation, file-pair opening, and previewed update, mirror, custom copy, move, and recycle operations.
- **Merge:** Three-way merge (base, left, right), conservative automatic conflict resolution, explicit conflict choice buttons, editable output editor, stale-input invalidation, and safe atomic saving.
- **Integration:** Headless CLI, waiting Git difftool and mergetool modes, directory comparison mode, dark/light themes, recent session history, saved sessions, and per-file-type comparison profiles.

Operational limits are enforced at the engine boundary: text inputs are bounded to 1 MiB and 20,000 lines per side; folder scans to 250,000 entries per root and 100 MiB per file. A larger tree shows a partial list with a warning, and Sync is disabled for it. These are enforced protective limits, not complete feature parity or a huge-file performance promise. See the [Usage Guide](docs/product/usage.md), [Validation Evidence](docs/engineering/validation.md), and [Data Safety Contract](docs/engineering/data-safety.md#implemented-local-backend) for full details.

## Development

The desktop display name is configured once as `productName` in [`apps/desktop/src-tauri/tauri.conf.json`](apps/desktop/src-tauri/tauri.conf.json). The UI, window title, and package labels use that value. Cargo and npm package names remain stable internal build identifiers.

Install Node 22.17.0, npm 11.7.0, Rust 1.99.0, and [Tauri's native prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows, install Visual Studio's **Desktop development with C++** workload (MSVC x64/x86 tools and Windows SDK) and the WebView2 Evergreen Runtime. Visual Studio Community or standalone Build Tools is sufficient; the full IDE is not required. Restart VS Code after installation so terminal sessions inherit the updated PATH.

From the repository root in PowerShell:

```powershell
node --version
npm --version
rustup show active-toolchain
cargo --version
npm ci
npm run desktop:dev
```

Run each command sequentially after the previous succeeds. The repository pins Rust 1.99.0; standard Windows development uses the MSVC host. The initial native build downloads and compiles locked Rust dependencies, which may take several minutes. Wait for the Just Compare desktop window to appear.

`npm run desktop:dev` runs Vite and the native Tauri process concurrently. Frontend edits reload the UI, and Rust changes rebuild and restart the application automatically. Stop development with Ctrl+C.

`npm run dev` starts a browser-only UI preview; it cannot run native Rust commands or filesystem operations and reports this limitation explicitly instead of faking results. See the [Validation Guide](docs/engineering/validation.md) for automated test suites, release packaging, and the portable Windows toolchain alternative.

If `cargo` or `rustup` are not found after installation, restart VS Code or add `$env:USERPROFILE\.cargo\bin` to PATH as described in [Windows local development](docs/engineering/validation.md#windows-local-development). Always use disposable files and folders for save, mirror, move, and recycle tests.

For an optimized local Windows package, build the frontend and native binaries, then run `npm run package:windows --workspace apps/desktop`. The packager produces an unsigned relocatable ZIP including executables, the toolchain-required WebView2 loader, licenses, and SHA-256 digests. The `npm run package:msix` script is a separate Store packaging path; see the [Release Guide](docs/engineering/release.md).

## Documentation

- **[Documentation Index](docs/README.md)** - Documentation catalog organized by audience and workflow.
- **[Usage Guide](docs/product/usage.md)** - Everyday workflows for text diff, folder sync, 3-way merge, and Git integration.
- **[Product Roadmap & Scope](docs/product/roadmap.md)** - MVP feature set, core requirements, and future milestones.
- **[Architecture Overview](docs/architecture/overview.md)** - System design, component boundaries, and IPC conventions.
- **[Store Release Preparation](docs/engineering/release.md)** - Requirements, validation gates, and packaging workflow for the Windows Store.
- **[Future Source Publication](docs/engineering/source-publication.md)** - Gates and obligations for changing repository visibility.
- **[Data Safety Contract](docs/engineering/data-safety.md)** - Non-negotiable guarantees for file handling, sync, and deletion.
- **[Validation & Definition of Done](docs/engineering/validation.md)** - Testing commands, Windows setup, verified evidence, and performance measurements.
- **[Dependency Review](docs/engineering/dependencies.md)** - Direct dependencies, licensing terms, and distribution obligations.
- **[Contributing Guide](CONTRIBUTING.md)** - How to propose changes and contribute code.
- **[AI Agent Instructions](AGENTS.md)** - Architectural rules, local environment setup, and routing table for AI coding assistants.

## License and Distribution

Project contributions are licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option. Third-party dependencies retain their own licenses; see the [Dependency Review](docs/engineering/dependencies.md).
