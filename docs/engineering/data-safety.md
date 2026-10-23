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
- **Format Integrity:** Preserve the original character encoding (UTF-8, UTF-16, ASCII), BOM (Byte Order Mark), and line-ending conventions (CRLF vs. LF). Warn the user and require confirmation before any lossy conversion.
- **External Change Detection:** Detect if a file was modified externally before overwriting it. Never overwrite newer changes silently.
- **Atomic Writes:** Save files using atomic write-and-replace patterns (writing to a temporary file in the same directory/filesystem, flushing, and renaming) to prevent data corruption during unexpected crashes or power loss.
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

- **Symlinks & Junctions:** Do not follow symbolic links or directory junctions outside the user-selected boundary without explicit user permission.
- **Path Sanitization:** Reject path traversal attacks (e.g. `../` sequences) when extracting or reading archives.
- **Cross-Platform Compatibility:** Correctly handle non-Unicode file paths, spaces, case-sensitivity differences, and platform-specific path length limits.

---

## 5. Privacy, Credentials & Test Fixtures

- **Privacy by Default:** Do not log file contents, secret tokens, or sensitive machine paths.
- **Credentials:** When remote sources (e.g. SFTP, S3) are introduced, store credentials in the platform's native secure keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service).
- **Test Safety:** Automated tests that write or delete files must operate strictly within isolated, uniquely owned temporary directories and clean up after themselves. Tests must never modify workspace files, user home directories, or system paths.
