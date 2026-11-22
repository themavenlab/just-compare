# 0004: Folder comparison engine

Status: Accepted

Approval: Owner-confirmed folder behavior and implementation plan, recorded in `temp-plan-new.md` Sections 1, 5.1 and 6.1; Phase 8 documentation was explicitly authorized for implementation.

## Context

Folder comparison, refresh and synchronization must use one consistent row model. The UI needs stable identity across same-name files and directories, while refresh and sync must remain bounded and must not make filesystem effects from display data alone.

## Decision

- A row is identified by its relative path and kind (`isDirectory`). A file and directory with the same name are separate rows; there is no type-mismatch status.
- Statuses are `same`, `different`, `leftOnly`, `rightOnly` and `error`. Left-only cells are red, right-only cells green, differing paired cells yellow, identical cells untinted, and selection/focus blue. A paired directory's status remains its own status; descendant counts and presentation may show differences without changing it.
- New comparisons use the size-and-modified-time quick test with a 2-second tolerance and no content reads. Explicit content comparison uses the selected binary, CRC or text-rules method.
- Symbolic links and junctions are link entries compared by their target text. Scans never follow them. Sync skips link and error rows individually, with a reason; they do not block unrelated operations. Cloud placeholder files and folders are treated as ordinary entries.
- `scan_folders` returns a `FolderScan` containing a scan handle, rows and a truncation flag. Each root is bounded to 250,000 entries; a limit hit returns a partial result. Sync refuses truncated scans because their rows do not describe the whole tree.
- Rust retains up to eight recent rule-based scans. `refresh_folder_paths` takes a scan handle and relative paths and returns a `FolderPatch` of removed and upserted rows, identified by path and kind. Failed or expired handles require a full rescan.
- Sync plans are built from the cached rows shown in the grid and the existing Update/Mirror decision table. Execution revalidates the specific operation inputs; stale items fail individually. Rows are display data, not an executable operation list.
- Folder operations remain bounded to 250,000 entries and regular files up to 100 MiB. Binary and CRC display comparisons stream independently of the operation-size limit; text-rule comparisons fall back to binary above 8 MiB.

## Alternatives

- Pairing only by path would conflate same-name files and directories and make refresh identity ambiguous.
- Hashing both complete trees for every Sync preview duplicates comparison work and can disagree with the visible rules-based rows.
- Following links risks escaping the selected trees and makes recursion unpredictable.
- Failing an entire scan or sync at the entry limit or on one bad row would discard useful partial results and prevent unrelated safe operations.

## Consequences

The React layer can preserve row selection and apply scoped refresh patches without sending the previous table back to Rust. A truncated scan remains inspectable but cannot be synchronized. Errors and links are visible and actionable only through their reported skip reasons; no fallback follows or copies them. Platform-specific metadata capabilities continue to report errors where unsupported.

## Verification

Rust, frontend and Windows native tests exercise the engine, refresh, sync and UI. Their actual Phase 8 results, including the remaining failures, are recorded in the [validation guide](../engineering/validation.md); macOS/Linux results are not inferred from Windows checks.
