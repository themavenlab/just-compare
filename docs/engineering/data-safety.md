# Data Safety Contract

This document defines the core safety guarantees governing file inspection, modification, synchronization, and deletion across Just Compare.

---

## 1. Read-Only Comparison

- Comparison and scanning operations are strictly read-only.
- Opening, inspecting, hashing, or decoding files must never trigger file modifications, temporary backup clutter, or network transmissions.
- Reading and mutation are completely decoupled into distinct subsystems.

---

## 2. Safe Saving and Encoding Preservation

- **Explicit Intent:** File modifications require explicit user initiation and a confirmed destination.
- **Format Integrity:** Preserve the original character encoding (UTF-8, UTF-16, legacy codepages), BOM (Byte Order Mark), and line-ending conventions (CRLF vs. LF). Warn the user and require confirmation before any lossy conversion.
- **External Change Detection:** Detect if a file was modified externally before overwriting it. Never overwrite newer changes silently.
- **Atomic Writes:** Save files using atomic write-and-replace patterns (writing to a temporary file in the same directory/filesystem, flushing, and replacing) to prevent data corruption during crashes or power loss.
- **Failure Recovery:** Never discard unsaved user edits or falsely report a failed write as successful. Retain recoverable temporary drafts if a write operation fails.

---

## 3. Directory Synchronization & Deletion

- **Preview Before Execution:** Always present a clear dry-run preview detailing planned additions, overwrites, and deletions before executing any sync operation.
- **Stale State Protection:** Revalidate file metadata immediately prior to executing scheduled operations. If timestamps, sizes, or hashes have changed since the preview was generated, halt the affected action and prompt for an updated preview.
- **Recoverable Deletion:** Default to the system trash / recycle bin where supported by the OS. Clearly notify the user and require explicit confirmation when irreversible deletion is necessary.
- **Granular Reporting:** Report results for each individual operation in a batch sync. If an error occurs midway, clearly report completed, failed, and skipped items.
- **Graceful Cancellation:** Cancelling an in-flight sync stops subsequent operations immediately and reports all actions completed up to that point.

---

## 4. Path & Filesystem Traversal

- **Symlinks & Reparse Points:** Reject symbolic links, directory junctions, and linked ancestors outside the user-selected boundary without explicit authorization.
- **Path Sanitization:** Reject path traversal attacks (e.g. `../` sequences) when extracting or reading archives. Paths must be absolute.
- **Cross-Platform Compatibility:** Correctly handle non-Unicode file paths, spaces, case-sensitivity differences, and platform-specific path length limits.

---

## 5. Credentials, Privacy & Test Fixtures

- **Privacy by Default:** Do not log file contents, secret tokens, or sensitive machine paths.
- **Credentials:** When remote sources (e.g. SFTP, S3) are introduced, store credentials in the platform's native secure keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service).
- **Test Safety:** Automated tests that write or delete files must operate strictly within isolated, uniquely owned temporary directories and clean up after themselves. Tests must never modify workspace files, user home directories, or system paths.

---

## 6. Implemented Local Backend Details

- **Atomic Text Replacement:** Text snapshots retain original bytes and modification timestamps. Saving checks both, writes a sibling temporary file, flushes it to disk, preserves destination permissions, and safely replaces the target. Read-only destinations fail visibly. Save As never clobbers existing files.
- **Encoding & EOL Handling:** UTF-8 and UTF-16 BOMs and original EOLs are preserved. CodeMirror normalizes editor view state, while Rust restores original line terminators and uses the first original terminator for new lines. Missing trailing newlines remain significant. Explicit UTF-8 conversion creates a separate file.
- **Folder Sync Validation:** Folder sync plans always hash file contents, even when display filtering uses size or timestamps. Execution consumes the preview handle exactly once, rescans roots, and verifies each affected entry again before modifying disk. Changed snapshots immediately halt execution and require generating a new preview. Update and mirror support both directions through explicit planner-root reversal; mirror additionally recycles destination-only entries.
- **Local-Action Plans & Safe Operations:** Local-action plans separately support recursive copy/move/recycle, exact-target transfers for aligned counterpart names, rename, mkdir, read-only attribute toggling, and timestamp touch. Directory copy/move merges preserve destination-only entries. Existing-file replacement is opt-in and explicitly listed in every leaf preview. Batches share limits and reject cross-operation overlaps. Plans capture and revalidate content and destinations independently of display rules; the UI cannot weaken checks with CRC, quick tests, or ignored markers. A plan is bounded to 10,000 entries and 100 MiB per file.
- **CRC, Unicode NFC, and Version Queries:** CRC is a read-only display checksum with possible collisions, never a replacement for exact byte comparison or BLAKE3 operation revalidation. NFC matching retains both actual paths and never renames source files. Windows executable version queries read fixed resources as plain data and never execute binary code; file and product version equality requires valid metadata on both sides, and missing resources produce errors. Free-space queries sample available capacity for display but never reserve space or guarantee write success.
- **Rename, Make Directory, and Attributes:** Rename and mkdir do not intentionally clobber existing paths. Read-only and touch operations may affect hard-link aliases. Touch accepts regular files and explicit non-negative Unix-millisecond timestamps only.
- **Safe Copy and Move:** File moving copies to the destination first and recycles the source only after successful copy verification. Orphan directories are recycled deepest-first and only when verified empty. Excluded files are never deleted. No permanent deletion fallback exists: unavailable trash and failed moves report partial outcomes.
- **Hard Links & Permissions:** Replacing a file safely breaks that name's hard-link association; other names retain the previous content. Basic permission bits are preserved on copied files.
- **Settings & Session Integrity:** Settings are saved via a flushed temporary replacement. If a settings file becomes corrupt, the error is reported and the file is retained rather than silently reset. Named-session additions and confirmed removals persist immediately; the shared session list updates only after a successful write. Other preference or profile changes use explicit Save preferences. Sessions store paths and rules, never unsaved file contents. Failed session saves retain entered details and report the error. Concurrent instances do not merge settings updates. No credentials or telemetry are stored.
- **Activity Logs:** Activity logs hold at most 200 events per workspace and are not automatically persisted. Failure events direct the user to the explicit error banner rather than copying detailed path-bearing errors into the log. Log export is an explicit no-clobber save; comparison contents are never logged.
- **Windows Explorer Integration:** Registration is strictly per-user under HKCU (`Software\Classes`), without elevation, default file-association overrides, or shell DLLs. Registry operations are scoped to owned application keys and removable at any time. The selected path is persisted in private `shell-selection.json` without file contents or credentials. Launching or comparing from Explorer never mutates source files or replaces dirty drafts.
