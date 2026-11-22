# Architecture decision records

Use ADRs for durable decisions with material consequences: stack, boundaries, storage formats, safety semantics, or significant dependencies. Routine implementation details belong in code or issue/PR discussion.

## Workflow

1. Inspect existing ADRs before proposing a change.
2. Use the next unused four-digit number and a descriptive filename.
3. Mark a new decision `Proposed` until the authorized human accepts it.
4. Record accepted decisions with approval evidence. An agent cannot approve its own dependency or architecture proposal.
5. Supersede rather than silently rewrite a previous decision's rationale. Correct factual errors explicitly and link replacement decisions both ways.

## Template

```text
# NNNN: Decision title

Status: Proposed | Accepted | Superseded by NNNN
Approval: Link/reference to explicit approval, if accepted

## Context
Problem, constraints, and evidence.

## Decision
Chosen approach and boundaries.

## Alternatives
Credible alternatives and reasons for not choosing them.

## Consequences
Benefits, costs, risks, and compatibility/migration implications.

## Verification
Evidence already gathered and remaining validation.
```

## Index

- [0001: Desktop stack](0001-desktop-stack.md) - Accepted; Windows Phase 1 implemented.
- [0002: Prototype tooling](0002-prototype-tooling.md) - Accepted.
- [0003: Windows Explorer integration](0003-windows-explorer-integration.md) - Accepted; opt-in static verbs.
- [0004: Folder comparison engine](0004-folder-comparison-engine.md) - Accepted.
