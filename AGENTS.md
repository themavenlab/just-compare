# Agent Instructions

## Product & Scope

Review the [Product Roadmap & Scope](docs/product/roadmap.md) for product boundaries and MVP goals, and the [Architecture Overview](docs/architecture/overview.md) before changing system architecture or user-visible behavior. The [README](README.md) summarizes the current MVP status, and the [Validation Guide](docs/engineering/validation.md) records validation commands and verified evidence.

## Guidance by Task

| Task / Focus | Required Guidance |
| :--- | :--- |
| **Every task** | [Agent Workflow](docs/engineering/agent-workflow.md), [Validation Guide](docs/engineering/validation.md) |
| **Architecture & IPC** | [Architecture Overview](docs/architecture/overview.md) |
| **File I/O, Sync, or Deletion** | [Data Safety Contract](docs/engineering/data-safety.md) |
| **Dependencies & Licensing** | [Dependency Review](docs/engineering/dependencies.md) |
| **Commit Formatting** | Use the [commit-message skill](.agents/skills/commit-message/SKILL.md) |

## Local Developer Environment

- Prefer installed Windows Rust/MSVC and Visual Studio C++ tools/Windows SDK. Do not assume the historical session-scoped GNU fallback is still necessary.
- If newly installed tools are missing from PATH, check the user's Rust bin (`$env:USERPROFILE\.cargo\bin`) and Visual Studio installation before declaring prerequisites absent. Restarting VS Code refreshes inherited PATH; avoid machine-wide environment changes.
- Use `npm ci` for a fresh checkout and `npm run desktop:dev` for native manual testing. A browser-only Vite launch (`npm run dev`) does not verify Rust IPC or file operations.
- Follow [Windows local development](docs/engineering/validation.md#windows-local-development) for launch commands, troubleshooting, native test builds, and toolchain selection. Do not carry GNU linker or toolchain overrides into a standard MSVC session.

## Context & Completion

- For unfinished tasks, leave a structured handoff following [Agent Workflow](docs/engineering/agent-workflow.md#handoff).
- Human approval is required prior to introducing new dependencies, making breaking contract changes, or executing destructive development actions. Product decision (approved by the owner): copy and move to the other side replace same-name files by default, and delete (Recycle Bin) runs after one Start click in the folder dialog with no second confirmation. Single-dialog copy/move/recycle matches standard "Copy to Side" behavior. Do not add extra confirmations or a replacement opt-out without a new owner decision.
- For every bug fix, add or extend an automated regression test wherever feasible. Exercise the reported behavior and relevant entry points; for UI/IPC bugs prefer native interaction coverage over checking implementation details. If automation is impractical, explain why and record the manual verification.
- Tool-specific instruction files, if introduced, must point here rather than duplicate policy. Verify each tool's discovery behavior before relying on it.
- **Markdown Formatting:** Do not break lines mid-sentence at arbitrary column widths. Write full sentences on continuous lines; allow text editors and Markdown renderers to handle soft wrapping.
