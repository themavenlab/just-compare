//! Explicit, single-use local action previews. Copies replace existing names only
//! with explicit overwrite intent and a matching destination content snapshot.
//!
//! Directory copy/move/recycle previews include their entire subtree. Attribute and
//! timestamp changes affect selected entries only. Checks are bounded and reject
//! links, but are not a race-free boundary against concurrent filesystem changes.
//! Basic permissions are preserved on copy; timestamps, ACLs and extended metadata
//! are not. Direct-target copy/move previews include missing parent directories,
//! which are created individually and retained if a later effect fails. Moves
//! copy first, then recycle, and are not transactional.
//! Rename checks for collisions before calling the portable rename API; concurrent
//! namespace changes can still race that check on platforms without no-replace
//! directory rename. Read-only/touch change an inode, including its hard-link aliases.
//! Touch accepts nonnegative Unix milliseconds and regular files only.
//! Overwrite merges preserve destination-only entries and existing destination
//! permissions. Previews expose every affected entry for all actions. Source and
//! destination trees share the 10000-entry budget; each file is limited to 100 MiB.
//! CopyTo/MoveTo accept exact file or directory targets. Non-nested batches retain
//! independent operation outcomes, reject overlapping operation footprints, and
//! share the same entry budget; they do not promise transactional execution.

use crate::{checked_path, display_path, FileError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, FileTimes, Metadata};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;
use tempfile::NamedTempFile;

const MAX_ENTRIES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum FileActionRequest {
  Batch {
    requests: Vec<FileActionRequest>,
  },
  Copy {
    sources: Vec<PathBuf>,
    destination: PathBuf,
    #[serde(default)]
    overwrite: bool,
  },
  Move {
    sources: Vec<PathBuf>,
    destination: PathBuf,
    #[serde(default)]
    overwrite: bool,
  },
  CopyTo {
    source: PathBuf,
    destination: PathBuf,
    #[serde(default)]
    overwrite: bool,
  },
  MoveTo {
    source: PathBuf,
    destination: PathBuf,
    #[serde(default)]
    overwrite: bool,
  },
  Recycle {
    sources: Vec<PathBuf>,
  },
  Rename {
    source: PathBuf,
    name: String,
  },
  CreateDirectory {
    parent: PathBuf,
    name: String,
  },
  SetReadOnly {
    sources: Vec<PathBuf>,
    readonly: bool,
  },
  Touch {
    sources: Vec<PathBuf>,
    modified_ms: u64,
  },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase"
)]
pub enum FileAction {
  Copy,
  Move,
  Recycle,
  Rename,
  CreateDirectory,
  SetReadOnly { readonly: bool },
  Touch { modified_ms: u64 },
}

/// A concrete selected-root operation; `entry_count` equals `entries.len()`.
/// Snapshots may cover more entries than the action changes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionOperation {
  pub action: FileAction,
  pub source: Option<PathBuf>,
  pub destination: Option<PathBuf>,
  pub entry_count: usize,
  pub entries: Vec<FileActionEntry>,
}

/// Every affected entry and concrete target. Rename maps the entire subtree;
/// recycle lists the affected original paths, not an invented OS trash location.
/// In-place actions and recycle use the original path for both fields. Creation
/// uses the prospective path for both fields because no source exists. `action`
/// distinguishes these cases. Destination-only merge children are never removed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionEntry {
  pub action: FileAction,
  pub source: Option<PathBuf>,
  pub destination: Option<PathBuf>,
  pub directory: bool,
  pub replaces_existing: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", content = "message", rename_all = "camelCase")]
pub enum FileActionStatus {
  Completed,
  Failed(String),
  Cancelled,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionOutcome {
  pub operation: FileActionOperation,
  pub result: FileActionStatus,
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
  directory: bool,
  len: u64,
  modified: SystemTime,
  readonly: bool,
  #[cfg(unix)]
  mode: u32,
  hash: Option<blake3::Hash>,
}

type Tree = BTreeMap<PathBuf, Snapshot>;

struct ApprovedOperation {
  operation: FileActionOperation,
  source: Tree,
  destination: Tree,
  destination_parent: Option<(PathBuf, ParentSnapshot)>,
  missing_ancestors: Vec<PathBuf>,
}

#[derive(PartialEq, Eq)]
struct ParentSnapshot {
  created: Option<SystemTime>,
  readonly: bool,
  #[cfg(unix)]
  identity: (u64, u64, u32),
}

fn parent_snapshot(path: &Path) -> Result<ParentSnapshot, FileError> {
  let metadata = fs::metadata(path)?;
  if !metadata.is_dir() {
    return Err(failure("Destination parent must remain a directory."));
  }
  Ok(ParentSnapshot {
    created: metadata.created().ok(),
    readonly: metadata.permissions().readonly(),
    #[cfg(unix)]
    identity: {
      use std::os::unix::fs::{MetadataExt, PermissionsExt};
      (
        metadata.dev(),
        metadata.ino(),
        metadata.permissions().mode(),
      )
    },
  })
}

/// Not deserializable or cloneable: adapters must retain this object behind an
/// opaque, single-use handle. The public preview is never execution input.
pub struct FileActionPlan {
  operations: Vec<FileActionOperation>,
  approved: Vec<ApprovedOperation>,
}

fn failure(message: &str) -> FileError {
  FileError(message.into())
}

fn check_cancel(cancelled: &AtomicBool) -> Result<(), FileError> {
  if cancelled.load(Ordering::Relaxed) {
    Err(failure("File action cancelled."))
  } else {
    Ok(())
  }
}

fn safe_path(path: &Path, missing: bool) -> Result<PathBuf, FileError> {
  validate_path_syntax(path)?;
  checked_path(path, missing)
}

fn validate_path_syntax(path: &Path) -> Result<(), FileError> {
  if path.to_str().is_none() || path.components().any(|c| matches!(c, Component::CurDir)) {
    return Err(failure("Unicode paths without traversal are required."));
  }
  if !path.is_absolute()
    || path
      .components()
      .any(|component| matches!(component, Component::ParentDir))
  {
    return Err(failure(
      "An absolute path without parent traversal is required.",
    ));
  }
  Ok(())
}

/// Returns the nearest existing directory ancestor and missing ancestors,
/// ordered shallowest-first and rooted at the canonical ancestor path.
fn missing_ancestors(target: &Path) -> Result<(PathBuf, Vec<PathBuf>), FileError> {
  validate_path_syntax(target)?;
  let mut cursor = target
    .parent()
    .ok_or_else(|| failure("Destination has no parent directory."))?;
  let mut missing = Vec::new();
  loop {
    match fs::symlink_metadata(cursor) {
      Ok(metadata) => {
        if !metadata.is_dir() {
          return Err(failure(&format!(
            "Cannot create a folder because \"{}\" is not a directory.",
            display_path(cursor)
          )));
        }
        let canonical = checked_path(cursor, false)?;
        let missing = missing
          .iter()
          .rev()
          .map(|path: &PathBuf| {
            path
              .strip_prefix(cursor)
              .map(|relative| canonical.join(relative))
              .map_err(|_| failure("Invalid missing destination ancestor."))
          })
          .collect::<Result<Vec<_>, _>>()?;
        return Ok((canonical, missing));
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        if missing.len() == 64 {
          return Err(failure(
            "Destination has more than 64 missing parent folders.",
          ));
        }
        missing.push(cursor.to_path_buf());
        cursor = cursor
          .parent()
          .ok_or_else(|| failure("Destination has no existing ancestor."))?;
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
        cursor = cursor
          .parent()
          .ok_or_else(|| FileError(error.to_string()))?;
      }
      Err(error) => return Err(error.into()),
    }
  }
}

fn leaf_name(name: &str) -> Result<&Path, FileError> {
  let path = Path::new(name);
  if name.is_empty()
    || name.contains(['/', '\\', ':'])
    || name.ends_with(['.', ' '])
    || name.chars().any(|c| c.is_control())
    || path.components().count() != 1
    || !matches!(path.components().next(), Some(Component::Normal(_)))
  {
    return Err(failure(
      "A single ordinary filename without traversal is required.",
    ));
  }
  Ok(path)
}

fn overlaps(a: &Path, b: &Path) -> bool {
  a.starts_with(b) || b.starts_with(a)
}

fn tree_path(root: &Path, relative: &Path) -> PathBuf {
  if relative.as_os_str().is_empty() {
    root.to_path_buf()
  } else {
    root.join(relative)
  }
}

fn metadata_snapshot(
  metadata: &Metadata,
  hash: Option<blake3::Hash>,
) -> Result<Snapshot, FileError> {
  Ok(Snapshot {
    directory: metadata.is_dir(),
    len: metadata.len(),
    modified: metadata.modified()?,
    readonly: metadata.permissions().readonly(),
    #[cfg(unix)]
    mode: {
      use std::os::unix::fs::PermissionsExt;
      metadata.permissions().mode()
    },
    hash,
  })
}

fn entry_snapshot(path: &Path, cancelled: &AtomicBool) -> Result<Snapshot, FileError> {
  check_cancel(cancelled)?;
  safe_path(path, false)?;
  let metadata = fs::symlink_metadata(path)?;
  if !metadata.is_file() && !metadata.is_dir() {
    return Err(failure("Only regular files and directories are supported."));
  }
  let before = metadata_snapshot(&metadata, None)?;
  let hash = if metadata.is_file() {
    if metadata.len() > MAX_FILE_BYTES {
      return Err(failure("File exceeds the 100 MiB action limit."));
    }
    let mut reader = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0; 64 * 1024];
    let mut total = 0;
    loop {
      check_cancel(cancelled)?;
      let n = reader.read(&mut buffer)?;
      if n == 0 {
        break;
      }
      total += n as u64;
      if total > MAX_FILE_BYTES {
        return Err(failure("File exceeds the 100 MiB action limit."));
      }
      hasher.update(&buffer[..n]);
    }
    Some(hasher.finalize())
  } else {
    None
  };
  safe_path(path, false)?;
  if before != metadata_snapshot(&fs::symlink_metadata(path)?, None)? {
    return Err(failure("Entry changed during preview. Preview again."));
  }
  Ok(Snapshot { hash, ..before })
}

fn snapshot_tree(
  root: &Path,
  cancelled: &AtomicBool,
  count: &mut usize,
) -> Result<Tree, FileError> {
  let mut tree = BTreeMap::new();
  let mut pending = vec![PathBuf::new()];
  while let Some(relative) = pending.pop() {
    check_cancel(cancelled)?;
    *count += 1;
    if *count > MAX_ENTRIES {
      return Err(failure("Selection exceeds the 10000-entry action limit."));
    }
    let path = tree_path(root, &relative);
    let snapshot = entry_snapshot(&path, cancelled)?;
    if snapshot.directory {
      // Bound the queue as well as the completed traversal.
      for child in fs::read_dir(&path)? {
        check_cancel(cancelled)?;
        let child = child?;
        if child.file_name().to_str().is_none() {
          return Err(failure("Non-Unicode names are unsupported."));
        }
        if tree.len() + pending.len() + 1 >= MAX_ENTRIES {
          return Err(failure("Selection exceeds the 10000-entry action limit."));
        }
        pending.push(relative.join(child.file_name()));
      }
    }
    tree.insert(relative, snapshot);
  }
  Ok(tree)
}

fn selected_paths(sources: Vec<PathBuf>) -> Result<Vec<PathBuf>, FileError> {
  if sources.is_empty() {
    return Err(failure("Select at least one entry."));
  }
  if sources.len() > MAX_ENTRIES {
    return Err(failure("Selection exceeds the 10000-entry action limit."));
  }
  let mut paths = Vec::new();
  for source in sources {
    let source = safe_path(&source, false)?;
    if source.parent().is_none() || source.file_name().is_none() {
      return Err(failure("Filesystem roots cannot be action sources."));
    }
    paths.push(source);
  }
  paths.sort();
  paths.dedup();
  let mut roots: Vec<PathBuf> = Vec::new();
  for path in paths {
    if !roots.iter().any(|root| path.starts_with(root)) {
      roots.push(path);
    }
  }
  Ok(roots)
}

fn absent_destination(path: &Path) -> Result<PathBuf, FileError> {
  let path = safe_path(path, true)?;
  match fs::symlink_metadata(&path) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
    Ok(_) => Err(failure(
      "Destination already exists; actions never overwrite entries.",
    )),
    Err(e) => Err(e.into()),
  }
}

impl FileActionPlan {
  pub fn preview(request: FileActionRequest, cancelled: &AtomicBool) -> Result<Self, FileError> {
    check_cancel(cancelled)?;
    let request = match request {
      FileActionRequest::Batch { requests } => {
        if requests.is_empty() || requests.len() > MAX_ENTRIES {
          return Err(failure("Batch requires 1 to 10000 non-nested requests."));
        }
        let mut approved: Vec<ApprovedOperation> = Vec::new();
        let mut count = 0;
        for request in requests {
          check_cancel(cancelled)?;
          if matches!(request, FileActionRequest::Batch { .. }) {
            return Err(failure("Nested action batches are unsupported."));
          }
          let plan = Self::preview(request, cancelled)?;
          for next in plan.approved {
            count +=
              next.source.len().max(1) + next.destination.len() + next.missing_ancestors.len();
            if count > MAX_ENTRIES {
              return Err(failure("Batch exceeds the 10000-entry action limit."));
            }
            let next_paths: Vec<_> = [
              next.operation.source.as_ref(),
              next.operation.destination.as_ref(),
            ]
            .into_iter()
            .flatten()
            .collect();
            if approved.iter().any(|previous| {
              [
                previous.operation.source.as_ref(),
                previous.operation.destination.as_ref(),
              ]
              .into_iter()
              .flatten()
              .any(|path| next_paths.iter().any(|next| overlaps(path, next)))
            }) {
              return Err(failure(
                "Batch operations have overlapping sources or destinations.",
              ));
            }
            approved.push(next);
          }
        }
        return Ok(Self {
          operations: approved.iter().map(|a| a.operation.clone()).collect(),
          approved,
        });
      }
      request => request,
    };
    let mut overwrite = false;
    let mut direct_target = false;
    let (action, sources, destination) = match request {
      FileActionRequest::Copy {
        sources,
        destination,
        overwrite: allow,
      } => {
        overwrite = allow;
        (
          FileAction::Copy,
          selected_paths(sources)?,
          Some(safe_path(&destination, false)?),
        )
      }
      FileActionRequest::Move {
        sources,
        destination,
        overwrite: allow,
      } => {
        overwrite = allow;
        (
          FileAction::Move,
          selected_paths(sources)?,
          Some(safe_path(&destination, false)?),
        )
      }
      FileActionRequest::CopyTo {
        source,
        destination,
        overwrite: allow,
      } => {
        overwrite = allow;
        direct_target = true;
        validate_path_syntax(&destination)?;
        let sources = selected_paths(vec![source])?;
        (FileAction::Copy, sources, Some(destination))
      }
      FileActionRequest::MoveTo {
        source,
        destination,
        overwrite: allow,
      } => {
        overwrite = allow;
        direct_target = true;
        validate_path_syntax(&destination)?;
        (
          FileAction::Move,
          selected_paths(vec![source])?,
          Some(destination),
        )
      }
      FileActionRequest::Batch { .. } => unreachable!(),
      FileActionRequest::Recycle { sources } => {
        (FileAction::Recycle, selected_paths(sources)?, None)
      }
      FileActionRequest::Rename { source, name } => {
        let sources = selected_paths(vec![source])?;
        let destination = sources[0].parent().unwrap().join(leaf_name(&name)?);
        (FileAction::Rename, sources, Some(destination))
      }
      FileActionRequest::CreateDirectory { parent, name } => {
        let parent = safe_path(&parent, false)?;
        if !parent.is_dir() {
          return Err(failure("Destination parent must be a directory."));
        }
        let destination = parent.join(leaf_name(&name)?);
        (FileAction::CreateDirectory, Vec::new(), Some(destination))
      }
      FileActionRequest::SetReadOnly { sources, readonly } => (
        FileAction::SetReadOnly { readonly },
        selected_paths(sources)?,
        None,
      ),
      FileActionRequest::Touch {
        sources,
        modified_ms,
      } => {
        if modified_ms > 8_640_000_000_000_000
          || SystemTime::UNIX_EPOCH
            .checked_add(std::time::Duration::from_millis(modified_ms))
            .is_none()
        {
          return Err(failure(
            "Timestamp is outside the supported Unix millisecond range.",
          ));
        }
        (
          FileAction::Touch { modified_ms },
          selected_paths(sources)?,
          None,
        )
      }
    };
    if matches!(action, FileAction::Copy | FileAction::Move)
      && !direct_target
      && !destination.as_ref().unwrap().is_dir()
    {
      return Err(failure(
        "Copy/move destination must be an existing directory.",
      ));
    }
    let mut approved = Vec::new();
    let mut count = 0;
    let items = if sources.is_empty() {
      vec![None]
    } else {
      sources.iter().map(Some).collect()
    };
    for source in items {
      check_cancel(cancelled)?;
      let mut missing_directories = Vec::new();
      let mut existing_destination_parent = None;
      let target = match &action {
        FileAction::Copy | FileAction::Move => {
          let parent = destination.as_ref().unwrap();
          let source = source.unwrap();
          if !direct_target && parent.starts_with(source) {
            return Err(failure(
              "Destination directory cannot be within the source.",
            ));
          }
          let target = if direct_target {
            parent.clone()
          } else {
            parent.join(source.file_name().unwrap())
          };
          if direct_target {
            let (existing_parent, missing) = missing_ancestors(&target)?;
            if missing.is_empty() {
              Some(if overwrite {
                safe_path(&target, true)?
              } else {
                absent_destination(&target)?
              })
            } else {
              let leaf = target
                .file_name()
                .ok_or_else(|| failure("Destination has no filename."))?;
              let target = missing.last().unwrap().join(leaf);
              existing_destination_parent = Some(existing_parent);
              missing_directories = missing;
              Some(target)
            }
          } else {
            Some(if overwrite {
              safe_path(&target, true)?
            } else {
              absent_destination(&target)?
            })
          }
        }
        FileAction::Rename | FileAction::CreateDirectory => {
          Some(absent_destination(destination.as_ref().unwrap())?)
        }
        _ => None,
      };
      if direct_target
        && target
          .as_ref()
          .is_some_and(|target| target.starts_with(source.unwrap()))
      {
        return Err(failure(
          "Destination directory cannot be within the source.",
        ));
      }
      if let Some(target) = &target {
        if sources.iter().any(|s| overlaps(s, target))
          || approved.iter().any(|a: &ApprovedOperation| {
            a.operation
              .destination
              .as_ref()
              .is_some_and(|d| overlaps(d, target))
          })
        {
          return Err(failure(
            "Selected sources and destinations overlap or collide.",
          ));
        }
      }
      let tree = match source {
        Some(source) => snapshot_tree(source, cancelled, &mut count)?,
        None => BTreeMap::new(),
      };
      let destination_tree = if matches!(action, FileAction::Copy | FileAction::Move)
        && target.as_ref().unwrap().exists()
      {
        snapshot_tree(target.as_ref().unwrap(), cancelled, &mut count)?
      } else {
        BTreeMap::new()
      };
      for (relative, from) in &tree {
        if let Some(to) = destination_tree.get(relative) {
          if from.directory != to.directory {
            return Err(failure("File/directory collisions cannot be merged."));
          }
          if to.readonly {
            return Err(failure(
              "Read-only destinations cannot be overwritten or merged.",
            ));
          }
        }
      }
      let mut entries: Vec<_> = match &action {
        FileAction::Copy | FileAction::Move | FileAction::Rename => tree
          .iter()
          .map(|(relative, snapshot)| FileActionEntry {
            action: action.clone(),
            source: Some(tree_path(source.unwrap(), relative)),
            destination: Some(tree_path(target.as_ref().unwrap(), relative)),
            directory: snapshot.directory,
            replaces_existing: destination_tree.contains_key(relative),
          })
          .collect(),
        FileAction::Recycle => tree
          .iter()
          .map(|(relative, snapshot)| {
            let path = tree_path(source.unwrap(), relative);
            FileActionEntry {
              action: action.clone(),
              source: Some(path.clone()),
              destination: Some(path),
              directory: snapshot.directory,
              replaces_existing: false,
            }
          })
          .collect(),
        FileAction::CreateDirectory => {
          let path = target.as_ref().unwrap();
          vec![FileActionEntry {
            action: action.clone(),
            source: Some(path.clone()),
            destination: Some(path.clone()),
            directory: true,
            replaces_existing: false,
          }]
        }
        FileAction::SetReadOnly { .. } | FileAction::Touch { .. } => {
          let path = source.unwrap();
          vec![FileActionEntry {
            action: action.clone(),
            source: Some(path.clone()),
            destination: Some(path.clone()),
            directory: tree[Path::new("")].directory,
            replaces_existing: false,
          }]
        }
      };
      for ancestor in missing_directories.iter().rev() {
        entries.insert(
          0,
          FileActionEntry {
            action: FileAction::CreateDirectory,
            source: None,
            destination: Some(ancestor.clone()),
            directory: true,
            replaces_existing: false,
          },
        );
      }
      if matches!(action, FileAction::Touch { .. })
        && tree.get(Path::new("")).is_some_and(|s| s.directory)
      {
        return Err(failure("Touch supports regular files only."));
      }
      let destination_parent = target
        .as_ref()
        .map(|p| {
          let parent = existing_destination_parent
            .clone()
            .unwrap_or_else(|| p.parent().unwrap().to_path_buf());
          let snapshot = parent_snapshot(&parent)?;
          Ok::<_, FileError>((parent, snapshot))
        })
        .transpose()?;
      count += missing_directories.len();
      if count > MAX_ENTRIES {
        return Err(failure("File action exceeds the 10000-entry limit."));
      }
      approved.push(ApprovedOperation {
        operation: FileActionOperation {
          action: action.clone(),
          source: source.cloned(),
          destination: target,
          entry_count: entries.len(),
          entries,
        },
        source: tree,
        destination: destination_tree,
        destination_parent,
        missing_ancestors: missing_directories,
      });
    }
    Ok(Self {
      operations: approved.iter().map(|a| a.operation.clone()).collect(),
      approved,
    })
  }

  pub fn operations(&self) -> &[FileActionOperation] {
    &self.operations
  }

  /// Consumes approved state. Cancellation reports every unstarted operation;
  /// completed effects (including partial directory copies) are not rolled back.
  pub fn execute(
    self,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(usize, usize),
  ) -> Vec<FileActionOutcome> {
    self.execute_with(cancelled, &mut progress, |path| {
      trash::delete(path).map_err(|e| FileError(e.to_string()))
    })
  }

  fn execute_with(
    self,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(usize, usize),
    mut recycle: impl FnMut(&Path) -> Result<(), FileError>,
  ) -> Vec<FileActionOutcome> {
    let total = self.approved.len();
    let mut results = Vec::with_capacity(total);
    for (index, approved) in self.approved.into_iter().enumerate() {
      let result = if cancelled.load(Ordering::Relaxed) {
        FileActionStatus::Cancelled
      } else {
        match execute_operation(&approved, cancelled, &mut recycle) {
          Ok(()) => FileActionStatus::Completed,
          Err(error) => FileActionStatus::Failed(format!(
            "Operation failed; any completed effects are retained: {error}"
          )),
        }
      };
      results.push(FileActionOutcome {
        operation: approved.operation,
        result,
      });
      progress(index + 1, total);
    }
    results
  }
}

fn revalidate(approved: &ApprovedOperation, cancelled: &AtomicBool) -> Result<(), FileError> {
  check_cancel(cancelled)?;
  if let Some(source) = &approved.operation.source {
    if safe_path(source, false)? != *source
      || snapshot_tree(source, cancelled, &mut 0)? != approved.source
    {
      return Err(failure("Source changed since preview. Preview again."));
    }
  }
  if let Some(destination) = &approved.operation.destination {
    let (parent, snapshot) = approved.destination_parent.as_ref().unwrap();
    let target_matches = if !approved.missing_ancestors.is_empty() {
      for ancestor in &approved.missing_ancestors {
        match fs::symlink_metadata(ancestor) {
          Ok(metadata) if metadata.is_dir() => {
            if checked_path(ancestor, false)? != *ancestor {
              return Err(failure(
                "Destination ancestor changed since preview. Preview again.",
              ));
            }
          }
          Ok(_) => {
            return Err(failure(
              "A missing destination folder is now occupied by a non-folder.",
            ));
          }
          Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
          Err(error) => return Err(error.into()),
        }
      }
      match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Ok(_) => false,
        Err(error) => return Err(error.into()),
      }
    } else if approved.destination.is_empty() {
      absent_destination(destination)? == *destination
    } else {
      safe_path(destination, false)? == *destination
        && snapshot_tree(destination, cancelled, &mut 0)? == approved.destination
    };
    if !target_matches
      || safe_path(parent, false)? != *parent
      || parent_snapshot(parent)? != *snapshot
    {
      return Err(failure("Destination changed since preview. Preview again."));
    }
  }
  Ok(())
}

fn copy_tree(
  source: &Path,
  destination: &Path,
  tree: &Tree,
  destination_tree: &Tree,
  cancelled: &AtomicBool,
) -> Result<(), FileError> {
  for (relative, expected) in tree {
    check_cancel(cancelled)?;
    let from = tree_path(source, relative);
    let to = tree_path(destination, relative);
    if entry_snapshot(&from, cancelled)? != *expected {
      return Err(failure(
        "Source changed during copy. Partial destination retained.",
      ));
    }
    let existing = destination_tree.get(relative);
    if let Some(existing) = existing {
      if entry_snapshot(&to, cancelled)? != *existing {
        return Err(failure("Destination changed during copy. Preview again."));
      }
    } else {
      absent_destination(&to)?;
    }
    if expected.directory {
      if existing.is_none() {
        fs::create_dir(&to)?;
      }
    } else {
      let mut input = File::open(&from)?;
      let mut output = NamedTempFile::new_in(to.parent().unwrap())?;
      let mut hasher = blake3::Hasher::new();
      let mut buffer = [0; 64 * 1024];
      let mut length = 0;
      loop {
        check_cancel(cancelled)?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
          break;
        }
        length += n as u64;
        if length > MAX_FILE_BYTES || length > expected.len {
          return Err(failure(
            "Source changed during copy. Partial destination retained.",
          ));
        }
        hasher.update(&buffer[..n]);
        output.write_all(&buffer[..n])?;
      }
      if Some(hasher.finalize()) != expected.hash || length != expected.len {
        return Err(failure(
          "Source changed during copy. Partial destination retained.",
        ));
      }
      let permissions = fs::metadata(if existing.is_some() { &to } else { &from })?.permissions();
      output.as_file().sync_all()?;
      check_cancel(cancelled)?;
      if entry_snapshot(&from, cancelled)? != *expected {
        return Err(failure(
          "Source changed during copy. Partial destination retained.",
        ));
      }
      let persisted = if let Some(existing) = existing {
        if entry_snapshot(&to, cancelled)? != *existing {
          return Err(failure("Destination changed during copy. Preview again."));
        }
        output.persist(&to)
      } else {
        absent_destination(&to)?;
        output.persist_noclobber(&to)
      }
      .map_err(|e| FileError(e.to_string()))?;
      // Keep the owned temporary writable until published, so cancellation
      // cannot strand a read-only temporary on Windows.
      persisted.set_permissions(permissions)?;
      persisted.sync_all()?;
    }
  }
  // Delay directory permissions until children exist, deepest first.
  for (relative, snapshot) in tree.iter().rev() {
    if snapshot.directory && !destination_tree.contains_key(relative) {
      check_cancel(cancelled)?;
      let from = tree_path(source, relative);
      let to = tree_path(destination, relative);
      safe_path(&from, false)?;
      safe_path(&to, false)?;
      fs::set_permissions(to, fs::metadata(from)?.permissions())?;
    }
  }
  Ok(())
}

fn execute_operation(
  approved: &ApprovedOperation,
  cancelled: &AtomicBool,
  recycle: &mut impl FnMut(&Path) -> Result<(), FileError>,
) -> Result<(), FileError> {
  revalidate(approved, cancelled)?;
  check_cancel(cancelled)?;
  let operation = &approved.operation;
  let source = operation.source.as_deref();
  let destination = operation.destination.as_deref();
  if matches!(operation.action, FileAction::Copy | FileAction::Move) {
    for directory in &approved.missing_ancestors {
      check_cancel(cancelled)?;
      match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
          match fs::create_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
              let metadata = fs::symlink_metadata(directory)?;
              if !metadata.is_dir() || checked_path(directory, false)? != *directory {
                return Err(failure(
                  "A missing destination folder is now occupied by a non-folder.",
                ));
              }
            }
            Err(error) => return Err(error.into()),
          }
          checked_path(directory, false)?;
        }
        Ok(metadata) if metadata.is_dir() => {
          if checked_path(directory, false)? != *directory {
            return Err(failure(
              "Destination ancestor changed since preview. Preview again.",
            ));
          }
        }
        Ok(_) => {
          return Err(failure(
            "A missing destination folder is now occupied by a non-folder.",
          ));
        }
        Err(error) => return Err(error.into()),
      }
    }
  }
  match &operation.action {
    FileAction::Copy | FileAction::Move => {
      copy_tree(
        source.unwrap(),
        destination.unwrap(),
        &approved.source,
        &approved.destination,
        cancelled,
      )?;
      if operation.action == FileAction::Move {
        // Copy completion does not authorize recycling a newly changed source.
        if snapshot_tree(source.unwrap(), cancelled, &mut 0)? != approved.source {
          return Err(failure(
            "Copy completed but source changed; source was not recycled.",
          ));
        }
        check_cancel(cancelled)?;
        recycle(source.unwrap())
          .map_err(|e| FileError(format!("Copy completed but source recycling failed: {e}")))?;
      }
    }
    FileAction::Recycle => recycle(source.unwrap())?,
    FileAction::Rename => {
      // std has no portable directory rename-no-replace primitive. Recheck
      // immediately before rename; concurrent namespace mutation is unsupported.
      absent_destination(destination.unwrap())?;
      fs::rename(source.unwrap(), destination.unwrap())?;
    }
    FileAction::CreateDirectory => fs::create_dir(destination.unwrap())?,
    FileAction::SetReadOnly { readonly } => {
      let source = source.unwrap();
      let mut permissions = fs::metadata(source)?.permissions();
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        let mode = permissions.mode();
        permissions.set_mode(if *readonly {
          mode & !0o222
        } else {
          mode | 0o200
        });
      }
      #[cfg(not(unix))]
      permissions.set_readonly(*readonly);
      fs::set_permissions(source, permissions)?;
    }
    FileAction::Touch { modified_ms } => {
      let source = source.unwrap();
      if fs::metadata(source)?.permissions().readonly() {
        return Err(failure("Read-only files cannot be touched."));
      }
      File::options().write(true).open(source)?.set_times(
        FileTimes::new()
          .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(*modified_ms)),
      )?;
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::{tempdir, TempDir};

  fn fixture() -> (TempDir, PathBuf, PathBuf) {
    let temp = tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&destination).unwrap();
    fs::write(source.join("a.txt"), b"alpha").unwrap();
    (temp, source, destination)
  }

  fn copy(source: PathBuf, destination: PathBuf) -> FileActionRequest {
    FileActionRequest::Copy {
      sources: vec![source],
      destination,
      overwrite: false,
    }
  }

  fn copy_to(source: PathBuf, destination: PathBuf, overwrite: bool) -> FileActionRequest {
    FileActionRequest::CopyTo {
      source,
      destination,
      overwrite,
    }
  }

  fn run(plan: FileActionPlan) -> Vec<FileActionOutcome> {
    plan.execute(&AtomicBool::new(false), |_, _| {})
  }

  #[test]
  fn recursive_copy_deduplicates_descendants_and_is_exact() {
    let (_temp, source, destination) = fixture();
    fs::create_dir(source.join("empty")).unwrap();
    fs::create_dir(source.join("nested")).unwrap();
    fs::write(source.join("nested").join("b"), b"beta").unwrap();
    let request = FileActionRequest::Copy {
      sources: vec![source.join("a.txt"), source.clone(), source.clone()],
      destination: destination.clone(),
      overwrite: false,
    };
    let plan = FileActionPlan::preview(request, &AtomicBool::new(false)).unwrap();
    assert_eq!(plan.operations().len(), 1);
    assert_eq!(plan.operations()[0].entry_count, 5);
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(
      fs::read(destination.join("source").join("nested").join("b")).unwrap(),
      b"beta"
    );
    assert!(destination.join("source").join("empty").is_dir());
    assert!(source.exists());
  }

  #[test]
  fn direct_directory_copy_previews_and_creates_missing_parent_folders() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("source");
    let destination_root = temp.path().join("destination");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&destination_root).unwrap();
    fs::create_dir(source.join("sub")).unwrap();
    fs::write(source.join("a.txt"), b"alpha").unwrap();
    fs::write(source.join("sub").join("b.txt"), b"beta").unwrap();
    let destination = destination_root
      .join("missing1")
      .join("missing2")
      .join("leaf");

    let plan = FileActionPlan::preview(
      copy_to(source.clone(), destination.clone(), false),
      &AtomicBool::new(false),
    )
    .unwrap();
    let operation = &plan.operations()[0];
    let canonical_destination_root = fs::canonicalize(&destination_root).unwrap();
    let creation_entries: Vec<_> = operation
      .entries
      .iter()
      .filter(|entry| entry.action == FileAction::CreateDirectory)
      .collect();
    assert_eq!(
      creation_entries
        .iter()
        .map(|entry| entry.destination.as_ref().unwrap().clone())
        .collect::<Vec<_>>(),
      vec![
        canonical_destination_root.join("missing1"),
        canonical_destination_root.join("missing1").join("missing2"),
      ]
    );
    assert!(creation_entries.iter().all(|entry| entry.source.is_none()));
    assert_eq!(operation.entry_count, operation.entries.len());
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(
      fs::read(destination.join("sub").join("b.txt")).unwrap(),
      b"beta"
    );
  }

  #[test]
  fn direct_file_copy_creates_missing_parent_with_either_overwrite_setting() {
    let (_temp, source, destination_root) = fixture();
    for overwrite in [false, true] {
      let destination = destination_root
        .join(format!("target-{overwrite}"))
        .join("nested")
        .join("copy.txt");
      let plan = FileActionPlan::preview(
        copy_to(source.join("a.txt"), destination.clone(), overwrite),
        &AtomicBool::new(false),
      )
      .unwrap();
      assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
      assert_eq!(fs::read(destination).unwrap(), b"alpha");
    }
  }

  #[test]
  fn batch_direct_copies_can_share_missing_parent_folders() {
    let (_temp, source, destination_root) = fixture();
    fs::write(source.join("b.txt"), b"beta").unwrap();
    let parent = destination_root.join("shared").join("missing");
    let plan = FileActionPlan::preview(
      FileActionRequest::Batch {
        requests: vec![
          copy_to(source.join("a.txt"), parent.join("a.txt"), false),
          copy_to(source.join("b.txt"), parent.join("b.txt"), false),
        ],
      },
      &AtomicBool::new(false),
    )
    .unwrap();
    let results = run(plan);
    assert!(results
      .iter()
      .all(|result| result.result == FileActionStatus::Completed));
    assert_eq!(fs::read(parent.join("a.txt")).unwrap(), b"alpha");
    assert_eq!(fs::read(parent.join("b.txt")).unwrap(), b"beta");
  }

  #[test]
  fn a_file_in_the_destination_ancestor_chain_blocks_preview() {
    let (_temp, source, destination_root) = fixture();
    fs::write(destination_root.join("blocked"), b"not a folder").unwrap();
    let error = FileActionPlan::preview(
      copy_to(
        source.join("a.txt"),
        destination_root
          .join("blocked")
          .join("nested")
          .join("a.txt"),
        false,
      ),
      &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("not a directory"));
    assert!(error.to_string().contains("blocked"));
    assert!(!destination_root.join("blocked").join("nested").exists());
  }

  #[test]
  fn a_missing_ancestor_occupied_after_preview_is_rejected() {
    let (_temp, source, destination_root) = fixture();
    let blocked = destination_root.join("created-after-preview");
    let destination = blocked.join("nested").join("a.txt");
    let plan = FileActionPlan::preview(
      copy_to(source.join("a.txt"), destination.clone(), false),
      &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(&blocked, b"now a file").unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    assert!(!destination.exists());
    assert_eq!(fs::read(source.join("a.txt")).unwrap(), b"alpha");
  }

  #[test]
  fn move_to_missing_parent_recycles_source_only_after_copy_succeeds() {
    let (_temp, source, destination_root) = fixture();
    let source_file = source.join("a.txt");
    let recovered = destination_root.join("recovered");
    fs::create_dir(&recovered).unwrap();
    let destination = destination_root.join("move").join("nested").join("a.txt");
    let plan = FileActionPlan::preview(
      FileActionRequest::MoveTo {
        source: source_file.clone(),
        destination: destination.clone(),
        overwrite: false,
      },
      &AtomicBool::new(false),
    )
    .unwrap();
    let result = plan.execute_with(&AtomicBool::new(false), &mut |_, _| {}, |path| {
      fs::rename(path, recovered.join("a.txt")).map_err(Into::into)
    });
    assert_eq!(result[0].result, FileActionStatus::Completed);
    assert!(!source_file.exists());
    assert!(recovered.join("a.txt").exists());
    assert_eq!(fs::read(destination).unwrap(), b"alpha");

    fs::write(&source_file, b"alpha").unwrap();
    let destination = destination_root
      .join("move-failure")
      .join("nested")
      .join("a.txt");
    let plan = FileActionPlan::preview(
      FileActionRequest::MoveTo {
        source: source_file.clone(),
        destination: destination.clone(),
        overwrite: false,
      },
      &AtomicBool::new(false),
    )
    .unwrap();
    let result = plan.execute_with(&AtomicBool::new(false), &mut |_, _| {}, |_| {
      Err(failure("trash unavailable"))
    });
    assert!(matches!(result[0].result, FileActionStatus::Failed(_)));
    assert!(source_file.exists());
    assert_eq!(fs::read(destination).unwrap(), b"alpha");
  }

  #[test]
  fn stale_same_length_content_and_new_children_are_rejected() {
    let (_temp, source, destination) = fixture();
    let plan = FileActionPlan::preview(
      copy(source.clone(), destination.clone()),
      &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(source.join("a.txt"), b"ALPHA").unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    assert!(!destination.join("source").exists());
    let plan = FileActionPlan::preview(
      copy(source.clone(), destination.clone()),
      &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(source.join("new"), b"new").unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
  }

  #[test]
  fn collisions_at_preview_and_execution_do_not_clobber() {
    let (_temp, source, destination) = fixture();
    let plan = FileActionPlan::preview(
      copy(source.join("a.txt"), destination.clone()),
      &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(destination.join("a.txt"), b"existing").unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    assert_eq!(fs::read(destination.join("a.txt")).unwrap(), b"existing");
    assert!(FileActionPlan::preview(
      copy(source.join("a.txt"), destination),
      &AtomicBool::new(false)
    )
    .is_err());
  }

  #[test]
  fn rename_mkdir_attributes_and_touch() {
    let (_temp, source, _) = fixture();
    let cancel = AtomicBool::new(false);
    let plan = FileActionPlan::preview(
      FileActionRequest::Rename {
        source: source.join("a.txt"),
        name: "renamed".into(),
      },
      &cancel,
    )
    .unwrap();
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert!(!source.join("a.txt").exists());
    let plan = FileActionPlan::preview(
      FileActionRequest::CreateDirectory {
        parent: source.clone(),
        name: "created".into(),
      },
      &cancel,
    )
    .unwrap();
    fs::create_dir(source.join("created")).unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    for readonly in [true, false] {
      let plan = FileActionPlan::preview(
        FileActionRequest::SetReadOnly {
          sources: vec![source.join("renamed")],
          readonly,
        },
        &cancel,
      )
      .unwrap();
      assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
      assert_eq!(
        fs::metadata(source.join("renamed"))
          .unwrap()
          .permissions()
          .readonly(),
        readonly
      );
    }
    let modified = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
    let plan = FileActionPlan::preview(
      FileActionRequest::Touch {
        sources: vec![source.join("renamed")],
        modified_ms: 1_600_000_000_000,
      },
      &cancel,
    )
    .unwrap();
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(
      fs::metadata(source.join("renamed"))
        .unwrap()
        .modified()
        .unwrap(),
      modified
    );
  }

  #[test]
  fn cancellation_stops_unstarted_work_and_preserves_completed_work() {
    let (_temp, source, destination) = fixture();
    fs::write(source.join("b.txt"), b"beta").unwrap();
    let cancel = AtomicBool::new(false);
    let plan = FileActionPlan::preview(
      FileActionRequest::Copy {
        sources: vec![source.join("a.txt"), source.join("b.txt")],
        destination: destination.clone(),
        overwrite: false,
      },
      &cancel,
    )
    .unwrap();
    let outcomes = plan.execute(&cancel, |_, _| cancel.store(true, Ordering::Relaxed));
    assert_eq!(outcomes[0].result, FileActionStatus::Completed);
    assert_eq!(outcomes[1].result, FileActionStatus::Cancelled);
    assert!(destination.join("a.txt").exists());
    assert!(!destination.join("b.txt").exists());
    assert!(FileActionPlan::preview(copy(source, destination), &cancel).is_err());
  }

  #[test]
  fn failed_recycling_has_no_permanent_delete_fallback() {
    let (_temp, source, destination) = fixture();
    let cancel = AtomicBool::new(false);
    for request in [
      FileActionRequest::Move {
        sources: vec![source.join("a.txt")],
        destination: destination.clone(),
        overwrite: false,
      },
      FileActionRequest::Recycle {
        sources: vec![source.clone()],
      },
    ] {
      let plan = FileActionPlan::preview(request, &cancel).unwrap();
      let outcomes = plan.execute_with(&cancel, &mut |_, _| {}, |_| {
        Err(failure("trash unavailable"))
      });
      assert!(matches!(outcomes[0].result, FileActionStatus::Failed(_)));
      assert!(source.join("a.txt").exists());
    }
    assert_eq!(fs::read(destination.join("a.txt")).unwrap(), b"alpha");
  }

  #[test]
  fn move_and_recursive_recycle_use_only_the_approved_roots() {
    let (temp, source, destination) = fixture();
    let cancel = AtomicBool::new(false);
    let held = temp.path().join("recoverable");
    fs::create_dir(&held).unwrap();
    let plan = FileActionPlan::preview(
      FileActionRequest::Move {
        sources: vec![source.clone()],
        destination: destination.clone(),
        overwrite: false,
      },
      &cancel,
    )
    .unwrap();
    let result = plan.execute_with(&cancel, &mut |_, _| {}, |path| {
      fs::rename(path, held.join("source")).map_err(Into::into)
    });
    assert_eq!(result[0].result, FileActionStatus::Completed);
    assert!(!source.exists());
    assert!(held.join("source").join("a.txt").exists());
    assert!(destination.join("source").join("a.txt").exists());
  }

  #[test]
  fn unsafe_destinations_names_and_empty_selection_are_rejected() {
    let (_temp, source, destination) = fixture();
    let cancel = AtomicBool::new(false);
    fs::create_dir(source.join("nested")).unwrap();
    assert!(FileActionPlan::preview(copy(source.clone(), source.join("nested")), &cancel).is_err());
    assert!(FileActionPlan::preview(copy(source.join("a.txt"), source.clone()), &cancel).is_err());
    assert!(
      FileActionPlan::preview(copy(source.join("..").join("source"), destination), &cancel)
        .is_err()
    );
    for name in ["..", ".", "../outside", "a\\b", "x:y", "bad."] {
      assert!(FileActionPlan::preview(
        FileActionRequest::Rename {
          source: source.clone(),
          name: name.into(),
        },
        &cancel
      )
      .is_err());
    }
    assert!(
      FileActionPlan::preview(FileActionRequest::Recycle { sources: vec![] }, &cancel).is_err()
    );
  }

  #[test]
  fn oversized_files_are_rejected_without_reading_them() {
    let (_temp, source, destination) = fixture();
    File::create(source.join("large"))
      .unwrap()
      .set_len(MAX_FILE_BYTES + 1)
      .unwrap();
    assert!(FileActionPlan::preview(copy(source, destination), &AtomicBool::new(false)).is_err());
  }

  #[test]
  fn links_are_rejected_where_creation_is_permitted() {
    let (_temp, source, destination) = fixture();
    let link = source.join("link");
    #[cfg(unix)]
    let created = std::os::unix::fs::symlink(source.join("a.txt"), &link);
    #[cfg(windows)]
    let created = std::os::windows::fs::symlink_file(source.join("a.txt"), &link);
    if created.is_err() {
      // Windows symlink creation requires Developer Mode or privilege.
      return;
    }
    assert!(
      FileActionPlan::preview(copy(link, destination.clone()), &AtomicBool::new(false)).is_err()
    );
    assert!(FileActionPlan::preview(copy(source, destination), &AtomicBool::new(false)).is_err());
  }

  #[test]
  fn mkdir_and_directory_rename_are_no_clobber() {
    let (_temp, source, _) = fixture();
    let cancel = AtomicBool::new(false);
    let request = FileActionRequest::CreateDirectory {
      parent: source.clone(),
      name: "created".into(),
    };
    let plan = FileActionPlan::preview(request, &cancel).unwrap();
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    fs::write(source.join("created").join("child"), b"child").unwrap();
    let plan = FileActionPlan::preview(
      FileActionRequest::Rename {
        source: source.join("created"),
        name: "renamed".into(),
      },
      &cancel,
    )
    .unwrap();
    fs::create_dir(source.join("renamed")).unwrap();
    fs::write(source.join("renamed").join("keep"), b"existing").unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    assert_eq!(
      fs::read(source.join("renamed").join("keep")).unwrap(),
      b"existing"
    );
    let plan = FileActionPlan::preview(
      FileActionRequest::Rename {
        source: source.join("created"),
        name: "fresh".into(),
      },
      &cancel,
    )
    .unwrap();
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(
      fs::read(source.join("fresh").join("child")).unwrap(),
      b"child"
    );
  }

  #[test]
  fn public_preview_is_not_authoritative_execution_state() {
    let (_temp, source, destination) = fixture();
    let mut plan = FileActionPlan::preview(
      copy(source.join("a.txt"), destination.clone()),
      &AtomicBool::new(false),
    )
    .unwrap();
    plan.operations[0].action = FileAction::Recycle;
    plan.operations[0].source = Some(destination.clone());
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert!(source.join("a.txt").exists());
    assert_eq!(fs::read(destination.join("a.txt")).unwrap(), b"alpha");
  }

  #[test]
  fn snapshots_bound_count_and_detect_permissions() {
    let (_temp, source, destination) = fixture();
    let cancel = AtomicBool::new(false);
    let mut count = MAX_ENTRIES;
    assert!(snapshot_tree(&source, &cancel, &mut count).is_err());
    let plan = FileActionPlan::preview(copy(source.join("a.txt"), destination), &cancel).unwrap();
    let readonly = FileActionPlan::preview(
      FileActionRequest::SetReadOnly {
        sources: vec![source.join("a.txt")],
        readonly: true,
      },
      &cancel,
    )
    .unwrap();
    assert_eq!(run(readonly)[0].result, FileActionStatus::Completed);
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    let writable = FileActionPlan::preview(
      FileActionRequest::SetReadOnly {
        sources: vec![source.join("a.txt")],
        readonly: false,
      },
      &cancel,
    )
    .unwrap();
    assert_eq!(run(writable)[0].result, FileActionStatus::Completed);
  }

  #[test]
  fn request_and_outcome_transport_is_explicit() {
    let request: FileActionRequest = serde_json::from_value(serde_json::json!({
        "kind": "touch", "sources": [], "modifiedMs": 1600000000000_u64
    }))
    .unwrap();
    assert!(matches!(
      request,
      FileActionRequest::Touch {
        modified_ms: 1_600_000_000_000,
        ..
      }
    ));
    assert!(
      serde_json::from_value::<FileActionRequest>(serde_json::json!({
          "kind": "recycle", "sources": [], "permanent": true
      }))
      .is_err()
    );
    assert_eq!(
      serde_json::to_value(FileActionStatus::Failed("reason".into())).unwrap(),
      serde_json::json!({"status": "failed", "message": "reason"})
    );
    assert_eq!(
      serde_json::to_value(FileAction::Touch { modified_ms: 42 }).unwrap(),
      serde_json::json!({"kind": "touch", "modifiedMs": 42})
    );
  }

  #[test]
  fn safe_copy_to_an_ancestor_directory_is_allowed() {
    let (_temp, source, _) = fixture();
    let nested = source.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("other"), b"other").unwrap();
    let plan = FileActionPlan::preview(
      copy(nested.join("other"), source.clone()),
      &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(fs::read(source.join("other")).unwrap(), b"other");
  }

  #[test]
  fn recursive_merge_replaces_only_approved_leaves_and_retains_extras() {
    let (_temp, source, destination) = fixture();
    let target = destination.join("source");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("a.txt"), b"old").unwrap();
    fs::write(target.join("extra"), b"keep").unwrap();
    fs::create_dir(source.join("nested")).unwrap();
    fs::write(source.join("nested").join("new"), b"new").unwrap();
    let plan = FileActionPlan::preview(
      FileActionRequest::Copy {
        sources: vec![source.clone()],
        destination,
        overwrite: true,
      },
      &AtomicBool::new(false),
    )
    .unwrap();
    let entries = &plan.operations()[0].entries;
    assert_eq!(entries.len(), 4);
    assert!(entries.iter().any(|e| e.source
      == Some(safe_path(&source.join("a.txt"), false).unwrap())
      && e.destination == Some(safe_path(&target.join("a.txt"), false).unwrap())
      && e.replaces_existing));
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(fs::read(target.join("a.txt")).unwrap(), b"alpha");
    assert_eq!(fs::read(target.join("extra")).unwrap(), b"keep");
    assert_eq!(fs::read(target.join("nested").join("new")).unwrap(), b"new");
  }

  #[test]
  fn explicit_counterpart_copy_and_stale_destination_content() {
    let (_temp, source, destination) = fixture();
    let target = destination.join("different-name");
    fs::write(&target, b"first").unwrap();
    let request = || FileActionRequest::CopyTo {
      source: source.join("a.txt"),
      destination: target.clone(),
      overwrite: true,
    };
    let plan = FileActionPlan::preview(request(), &AtomicBool::new(false)).unwrap();
    let modified = fs::metadata(&target).unwrap().modified().unwrap();
    fs::write(&target, b"other").unwrap();
    File::options()
      .write(true)
      .open(&target)
      .unwrap()
      .set_times(FileTimes::new().set_modified(modified))
      .unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    assert_eq!(fs::read(&target).unwrap(), b"other");
    let plan = FileActionPlan::preview(request(), &AtomicBool::new(false)).unwrap();
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(fs::read(&target).unwrap(), b"alpha");
    assert!(source.join("a.txt").exists());
  }

  #[test]
  fn merges_reject_collisions_and_new_destination_children() {
    let (_temp, source, destination) = fixture();
    let target = destination.join("source");
    fs::create_dir(&target).unwrap();
    fs::create_dir(target.join("a.txt")).unwrap();
    let request = || FileActionRequest::Copy {
      sources: vec![source.clone()],
      destination: destination.clone(),
      overwrite: true,
    };
    assert!(FileActionPlan::preview(request(), &AtomicBool::new(false)).is_err());
    fs::remove_dir(target.join("a.txt")).unwrap();
    let plan = FileActionPlan::preview(request(), &AtomicBool::new(false)).unwrap();
    fs::write(target.join("external"), b"external").unwrap();
    assert!(matches!(run(plan)[0].result, FileActionStatus::Failed(_)));
    assert!(!target.join("a.txt").exists());
  }

  #[test]
  fn move_overwrite_copies_before_recycling_and_retains_original_on_failure() {
    let (_temp, source, destination) = fixture();
    fs::write(destination.join("a.txt"), b"old").unwrap();
    let cancel = AtomicBool::new(false);
    let plan = FileActionPlan::preview(
      FileActionRequest::Move {
        sources: vec![source.join("a.txt")],
        destination: destination.clone(),
        overwrite: true,
      },
      &cancel,
    )
    .unwrap();
    let result = plan.execute_with(&cancel, &mut |_, _| {}, |_| {
      Err(failure("trash unavailable"))
    });
    assert!(matches!(result[0].result, FileActionStatus::Failed(_)));
    assert_eq!(fs::read(destination.join("a.txt")).unwrap(), b"alpha");
    assert_eq!(fs::read(source.join("a.txt")).unwrap(), b"alpha");
  }

  #[test]
  fn overwrite_requires_explicit_intent_and_cancellation_preserves_destination() {
    let (_temp, source, destination) = fixture();
    let target = destination.join("counterpart");
    fs::write(&target, b"old").unwrap();
    let request: FileActionRequest = serde_json::from_value(serde_json::json!({
        "kind": "copyTo", "source": source.join("a.txt"), "destination": target
    }))
    .unwrap();
    let cancel = AtomicBool::new(false);
    assert!(FileActionPlan::preview(request, &cancel).is_err());
    let plan = FileActionPlan::preview(
      FileActionRequest::CopyTo {
        source: source.join("a.txt"),
        destination: target.clone(),
        overwrite: true,
      },
      &cancel,
    )
    .unwrap();
    cancel.store(true, Ordering::Relaxed);
    assert_eq!(
      plan.execute(&cancel, |_, _| {})[0].result,
      FileActionStatus::Cancelled
    );
    assert_eq!(fs::read(&target).unwrap(), b"old");
    let target = destination.join("fresh-counterpart");
    let plan = FileActionPlan::preview(
      FileActionRequest::CopyTo {
        source: source.join("a.txt"),
        destination: target.clone(),
        overwrite: false,
      },
      &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
    assert_eq!(fs::read(target).unwrap(), b"alpha");
  }

  #[test]
  fn read_only_destination_rejects_overwrite_without_changing_it() {
    let (_temp, source, destination) = fixture();
    let target = destination.join("a.txt");
    fs::write(&target, b"old").unwrap();
    let cancel = AtomicBool::new(false);
    for readonly in [true, false] {
      let plan = FileActionPlan::preview(
        FileActionRequest::SetReadOnly {
          sources: vec![target.clone()],
          readonly,
        },
        &cancel,
      )
      .unwrap();
      assert_eq!(run(plan)[0].result, FileActionStatus::Completed);
      if readonly {
        assert!(FileActionPlan::preview(
          FileActionRequest::Copy {
            sources: vec![source.join("a.txt")],
            destination: destination.clone(),
            overwrite: true,
          },
          &cancel
        )
        .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
      }
    }
  }

  #[test]
  fn every_request_kind_has_concrete_authoritative_entry_previews() {
    let (_temp, source, destination) = fixture();
    let cancel = AtomicBool::new(false);
    let source = safe_path(&source, false).unwrap();
    let destination = safe_path(&destination, false).unwrap();
    let file = source.join("a.txt");
    let requests = vec![
      (
        FileActionRequest::Copy {
          sources: vec![source.clone()],
          destination: destination.clone(),
          overwrite: false,
        },
        FileAction::Copy,
        source.clone(),
        destination.join("source"),
        2,
        true,
      ),
      (
        FileActionRequest::Move {
          sources: vec![file.clone()],
          destination: destination.clone(),
          overwrite: false,
        },
        FileAction::Move,
        file.clone(),
        destination.join("a.txt"),
        1,
        false,
      ),
      (
        FileActionRequest::CopyTo {
          source: source.clone(),
          destination: destination.join("exact-copy"),
          overwrite: false,
        },
        FileAction::Copy,
        source.clone(),
        destination.join("exact-copy"),
        2,
        true,
      ),
      (
        FileActionRequest::MoveTo {
          source: source.clone(),
          destination: destination.join("exact-move"),
          overwrite: false,
        },
        FileAction::Move,
        source.clone(),
        destination.join("exact-move"),
        2,
        true,
      ),
      (
        FileActionRequest::Rename {
          source: source.clone(),
          name: "renamed".into(),
        },
        FileAction::Rename,
        source.clone(),
        source.parent().unwrap().join("renamed"),
        2,
        true,
      ),
      (
        FileActionRequest::Recycle {
          sources: vec![source.clone()],
        },
        FileAction::Recycle,
        source.clone(),
        source.clone(),
        2,
        true,
      ),
      (
        FileActionRequest::CreateDirectory {
          parent: destination.clone(),
          name: "new".into(),
        },
        FileAction::CreateDirectory,
        destination.join("new"),
        destination.join("new"),
        1,
        true,
      ),
      (
        FileActionRequest::SetReadOnly {
          sources: vec![source.clone()],
          readonly: true,
        },
        FileAction::SetReadOnly { readonly: true },
        source.clone(),
        source.clone(),
        1,
        true,
      ),
      (
        FileActionRequest::Touch {
          sources: vec![file.clone()],
          modified_ms: 42,
        },
        FileAction::Touch { modified_ms: 42 },
        file.clone(),
        file,
        1,
        false,
      ),
    ];
    for (request, action, from, to, count, directory) in requests {
      let plan = FileActionPlan::preview(request, &cancel).unwrap();
      let operation = &plan.operations()[0];
      assert_eq!(operation.entries.len(), count);
      assert_eq!(operation.entry_count, count);
      let entry = &operation.entries[0];
      assert_eq!(entry.action, action);
      assert_eq!(entry.source, Some(from.clone()));
      assert_eq!(entry.destination, Some(to.clone()));
      assert_eq!(entry.directory, directory);
      assert!(!entry.replaces_existing);
      if count == 2 {
        assert_eq!(operation.entries[1].source, Some(from.join("a.txt")));
        assert_eq!(operation.entries[1].destination, Some(to.join("a.txt")));
      }
      assert_eq!(
        serde_json::to_value(entry).unwrap(),
        serde_json::json!({
            "action": action, "source": from, "destination": to,
            "directory": directory, "replacesExisting": false
        })
      );
    }
  }

  #[test]
  fn batch_exact_targets_preserve_distinct_names_and_directories() {
    let (_temp, source, destination) = fixture();
    let nested = source.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("b"), b"beta").unwrap();
    let cancel = AtomicBool::new(false);
    let plan = FileActionPlan::preview(
      FileActionRequest::Batch {
        requests: vec![
          FileActionRequest::CopyTo {
            source: source.join("a.txt"),
            destination: destination.join("aligned"),
            overwrite: false,
          },
          FileActionRequest::CopyTo {
            source: nested.clone(),
            destination: destination.join("other-parent"),
            overwrite: false,
          },
        ],
      },
      &cancel,
    )
    .unwrap();
    assert_eq!(plan.operations().len(), 2);
    assert!(run(plan)
      .iter()
      .all(|o| o.result == FileActionStatus::Completed));
    assert_eq!(fs::read(destination.join("aligned")).unwrap(), b"alpha");
    assert_eq!(
      fs::read(destination.join("other-parent").join("b")).unwrap(),
      b"beta"
    );
    let moved = destination.join("moved-tree");
    let plan = FileActionPlan::preview(
      FileActionRequest::MoveTo {
        source: nested.clone(),
        destination: moved.clone(),
        overwrite: false,
      },
      &cancel,
    )
    .unwrap();
    let (_temp2, held, _) = fixture();
    let results = plan.execute_with(&cancel, &mut |_, _| {}, |path| {
      fs::rename(path, held.join("recoverable")).map_err(Into::into)
    });
    assert_eq!(results[0].result, FileActionStatus::Completed);
    assert!(!nested.exists());
    assert_eq!(fs::read(moved.join("b")).unwrap(), b"beta");
  }

  #[test]
  fn batch_rejects_cross_operation_collisions_overlap_and_nesting() {
    let (_temp, source, destination) = fixture();
    let cancel = AtomicBool::new(false);
    let first = || FileActionRequest::CopyTo {
      source: source.join("a.txt"),
      destination: destination.join("same"),
      overwrite: false,
    };
    for second in [
      FileActionRequest::CopyTo {
        source: source.clone(),
        destination: destination.join("same"),
        overwrite: false,
      },
      FileActionRequest::Recycle {
        sources: vec![source.clone()],
      },
      FileActionRequest::CreateDirectory {
        parent: destination.clone(),
        name: "same".into(),
      },
      FileActionRequest::CopyTo {
        source: source.clone(),
        destination: source.join("a.txt"),
        overwrite: true,
      },
    ] {
      assert!(FileActionPlan::preview(
        FileActionRequest::Batch {
          requests: vec![first(), second],
        },
        &cancel
      )
      .is_err());
    }
    for requests in [
      vec![],
      vec![FileActionRequest::Batch {
        requests: vec![first()],
      }],
    ] {
      assert!(FileActionPlan::preview(FileActionRequest::Batch { requests }, &cancel).is_err());
    }
  }

  #[test]
  fn batch_retains_destination_stale_checks_per_operation() {
    let (_temp, source, destination) = fixture();
    let counterpart = destination.join("counterpart");
    fs::write(&counterpart, b"old").unwrap();
    fs::write(source.join("b"), b"beta").unwrap();
    let plan = FileActionPlan::preview(
      FileActionRequest::Batch {
        requests: vec![
          FileActionRequest::CopyTo {
            source: source.join("a.txt"),
            destination: destination.join("new"),
            overwrite: false,
          },
          FileActionRequest::MoveTo {
            source: source.join("b"),
            destination: counterpart.clone(),
            overwrite: true,
          },
        ],
      },
      &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(&counterpart, b"changed").unwrap();
    let results = run(plan);
    assert_eq!(results[0].result, FileActionStatus::Completed);
    assert!(matches!(results[1].result, FileActionStatus::Failed(_)));
    assert!(source.join("b").exists());
    assert_eq!(fs::read(counterpart).unwrap(), b"changed");
  }

  #[test]
  fn batch_transport_and_directory_exact_target_merge_are_supported() {
    let (_temp, source, destination) = fixture();
    let target = destination.join("aligned-directory");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("a.txt"), b"old").unwrap();
    fs::write(target.join("extra"), b"extra").unwrap();
    let request = serde_json::from_value::<FileActionRequest>(serde_json::json!({
        "kind": "batch",
        "requests": [{
            "kind": "moveTo", "source": source, "destination": target, "overwrite": true
        }]
    }))
    .unwrap();
    let cancel = AtomicBool::new(false);
    let plan = FileActionPlan::preview(request, &cancel).unwrap();
    assert_eq!(plan.operations()[0].entries.len(), 2);
    assert!(plan.operations()[0]
      .entries
      .iter()
      .all(|e| e.replaces_existing));
    let result = plan.execute_with(&cancel, &mut |_, _| {}, |_| {
      Err(failure("recycling unavailable"))
    });
    assert!(matches!(result[0].result, FileActionStatus::Failed(_)));
    assert_eq!(fs::read(target.join("a.txt")).unwrap(), b"alpha");
    assert_eq!(fs::read(target.join("extra")).unwrap(), b"extra");
    assert!(source.exists());
  }
}
