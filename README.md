# Just Compare

A modern, fast, local-first file and folder comparison and merge utility for Windows, macOS, and Linux.

## Project Vision

Just Compare is designed to provide developers with a clean, responsive, and privacy-respecting diff and merge experience:

- **Local-First & Private:** All comparison logic runs locally on your machine. No cloud dependencies, no analytics, no telemetry.
- **Data Integrity Above All:** Diffing is strictly read-only. File synchronizations, replacements, and deletions require preview confirmation and atomic writes.
- **Native Performance:** Built with [Tauri v2](https://v2.tauri.app/), a headless [Rust](https://www.rust-lang.org/) comparison engine, and a modern [React](https://react.dev/) / TypeScript UI.

## Project Status

The project is in the **foundation phase**. Architectural boundaries, safety guarantees, and milestone goals are established. Application scaffolding and core text diff prototypes are up next.

## Documentation

- **[Product Roadmap & Scope](docs/product/roadmap.md)** - MVP feature set, core requirements, and future milestones.
- **[Architecture Overview](docs/architecture/overview.md)** - System design, component boundaries, and IPC conventions.
- **[Data Safety Contract](docs/engineering/data-safety.md)** - Non-negotiable guarantees for file handling, sync, and deletion.
- **[Validation & Definition of Done](docs/engineering/validation.md)** - Testing expectations and quality standards.
- **[Contributing Guide](CONTRIBUTING.md)** - How to propose changes and contribute code.
- **[AI Agent Instructions](AGENTS.md)** - Architectural rules and routing table for AI coding assistants.
