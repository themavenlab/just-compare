# Usage Guide

This guide covers everyday usage of Just Compare, including text comparison, folder synchronization, three-way merge, preferences, CLI commands, and Git configuration.

---

## 1. Text Comparison

1. **Opening Files:** Select the **text** tab, enter file paths and click **Open**, or use the file browse dialogs.
2. **Comparing:** Edit either pane directly. Clicking **Compare** (or pressing `Ctrl+Enter` / `Cmd+Enter`) calculates aligned editable lines and an interactive overview map. Ignore options (case, whitespace, line endings) and regex rules affect comparison keys only, never your source bytes on disk.
3. **Navigation & Merging:** Navigate differences with the overview buttons or by pressing `Alt+ArrowUp` / `Alt+ArrowDown`. Copy the selected difference block in either direction, use Undo, or click **Refine selected region** for character/word-level intraline highlighting.
4. **Saving:** Press `Ctrl+S` / `Cmd+S` to save the active pane. Save As will prompt before overwriting any existing destination. Explicit legacy or UTF-16 encodings can be selected from the encoding menu.
5. **Safety Protections:** External modifications to an open file trigger conflict alerts. Unsaved edits require confirmation before loading a new file or closing the window.

---

## 2. Folder Comparison & Synchronization

1. **Scanning Folders:** Select the **folder** tab, choose two local directories, select your comparison criterion (Content Hash, File Size, or Size + Timestamp), and click **Scan folders**.
2. **Exclusion Rules:** Enter newline-separated glob patterns (e.g. `*.tmp`, `node_modules/**`, `.git/**`) to exclude matching entries from the scan.
3. **Operation Previews:**
   - **Update:** Previews copying new and modified files from Left to Right, including creating missing subdirectories.
   - **Mirror:** Previews Left-to-Right updates plus recycling Right-only entries so the Right directory mirrors the Left.
   - **Single File Actions:** Select any entry to copy, move (copy to Right and recycle Left), or recycle individually.
4. **Execution & Cancellation:** Review the planned operations and click Execute. If files change externally between preview generation and execution, the stale preview is halted automatically. Cancelling mid-flight cleanly stops remaining operations while reporting already completed actions.

---

## 3. Three-Way Merge

1. **Setting Up:** Select the **merge** tab, open Base, Left (e.g. your branch), and Right (e.g. their branch), and click **Merge three inputs**.
2. **Resolving Conflicts:** Non-overlapping and identical edits are auto-resolved. Overlapping conflicting regions remain highlighted. Use the resolution buttons (**Use Left**, **Use Right**, **Use Base**, **Delete**) to resolve each conflict, or edit the output pane directly.
3. **Saving the Merge:** The **Save merge output** button is enabled once all conflicts are resolved. In Git merge mode, saving accepts the merge and exits the process with code 0; closing the window without saving exits with code 1.

---

## 4. Preferences & Saved Sessions

- **Theme & Formatting:** Toggle Light and Dark themes, configure global ignore options, and set up filename suffix profiles (e.g. always ignoring whitespace for `.txt` files).
- **Saved Sessions:** Save your active directory pairs or merge files as named sessions for quick restoration from the **Sessions and recent files** panel.
- **Persistence:** Settings are stored in your operating system's standard application-config directory (`settings.json`). If a settings file is ever corrupted, Just Compare retains the existing file for recovery and reports a clear diagnostic error instead of silently overwriting it.

---

## 5. Command Line Interface (CLI)

Build the CLI binary with `cargo build --workspace --release --locked` (produces `target/release/compare.exe` on Windows).

```text
# Headless text diff
compare diff LEFT_FILE RIGHT_FILE

# Headless folder comparison
compare folder LEFT_DIR RIGHT_DIR

# Headless three-way merge
compare merge BASE_FILE LEFT_FILE RIGHT_FILE OUTPUT_FILE

# Launch GUI with folder pair
compare gui LEFT_DIR RIGHT_DIR

# Git tool integration
compare git-diff LEFT_FILE RIGHT_FILE
compare git-merge BASE_FILE LEFT_FILE RIGHT_FILE OUTPUT_FILE
```

### Exit Codes
- `0`: Files/folders are identical, or merge completed cleanly.
- `1`: Differences found, conflicts remained unresolved, or operation was cancelled.
- `2`: Invalid arguments, I/O errors, or scan failures.

---

## 6. Git Difftool and Mergetool Setup

Configure Just Compare as your local Git difftool and mergetool. In PowerShell on Windows:

```powershell
$env:COMPARE_DESKTOP = "C:\path\to\just-compare\compare-desktop.exe"
git config --local diff.tool justcompare
git config --local difftool.justcompare.cmd '"C:/path/to/just-compare/compare.exe" git-diff "$LOCAL" "$REMOTE"'

git config --local merge.tool justcompare
git config --local mergetool.justcompare.cmd '"C:/path/to/just-compare/compare.exe" git-merge "$BASE" "$LOCAL" "$REMOTE" "$MERGED"'
git config --local mergetool.justcompare.trustExitCode true
```

### Running Git Diff and Merge
```powershell
# Compare files in working tree
git difftool --no-prompt

# Resolve conflicts in a merge
git mergetool --no-prompt

# Compare entire directories in Git
git -c 'difftool.justcompare.cmd="C:/path/to/just-compare/compare.exe" gui "$LOCAL" "$REMOTE"' difftool --dir-diff --no-symlinks --no-prompt
```
