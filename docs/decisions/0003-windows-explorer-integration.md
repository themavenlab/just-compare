# 0003: Opt-in Windows Explorer integration

Status: Accepted

Approval: On 2026-10-16 the owner requested investigation, roadmap promotion, implementation and a separate commit for Explorer comparison, explicitly approving required dependencies.

## Context

The portable desktop has no installer or app identity. Windows supports static per-user verbs for files and directories. Windows 11 exposes legacy verbs under Show more options; its modern menu requires IExplorerCommand and app identity. Do not load a new DLL inside Explorer merely to launch a comparison.

## Decision

- Rust filesystem code owns registration and one persisted selected path. React provides explicit enable/remove/status/clear commands and opens new tabs.
- Use quoted static verbs under HKCU Software\Classes for `*` and `Directory`, each with MultiSelectModel=Single and an executable ownership marker. Never invoke a command shell, change default associations or require elevation.
- Only Select as left file/folder for compare is visible without a selection. Selection updates the matching class's Compare to name title and visibility; clear hides both compare verbs. Remove the original one-sided open verb on re-enable. Use LegacyDisable and SHChangeNotify rather than adding an Explorer DLL. This state refresh is application-driven, not an Explorer-time watcher for external renames/deletions.
- Left selection is windowless: before Tauri or singleton handoff starts, the executable persists the selection in Tauri's resolved config directory, refreshes owned registration and exits. Failures fall through to the normal app so they are visible. Only compare/open launches create or focus a window.
- Keep canonical executable identity for key ownership, but use ordinary drive/UNC paths in launch commands and icons. Filesystem device prefixes such as `\\?\` are not shell-activation paths.
- Adopt Windows-only winreg 0.56.0 (MIT) for safe registry access and tauri-plugin-single-instance 2.5.4 (MIT OR Apache-2.0) for normal-app handoff. Pin both and update both Cargo graphs; no frontend dependency is needed.
- The Tauri callback queues at most 32 requests and emits a notification; React subscribes before draining, avoiding startup listener races. It appends workspaces, never replaces dirty tabs. Selection IO and comparison remain Rust.
- Exclude Git diff/merge and CLI waiting launches from singleton routing, preserving process waiting, temporary directory lifetime, cancellation and saved-output exit semantics. The CLI sets COMPARE_WAIT_FOR_CLOSE=1 only in its child environment; direct shell launches do not use that flag.
- Debug native tests isolate singleton identity by canonical test-config path and registry writes under a test-only HKCU subtree, not Explorer associations. Release builds do not honor test overrides.

## Alternatives

A COM extension plus sparse package could expose modern Windows 11 commands and multi-selection, but adds packaging, deployment and Explorer lifetime concerns. Hand-written mutex/WM_COPYDATA or IPC duplicates an official Tauri facility. PowerShell scripts or command-shell registry writes add quoting and policy risks.

## Consequences

Selection survives restarts as a local path only; clear it explicitly or remove integration. No drafts, credentials, contents or telemetry are stored. All paths are revalidated and missing/mixed/linked inputs report errors.
The registered executable must remain at its location: remove before moving it and re-enable afterward. Another executable cannot remove owned keys.
Partial registration failures report errors; retry enable/remove to repair.
Secondary shell launch exit means delivery, not comparison completion; failures are visible in the primary app. CLI/Git waiting launches remain independent.
macOS/Linux integration and modern Windows 11 packaging remain future work.

## Sources and verification

- [Microsoft static verb registration](https://learn.microsoft.com/en-us/windows/win32/shell/context-menu-handlers)
- [Windows 11 menu model](https://blogs.windows.com/windowsdeveloper/2021/07/19/extending-the-context-menu-and-share-dialog-in-windows-11/)
- [Tauri single-instance plugin](https://v2.tauri.app/plugin/single-instance/)

Actual checks and remaining manual/platform omissions are recorded in [validation](../engineering/validation.md).
