use crate::{checked_path, display_path, FileError};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_FOLDER_ENTRIES: usize = 250_000;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[path = "folder_rules.rs"]
mod folder_rules;
pub use folder_rules::{
  refresh_paths, scan_pair_with_rules, scan_selected_with_rules, validate_folder_configuration,
  ComparisonImportance, ContentMethod, FolderPatch, FolderRules, FolderScan, FolderSide,
  FolderTextRules, QuickTest, QuickTestPolicy, RowId,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderOptions {
  pub exclude: Vec<String>,
  /// Exact normalized relative file paths excluded from comparison.
  #[serde(default)]
  pub exclude_files: Vec<String>,
  /// Exact normalized relative directory paths excluded with their subtrees.
  #[serde(default)]
  pub exclude_directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FolderEntryKind {
  File,
  Directory,
  /// A symbolic link or junction, recorded by its target and never followed.
  Link,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FolderStatus {
  Same,
  Different,
  LeftOnly,
  RightOnly,
  Error,
}

impl FolderStatus {
  /// The wire name used by IPC and CLI output, identical to the serde form.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Same => "same",
      Self::Different => "different",
      Self::LeftOnly => "leftOnly",
      Self::RightOnly => "rightOnly",
      Self::Error => "error",
    }
  }
}

/// Descendant file counts beneath a directory row. Files only; folders are not counted.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderCounts {
  pub different: u64,
  pub left_only: u64,
  pub right_only: u64,
  pub error: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
  pub relative: String,
  pub left_relative: Option<String>,
  pub right_relative: Option<String>,
  pub left_kind: Option<FolderEntryKind>,
  pub right_kind: Option<FolderEntryKind>,
  pub status: FolderStatus,
  pub left_size: Option<u64>,
  pub right_size: Option<u64>,
  pub left_modified: Option<u64>,
  pub right_modified: Option<u64>,
  pub newer: Option<FolderSide>,
  pub newer_mixed: bool,
  pub importance: ComparisonImportance,
  pub error: Option<String>,
  pub detail: Option<String>,
  pub is_directory: bool,
  pub counts: FolderCounts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
  size: u64,
  modified: std::time::SystemTime,
  hash: String,
}

/// Kind of the entry at `path` without following links: `None` if absent, otherwise
/// `Some(true)` for a directory and `Some(false)` for anything else, including links.
fn other_side_is_directory(path: &Path) -> Result<Option<bool>, FileError> {
  match fs::symlink_metadata(path) {
    Ok(metadata) => Ok(Some(metadata.is_dir())),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error.into()),
  }
}

fn cancel(cancelled: &AtomicBool) -> Result<(), FileError> {
  if cancelled.load(Ordering::Relaxed) {
    Err(FileError("Folder operation cancelled.".into()))
  } else {
    Ok(())
  }
}

fn snapshot(path: &Path, cancelled: &AtomicBool) -> Result<Snapshot, FileError> {
  checked_path(path, false)?;
  let metadata = fs::metadata(path)?;
  if metadata.is_dir() {
    return Ok(Snapshot {
      size: 0,
      modified: metadata.modified()?,
      hash: "directory".into(),
    });
  }
  let mut file = fs::File::open(path)?;
  let before = file.metadata()?;
  if !before.is_file() || before.len() > MAX_FILE_BYTES {
    return Err(FileError(
      "Only regular files up to 100 MiB are supported.".into(),
    ));
  }
  let mut hasher = blake3::Hasher::new();
  let mut buffer = [0u8; 64 * 1024];
  let mut total = 0u64;
  loop {
    cancel(cancelled)?;
    let read = file.read(&mut buffer)?;
    if read == 0 {
      break;
    }
    total += read as u64;
    if total > MAX_FILE_BYTES {
      return Err(FileError("File grew above 100 MiB.".into()));
    }
    hasher.update(&buffer[..read]);
  }
  let after = file.metadata()?;
  if before.len() != total || after.len() != total || before.modified()? != after.modified()? {
    return Err(FileError("File changed while hashing.".into()));
  }
  Ok(Snapshot {
    size: total,
    modified: before.modified()?,
    hash: hasher.finalize().to_hex().to_string(),
  })
}

pub fn relative_folder_path(
  left: &Path,
  right: &Path,
  path: &Path,
) -> Result<Option<String>, FileError> {
  let path = checked_path(path, false)?;
  if !fs::metadata(&path)?.is_file() {
    return Err(FileError("Only regular files can be refreshed.".into()));
  }
  for root in [left, right] {
    let root = checked_path(root, false)?;
    if !fs::metadata(&root)?.is_dir() {
      return Err(FileError("Folder roots must be directories.".into()));
    }
    let Ok(relative) = path.strip_prefix(&root) else {
      continue;
    };
    let mut parts = Vec::new();
    for component in relative.components() {
      match component {
        std::path::Component::Normal(part) => parts.push(
          part
            .to_str()
            .ok_or_else(|| FileError("Non-Unicode names are unsupported.".into()))?,
        ),
        _ => return Err(FileError("A relative file path is required.".into())),
      }
    }
    if !parts.is_empty() {
      return Ok(Some(parts.join("/")));
    }
  }
  Ok(None)
}

pub(super) struct ExclusionFilters {
  pub patterns: GlobSet,
  pub files: BTreeSet<String>,
  pub directories: BTreeSet<String>,
}

impl ExclusionFilters {
  pub fn matches_directory_pattern(&self, relative: &str) -> bool {
    self.patterns.is_match(format!("{relative}/"))
  }
}

fn exact_exclusions(paths: &[String]) -> Result<BTreeSet<String>, FileError> {
  paths
    .iter()
    .map(|path| {
      if path.is_empty()
        || path.len() > 4096
        || path
          .split('/')
          .any(|part| part.is_empty() || part == "." || part == "..")
      {
        return Err(FileError(
          "Excluded paths must be normalized relative paths.".into(),
        ));
      }
      Ok(path.clone())
    })
    .collect()
}

pub(super) fn exclusion_filters(options: &FolderOptions) -> Result<ExclusionFilters, FileError> {
  if options.exclude.len() > 32 {
    return Err(FileError(
      "At most 32 exclusion patterns are supported.".into(),
    ));
  }
  if options
    .exclude_files
    .len()
    .saturating_add(options.exclude_directories.len())
    > MAX_FOLDER_ENTRIES
  {
    return Err(FileError(
      "At most 250,000 exact exclusions are supported.".into(),
    ));
  }
  let mut builder = GlobSetBuilder::new();
  for pattern in &options.exclude {
    if pattern.len() > 4096 {
      return Err(FileError("Exclusion pattern is too long.".into()));
    }
    builder.add(Glob::new(pattern).map_err(|e| FileError(e.to_string()))?);
  }
  let files = exact_exclusions(&options.exclude_files)?;
  let directories = exact_exclusions(&options.exclude_directories)?;
  Ok(ExclusionFilters {
    patterns: builder.build().map_err(|e| FileError(e.to_string()))?,
    files,
    directories,
  })
}

fn roots(left: &Path, right: &Path) -> Result<(PathBuf, PathBuf), FileError> {
  let left = checked_path(left, false).map_err(|error| {
    error.context(format!(
      "Could not read the left folder \"{}\"",
      display_path(left)
    ))
  })?;
  let right = checked_path(right, false).map_err(|error| {
    error.context(format!(
      "Could not read the right folder \"{}\"",
      display_path(right)
    ))
  })?;
  if left.starts_with(&right) || right.starts_with(&left) {
    return Err(
      FileError("Folder roots must not be identical or nested.".into()).context(format!(
        "Could not compare the left folder \"{}\" with the right folder \"{}\"",
        display_path(&left),
        display_path(&right)
      )),
    );
  }
  Ok((left, right))
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncMode {
  Update,
  Mirror,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOperation {
  pub relative: String,
  pub action: String,
}

pub type OperationResults = Vec<(String, Result<(), String>)>;

/// A row that Sync will not act on, with the reason shown in the preview.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRow {
  pub relative: String,
  pub reason: String,
}

/// Approval guard for one operation: the items the preview judged, revalidated at execution.
struct Guard {
  source: Option<Snapshot>,
  destination: Option<Snapshot>,
}

pub struct Plan {
  left: PathBuf,
  right: PathBuf,
  guards: BTreeMap<String, Guard>,
  pub operations: Vec<PlannedOperation>,
  pub skipped: Vec<SkippedRow>,
}

/// Mirror scan rows so that the right side plays the left role. `Plan::from_rows` only
/// plans left-to-right, so a right-to-left Sync plans `swap_sides(rows)` against the
/// swapped roots. Row identity (`relative`, `is_directory`) is unchanged by the swap.
pub fn swap_sides(rows: &[FolderEntry]) -> Vec<FolderEntry> {
  rows
    .iter()
    .map(|row| FolderEntry {
      relative: row.relative.clone(),
      left_relative: row.right_relative.clone(),
      right_relative: row.left_relative.clone(),
      left_kind: row.right_kind.clone(),
      right_kind: row.left_kind.clone(),
      status: match row.status {
        FolderStatus::LeftOnly => FolderStatus::RightOnly,
        FolderStatus::RightOnly => FolderStatus::LeftOnly,
        other => other,
      },
      left_size: row.right_size,
      right_size: row.left_size,
      left_modified: row.right_modified,
      right_modified: row.left_modified,
      newer: row.newer.map(|side| match side {
        FolderSide::Left => FolderSide::Right,
        FolderSide::Right => FolderSide::Left,
      }),
      newer_mixed: row.newer_mixed,
      importance: row.importance,
      error: row.error.clone(),
      detail: row.detail.clone(),
      is_directory: row.is_directory,
      counts: FolderCounts {
        different: row.counts.different,
        left_only: row.counts.right_only,
        right_only: row.counts.left_only,
        error: row.counts.error,
      },
    })
    .collect()
}

impl Plan {
  /// Decide Sync operations from scan rows. Update semantics are unchanged:
  ///
  /// | Row                                  | Update    | Mirror          |
  /// | ------------------------------------ | --------- | --------------- |
  /// | LeftOnly file                        | copy      | copy            |
  /// | LeftOnly directory                   | mkdir     | mkdir           |
  /// | Different file                       | overwrite | overwrite       |
  /// | Different directory, Same row        | none      | none            |
  /// | RightOnly file                       | none      | trash           |
  /// | RightOnly directory                  | none      | trashDirectory  |
  /// | Error row, or a link on either side  | skipped   | skipped         |
  ///
  /// Excluded entries never appear as rows. If an excluded item on the other side has a
  /// different kind from a planned item, the preview is refused as a collision; if it has
  /// the same kind, the item is treated as excluded and skipped.
  ///
  /// `selection` limits operations to the named rows; selecting a directory includes all
  /// of its descendants. `None` plans every row.
  pub fn from_rows(
    left: &Path,
    right: &Path,
    rows: &[FolderEntry],
    mode: SyncMode,
    selection: Option<&[RowId]>,
    cancelled: &AtomicBool,
  ) -> Result<Self, FileError> {
    let (left, right) = roots(left, right)?;
    let mut kinds: BTreeMap<&str, (bool, bool)> = BTreeMap::new();
    for row in rows {
      let entry = kinds.entry(row.relative.as_str()).or_default();
      if row.is_directory {
        entry.0 = true;
      } else {
        entry.1 = true;
      }
      if entry.0 && entry.1 {
        return Err(FileError(format!(
          "File/directory collision at {}; no sync was planned.",
          row.relative
        )));
      }
    }
    if let Some(selection) = selection {
      if selection.len() > MAX_FOLDER_ENTRIES
        || selection.iter().any(|id| {
          !rows
            .iter()
            .any(|row| row.relative == id.relative && row.is_directory == id.is_directory)
        })
      {
        return Err(FileError(
          "Selection includes an operation outside the preview.".into(),
        ));
      }
    }
    // Missing parents of selected items are planned too, so no directory is created unseen.
    let required_parents: BTreeSet<&str> = selection
      .unwrap_or_default()
      .iter()
      .flat_map(|id| {
        id.relative
          .match_indices('/')
          .map(move |(index, _)| &id.relative[..index])
      })
      .collect();
    let in_scope = |row: &FolderEntry| match selection {
      None => true,
      Some(selection) => {
        selection.iter().any(|id| {
          (id.relative == row.relative && id.is_directory == row.is_directory)
            || (id.is_directory
              && row
                .relative
                .strip_prefix(id.relative.as_str())
                .is_some_and(|rest| rest.starts_with('/')))
        }) || (row.is_directory
          && row.status == FolderStatus::LeftOnly
          && required_parents.contains(row.relative.as_str()))
      }
    };
    let mut operations = Vec::new();
    let mut skipped = Vec::new();
    let mut guards = BTreeMap::new();
    for row in rows.iter().filter(|row| in_scope(row)) {
      if row.status == FolderStatus::Same {
        continue;
      }
      if row.status == FolderStatus::Error {
        skipped.push(SkippedRow {
          relative: row.relative.clone(),
          reason: row
            .error
            .clone()
            .unwrap_or_else(|| "Could not be compared.".into()),
        });
        continue;
      }
      if row.left_kind == Some(FolderEntryKind::Link)
        || row.right_kind == Some(FolderEntryKind::Link)
      {
        skipped.push(SkippedRow {
          relative: row.relative.clone(),
          reason: "Links are not synced.".into(),
        });
        continue;
      }
      let left_path = left.join(row.left_relative.as_deref().unwrap_or(&row.relative));
      let right_path = right.join(row.right_relative.as_deref().unwrap_or(&row.relative));
      // Excluded items on the other side are invisible to rows, so probe them here.
      if matches!(row.status, FolderStatus::LeftOnly | FolderStatus::RightOnly) {
        let other = if row.status == FolderStatus::LeftOnly {
          &right_path
        } else {
          &left_path
        };
        match other_side_is_directory(other)? {
          Some(other_is_directory) if other_is_directory != row.is_directory => {
            return Err(FileError(format!(
              "File/directory collision at {}; no sync was planned.",
              row.relative
            )));
          }
          // Present with the same kind: an excluded item, so it is not synced.
          Some(_) => continue,
          None => {}
        }
      }
      let action = match (row.status, row.is_directory, mode) {
        (FolderStatus::LeftOnly, true, _) => "mkdir",
        (FolderStatus::LeftOnly, false, _) => "copy",
        (FolderStatus::Different, false, _) => "overwrite",
        (FolderStatus::RightOnly, true, SyncMode::Mirror) => "trashDirectory",
        (FolderStatus::RightOnly, false, SyncMode::Mirror) => "trash",
        _ => continue,
      };
      let (source, destination) = match action {
        "trash" | "trashDirectory" => (None, Some(&right_path)),
        "mkdir" | "copy" => (Some(&left_path), None),
        _ => (Some(&left_path), Some(&right_path)),
      };
      let captured = (|| -> Result<Guard, FileError> {
        Ok(Guard {
          source: source.map(|path| snapshot(path, cancelled)).transpose()?,
          destination: destination
            .filter(|path| path.symlink_metadata().is_ok())
            .map(|path| snapshot(path, cancelled))
            .transpose()?,
        })
      })();
      let guard = match captured {
        Ok(guard) => guard,
        Err(_) if cancelled.load(Ordering::Relaxed) => {
          return Err(FileError("Folder operation cancelled.".into()));
        }
        Err(error) => {
          skipped.push(SkippedRow {
            relative: row.relative.clone(),
            reason: error.to_string(),
          });
          continue;
        }
      };
      guards.insert(row.relative.clone(), guard);
      operations.push(PlannedOperation {
        relative: row.relative.clone(),
        action: action.into(),
      });
    }
    // Parents before children for creation; children before parents for recycling.
    operations.sort_by(|a, b| {
      let depth = |op: &PlannedOperation| op.relative.matches('/').count();
      match (a.action.starts_with("trash"), b.action.starts_with("trash")) {
        (true, true) => depth(b).cmp(&depth(a)).then(a.relative.cmp(&b.relative)),
        (false, false) => depth(a).cmp(&depth(b)).then(a.relative.cmp(&b.relative)),
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
      }
    });
    Ok(Self {
      left,
      right,
      guards,
      operations,
      skipped,
    })
  }

  /// Preview a whole-tree Sync with byte-exact rules. Refuses truncated scans.
  pub fn preview(
    left: &Path,
    right: &Path,
    options: FolderOptions,
    mode: SyncMode,
    cancelled: &AtomicBool,
  ) -> Result<Self, FileError> {
    let context = format!(
      "Could not prepare Sync between the left folder \"{}\" and the right folder \"{}\"",
      display_path(left),
      display_path(right)
    );
    let rules = FolderRules {
      content: ContentMethod::Binary,
      ..FolderRules::default()
    };
    let scan = scan_pair_with_rules(left, right, &options, &rules, cancelled, |_| {})
      .map_err(|error| error.context(context.clone()))?;
    if scan.truncated {
      return Err(
        FileError("Folder scan was truncated; narrow the folders before syncing.".into())
          .context(context),
      );
    }
    Self::from_rows(left, right, &scan.entries, mode, None, cancelled)
      .map_err(|error| error.context(context))
  }

  /// Consume a preview once. Failures are per-operation, never hidden as complete sync.
  pub fn execute(
    self,
    cancelled: &AtomicBool,
    progress: impl FnMut(usize),
  ) -> Result<OperationResults, FileError> {
    self.execute_with(cancelled, progress, |path| {
      trash::delete(path).map_err(|e| {
        FileError(format!(
          "Recoverable deletion failed; no permanent deletion attempted: {e}"
        ))
      })
    })
  }

  fn execute_with(
    self,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(usize),
    mut recycle: impl FnMut(&Path) -> Result<(), FileError>,
  ) -> Result<OperationResults, FileError> {
    let mut results = Vec::new();
    for operation in self.operations {
      if cancelled.load(Ordering::Relaxed) {
        results.push((
          operation.relative,
          Err("Cancelled before execution.".into()),
        ));
        continue;
      }
      let guard = self
        .guards
        .get(&operation.relative)
        .ok_or_else(|| FileError("Missing approval for operation.".into()))?;
      let source = self.left.join(&operation.relative);
      let destination = self.right.join(&operation.relative);
      let operation_context = sync_operation_context(&operation.action, &source, &destination);
      let result = (|| -> Result<(), FileError> {
        checked_path(&self.left, false)?;
        checked_path(&self.right, false)?;
        if operation.action == "trashDirectory" {
          checked_path(&destination, false)?;
          if !destination.is_dir() || fs::read_dir(&destination)?.next().is_some() {
            return Err(FileError(
              "Directory is no longer empty; recycling refused.".into(),
            ));
          }
          recycle(&destination)?;
          return Ok(());
        }
        match &guard.destination {
          Some(expected) => {
            if snapshot(&destination, cancelled)? != *expected {
              return Err(FileError("Changed since preview; skipped".into()));
            }
          }
          None => {
            if destination.symlink_metadata().is_ok() {
              return Err(FileError("Changed since preview; skipped".into()));
            }
          }
        }
        if operation.action == "trash" {
          checked_path(&destination, false)?;
          recycle(&destination)?;
          return Ok(());
        }
        let expected_source = guard
          .source
          .as_ref()
          .ok_or_else(|| FileError("Missing source approval.".into()))?;
        if snapshot(&source, cancelled)? != *expected_source {
          return Err(FileError("Changed since preview; skipped".into()));
        }
        let parent = destination
          .parent()
          .ok_or_else(|| FileError("Missing parent.".into()))?;
        // Validate the nearest existing ancestor before creating missing directories.
        let ancestor = parent
          .ancestors()
          .find(|p| p.exists())
          .ok_or_else(|| FileError("Missing destination root.".into()))?;
        checked_path(ancestor, false)?;
        fs::create_dir_all(parent)?;
        checked_path(parent, false)?;
        if operation.action == "mkdir" {
          checked_path(&destination, true)?;
          fs::create_dir(&destination)?;
          return Ok(());
        }
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        let mut source_file = fs::File::open(&source)?;
        let mut buffer = [0u8; 64 * 1024];
        let mut hash = blake3::Hasher::new();
        let mut total = 0u64;
        loop {
          cancel(cancelled)?;
          let read = source_file.read(&mut buffer)?;
          if read == 0 {
            break;
          }
          total += read as u64;
          if total > MAX_FILE_BYTES {
            return Err(FileError("Source grew above limit.".into()));
          }
          hash.update(&buffer[..read]);
          temp.write_all(&buffer[..read])?;
        }
        if hash.finalize().to_hex().as_str() != expected_source.hash {
          return Err(FileError("Source changed during copy.".into()));
        }
        checked_path(&destination, true)?;
        let permissions = if let Some(expected) = &guard.destination {
          if snapshot(&destination, cancelled)? != *expected {
            return Err(FileError("Destination changed during copy.".into()));
          }
          let permissions = fs::metadata(&destination)?.permissions();
          if permissions.readonly() {
            return Err(FileError("Destination is read-only.".into()));
          }
          permissions
        } else {
          fs::metadata(&source)?.permissions()
        };
        temp
          .as_file()
          .set_times(fs::FileTimes::new().set_modified(expected_source.modified))?;
        temp.as_file().set_permissions(permissions)?;
        temp.as_file().sync_all()?;
        if guard.destination.is_some() {
          temp
            .persist(&destination)
            .map_err(|e| FileError(e.error.to_string()))?;
        } else {
          temp
            .persist_noclobber(&destination)
            .map_err(|e| FileError(e.error.to_string()))?;
        }
        crate::file_actions::copy_hidden_system_attributes(&source, &destination)?;
        Ok(())
      })()
      .map_err(|error| error.context(&operation_context).to_string());
      results.push((operation.relative, result));
      progress(results.len());
    }
    Ok(results)
  }
}

fn sync_operation_context(action: &str, source: &Path, destination: &Path) -> String {
  let source = display_path(source);
  let destination = display_path(destination);
  match action {
        "copy" => format!(
            "Could not copy \"{source}\" from the left folder to \"{destination}\" in the right folder"
        ),
        "overwrite" => format!(
            "Could not overwrite \"{destination}\" in the right folder from \"{source}\" in the left folder"
        ),
        "mkdir" => format!(
            "Could not create folder \"{destination}\" in the right folder from \"{source}\" in the left folder"
        ),
        "trash" => format!("Could not recycle \"{destination}\" from the right folder"),
        "trashDirectory" => format!(
            "Could not recycle directory \"{destination}\" from the right folder"
        ),
        _ => format!(
            "Could not execute Sync action \"{action}\" for \"{source}\" and \"{destination}\""
        ),
    }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Row output under binary content rules without quick test or case folding,
  /// matching the behaviour the scenarios below were written against.
  fn scan_pair(
    left: &Path,
    right: &Path,
    options: &FolderOptions,
    cancelled: &AtomicBool,
    progress: impl FnMut(usize) + Send,
  ) -> Result<Vec<FolderEntry>, FileError> {
    let rules = FolderRules {
      align_case: false,
      content: ContentMethod::Binary,
      quick_test: QuickTest::None,
      ..FolderRules::default()
    };
    scan_pair_with_rules(left, right, options, &rules, cancelled, progress).map(|scan| scan.entries)
  }

  #[test]
  fn folder_status_wire_names_match_serde_and_as_str() {
    let cases = [
      (FolderStatus::Same, "same"),
      (FolderStatus::Different, "different"),
      (FolderStatus::LeftOnly, "leftOnly"),
      (FolderStatus::RightOnly, "rightOnly"),
      (FolderStatus::Error, "error"),
    ];
    for (status, wire) in cases {
      assert_eq!(status.as_str(), wire);
      assert_eq!(serde_json::to_value(status).unwrap(), wire);
      let parsed: FolderStatus = serde_json::from_value(wire.into()).unwrap();
      assert_eq!(parsed, status);
    }
    assert!(serde_json::from_value::<FolderStatus>("typeMismatch".into()).is_err());
  }

  #[test]
  fn relative_folder_path_maps_only_files_beneath_either_root() {
    let root = tempfile::tempdir().unwrap();
    let left = root.path().join("left");
    let right = root.path().join("right");
    fs::create_dir_all(left.join("nested")).unwrap();
    fs::create_dir_all(&right).unwrap();
    fs::write(left.join("nested/file.txt"), "left").unwrap();
    fs::write(right.join("other.txt"), "right").unwrap();
    let outside = root.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();

    assert_eq!(
      relative_folder_path(&left, &right, &left.join("nested/file.txt")).unwrap(),
      Some("nested/file.txt".into())
    );
    assert_eq!(
      relative_folder_path(&left, &right, &right.join("other.txt")).unwrap(),
      Some("other.txt".into())
    );
    assert_eq!(relative_folder_path(&left, &right, &outside).unwrap(), None);
    assert!(relative_folder_path(&left, &right, &left).is_err());
  }

  #[test]
  fn trash_unavailable_and_midflight_cancel_preserve_unexecuted_files() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(b.join("orphan"), "retained").unwrap();
    let flag = AtomicBool::new(false);
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Mirror, &flag).unwrap();
    let results = plan
      .execute_with(
        &flag,
        |_| {},
        |_| {
          Err(FileError(
            "Trash unavailable; no permanent deletion attempted.".into(),
          ))
        },
      )
      .unwrap();
    assert!(results[0]
      .1
      .as_ref()
      .unwrap_err()
      .contains("Trash unavailable"));
    assert_eq!(fs::read_to_string(b.join("orphan")).unwrap(), "retained");
    fs::write(a.join("one"), "one").unwrap();
    fs::write(a.join("two"), "two").unwrap();
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    let results = plan
      .execute(&flag, |_| flag.store(true, Ordering::Relaxed))
      .unwrap();
    assert!(results[0].1.is_ok());
    assert!(results[1].1.is_err());
    assert!(b.join("one").exists());
    assert!(!b.join("two").exists());
  }

  #[cfg(unix)]
  #[test]
  fn unix_backslashes_are_filename_content() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("back\\slash"), "data").unwrap();
    let flag = AtomicBool::new(false);
    let rows = scan_pair(&a, &b, &FolderOptions::default(), &flag, |_| {}).unwrap();
    assert_eq!(rows[0].relative, "back\\slash");
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    assert!(plan.execute(&flag, |_| {}).unwrap()[0].1.is_ok());
    assert_eq!(fs::read_to_string(b.join("back\\slash")).unwrap(), "data");
  }
  #[test]
  fn update_preview_rejects_stale_inputs_and_copies_exact_bytes() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("one"), b"first").unwrap();
    let flag = AtomicBool::new(false);
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    fs::write(a.join("one"), b"changed").unwrap();
    let results = plan.execute(&flag, |_| {}).unwrap();
    assert!(results[0]
      .1
      .as_ref()
      .unwrap_err()
      .contains("Changed since preview; skipped"));
    assert!(!b.join("one").exists());
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    assert_eq!(plan.operations.len(), 1);
    assert!(plan.execute(&flag, |_| {}).unwrap()[0].1.is_ok());
    assert_eq!(fs::read(b.join("one")).unwrap(), b"changed");
    assert_eq!(
      scan_pair(&a, &b, &FolderOptions::default(), &flag, |_| {}).unwrap()[0].status,
      FolderStatus::Same
    );
    assert!(Plan::preview(&a, &a, FolderOptions::default(), SyncMode::Update, &flag).is_err());
  }
  #[test]
  fn filters_and_cancellation_are_honored() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("skip.log"), b"x").unwrap();
    let options = FolderOptions {
      exclude: vec!["*.log".into()],
      ..FolderOptions::default()
    };
    assert!(scan_pair(&a, &b, &options, &AtomicBool::new(false), |_| {})
      .unwrap()
      .is_empty());
    assert!(scan_pair(&a, &b, &options, &AtomicBool::new(true), |_| {}).is_err());
  }

  #[test]
  fn directory_exclusions_preserve_same_name_files_and_sync_collision_checks() {
    let root = tempfile::tempdir().unwrap();
    let left = root.path().join("left");
    let right = root.path().join("right");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    fs::write(left.join("hello"), b"file").unwrap();
    fs::create_dir(right.join("hello")).unwrap();
    fs::write(right.join("hello").join("child.txt"), b"child").unwrap();
    fs::create_dir(left.join("paired")).unwrap();
    fs::create_dir(right.join("paired")).unwrap();
    fs::write(left.join("paired").join("left.txt"), b"left").unwrap();
    fs::write(right.join("paired").join("right.txt"), b"right").unwrap();
    let options = FolderOptions {
      exclude_directories: vec!["hello".into(), "paired".into()],
      ..FolderOptions::default()
    };
    let flag = AtomicBool::new(false);
    let rows = scan_pair(&left, &right, &options, &flag, |_| {}).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].relative, "hello");
    assert_eq!(rows[0].status, FolderStatus::LeftOnly);
    assert_eq!(rows[0].left_kind, Some(FolderEntryKind::File));
    assert_eq!(rows[0].right_kind, None);
    let error = match Plan::preview(&left, &right, options, SyncMode::Update, &flag) {
      Ok(_) => panic!("directory exclusion must not hide a file/directory collision"),
      Err(error) => error,
    };
    assert!(error.0.contains("File/directory collision at hello"));

    fs::remove_file(left.join("hello")).unwrap();
    fs::remove_dir_all(right.join("hello")).unwrap();
    let options = FolderOptions {
      exclude_directories: vec!["paired".into()],
      ..FolderOptions::default()
    };
    let plan = Plan::preview(&left, &right, options, SyncMode::Update, &flag).unwrap();
    assert!(plan.operations.is_empty());
  }

  #[test]
  fn full_sync_reports_unrelated_type_collisions() {
    // A `.git` directory on one side and a plain `.git` file on the other
    // (git worktree pointer) must block a full sync, even when the mismatch
    // is unrelated to any user-selected change.
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    let dst = root.path().join("dst");
    fs::create_dir(&src).unwrap();
    fs::create_dir(&dst).unwrap();
    fs::create_dir(src.join(".git")).unwrap();
    fs::write(dst.join(".git"), b"gitdir: /path/to/.git").unwrap();
    fs::create_dir(src.join("support")).unwrap();
    fs::write(src.join("support/README.md"), b"readme").unwrap();
    let flag = AtomicBool::new(false);
    assert!(
      Plan::preview(
        &src,
        &dst,
        FolderOptions::default(),
        SyncMode::Update,
        &flag
      )
      .is_err(),
      "full-sync preview must report the .git type collision"
    );
  }

  #[test]
  fn descendant_glob_exclusions_prune_directories_and_keep_sync_collisions_visible() {
    let root = tempfile::tempdir().unwrap();
    let left = root.path().join("left");
    let right = root.path().join("right");
    fs::create_dir_all(left.join("node_modules/package")).unwrap();
    fs::create_dir_all(right.join("node_modules/package")).unwrap();
    fs::write(left.join("node_modules/package/index.js"), b"left").unwrap();
    fs::write(right.join("node_modules/package/index.js"), b"right").unwrap();
    let options = FolderOptions {
      exclude: vec!["**/node_modules/**".into()],
      ..FolderOptions::default()
    };
    let flag = AtomicBool::new(false);
    assert!(scan_pair(&left, &right, &options, &flag, |_| {})
      .unwrap()
      .is_empty());
    assert!(
      Plan::preview(&left, &right, options.clone(), SyncMode::Update, &flag)
        .unwrap()
        .operations
        .is_empty()
    );

    fs::remove_dir_all(right.join("node_modules")).unwrap();
    fs::write(right.join("node_modules"), b"file").unwrap();
    let error = match Plan::preview(&left, &right, options, SyncMode::Update, &flag) {
      Ok(_) => panic!("excluded directory markers must not hide type collisions"),
      Err(error) => error,
    };
    assert!(error.0.contains("File/directory collision at node_modules"));
  }

  #[test]
  fn empty_directories_and_type_collisions_are_explicit() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::create_dir(a.join("empty")).unwrap();
    let flag = AtomicBool::new(false);
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    assert_eq!(plan.operations[0].action, "mkdir");
    assert!(plan.execute(&flag, |_| {}).unwrap()[0].1.is_ok());
    assert!(b.join("empty").is_dir());
    fs::write(b.join("collision"), "file").unwrap();
    fs::create_dir(a.join("collision")).unwrap();
    fs::write(a.join("reverse"), "file").unwrap();
    fs::create_dir(b.join("reverse")).unwrap();
    fs::write(b.join("reverse").join("child"), "file").unwrap();
    assert!(Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).is_err());
    let rows = scan_pair(&a, &b, &FolderOptions::default(), &flag, |_| {}).unwrap();
    let collision_rows: Vec<_> = rows
      .iter()
      .filter(|row| row.relative == "collision")
      .collect();
    assert_eq!(collision_rows.len(), 2);
    let collision_folder = collision_rows.iter().find(|row| row.is_directory).unwrap();
    assert_eq!(collision_folder.status, FolderStatus::LeftOnly);
    assert_eq!(collision_folder.left_kind, Some(FolderEntryKind::Directory));
    assert_eq!(collision_folder.right_kind, None);
    let collision_file = collision_rows.iter().find(|row| !row.is_directory).unwrap();
    assert_eq!(collision_file.status, FolderStatus::RightOnly);
    assert_eq!(collision_file.right_kind, Some(FolderEntryKind::File));
    assert!(rows.iter().all(|row| row.error.is_none()));
    let reverse_rows: Vec<_> = rows
      .iter()
      .filter(|row| row.relative == "reverse")
      .collect();
    assert_eq!(reverse_rows.len(), 2);
    assert!(reverse_rows.iter().any(
      |row| row.status == FolderStatus::LeftOnly && row.left_kind == Some(FolderEntryKind::File)
    ));
    assert!(reverse_rows
      .iter()
      .any(|row| row.status == FolderStatus::RightOnly
        && row.right_kind == Some(FolderEntryKind::Directory)));
    assert!(rows
      .iter()
      .any(|row| { row.relative == "reverse/child" && row.status == FolderStatus::RightOnly }));
  }

  #[test]
  fn cancellation_and_failed_copy_have_explicit_outcomes() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("file"), "new").unwrap();
    fs::write(b.join("file"), "old").unwrap();
    let permissions = fs::metadata(b.join("file")).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(b.join("file"), readonly).unwrap();
    let flag = AtomicBool::new(false);
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    let results = plan.execute(&flag, |_| {}).unwrap();
    assert!(results[0].1.is_err());
    assert_eq!(fs::read_to_string(b.join("file")).unwrap(), "old");
    fs::set_permissions(b.join("file"), permissions).unwrap();
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    flag.store(true, Ordering::Relaxed);
    let results = plan.execute(&flag, |_| {}).unwrap();
    assert!(results.iter().all(|(_, result)| result.is_err()));
    assert_eq!(fs::read_to_string(b.join("file")).unwrap(), "old");
  }

  #[test]
  fn sync_copy_preserves_source_modified_time_and_windows_attributes() {
    let root = tempfile::tempdir().unwrap();
    let left = root.path().join("left");
    let right = root.path().join("right");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    let source = left.join("file");
    let destination = right.join("file");
    fs::write(&source, "new content").unwrap();
    fs::write(&destination, "old content").unwrap();
    let modified =
      std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_620_000_000);
    fs::File::options()
      .write(true)
      .open(&source)
      .unwrap()
      .set_times(fs::FileTimes::new().set_modified(modified))
      .unwrap();
    #[cfg(windows)]
    {
      use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
      use windows_sys::Win32::Storage::FileSystem::{
        SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
      };
      let path: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
      let attributes = fs::metadata(&source).unwrap().file_attributes()
        | FILE_ATTRIBUTE_HIDDEN
        | FILE_ATTRIBUTE_SYSTEM;
      assert_ne!(unsafe { SetFileAttributesW(path.as_ptr(), attributes) }, 0);
    }

    let flag = AtomicBool::new(false);
    let plan = Plan::preview(
      &left,
      &right,
      FolderOptions::default(),
      SyncMode::Update,
      &flag,
    )
    .unwrap();
    assert!(plan
      .execute(&flag, |_| {})
      .unwrap()
      .iter()
      .all(|(_, result)| result.is_ok()));
    let copied = fs::metadata(&destination).unwrap();
    assert_eq!(copied.modified().unwrap(), modified);
    #[cfg(windows)]
    {
      use std::os::windows::fs::MetadataExt;
      use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM};
      assert_eq!(
        copied.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM),
        FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM
      );
    }
  }

  #[test]
  fn sync_preview_and_operation_errors_name_side_paths_and_reasons() {
    let root = tempfile::tempdir().unwrap();
    let left = root.path().join("left");
    let right = root.path().join("right");
    fs::create_dir(&right).unwrap();
    let missing_left = root.path().join("missing-left");
    let preview_error = Plan::preview(
      &missing_left,
      &right,
      FolderOptions::default(),
      SyncMode::Update,
      &AtomicBool::new(false),
    )
    .err()
    .unwrap()
    .to_string();
    assert!(preview_error.contains("Could not prepare Sync"));
    assert!(preview_error.contains("Could not read the left folder"));
    assert!(preview_error.contains(&display_path(&missing_left)));

    fs::create_dir(&left).unwrap();
    let orphan = right.join("orphan.txt");
    fs::write(&orphan, "right only").unwrap();
    let flag = AtomicBool::new(false);
    let plan = Plan::preview(
      &left,
      &right,
      FolderOptions::default(),
      SyncMode::Mirror,
      &flag,
    )
    .unwrap();
    let mut results = plan
      .execute_with(
        &flag,
        |_| {},
        |_| Err(FileError("trash unavailable".into())),
      )
      .unwrap();
    let error = results.pop().unwrap().1.unwrap_err();
    assert!(error.contains("Could not recycle"));
    assert!(error.contains("right folder"));
    assert!(error.contains(&display_path(&checked_path(&orphan, false).unwrap())));
    assert!(error.contains("trash unavailable"));
  }

  fn preview_selected(
    a: &Path,
    b: &Path,
    mode: SyncMode,
    selection: &[RowId],
    flag: &AtomicBool,
  ) -> Result<Plan, FileError> {
    let rules = FolderRules {
      content: ContentMethod::Binary,
      ..FolderRules::default()
    };
    let scan = scan_pair_with_rules(a, b, &FolderOptions::default(), &rules, flag, |_| {})?;
    Plan::from_rows(a, b, &scan.entries, mode, Some(selection), flag)
  }

  fn file_row(relative: &str) -> RowId {
    RowId {
      relative: relative.into(),
      is_directory: false,
    }
  }

  #[test]
  fn preview_selection_cannot_add_operations() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("one"), "one").unwrap();
    fs::write(a.join("two"), "two").unwrap();
    let flag = AtomicBool::new(false);
    assert!(preview_selected(&a, &b, SyncMode::Update, &[file_row("../escape")], &flag).is_err());
    let plan = preview_selected(&a, &b, SyncMode::Update, &[file_row("two")], &flag).unwrap();
    assert_eq!(plan.operations.len(), 1);
    assert!(plan.execute(&flag, |_| {}).unwrap()[0].1.is_ok());
    assert!(!b.join("one").exists());
    fs::create_dir(a.join("nested")).unwrap();
    fs::write(a.join("nested").join("file"), "nested").unwrap();
    let plan =
      preview_selected(&a, &b, SyncMode::Update, &[file_row("nested/file")], &flag).unwrap();
    assert_eq!(plan.operations.len(), 2);
    assert!(plan.operations.iter().any(|op| op.action == "mkdir"));
    assert!(plan
      .execute(&flag, |_| {})
      .unwrap()
      .iter()
      .all(|(_, result)| result.is_ok()));
    assert_eq!(
      fs::read_to_string(b.join("nested").join("file")).unwrap(),
      "nested"
    );
  }

  #[test]
  fn selecting_a_directory_includes_its_descendants() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir_all(a.join("dir").join("inner")).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("dir").join("top"), "top").unwrap();
    fs::write(a.join("dir").join("inner").join("deep"), "deep").unwrap();
    let flag = AtomicBool::new(false);
    let dir_row = RowId {
      relative: "dir".into(),
      is_directory: true,
    };
    let plan = preview_selected(&a, &b, SyncMode::Update, &[dir_row], &flag).unwrap();
    assert!(plan
      .operations
      .iter()
      .any(|op| op.action == "copy" && op.relative == "dir/inner/deep"));
    assert!(plan
      .operations
      .iter()
      .any(|op| op.action == "copy" && op.relative == "dir/top"));
    assert!(plan
      .execute(&flag, |_| {})
      .unwrap()
      .iter()
      .all(|(_, r)| r.is_ok()));
    assert_eq!(
      fs::read_to_string(b.join("dir/inner/deep")).unwrap(),
      "deep"
    );
  }

  #[test]
  fn stale_item_fails_alone_while_others_complete() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("one"), "one").unwrap();
    fs::write(a.join("two"), "two").unwrap();
    let flag = AtomicBool::new(false);
    let plan = Plan::from_rows(
      &a,
      &b,
      &scan_pair_with_rules(
        &a,
        &b,
        &FolderOptions::default(),
        &FolderRules {
          content: ContentMethod::Binary,
          ..FolderRules::default()
        },
        &flag,
        |_| {},
      )
      .unwrap()
      .entries,
      SyncMode::Update,
      None,
      &flag,
    )
    .unwrap();
    assert_eq!(plan.operations.len(), 2);
    fs::write(a.join("one"), "changed after preview").unwrap();
    let results = plan.execute(&flag, |_| {}).unwrap();
    let failed = results.iter().filter(|(_, r)| r.is_err()).count();
    let succeeded = results.iter().filter(|(_, r)| r.is_ok()).count();
    assert_eq!((failed, succeeded), (1, 1));
    assert!(!b.join("one").exists());
    assert_eq!(fs::read_to_string(b.join("two")).unwrap(), "two");
  }

  #[test]
  fn grid_quick_test_rows_are_not_resynced_but_preview_compares_bytes() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("file"), "aaaa").unwrap();
    fs::write(b.join("file"), "bbbb").unwrap();
    let modified =
      std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_620_000_000);
    for path in [a.join("file"), b.join("file")] {
      fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    }
    let flag = AtomicBool::new(false);
    let scan = scan_pair_with_rules(
      &a,
      &b,
      &FolderOptions::default(),
      &FolderRules::default(),
      &flag,
      |_| {},
    )
    .unwrap();
    assert_eq!(scan.entries[0].status, FolderStatus::Same);
    let plan = Plan::from_rows(&a, &b, &scan.entries, SyncMode::Update, None, &flag).unwrap();
    assert!(plan.operations.is_empty());
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    assert_eq!(plan.operations.len(), 1);
    assert_eq!(plan.operations[0].action, "overwrite");
  }

  #[test]
  fn swap_sides_plans_right_to_left_sync() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("only-a"), "from a").unwrap();
    fs::write(b.join("only-b"), "from b").unwrap();
    let flag = AtomicBool::new(false);
    let rules = FolderRules {
      content: ContentMethod::Binary,
      ..FolderRules::default()
    };
    let scan =
      scan_pair_with_rules(&a, &b, &FolderOptions::default(), &rules, &flag, |_| {}).unwrap();
    // Right-to-left: the right folder b is the source, so plan with b as the left root.
    let swapped = swap_sides(&scan.entries);
    let plan = Plan::from_rows(&b, &a, &swapped, SyncMode::Update, None, &flag).unwrap();
    assert_eq!(plan.operations.len(), 1);
    assert_eq!(plan.operations[0].relative, "only-b");
    assert_eq!(plan.operations[0].action, "copy");
    assert!(plan.execute(&flag, |_| {}).unwrap()[0].1.is_ok());
    assert_eq!(fs::read_to_string(a.join("only-b")).unwrap(), "from b");
    assert_eq!(fs::read_to_string(a.join("only-a")).unwrap(), "from a");
    assert!(!b.join("only-a").exists());
  }
}
