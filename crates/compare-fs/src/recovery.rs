use crate::{checked_path, document::read_bounded, FileError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const RECOVERY_RETENTION_SECONDS: u64 = 7 * 24 * 60 * 60;
const MAX_RECOVERIES: usize = 20;
const MAX_RECOVERY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 3 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const RECOVERY_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryStore {
  version: u32,
  records: Vec<DraftRecovery>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftRecovery {
  pub id: String,
  pub updated_at: u64,
  pub mode: String,
  pub left_path: String,
  pub right_path: String,
  pub base_path: String,
  pub left_text: String,
  pub right_text: String,
  pub base_text: String,
  pub output: String,
  #[serde(default)]
  pub choices: BTreeMap<u32, String>,
}

impl DraftRecovery {
  fn validate(&self) -> Result<(), FileError> {
    if self.id.is_empty()
      || self.id.len() > 64
      || !self
        .id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
      return Err(FileError("Invalid draft recovery identifier.".into()));
    }
    if !matches!(self.mode.as_str(), "text" | "merge") {
      return Err(FileError(
        "Only text and non-Git merge drafts can be recovered.".into(),
      ));
    }
    if [
      self.left_path.len(),
      self.right_path.len(),
      self.base_path.len(),
    ]
    .into_iter()
    .any(|length| length > MAX_PATH_BYTES)
    {
      return Err(FileError("Draft recovery path label is too long.".into()));
    }
    if [
      self.left_text.len(),
      self.right_text.len(),
      self.base_text.len(),
    ]
    .into_iter()
    .any(|length| length > MAX_TEXT_BYTES)
    {
      return Err(FileError(
        "Draft recovery text exceeds the 1 MiB pane limit.".into(),
      ));
    }
    if self.output.len() > MAX_OUTPUT_BYTES
      || self.choices.len() > 10_000
      || self
        .choices
        .values()
        .any(|choice| choice.len() > MAX_TEXT_BYTES)
    {
      return Err(FileError("Draft recovery exceeds supported bounds.".into()));
    }
    let bytes = serde_json::to_vec(self).map_err(|error| FileError(error.to_string()))?;
    if bytes.len() > MAX_RECORD_BYTES {
      return Err(FileError(
        "Draft recovery exceeds the 8 MiB per-workspace limit.".into(),
      ));
    }
    Ok(())
  }
}

pub fn load_recoveries(path: &Path) -> Result<Vec<DraftRecovery>, FileError> {
  load_recoveries_at(path, now_seconds()?)
}

fn load_recoveries_at(path: &Path, now: u64) -> Result<Vec<DraftRecovery>, FileError> {
  validate_storage_path(path)?;
  let bytes = match std::fs::symlink_metadata(path) {
    Ok(_) => {
      checked_path(path, false)?;
      read_bounded(path, MAX_RECOVERY_BYTES)?
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(error) => return Err(error.into()),
  };
  let store: RecoveryStore = serde_json::from_slice(&bytes).map_err(|error| {
    FileError(format!(
      "Draft recovery cannot be read; original retained: {error}"
    ))
  })?;
  if store.version != RECOVERY_FORMAT_VERSION {
    return Err(FileError(
      "Unsupported draft recovery version; stored data was not reset.".into(),
    ));
  }
  let recoveries = store.records;
  validate_recoveries(&recoveries)?;
  let original_count = recoveries.len();
  let retained: Vec<_> = recoveries
    .into_iter()
    .filter(|record| now.saturating_sub(record.updated_at) < RECOVERY_RETENTION_SECONDS)
    .collect();
  if retained.len() != original_count {
    save_recoveries_at(path, &retained, now)?;
  }
  Ok(retained)
}

pub fn save_recoveries(
  path: &Path,
  recoveries: &[DraftRecovery],
) -> Result<Vec<DraftRecovery>, FileError> {
  save_recoveries_at(path, recoveries, now_seconds()?)
}

pub fn discard_recovery(path: &Path, id: &str) -> Result<Vec<DraftRecovery>, FileError> {
  discard_recovery_at(path, id, now_seconds()?)
}

fn discard_recovery_at(path: &Path, id: &str, now: u64) -> Result<Vec<DraftRecovery>, FileError> {
  let mut recoveries = load_recoveries_at(path, now)?;
  recoveries.retain(|record| record.id != id);
  save_recoveries_at(path, &recoveries, now)
}

pub fn clear_recoveries(path: &Path) -> Result<(), FileError> {
  validate_storage_path(path)?;
  match std::fs::symlink_metadata(path) {
    Ok(_) => {
      checked_path(path, false)?;
      std::fs::remove_file(path)?;
      Ok(())
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error.into()),
  }
}

fn save_recoveries_at(
  path: &Path,
  recoveries: &[DraftRecovery],
  now: u64,
) -> Result<Vec<DraftRecovery>, FileError> {
  validate_storage_path(path)?;
  if recoveries.len() > MAX_RECOVERIES {
    return Err(FileError(
      "Draft recovery is limited to 20 workspaces; close or discard a draft first.".into(),
    ));
  }
  let mut ids = HashSet::with_capacity(recoveries.len());
  let mut saved = recoveries.to_vec();
  for record in &mut saved {
    record.validate()?;
    if !ids.insert(record.id.clone()) {
      return Err(FileError("Duplicate draft recovery identifier.".into()));
    }
    if record.updated_at == 0 {
      record.updated_at = now;
    } else if record.updated_at > now {
      return Err(FileError(
        "Draft recovery timestamp cannot be in the future.".into(),
      ));
    }
    record.validate()?;
  }
  if saved.is_empty() {
    clear_recoveries(path)?;
    return Ok(saved);
  }
  let bytes = serde_json::to_vec_pretty(&RecoveryStore {
    version: RECOVERY_FORMAT_VERSION,
    records: saved.clone(),
  })
  .map_err(|error| FileError(error.to_string()))?;
  if bytes.len() as u64 > MAX_RECOVERY_BYTES {
    return Err(FileError(
      "Draft recovery storage exceeds the 64 MiB limit; discard a recovery record first.".into(),
    ));
  }
  let parent = path
    .parent()
    .ok_or_else(|| FileError("Missing draft recovery directory.".into()))?;
  let ancestor = parent
    .ancestors()
    .find(|candidate| candidate.exists())
    .ok_or_else(|| FileError("Missing configuration root.".into()))?;
  checked_path(ancestor, false)?;
  std::fs::create_dir_all(parent)?;
  checked_path(parent, false)?;
  checked_path(path, true)?;
  let mut temp = tempfile::NamedTempFile::new_in(parent)?;
  temp.write_all(&bytes)?;
  temp.as_file().sync_all()?;
  temp.persist(path).map_err(|error| {
    FileError(format!(
      "Draft recovery replacement failed: {}",
      error.error
    ))
  })?;
  Ok(saved)
}

fn validate_storage_path(path: &Path) -> Result<(), FileError> {
  if !path.is_absolute()
    || path.file_name().and_then(|name| name.to_str()) != Some("draft-recovery.json")
  {
    return Err(FileError(
      "Draft recovery requires its dedicated application storage path.".into(),
    ));
  }
  if let Some(parent) = path.parent() {
    if parent.exists() {
      checked_path(parent, false)?;
    } else if let Some(ancestor) = parent.ancestors().find(|candidate| candidate.exists()) {
      checked_path(ancestor, false)?;
    }
  }
  Ok(())
}

fn validate_recoveries(recoveries: &[DraftRecovery]) -> Result<(), FileError> {
  if recoveries.len() > MAX_RECOVERIES {
    return Err(FileError(
      "Draft recovery file exceeds the 20-workspace limit.".into(),
    ));
  }
  let mut ids = HashSet::with_capacity(recoveries.len());
  for record in recoveries {
    record.validate()?;
    if !ids.insert(record.id.clone()) {
      return Err(FileError("Duplicate draft recovery identifier.".into()));
    }
  }
  Ok(())
}

fn now_seconds() -> Result<u64, FileError> {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .map_err(|error| FileError(format!("System clock is before the Unix epoch: {error}")))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn record(id: &str, updated_at: u64) -> DraftRecovery {
    DraftRecovery {
      id: id.into(),
      updated_at,
      mode: "text".into(),
      left_path: "left.txt".into(),
      right_path: "right.txt".into(),
      base_path: String::new(),
      left_text: "recovered left\n".into(),
      right_text: "right\n".into(),
      base_text: String::new(),
      output: String::new(),
      choices: BTreeMap::new(),
    }
  }

  #[test]
  fn recovery_survives_restart_and_discard_is_scoped() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("draft-recovery.json");
    let original = vec![record("recovery-1", 0), record("recovery-2", 0)];
    let stored = save_recoveries_at(&path, &original, 100).unwrap();
    assert_eq!(stored[0].updated_at, 100);

    let restarted = load_recoveries_at(&path, 101).unwrap();
    assert_eq!(restarted, stored);
    let remaining = discard_recovery_at(&path, "recovery-1", 102).unwrap();
    assert_eq!(remaining, vec![record("recovery-2", 100)]);
    assert_eq!(load_recoveries_at(&path, 103).unwrap(), remaining);
  }

  #[test]
  fn unchanged_records_keep_their_expiry_when_other_drafts_are_saved() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("draft-recovery.json");
    let pending = record("pending", 100);
    save_recoveries_at(&path, std::slice::from_ref(&pending), 100).unwrap();

    let mut active = record("active", 0);
    active.left_text = "changed active draft".into();
    let saved = save_recoveries_at(&path, &[pending.clone(), active], 200).unwrap();
    assert_eq!(saved[0], pending);
    assert_eq!(saved[1].updated_at, 200);

    let expired = load_recoveries_at(&path, 100 + RECOVERY_RETENTION_SECONDS).unwrap();
    let mut expected_active = record("active", 200);
    expected_active.left_text = "changed active draft".into();
    assert_eq!(expired, vec![expected_active]);
  }

  #[test]
  fn expired_records_are_removed_and_empty_state_deletes_storage() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("draft-recovery.json");
    std::fs::write(
      &path,
      serde_json::to_vec(&RecoveryStore {
        version: RECOVERY_FORMAT_VERSION,
        records: vec![record("expired", 1), record("fresh", 1_000_000)],
      })
      .unwrap(),
    )
    .unwrap();
    assert_eq!(
      load_recoveries_at(&path, 1_000_000).unwrap(),
      vec![record("fresh", 1_000_000)]
    );
    save_recoveries_at(&path, &[], 1_000_001).unwrap();
    assert!(!path.exists());
  }

  #[test]
  fn invalid_or_interrupted_replacement_keeps_existing_record() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("draft-recovery.json");
    let original = vec![record("safe", 100)];
    save_recoveries_at(&path, &original, 100).unwrap();
    let too_large = DraftRecovery {
      left_text: "x".repeat(MAX_TEXT_BYTES + 1),
      ..record("bad", 0)
    };
    assert!(save_recoveries_at(&path, &[too_large], 101).is_err());
    assert_eq!(load_recoveries_at(&path, 101).unwrap(), original);

    std::fs::write(&path, b"{interrupted").unwrap();
    assert!(load_recoveries_at(&path, 102).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"{interrupted");

    let unsupported = serde_json::json!({
        "version": 2,
        "records": [record("future", 100)]
    });
    let bytes = serde_json::to_vec(&unsupported).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    assert!(load_recoveries_at(&path, 103).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
  }

  #[test]
  fn rejects_unsafe_paths_duplicate_ids_and_unbounded_records() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    assert!(save_recoveries_at(&path, &[record("id", 0)], 100).is_err());
    let path = root.path().join("draft-recovery.json");
    assert!(save_recoveries_at(&path, &[record("../bad", 0)], 100).is_err());
    assert!(save_recoveries_at(&path, &[record("same", 0), record("same", 0)], 100).is_err());
    let many: Vec<_> = (0..=MAX_RECOVERIES)
      .map(|index| record(&format!("id-{index}"), 0))
      .collect();
    assert!(save_recoveries_at(&path, &many, 100).is_err());
  }
}
