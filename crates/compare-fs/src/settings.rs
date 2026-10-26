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
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub folder_rules: Option<crate::FolderRules>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
  pub version: u32,
  pub theme: String,
  pub recent: Vec<String>,
  #[serde(default)]
  pub recent_folders: Option<Vec<String>>,
  #[serde(default)]
  pub recent_comparisons: Vec<RecentComparison>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub line_detail: Option<LineDetail>,
  pub sessions: Vec<Session>,
  pub ignore_case: bool,
  pub ignore_whitespace: bool,
  pub ignore_line_endings: bool,
  pub unimportant_patterns: Vec<String>,
  #[serde(default)]
  pub formats: Vec<FormatRule>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub folder_rules: Option<crate::FolderRules>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub content_comparison: Option<ContentComparison>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineDetail {
  pub collapsed: bool,
  pub height: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentComparison {
  pub mode: String,
  pub left: String,
  pub right: String,
  #[serde(default)]
  pub base: String,
}

pub fn remember_history(
  settings: &mut Settings,
  folders: Vec<String>,
  comparison: Option<RecentComparison>,
) -> Result<(), FileError> {
  validate(settings)?;
  let mut recent = settings.recent_folders.clone().unwrap_or_default();
  for folder in folders.into_iter().rev().filter(|path| !path.is_empty()) {
    let path = crate::checked_path(Path::new(&folder), false)?;
    if !path.is_dir() {
      return Err(FileError("Recent folder must be a directory.".into()));
    }
    let path = path
      .to_str()
      .ok_or_else(|| FileError("Non-Unicode paths are unsupported.".into()))?
      .to_owned();
    recent.retain(|previous| previous != &path);
    recent.insert(0, path);
  }
  recent.truncate(20);
  settings.recent_folders = Some(recent);
  if let Some(comparison) = comparison {
    validate_comparison(&comparison)?;
    settings
      .recent_comparisons
      .retain(|item| item != &comparison);
    settings.recent_comparisons.insert(0, comparison);
    settings.recent_comparisons.truncate(20);
  }
  Ok(())
}

fn validate_comparison(comparison: &RecentComparison) -> Result<(), FileError> {
  if !["text", "folder", "merge"].contains(&comparison.mode.as_str())
    || comparison.left.is_empty()
    || comparison.right.is_empty()
    || (comparison.mode == "merge" && comparison.base.is_empty())
    || (comparison.mode != "merge" && !comparison.base.is_empty())
  {
    return Err(FileError(
      "Recent comparison requires a complete workflow tuple.".into(),
    ));
  }
  Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentComparison {
  pub method: crate::ContentMethod,
  pub show_results: bool,
  pub prompt: bool,
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
      recent_folders: Some(Vec::new()),
      recent_comparisons: Vec::new(),
      line_detail: None,
      sessions: Vec::new(),
      ignore_case: false,
      ignore_whitespace: false,
      ignore_line_endings: false,
      unimportant_patterns: Vec::new(),
      formats: Vec::new(),
      folder_rules: None,
      content_comparison: None,
    }
  }
}

fn validate(settings: &Settings) -> Result<(), FileError> {
  if settings
    .line_detail
    .as_ref()
    .is_some_and(|layout| !(80..=320).contains(&layout.height))
  {
    return Err(FileError(
      "Line detail height must be between 80 and 320 pixels.".into(),
    ));
  }
  if settings
    .recent_folders
    .as_ref()
    .is_some_and(|items| items.len() > 20)
    || settings.recent_comparisons.len() > 20
  {
    return Err(FileError("Recent history exceeds 20 entries.".into()));
  }
  for comparison in &settings.recent_comparisons {
    validate_comparison(comparison)?;
  }
  if settings.content_comparison.as_ref().is_some_and(|options| {
    !matches!(
      options.method,
      crate::ContentMethod::Binary | crate::ContentMethod::Rules | crate::ContentMethod::Crc
    )
  }) {
    return Err(FileError(
      "Selected content-comparison method is unavailable.".into(),
    ));
  }
  if let Some(rules) = &settings.folder_rules {
    rules.validate()?;
  }
  for session in &settings.sessions {
    if let Some(rules) = &session.folder_rules {
      rules.validate()?;
    }
  }
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
  let mut settings: Settings = serde_json::from_slice(&bytes)
    .map_err(|e| FileError(format!("Settings cannot be read; original retained: {e}")))?;
  validate(&settings)?;
  if settings.recent_folders.is_none() {
    let mut folders = Vec::new();
    for path in &settings.recent {
      if let Ok(path) = crate::checked_path(Path::new(path), false) {
        if path.is_dir() {
          if let Some(path) = path.to_str() {
            if !folders.iter().any(|item| item == path) {
              folders.push(path.to_owned());
            }
          }
        }
      }
    }
    settings.recent_folders = Some(folders);
  }
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
  fn history_is_bounded_deduplicated_and_migrates_only_folders() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("folder");
    std::fs::create_dir(&folder).unwrap();
    let file = root.path().join("file.txt");
    std::fs::write(&file, "private contents").unwrap();
    let path = root.path().join("settings.json");
    let legacy = Settings {
      recent: vec![
        folder.display().to_string(),
        file.display().to_string(),
        root.path().join("missing").display().to_string(),
      ],
      recent_folders: None,
      ..Default::default()
    };
    save_settings(&path, &legacy).unwrap();
    let mut settings = load_settings(&path).unwrap();
    assert_eq!(settings.recent_folders.as_ref().unwrap().len(), 1);
    assert!(settings.recent_comparisons.is_empty());
    for i in 0..25 {
      remember_history(
        &mut settings,
        vec![folder.display().to_string()],
        Some(RecentComparison {
          mode: "text".into(),
          left: format!("left-{i}"),
          right: "right".into(),
          base: "".into(),
        }),
      )
      .unwrap();
    }
    assert_eq!(settings.recent_folders.as_ref().unwrap().len(), 1);
    assert_eq!(settings.recent_comparisons.len(), 20);
    let comparison = settings.recent_comparisons[3].clone();
    remember_history(&mut settings, vec![], Some(comparison.clone())).unwrap();
    assert_eq!(settings.recent_comparisons[0], comparison);
    assert_eq!(settings.recent_comparisons.len(), 20);
    assert!(remember_history(&mut settings, vec![file.display().to_string()], None).is_err());
    save_settings(&path, &settings).unwrap();
    std::fs::remove_dir(&folder).unwrap();
    assert_eq!(load_settings(&path).unwrap(), settings);
    assert!(save_settings(root.path(), &settings).is_err());
    settings.recent_comparisons[0].mode = "merge".into();
    assert!(save_settings(&path, &settings).is_err());
  }
  #[test]
  fn settings_restart_and_corruption_are_explicit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let mut settings = Settings {
      theme: "dark".into(),
      line_detail: Some(LineDetail {
        collapsed: true,
        height: 220,
      }),
      ..Settings::default()
    };
    save_settings(&path, &settings).unwrap();
    assert_eq!(load_settings(&path).unwrap(), settings);
    settings.line_detail.as_mut().unwrap().height = 321;
    assert!(save_settings(&path, &settings).is_err());
    settings.line_detail.as_mut().unwrap().height = 220;
    settings.version = 99;
    assert!(save_settings(&path, &settings).is_err());
    std::fs::write(&path, "{broken").unwrap();
    assert!(load_settings(&path).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{broken");
  }
  #[test]
  fn approved_folder_methods_survive_settings_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let settings = Settings {
      folder_rules: Some(crate::FolderRules {
        content: crate::ContentMethod::Crc,
        executable_version: cfg!(windows),
        text_rules: crate::FolderTextRules {
          unicode_normalization: true,
          ..Default::default()
        },
        ..Default::default()
      }),
      content_comparison: Some(ContentComparison {
        method: crate::ContentMethod::Crc,
        show_results: true,
        prompt: false,
      }),
      ..Default::default()
    };
    save_settings(&path, &settings).unwrap();
    assert_eq!(load_settings(&path).unwrap(), settings);
    let invalid = Settings {
      content_comparison: Some(ContentComparison {
        method: crate::ContentMethod::None,
        show_results: true,
        prompt: true,
      }),
      ..Default::default()
    };
    assert!(save_settings(&path, &invalid).is_err());
    assert_eq!(load_settings(&path).unwrap(), settings);
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
