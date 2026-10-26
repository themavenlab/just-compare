# Usage Guide

This guide covers everyday usage of Just Compare, including text comparison, folder synchronization, three-way merge, preferences, CLI commands, and Git configuration.

---

## 1. Workbench Navigation & Tabs

Use the tab bar or File menu to open independent Text Compare, Folder Compare, or 3-Way Merge tabs. Each tab independently retains its drafts, comparison rules, selections, diff results, Undo history, and scroll viewports. A star indicator marks unsaved changes; closing a dirty tab or the window requests confirmation before discarding edits. Use `Ctrl+Tab` / `Cmd+Tab` to switch between tabs and `Ctrl+W` / `Cmd+W` to close the active tab. Drag the central splitter to adjust pane widths. Secondary commands and panels (rules, aligned view, legend, preferences) are available through the View and Edit menus without permanently cluttering editor space.

---

## 2. Text Comparison

1. **Opening Files:** Select a text tab, enter file paths and click **Open**, or use the file browse dialogs.
2. **Comparing:** Edit either pane directly. Clicking **Compare** (or pressing `Ctrl+Enter` / `Cmd+Enter`) calculates aligned editable lines and an interactive overview map. Ignore options (case, whitespace, line endings) and regex rules affect comparison keys only, never your source bytes on disk.
3. **Navigation & Merging:** Navigate differences with the overview buttons or by pressing `Alt+ArrowUp` / `Alt+ArrowDown`. Copy the selected difference block in either direction, use Undo, or click **Refine selected region** for character/word-level intraline highlighting. The docked bottom inspector follows the caret or selected aligned row. Labels occupy one shared gutter so both source versions begin at the same column, without duplicate inline prefixes. **Previous line / Next line** inspects every line of multiline regions; stacked versions include source numbers, missing-line placeholders and character-level Rust highlights. Long lines scroll horizontally. **Detail height** resizes it and **Collapse line detail** hides it; these controls persist layout only, never text. Each changed region also features an inline gutter arrow: the left pane's right arrow copies that region into the right draft, and the right pane's left arrow copies it into the left draft. Gutter arrows operate directly on their own region regardless of current selection; clicking or selecting a source line never activates a copy arrow. An arrow beside an empty gap copies the deletion to the counterpart pane. Region copies refresh differences automatically while preserving editor scroll positions without implicit disk writes. Undo restores the previous draft and refreshes differences automatically, whether invoked by the pane button, Edit menu, or `Ctrl+Z` / `Cmd+Z`. Manual edits invalidate the old comparison; run Compare after those.
4. **Saving & Reloading:** Press `Ctrl+S` / `Cmd+S` to save the active pane. Saving refreshes comparison differences automatically, including after manual edits. **Reload** rereads both file inputs and compares the loaded contents; dirty drafts require confirmation before discarding edits. Both retain the viewport and aligned, linked vertical scrolling without requiring a second Compare click. Save As will prompt before overwriting any existing destination. Explicit legacy or UTF-16 encodings can be selected from the encoding menu under **More**.
5. **Safety Protections:** External modifications to an open file trigger conflict alerts. Unsaved edits require confirmation before loading a new file or closing the window.

---

## 3. Folder Comparison & Synchronization

1. **Scanning Folders:** Select a folder tab, choose two local directories, select your comparison criterion, and click **Scan folders**. Choose between Tree and Flat views, sort by name, size, or modified timestamp, and expand or collapse folders. Tree view shows connecting branch lines and distinct folder/file icons; Flat view shows full relative paths without tree connectors. Click a row to select it, `Ctrl`/`Cmd`-click to toggle additional rows, or `Shift`-click to select a visible range without needing checkboxes. Entries display mirrored Name/Size/Modified columns with color-coded status indicators (muted for identical, red for different, blue for left-only, purple for right-only, amber for errors).
2. **Comparison Rules:** Click **Rules** to configure independent size/timestamp checks, timestamp tolerance, right-side timezone offsets, daylight-saving adjustments, attribute comparisons, case/extension alignment, and content rules. Content comparison defaults to binary hashing, with optional CRC-32 checksums. Unicode filename alignment supports canonical NFC matching within the same parent folder. On Windows, executable versions (file and product versions in EXE, DLL, OCX, SYS, SCR, CPL binaries) can be compared directly as metadata.
3. **Exclusion Rules:** Enter newline-separated glob patterns (e.g. `*.tmp`, `node_modules/**`, `.git/**`) to exclude matching entries from the scan.
4. **Opening File Pairs:** Clicking **Open pair** (or pressing Enter on a file row) loads the selected pair into a new Text Compare tab without altering folder roots or clearing directory listings. Double-clicking a file pair opens a new tab and starts comparison automatically.
5. **Row Copy Actions & Context Menu:** Each eligible row features copy arrows for either direction. Right-clicking a row opens contextual commands (Copy to Side, Move to Side, Delete to Recycle Bin, Rename, Make Directory, Read-only attributes, and Touch timestamp). Directory operations create a recursive preview before any execution.
6. **Operation Previews:**
   - **Update:** Previews copying new and modified files from Left to Right (or reverse), including creating missing subdirectories.
   - **Mirror:** Previews updates plus recycling counterpart-only entries so the target directory mirrors the source.
   - **Single File Actions:** Select any entry to copy, move, or recycle individually.
7. **Execution & Cancellation:** Review the planned operations and click Execute. If files change externally between preview generation and execution, the stale preview is halted automatically. Cancelling mid-flight cleanly stops remaining operations while reporting already completed actions. Free disk space is sampled for both roots after scanning.

---

## 4. Three-Way Merge

1. **Setting Up:** Select the merge tab, open Base, Left (e.g. your branch), and Right (e.g. their branch), and click **Merge three inputs**.
2. **Resolving Conflicts:** Non-overlapping and identical edits are auto-resolved. Overlapping conflicting regions remain highlighted. Use the resolution buttons (**Use Left**, **Use Right**, **Use Base**, **Delete**) to resolve each conflict, or edit the output pane directly.
3. **Saving the Merge:** The **Save merge output** button is enabled once all conflicts are resolved. In Git merge mode, saving accepts the merge and exits the process with code 0; closing the window without saving exits with code 1. Other open merge tabs cannot replace the designated Git conflict snapshot.

---

## 5. Preferences & Saved Sessions

- **Theme & Formatting:** Toggle Light and Dark themes, configure global ignore options, and set up filename suffix profiles (e.g. always ignoring whitespace for `.txt` files) via **Session > File-format Profiles...** or the toolbar format controls. Preferences are accessible from View > Preferences.
- **Sessions Menu & Toolbar Dropdown:** The toolbar **Sessions** dropdown beside Home is a compact switch/create menu providing quick access to **New Text Compare**, **New Folder Compare**, **New 3-Way Merge**, and saved session definitions. Opening a session creates a tab while leaving existing drafts intact.
- **Saving & Managing Sessions:** Use **Session > Save Session...** to name the current comparison in a modal dialog. Saving writes the session immediately without requiring a separate preference save. Empty and duplicate names are rejected with clear inline errors, and save failures retain the dialog input. **Session > Saved Sessions...** opens a management dialog to inspect and remove saved sessions or recent paths. Removing a session requires confirmation and persists immediately without deleting files or closing tabs. Home screen session list additions and removals also persist immediately.
- **Persistence:** Settings are stored in your operating system's standard application-config directory (`settings.json`). If a settings file is ever corrupted, Just Compare retains the existing file for recovery and reports a clear diagnostic error instead of silently overwriting it.

---

## 6. Command Line Interface (CLI)

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

## 7. Git Difftool and Mergetool Setup

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

---

## 8. Windows Explorer Integration

From a stable executable location, choose **Integration > Enable Explorer commands...** and confirm. This integration is opt-in for the current Windows user only, requiring no administrator elevation, default file-association changes, or shell extension DLLs. On Windows 11, these static commands appear under **Show more options** (or `Shift+F10`).

1. **Select for Compare:** Right-click a single file or directory and choose **Select for Compare**. The selected path is saved privately in `shell-selection.json` without modifying disk files.
2. **Compare with Selected:** Right-click a second file or folder of the same kind and choose **Compare with Selected**. The pair opens in a new comparison tab within the running application without disturbing dirty drafts.
3. **Compare:** Alternatively, right-click any supported file or directory and choose **Compare** to open it on the left side, ready for you to specify a counterpart.

Use **Integration > Check Explorer integration** to view current registration status, **Integration > Clear selected compare path** to clear the pending selection, or **Integration > Remove Explorer commands...** to cleanly remove all owned registry entries.
