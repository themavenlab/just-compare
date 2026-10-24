# Engineering Workflow and Context Preservation

This guide defines how tasks are scoped, approved, executed, and handed off within Just Compare.

---

## Task Intake

Every engineering task should define:
- **Objective:** Clear explanation of what is being built or fixed.
- **Scope & Non-Goals:** Explicit boundaries of the change.
- **Acceptance Criteria:** Observable outcomes with concrete verification methods.
- **Validation Plan:** Automated tests and manual procedures to confirm correctness.

Use the [Engineering Task Template](../../.github/ISSUE_TEMPLATE/engineering-task.md) when filing tasks.

---

## Approval Gates

Human approval is required before:
- Adding or upgrading third-party dependencies or changing licenses.
- Introducing major architectural changes or breaking IPC/data contracts.
- Destructive operations, such as deleting user files, modifying unowned fixtures, or rewriting Git history.
- Committing, pushing, publishing releases, or uploading external artifacts.

When requesting approval, present the concrete change, rationale, alternatives, and validation plan.

---

## Execution Steps

1. **Inspect:** Examine current code, related documentation, and requirements.
2. **Clarify:** Resolve any ambiguities or missing requirements early.
3. **Implement:** Focus on one cohesive, atomic task without unrelated refactoring or cleanup.
4. **Validate:** Verify functionality, edge cases, error handling, and cancellation paths.
5. **Document:** Keep documentation and code in sync within the same change.
6. **Report:** Report completion against the acceptance criteria, or provide a handoff if unfinished.

---

## Authoritative Sources of Truth

| Information | Authoritative Location |
| :--- | :--- |
| **Engineering Rules & Safety** | Root instructions and `docs/engineering/` |
| **Architecture & IPC Design** | `docs/architecture/overview.md` |
| **Product Scope & Roadmap** | `docs/product/roadmap.md` |
| **Task Progress & Acceptance** | GitHub Issues and Pull Requests |
| **Actual System Behavior** | Current codebase and passing test suites |

Do not commit ad-hoc status files, chat logs, or scratch notes to the repository.

---

## Documentation & Markdown Formatting

- **No Mid-Sentence Line Breaks:** Write full sentences on continuous lines. Do not introduce arbitrary hard line breaks or break lines mid-sentence at artificial column limits (e.g., 72 or 80 characters).
- **Soft Wrapping:** Allow text editors and Markdown renderers to handle soft wrapping. Only insert line breaks between distinct paragraphs, bullet points, headings, or table rows.
- **Diff Cleanliness:** Keeping complete sentences intact on single lines prevents ragged wrapping and minimizes noisy Git diffs during edits.

---

<a id="handoff"></a>
## Handoff Template

When a task is paused or handed over before completion, document its state using this format in the issue or task summary:

```text
Objective and issue:
Branch and state:
Completed:
Remaining:
Files/components affected:
Checks run and results:
Decisions made:
Blockers or uncertainties:
Next concrete action:
```
