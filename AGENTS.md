# Agent Instructions

## Start Here

- Review the [Product Roadmap](docs/product/roadmap.md) for product boundaries and MVP goals.
- Review the [Architecture Overview](docs/architecture/overview.md) for component ownership, directory structure, and IPC conventions.
- Check [README.md](README.md) for current repository status.

## Guidance by Task

| Task / Focus | Required Guidance |
| :--- | :--- |
| **Every task** | [Agent Workflow](docs/engineering/agent-workflow.md), [Validation Guide](docs/engineering/validation.md) |
| **Architecture & IPC** | [Architecture Overview](docs/architecture/overview.md) |
| **File I/O, Sync, or Deletion** | [Data Safety Contract](docs/engineering/data-safety.md) |
| **Commit Formatting** | Use the [commit-message skill](.agents/skills/commit-message/SKILL.md) |

## Context & Completion

- For unfinished tasks, leave a structured handoff following [Agent Workflow](docs/engineering/agent-workflow.md#handoff).
- Human approval is required prior to introducing new dependencies, making breaking contract changes, or executing destructive development actions.
- **Markdown Formatting:** Do not break lines mid-sentence at arbitrary column widths. Write full sentences on continuous lines; allow text editors and Markdown renderers to handle soft wrapping.
