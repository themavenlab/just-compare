# Just Compare

A modern, fast, local-first file and folder comparison and merge utility for Windows, macOS, and Linux.

## Project Vision

Just Compare is designed to provide developers with a clean, responsive, and privacy-respecting diff and merge experience:

- **Local-First & Private:** All comparison logic runs locally on your machine. No cloud dependencies, no analytics, no telemetry.
- **Data Integrity Above All:** Diffing is strictly read-only. File synchronizations, replacements, and deletions require preview confirmation and atomic writes.
- **Native Performance:** Built with [Tauri v2](https://v2.tauri.app/), a headless [Rust](https://www.rust-lang.org/) comparison engine, [CodeMirror 6](https://codemirror.net/), and a modern [React](https://react.dev/) / TypeScript UI.

## Project Status

**Phase 1 MVP is implemented** on Windows x64. It features side-by-side text diffing, directory scanning and synchronization, three-way merge with conflict resolution, CLI commands, and Git difftool/mergetool integration.

## Documentation

- **[Usage Guide](docs/product/usage.md)** - Everyday usage guide for text diff, folder sync, 3-way merge, and Git integration.
- **[Product Roadmap & Scope](docs/product/roadmap.md)** - MVP feature set, core requirements, and future milestones.
- **[Architecture Overview](docs/architecture/overview.md)** - System design, component boundaries, and IPC conventions.
- **[Data Safety Contract](docs/engineering/data-safety.md)** - Non-negotiable guarantees for file handling, sync, and deletion.
- **[Validation & Definition of Done](docs/engineering/validation.md)** - Testing commands, verified evidence, and performance benchmarks.
- **[Dependency Review](docs/engineering/dependencies.md)** - Direct dependencies, licensing terms, and distribution obligations.
- **[Contributing Guide](CONTRIBUTING.md)** - How to propose changes and contribute code.
- **[AI Agent Instructions](AGENTS.md)** - Architectural rules and routing table for AI coding assistants.
