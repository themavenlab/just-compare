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
- **Folder Sync Validation:** Folder sync plans always hash file contents, even when display filtering uses size or timestamps. Execution consumes the preview handle exactly once, rescans roots, and verifies each affected entry again before modifying disk. Changed snapshots immediately halt execution and require generating a new preview.
- **Safe Copy and Move:** File moving copies to the destination first and recycles the source only after successful copy verification. Orphan directories are recycled deepest-first and only when verified empty. Excluded files are never deleted.
- **Hard Links & Permissions:** Replacing a file safely breaks that name's hard-link association; other names retain the previous content. Basic permission bits are preserved on copied files.
- **Settings Integrity:** Settings are saved via a flushed temporary replacement. If a settings file becomes corrupt, the error is reported and the file is retained rather than silently reset. No credentials or telemetry are stored.
