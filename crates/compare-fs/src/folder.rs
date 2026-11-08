use crate::{checked_path, FileError};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_ENTRIES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[path = "folder_rules.rs"]
mod folder_rules;
pub use folder_rules::{
  refresh_selection, scan_pair_with_rules, scan_selected_with_rules, validate_folder_configuration,
  ComparisonImportance, ContentMethod, FolderRules, FolderSide, FolderTextRules, QuickTest,
  QuickTestPolicy,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Criterion {
  Content,
  Size,
  Modified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderOptions {
  pub criterion: Criterion,
  pub exclude: Vec<String>,
  /// Exact normalized relative file paths excluded from comparison.
  #[serde(default)]
  pub exclude_files: Vec<String>,
  /// Exact normalized relative directory paths excluded with their subtrees.
  #[serde(default)]
  pub exclude_directories: Vec<String>,
}
impl Default for FolderOptions {
  fn default() -> Self {
    Self {
      criterion: Criterion::Content,
      exclude: Vec::new(),
      exclude_files: Vec::new(),
      exclude_directories: Vec::new(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FolderEntryKind {
  File,
  Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
  pub relative: String,
  pub left_relative: Option<String>,
  pub right_relative: Option<String>,
  pub left_kind: Option<FolderEntryKind>,
  pub right_kind: Option<FolderEntryKind>,
  pub status: String,
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
  size: u64,
  modified: std::time::SystemTime,
  hash: String,
}

fn is_directory_hash(hash: &str) -> bool {
  matches!(hash, "directory" | "excludedDirectory")
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

type Scan = (BTreeMap<String, Snapshot>, BTreeMap<String, String>);

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
    > MAX_ENTRIES
  {
    return Err(FileError(
      "At most 10,000 exact exclusions are supported.".into(),
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

fn scan(
  root: &Path,
  options: &FolderOptions,
  cancelled: &AtomicBool,
  progress: &mut impl FnMut(usize),
) -> Result<Scan, FileError> {
  scan_internal(root, options, cancelled, progress, false)
}

fn scan_for_plan(
  root: &Path,
  options: &FolderOptions,
  cancelled: &AtomicBool,
  progress: &mut impl FnMut(usize),
) -> Result<Scan, FileError> {
  scan_internal(root, options, cancelled, progress, true)
}

fn scan_internal(
  root: &Path,
  options: &FolderOptions,
  cancelled: &AtomicBool,
  progress: &mut impl FnMut(usize),
  retain_excluded_markers: bool,
) -> Result<Scan, FileError> {
  let root = checked_path(root, false)?;
  if !root.is_dir() {
    return Err(FileError("Folder root must be a directory.".into()));
  }
  let filters = exclusion_filters(options)?;
  let mut stack = vec![root.clone()];
  let mut files = BTreeMap::new();
  let mut errors = BTreeMap::new();
  let mut count = 0;
  while let Some(directory) = stack.pop() {
    cancel(cancelled)?;
    checked_path(&directory, false)?;
    for item in fs::read_dir(&directory)? {
      cancel(cancelled)?;
      let item = item?;
      let path = item.path();
      let relative_path = path
        .strip_prefix(&root)
        .map_err(|e| FileError(e.to_string()))?;
      let relative = relative_path
        .components()
        .map(|component| {
          component
            .as_os_str()
            .to_str()
            .ok_or_else(|| FileError("Non-Unicode paths are unsupported; scan stopped.".into()))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
      if filters.patterns.is_match(&relative) {
        continue;
      }
      let glob_excludes_directory =
        !options.exclude.is_empty() && filters.matches_directory_pattern(&relative);
      let metadata = if glob_excludes_directory
        || filters.files.contains(&relative)
        || filters.directories.contains(&relative)
      {
        if let Err(error) = checked_path(&path, false) {
          errors.insert(relative, error.to_string());
          continue;
        }
        Some(fs::symlink_metadata(&path)?)
      } else {
        None
      };
      let excluded_file =
        filters.files.contains(&relative) && metadata.as_ref().is_some_and(|value| value.is_file());
      let excluded_directory = metadata.as_ref().is_some_and(|value| value.is_dir())
        && (filters.directories.contains(&relative) || glob_excludes_directory);
      if (excluded_file || excluded_directory) && !retain_excluded_markers {
        continue;
      }
      count += 1;
      if count > MAX_ENTRIES {
        return Err(FileError(
          "Folder exceeds the 10,000-entry prototype limit.".into(),
        ));
      }
      if count % 100 == 0 {
        progress(count);
      }
      if excluded_file || excluded_directory {
        let metadata = metadata.expect("excluded entry has metadata");
        let (size, hash) = if excluded_directory {
          (0, "excludedDirectory")
        } else {
          (metadata.len(), "excludedFile")
        };
        files.insert(
          relative,
          Snapshot {
            size,
            modified: metadata.modified()?,
            hash: hash.into(),
          },
        );
        continue;
      }
      if let Err(error) = checked_path(&path, false) {
        errors.insert(relative, error.to_string());
        continue;
      }
      let metadata = match metadata {
        Some(metadata) => metadata,
        None => fs::symlink_metadata(&path)?,
      };
      if metadata.is_dir() {
        files.insert(relative, snapshot(&path, cancelled)?);
        stack.push(path);
      } else {
        match snapshot(&path, cancelled) {
          Ok(value) => {
            files.insert(relative, value);
          }
          Err(error) => {
            errors.insert(relative, error.to_string());
          }
        }
      }
    }
  }
  progress(count);
  Ok((files, errors))
}

fn roots(left: &Path, right: &Path) -> Result<(PathBuf, PathBuf), FileError> {
  let left = checked_path(left, false)?;
  let right = checked_path(right, false)?;
  if left.starts_with(&right) || right.starts_with(&left) {
    return Err(FileError(
      "Folder roots must not be identical or nested.".into(),
    ));
  }
  Ok((left, right))
}

pub fn scan_pair(
  left: &Path,
  right: &Path,
  options: &FolderOptions,
  cancelled: &AtomicBool,
  progress: impl FnMut(usize) + Send,
) -> Result<Vec<FolderEntry>, FileError> {
  let (left, right) = roots(left, right)?;
  let callback = std::sync::Mutex::new(progress);
  let counts = [
    std::sync::atomic::AtomicUsize::new(0),
    std::sync::atomic::AtomicUsize::new(0),
  ];
  let scans = std::thread::scope(|scope| {
    let run = |root: &Path, side: usize| {
      scan(root, options, cancelled, &mut |count| {
        counts[side].store(count, Ordering::Relaxed);
        callback.lock().expect("Progress callback lock poisoned")(
          counts[0].load(Ordering::Relaxed) + counts[1].load(Ordering::Relaxed),
        );
      })
    };
    let left = &left;
    let right = &right;
    let a = scope.spawn(move || run(left, 0));
    let b = scope.spawn(move || run(right, 1));
    let a = a
      .join()
      .map_err(|_| FileError("Left scan worker panicked.".into()))??;
    let b = b
      .join()
      .map_err(|_| FileError("Right scan worker panicked.".into()))??;
    Ok::<_, FileError>((a, b))
  })?;
  let ((a, ae), (b, be)) = scans;
  let names: BTreeSet<_> = a
    .keys()
    .chain(b.keys())
    .chain(ae.keys())
    .chain(be.keys())
    .collect();
  Ok(
    names
      .into_iter()
      .map(|name| {
        let l = a.get(name);
        let r = b.get(name);
        let detail = ae.get(name).or_else(|| be.get(name)).cloned();
        let status = if detail.is_some() {
          "error"
        } else {
          match (l, r) {
            (Some(l), Some(r)) => {
              if is_directory_hash(&l.hash) != is_directory_hash(&r.hash) {
                "typeMismatch"
              } else {
                let equal = match options.criterion {
                  Criterion::Content => l.hash == r.hash,
                  Criterion::Size => l.size == r.size,
                  Criterion::Modified => l.size == r.size && l.modified == r.modified,
                };
                if equal {
                  "same"
                } else {
                  "different"
                }
              }
            }
            (Some(_), None) => "leftOnly",
            (None, Some(_)) => "rightOnly",
            _ => "error",
          }
        };
        FolderEntry {
          relative: name.clone(),
          left_relative: (l.is_some() || ae.contains_key(name)).then(|| name.clone()),
          right_relative: (r.is_some() || be.contains_key(name)).then(|| name.clone()),
          left_kind: l.map(|snapshot| {
            if snapshot.hash == "directory" {
              FolderEntryKind::Directory
            } else {
              FolderEntryKind::File
            }
          }),
          right_kind: r.map(|snapshot| {
            if snapshot.hash == "directory" {
              FolderEntryKind::Directory
            } else {
              FolderEntryKind::File
            }
          }),
          status: status.into(),
          left_size: l.map(|s| s.size),
          right_size: r.map(|s| s.size),
          left_modified: l.and_then(|s| folder_rules::modified_ms(s.modified)),
          right_modified: r.and_then(|s| folder_rules::modified_ms(s.modified)),
          newer: if status == "typeMismatch" {
            None
          } else {
            match (l, r) {
              (Some(l), Some(r)) if l.modified > r.modified => Some(FolderSide::Left),
              (Some(l), Some(r)) if l.modified < r.modified => Some(FolderSide::Right),
              _ => None,
            }
          },
          newer_mixed: false,
          importance: match status {
            "same" => ComparisonImportance::Equal,
            "error" => ComparisonImportance::Unknown,
            _ => ComparisonImportance::Important,
          },
          error: (status == "error").then(|| detail.clone()).flatten(),
          detail: if status == "typeMismatch" {
            Some("Not compared: one side is a file and the other is a folder.".into())
          } else {
            detail
          },
          is_directory: l.is_some_and(|s| s.hash == "directory")
            || r.is_some_and(|s| s.hash == "directory"),
        }
      })
      .collect(),
  )
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

pub struct Plan {
  left: PathBuf,
  right: PathBuf,
  options: FolderOptions,
  left_snapshot: BTreeMap<String, Snapshot>,
  right_snapshot: BTreeMap<String, Snapshot>,
  pub operations: Vec<PlannedOperation>,
}

impl Plan {
  pub fn select(&mut self, names: &[String]) -> Result<(), FileError> {
    if names.len() > MAX_ENTRIES
      || names
        .iter()
        .any(|name| !self.operations.iter().any(|op| &op.relative == name))
    {
      return Err(FileError(
        "Selection includes an operation outside the preview.".into(),
      ));
    }
    self.operations.retain(|op| {
      names.contains(&op.relative)
        || (op.action == "mkdir"
          && names
            .iter()
            .any(|name| Path::new(name).starts_with(&op.relative)))
    });
    Ok(())
  }

  pub fn file_action(
    left: &Path,
    right: &Path,
    options: FolderOptions,
    relative: &str,
    action: &str,
    cancelled: &AtomicBool,
  ) -> Result<Self, FileError> {
    if !["copy", "move", "trashLeft"].contains(&action) {
      return Err(FileError("Unsupported file action.".into()));
    }
    // Pass `relative` as the collision scope so that a file/directory type
    // mismatch at an unrelated path (e.g. a `.git` file vs directory in a
    // git worktree) does not block a single-item copy of an unrelated entry.
    let mut plan = Self::preview_internal(
      left,
      right,
      options,
      SyncMode::Update,
      cancelled,
      Some(relative),
    )?;
    if !plan.left_snapshot.contains_key(relative) {
      return Err(FileError(
        "Selected source is not in the scanned folder.".into(),
      ));
    }
    if plan.left_snapshot[relative].hash == "excludedFile" {
      return Err(FileError(
        "Selected source is excluded from folder operations.".into(),
      ));
    }
    if is_directory_hash(&plan.left_snapshot[relative].hash) && action != "copy" {
      return Err(FileError("Directory move/delete must use a complete sync preview; direct recursive operations are disabled.".into()));
    }
    if action == "copy" {
      plan.select(&[relative.into()])?;
    } else {
      plan.operations = vec![PlannedOperation {
        relative: relative.into(),
        action: action.into(),
      }];
    }
    Ok(plan)
  }
  pub fn preview(
    left: &Path,
    right: &Path,
    options: FolderOptions,
    mode: SyncMode,
    cancelled: &AtomicBool,
  ) -> Result<Self, FileError> {
    Self::preview_internal(left, right, options, mode, cancelled, None)
  }

  /// Inner implementation shared by [`Self::preview`] and [`Self::file_action`].
  ///
  /// `collision_scope` constrains which file/directory type-mismatch entries
  /// are treated as fatal.  When `None` (full-sync preview), every mismatch
  /// in the tree is an error.  When `Some(scope)`, only mismatches that are
  /// the scope entry itself or an ancestor directory of it are errors; a
  /// mismatch at an unrelated sibling path does not block a single-item copy.
  fn preview_internal(
    left: &Path,
    right: &Path,
    options: FolderOptions,
    mode: SyncMode,
    cancelled: &AtomicBool,
    collision_scope: Option<&str>,
  ) -> Result<Self, FileError> {
    let (left, right) = roots(left, right)?;
    let (a, ae) = scan_for_plan(&left, &options, cancelled, &mut |_| {})?;
    let (b, be) = scan_for_plan(&right, &options, cancelled, &mut |_| {})?;
    if !ae.is_empty() || !be.is_empty() {
      return Err(FileError("Sync is blocked by inaccessible, linked, or unsupported entries. Resolve scan errors first.".into()));
    }
    let mut operations = Vec::new();
    for (name, value) in &a {
      if b
        .get(name)
        .is_some_and(|other| is_directory_hash(&value.hash) != is_directory_hash(&other.hash))
      {
        // When a scope is set (single-item file_action), only collisions
        // on the scope entry itself or one of its ancestor directories
        // are fatal.  A mismatch at an unrelated entry (e.g. a `.git`
        // file vs directory in a git worktree) must not block copying a
        // completely different file.
        let in_scope = collision_scope
          .map(|scope| name == scope || scope.starts_with(&format!("{name}/")))
          .unwrap_or(true);
        if in_scope {
          return Err(FileError(format!(
            "File/directory collision at {name}; no sync was planned."
          )));
        }
        // Out-of-scope collision: skip the entry so it produces no operation.
        continue;
      }
      if excluded_from_plan(name, &a, &b, &options) {
        continue;
      }
      if b.get(name).is_none_or(|other| other.hash != value.hash) {
        operations.push(PlannedOperation {
          relative: name.clone(),
          action: if value.hash == "directory" {
            "mkdir"
          } else if b.contains_key(name) {
            "overwrite"
          } else {
            "copy"
          }
          .into(),
        });
      }
    }
    if matches!(mode, SyncMode::Mirror) {
      let mut orphaned: Vec<_> = b.keys().filter(|name| !a.contains_key(*name)).collect();
      orphaned.sort_by_key(|name| {
        (
          std::cmp::Reverse(name.matches('/').count()),
          is_directory_hash(&b[*name].hash),
        )
      });
      for name in orphaned {
        if !a.contains_key(name) && !excluded_from_plan(name, &a, &b, &options) {
          operations.push(PlannedOperation {
            relative: name.clone(),
            action: if b[name].hash == "directory" {
              "trashDirectory"
            } else {
              "trash"
            }
            .into(),
          });
        }
      }
    }
    Ok(Self {
      left,
      right,
      options,
      left_snapshot: a,
      right_snapshot: b,
      operations,
    })
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
    let (a, ae) = scan_for_plan(&self.left, &self.options, cancelled, &mut |_| {})?;
    let (b, be) = scan_for_plan(&self.right, &self.options, cancelled, &mut |_| {})?;
    if a != self.left_snapshot || b != self.right_snapshot || !ae.is_empty() || !be.is_empty() {
      return Err(FileError(
        "Sync preview is stale. Create a new preview.".into(),
      ));
    }
    let mut results = Vec::new();
    for operation in self.operations {
      if cancelled.load(Ordering::Relaxed) {
        results.push((
          operation.relative,
          Err("Cancelled before execution.".into()),
        ));
        continue;
      }
      let source = self.left.join(&operation.relative);
      let destination = self.right.join(&operation.relative);
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
        if operation.action == "trashLeft" {
          if snapshot(&source, cancelled)? != self.left_snapshot[&operation.relative] {
            return Err(FileError("Source changed after preview.".into()));
          }
          recycle(&source)?;
          return Ok(());
        }
        if let Some(expected) = self.right_snapshot.get(&operation.relative) {
          if snapshot(&destination, cancelled)? != *expected {
            return Err(FileError("Destination changed after preview.".into()));
          }
        } else if destination.exists() {
          return Err(FileError("Destination was created after preview.".into()));
        }
        if operation.action == "trash" {
          checked_path(&destination, false)?;
          recycle(&destination)?;
          return Ok(());
        }
        if snapshot(&source, cancelled)? != self.left_snapshot[&operation.relative] {
          return Err(FileError("Source changed after preview.".into()));
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
        if hash.finalize().to_hex().as_str() != self.left_snapshot[&operation.relative].hash {
          return Err(FileError("Source changed during copy.".into()));
        }
        temp.as_file().sync_all()?;
        checked_path(&destination, true)?;
        if let Some(expected) = self.right_snapshot.get(&operation.relative) {
          if snapshot(&destination, cancelled)? != *expected {
            return Err(FileError("Destination changed during copy.".into()));
          }
          let permissions = fs::metadata(&destination)?.permissions();
          if permissions.readonly() {
            return Err(FileError("Destination is read-only.".into()));
          }
          temp.as_file().set_permissions(permissions)?;
          temp
            .persist(&destination)
            .map_err(|e| FileError(e.error.to_string()))?;
        } else {
          temp
            .as_file()
            .set_permissions(fs::metadata(&source)?.permissions())?;
          temp
            .persist_noclobber(&destination)
            .map_err(|e| FileError(e.error.to_string()))?;
        }
        if operation.action == "move" {
          if snapshot(&source, cancelled)? != self.left_snapshot[&operation.relative] {
            return Err(FileError(
              "Copied destination, but source changed; move deletion was not performed.".into(),
            ));
          }
          recycle(&source).map_err(|e| {
            FileError(format!(
              "Destination copied, but source recycling failed: {e}"
            ))
          })?;
        }
        Ok(())
      })()
      .map_err(|e| e.to_string());
      results.push((operation.relative, result));
      progress(results.len());
    }
    Ok(results)
  }
}

fn excluded_from_plan(
  name: &str,
  left: &BTreeMap<String, Snapshot>,
  right: &BTreeMap<String, Snapshot>,
  options: &FolderOptions,
) -> bool {
  if left
    .get(name)
    .is_some_and(|entry| entry.hash == "excludedDirectory")
    || right
      .get(name)
      .is_some_and(|entry| entry.hash == "excludedDirectory")
  {
    return true;
  }
  let is_directory = |path: &str| {
    left
      .get(path)
      .is_some_and(|entry| is_directory_hash(&entry.hash))
      || right
        .get(path)
        .is_some_and(|entry| is_directory_hash(&entry.hash))
  };
  if options.exclude_directories.iter().any(|excluded| {
    (name == excluded
      || name
        .strip_prefix(excluded)
        .is_some_and(|suffix| suffix.starts_with('/')))
      && is_directory(excluded)
  }) {
    return true;
  }
  options.exclude_files.iter().any(|excluded| {
    name == excluded
      && (left
        .get(name)
        .is_some_and(|entry| entry.hash == "excludedFile")
        || right
          .get(name)
          .is_some_and(|entry| entry.hash == "excludedFile"))
  })
}

#[cfg(test)]
mod tests {
  use super::*;
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
    assert!(plan.execute(&flag, |_| {}).is_err());
    let plan = Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    assert_eq!(plan.operations.len(), 1);
    assert!(plan.execute(&flag, |_| {}).unwrap()[0].1.is_ok());
    assert_eq!(fs::read(b.join("one")).unwrap(), b"changed");
    assert_eq!(
      scan_pair(&a, &b, &FolderOptions::default(), &flag, |_| {}).unwrap()[0].status,
      "same"
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
    assert_eq!(rows[0].status, "leftOnly");
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

    fs::write(left.join("excluded.txt"), b"left").unwrap();
    fs::write(right.join("excluded.txt"), b"right").unwrap();
    let options = FolderOptions {
      exclude_files: vec!["excluded.txt".into()],
      ..FolderOptions::default()
    };
    assert!(
      Plan::file_action(&left, &right, options, "excluded.txt", "trashLeft", &flag,).is_err()
    );
  }

  #[test]
  fn file_action_copy_ignores_unrelated_type_collisions() {
    // Regression: when one root has `.git` as a directory (main clone) and the
    // other has `.git` as a plain file (git worktree pointer), a full-sync
    // preview correctly errors, but a single-item file_action copy of an
    // unrelated path must not be blocked by that mismatch.
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("src");
    let dst = root.path().join("dst");
    fs::create_dir(&src).unwrap();
    fs::create_dir(&dst).unwrap();
    // `.git` is a directory on the source, a plain file on the destination
    // (simulating a git worktree).
    fs::create_dir(src.join(".git")).unwrap();
    fs::write(dst.join(".git"), b"gitdir: /path/to/.git").unwrap();
    // The target file lives in a subfolder present only on the source side.
    fs::create_dir(src.join("support")).unwrap();
    fs::write(src.join("support/README.md"), b"readme").unwrap();
    let flag = AtomicBool::new(false);
    // Full sync preview must still report the collision.
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
    // Single-item file_action must succeed; the .git collision is out of scope.
    let plan = Plan::file_action(
      &src,
      &dst,
      FolderOptions::default(),
      "support/README.md",
      "copy",
      &flag,
    )
    .expect("file_action copy must not fail due to unrelated .git collision");
    assert!(
      plan
        .operations
        .iter()
        .any(|op| op.relative == "support/README.md"),
      "plan must include the requested file"
    );
    let results = plan.execute(&flag, |_| {}).unwrap();
    assert!(results.iter().all(|(_, r)| r.is_ok()));
    assert_eq!(
      fs::read_to_string(dst.join("support/README.md")).unwrap(),
      "readme"
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
    let collision = rows.iter().find(|row| row.relative == "collision").unwrap();
    assert_eq!(collision.status, "typeMismatch");
    assert_eq!(collision.left_kind, Some(FolderEntryKind::Directory));
    assert_eq!(collision.right_kind, Some(FolderEntryKind::File));
    assert!(collision.error.is_none());
    let reverse = rows.iter().find(|row| row.relative == "reverse").unwrap();
    assert_eq!(reverse.status, "typeMismatch");
    assert_eq!(reverse.left_kind, Some(FolderEntryKind::File));
    assert_eq!(reverse.right_kind, Some(FolderEntryKind::Directory));
    assert!(reverse.error.is_none());
    assert!(rows
      .iter()
      .any(|row| { row.relative == "reverse/child" && row.status == "rightOnly" }));
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
    assert!(plan.execute(&flag, |_| {}).is_err());
    assert_eq!(fs::read_to_string(b.join("file")).unwrap(), "old");
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
    let mut plan =
      Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    assert!(plan.select(&["../escape".into()]).is_err());
    plan.select(&["two".into()]).unwrap();
    assert_eq!(plan.operations.len(), 1);
    assert!(plan.execute(&flag, |_| {}).unwrap()[0].1.is_ok());
    assert!(!b.join("one").exists());
    fs::create_dir(a.join("nested")).unwrap();
    fs::write(a.join("nested").join("file"), "nested").unwrap();
    let mut plan =
      Plan::preview(&a, &b, FolderOptions::default(), SyncMode::Update, &flag).unwrap();
    plan.select(&["nested/file".into()]).unwrap();
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
}
