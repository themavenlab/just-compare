use crate::FileError;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
  pub name: String,
  pub left: String,
  pub right: String,
  pub mode: String,
  #[serde(default)]
  pub base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
  pub version: u32,
  pub theme: String,
  pub recent: Vec<String>,
  pub sessions: Vec<Session>,
  pub ignore_case: bool,
  pub ignore_whitespace: bool,
  pub ignore_line_endings: bool,
  pub unimportant_patterns: Vec<String>,
  #[serde(default)]
  pub formats: Vec<FormatRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormatRule {
  pub suffix: String,
  pub ignore_case: bool,
  pub ignore_whitespace: bool,
  pub ignore_line_endings: bool,
  pub patterns: Vec<String>,
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      version: 1,
      theme: "light".into(),
      recent: Vec::new(),
      sessions: Vec::new(),
      ignore_case: false,
      ignore_whitespace: false,
      ignore_line_endings: false,
      unimportant_patterns: Vec::new(),
      formats: Vec::new(),
    }
  }
}

fn validate(settings: &Settings) -> Result<(), FileError> {
  if settings.version != 1 {
    return Err(FileError(
      "Unsupported settings version; file was not reset.".into(),
    ));
  }
  if !["light", "dark"].contains(&settings.theme.as_str())
    || settings.recent.len() > 20
    || settings.sessions.len() > 100
    || settings.unimportant_patterns.len() > 16
    || settings.formats.len() > 100
  {
    return Err(FileError(
      "Settings exceed supported values or bounds.".into(),
    ));
  }
  for pattern in &settings.unimportant_patterns {
    compare_text::UnimportantRule::compile(pattern).map_err(|e| FileError(e.to_string()))?;
  }
  if settings.sessions.iter().any(|session| {
    !["text", "folder", "merge"].contains(&session.mode.as_str())
      || session.name.is_empty()
      || session.name.len() > 256
  }) {
    return Err(FileError("Invalid saved session mode or name.".into()));
  }
  for format in &settings.formats {
    if !format.suffix.starts_with('.')
      || format.suffix.len() > 64
      || format.patterns.len() > 16
      || format
        .suffix
        .chars()
        .any(|c| !c.is_ascii_alphanumeric() && c != '.' && c != '_' && c != '-')
    {
      return Err(FileError(
        "Invalid file-format suffix or rule count.".into(),
      ));
    }
    for pattern in &format.patterns {
      compare_text::UnimportantRule::compile(pattern).map_err(|e| FileError(e.to_string()))?;
    }
  }
  Ok(())
}

pub fn load_settings(path: &Path) -> Result<Settings, FileError> {
  match std::fs::symlink_metadata(path) {
    Ok(_) => {
      crate::checked_path(path, false)?;
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
    Err(error) => return Err(error.into()),
  }
  let bytes = crate::document::read_bounded(path, 1024 * 1024)?;
  let settings: Settings = serde_json::from_slice(&bytes)
    .map_err(|e| FileError(format!("Settings cannot be read; original retained: {e}")))?;
  validate(&settings)?;
  Ok(settings)
}

pub fn save_settings(path: &Path, settings: &Settings) -> Result<(), FileError> {
  validate(settings)?;
  let parent = path
    .parent()
    .ok_or_else(|| FileError("Missing settings directory.".into()))?;
  let ancestor = parent
    .ancestors()
    .find(|p| p.exists())
    .ok_or_else(|| FileError("Missing settings root.".into()))?;
  crate::checked_path(ancestor, false)?;
  std::fs::create_dir_all(parent)?;
  crate::checked_path(parent, false)?;
  crate::checked_path(path, true)?;
  let bytes = serde_json::to_vec_pretty(settings).map_err(|e| FileError(e.to_string()))?;
  if bytes.len() > 1024 * 1024 {
    return Err(FileError("Settings exceed 1 MiB.".into()));
  }
  let mut temp = tempfile::NamedTempFile::new_in(parent)?;
  temp.write_all(&bytes)?;
  temp.as_file().sync_all()?;
  temp
    .persist(path)
    .map_err(|e| FileError(format!("Settings replacement failed: {}", e.error)))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn settings_restart_and_corruption_are_explicit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let mut settings = Settings {
      theme: "dark".into(),
      ..Settings::default()
    };
    save_settings(&path, &settings).unwrap();
    assert_eq!(load_settings(&path).unwrap(), settings);
    settings.version = 99;
    assert!(save_settings(&path, &settings).is_err());
    std::fs::write(&path, "{broken").unwrap();
    assert!(load_settings(&path).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{broken");
  }
  #[test]
  fn earlier_version_one_settings_migrate_additive_profiles() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let mut value = serde_json::to_value(Settings::default()).unwrap();
    value.as_object_mut().unwrap().remove("formats");
    value["sessions"] = serde_json::json!([{"name":"earlier","left":"","right":"","mode":"text"}]);
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let loaded = load_settings(&path).unwrap();
    assert!(loaded.formats.is_empty());
    assert!(loaded.sessions[0].base.is_empty());
  }
}
