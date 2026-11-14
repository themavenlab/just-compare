//! Read-only display rules. Operation plans deliberately retain their independent
//! exact-path, content-hashed snapshots and never consume these display results.
use super::*;
use compare_text::{CompareOptions, DiffKind, UnimportantRule, WorkControl};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const TEXT_LIMIT: u64 = 1024 * 1024;

#[cfg(test)]
thread_local! {
    static BINARY_CHUNK_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FolderSide {
  Left,
  Right,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ComparisonImportance {
  Equal,
  Unimportant,
  Important,
  Unknown,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContentMethod {
  #[default]
  Binary,
  Rules,
  Crc,
  None,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QuickTest {
  #[default]
  None,
  Size,
  /// Size and adjusted modification time.
  Modified,
  Binary,
  Rules,
  Crc,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QuickTestPolicy {
  /// Enabled content comparison overrides the size/time quick result.
  #[default]
  Override,
  /// Equal quick results skip content; unequal quick results run content.
  Skip,
  /// Both the size/time quick tests and content comparison must agree.
  RequireAll,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderTextRules {
  pub ignore_case: bool,
  pub ignore_whitespace: bool,
  pub ignore_line_endings: bool,
  pub unimportant: Vec<String>,
  pub unicode_normalization: bool,
}

/// Independent of the legacy `FolderOptions::criterion`. Size/time quick tests
/// obey the content precedence policy; name/attribute checks remain independent.
/// Defaults compare exact bytes without a quick test.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderRules {
  pub compare_size: bool,
  pub compare_modified: bool,
  pub timestamp_tolerance_ms: u64,
  /// Minutes added to the right timestamp, not an inferred local timezone.
  pub timezone_offset_minutes: i32,
  pub ignore_dst: bool,
  pub compare_filename_case: bool,
  /// ASCII case-insensitive pairing only; Unicode case folding is not implied.
  pub align_case: bool,
  /// Pair unique files with the same parent and stem, ignoring their extension.
  pub align_extensions: bool,
  pub compare_readonly: bool,
  pub compare_archive: bool,
  pub compare_system: bool,
  pub compare_hidden: bool,
  /// Legacy aggregate Windows attribute comparison.
  pub compare_attributes: bool,
  pub content: ContentMethod,
  pub quick_test: QuickTest,
  pub quick_test_policy: QuickTestPolicy,
  pub text_rules: FolderTextRules,
  pub executable_version: bool,
}

impl FolderRules {
  pub fn validate(&self) -> Result<(), FileError> {
    if self.executable_version && !cfg!(windows) {
      return Err(FileError(
        "Capability unavailable: executable-version comparison requires Windows.".into(),
      ));
    }
    if (self.compare_attributes
      || self.compare_archive
      || self.compare_system
      || self.compare_hidden)
      && !cfg!(windows)
    {
      return Err(FileError(
        "Capability unavailable: Windows file attributes are not available on this platform."
          .into(),
      ));
    }
    if self.timestamp_tolerance_ms > JS_SAFE_INTEGER
      || self.timezone_offset_minutes.unsigned_abs() > 24 * 60
    {
      return Err(FileError(
        "Invalid timestamp tolerance or timezone offset (maximum +/-1440 minutes).".into(),
      ));
    }
    if self.quick_test_policy == QuickTestPolicy::Skip
      && ((!self.compare_size && !self.compare_modified && self.quick_test == QuickTest::None)
        || self.content == ContentMethod::None)
    {
      return Err(FileError(
        "Quick-test skip requires both a quick test and a content method.".into(),
      ));
    }
    if self.content == ContentMethod::None
      && self.quick_test == QuickTest::None
      && !(self.compare_size
        || self.compare_modified
        || self.compare_filename_case
        || self.compare_readonly
        || self.compare_archive
        || self.compare_system
        || self.compare_hidden
        || self.compare_attributes
        || self.executable_version)
    {
      return Err(FileError("Select at least one comparison test.".into()));
    }
    compile_rules(&self.text_rules)?;
    Ok(())
  }
}

fn compile_rules(rules: &FolderTextRules) -> Result<Vec<UnimportantRule>, FileError> {
  if rules.unimportant.len() > 16 {
    return Err(FileError(
      "At most 16 unimportant-difference rules are supported.".into(),
    ));
  }
  rules
    .unimportant
    .iter()
    .map(|pattern| UnimportantRule::compile(pattern).map_err(|e| FileError(e.to_string())))
    .collect()
}

/// Validate an entire Rules Apply transaction without touching the filesystem.
pub fn validate_folder_configuration(
  rules: &FolderRules,
  options: &FolderOptions,
) -> Result<(), FileError> {
  rules.validate()?;
  exclusion_filters(options)?;
  Ok(())
}

pub(super) fn modified_ms(time: SystemTime) -> Option<u64> {
  let millis = time.duration_since(UNIX_EPOCH).ok()?.as_millis();
  (millis <= u128::from(JS_SAFE_INTEGER)).then_some(millis as u64)
}

fn signed_millis(time: SystemTime) -> i128 {
  match time.duration_since(UNIX_EPOCH) {
    Ok(value) => value.as_millis() as i128,
    Err(value) => -(value.duration().as_millis() as i128),
  }
}

fn time_difference(left: SystemTime, right: SystemTime, rules: &FolderRules) -> i128 {
  let difference = signed_millis(left)
    - (signed_millis(right) + i128::from(rules.timezone_offset_minutes) * 60_000);
  if rules.ignore_dst {
    [difference, difference - 3_600_000, difference + 3_600_000]
      .into_iter()
      .min_by_key(|value| value.abs())
      .unwrap()
  } else {
    difference
  }
}

struct Item {
  metadata: Option<fs::Metadata>,
  error: Option<String>,
}

fn side_label(side: FolderSide) -> &'static str {
  match side {
    FolderSide::Left => "left",
    FolderSide::Right => "right",
  }
}

fn collect(
  root: &Path,
  side: FolderSide,
  options: &FolderOptions,
  cancelled: &AtomicBool,
  progress: &mut impl FnMut(usize),
) -> Result<BTreeMap<String, Item>, FileError> {
  if !root.is_dir() {
    return Err(
      FileError("Folder root must be a directory.".into()).context(format!(
        "Could not read the {} folder \"{}\"",
        side_label(side),
        crate::display_path(root)
      )),
    );
  }
  let filters = exclusion_filters(options)?;
  let mut items: BTreeMap<String, Item> = BTreeMap::new();
  let mut stack = vec![(root.to_path_buf(), String::new())];
  while let Some((directory, directory_name)) = stack.pop() {
    cancel(cancelled)?;
    let children = match checked_path(&directory, false).and_then(|_| Ok(fs::read_dir(&directory)?))
    {
      Ok(children) => children,
      Err(error) if !directory_name.is_empty() => {
        if let Some(item) = items.get_mut(&directory_name) {
          item.error = Some(error.to_string());
        }
        continue;
      }
      Err(error) => {
        return Err(error.context(format!(
          "Could not read the {} folder \"{}\"",
          side_label(side),
          crate::display_path(root)
        )));
      }
    };
    for child in children {
      cancel(cancelled)?;
      let child = child?;
      let path = child.path();
      let relative = path
        .strip_prefix(root)
        .map_err(|e| FileError(e.to_string()))?
        .components()
        .map(|part| {
          part
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
        Some(checked_path(&path, false).and_then(|_| Ok(fs::symlink_metadata(&path)?)))
      } else {
        None
      };
      if let Some(Ok(metadata)) = &metadata {
        if (glob_excludes_directory && metadata.is_dir())
          || (filters.files.contains(&relative) && metadata.is_file())
          || (filters.directories.contains(&relative) && metadata.is_dir())
        {
          continue;
        }
      }
      if items.len() == MAX_ENTRIES {
        return Err(FileError(
          "Folder exceeds the 10,000-entry prototype limit.".into(),
        ));
      }
      let metadata = match metadata {
        Some(metadata) => metadata,
        None => checked_path(&path, false).and_then(|_| Ok(fs::symlink_metadata(&path)?)),
      };
      let item = match metadata {
        Ok(metadata) if metadata.is_file() || metadata.is_dir() => {
          if metadata.is_dir() {
            stack.push((path, relative.clone()));
          }
          let error = metadata.modified().err().map(|e| e.to_string());
          Item {
            metadata: Some(metadata),
            error,
          }
        }
        Ok(_) => Item {
          metadata: None,
          error: Some("Only regular files and directories are supported.".into()),
        },
        Err(error) => Item {
          metadata: None,
          error: Some(error.to_string()),
        },
      };
      items.insert(relative, item);
      progress(items.len());
    }
  }
  Ok(items)
}

fn alignment_key(name: &str, rules: &FolderRules) -> (String, String) {
  let (parent, filename) = name.rsplit_once('/').unwrap_or(("", name));
  let filename = if rules.align_extensions {
    Path::new(filename)
      .file_stem()
      .and_then(|s| s.to_str())
      .unwrap_or(filename)
  } else {
    filename
  };
  let filename = if rules.text_rules.unicode_normalization {
    filename.nfc().collect::<String>()
  } else {
    filename.into()
  };
  (
    parent.into(),
    if rules.align_case {
      filename.to_ascii_lowercase()
    } else {
      filename
    },
  )
}

fn pair_names(
  left: &BTreeMap<String, Item>,
  right: &BTreeMap<String, Item>,
  rules: &FolderRules,
) -> Vec<(Option<String>, Option<String>)> {
  let mut pairs = Vec::new();
  let mut unmatched_left = BTreeMap::<_, Vec<_>>::new();
  let mut unmatched_right = BTreeMap::<_, Vec<_>>::new();
  let is_dir = |item: &Item| item.metadata.as_ref().is_some_and(|m| m.is_dir());
  for (name, item) in left {
    match right.get(name) {
      Some(other) if is_dir(item) == is_dir(other) => {
        pairs.push((Some(name.clone()), Some(name.clone())));
      }
      // A file and a folder with the same name are separate rows.
      Some(_) => pairs.push((Some(name.clone()), None)),
      None
        if (rules.align_case
          || rules.align_extensions
          || rules.text_rules.unicode_normalization)
          && item.metadata.as_ref().is_some_and(|m| m.is_file()) =>
      {
        unmatched_left
          .entry(alignment_key(name, rules))
          .or_default()
          .push(name.clone());
      }
      None => pairs.push((Some(name.clone()), None)),
    }
  }
  for (name, item) in right {
    match left.get(name) {
      Some(other) if is_dir(item) == is_dir(other) => continue,
      Some(_) => pairs.push((None, Some(name.clone()))),
      None
        if (rules.align_case
          || rules.align_extensions
          || rules.text_rules.unicode_normalization)
          && item.metadata.as_ref().is_some_and(|m| m.is_file()) =>
      {
        unmatched_right
          .entry(alignment_key(name, rules))
          .or_default()
          .push(name.clone());
      }
      None => pairs.push((None, Some(name.clone()))),
    }
  }
  for (key, names) in unmatched_left {
    let others = unmatched_right.remove(&key).unwrap_or_default();
    if names.len() == 1 && others.len() == 1 {
      pairs.push((Some(names[0].clone()), Some(others[0].clone())));
    } else {
      pairs.extend(names.into_iter().map(|name| (Some(name), None)));
      pairs.extend(others.into_iter().map(|name| (None, Some(name))));
    }
  }
  for names in unmatched_right.into_values() {
    pairs.extend(names.into_iter().map(|name| (None, Some(name))));
  }
  // Same-name rows sort folder-first so a file row never precedes its folder.
  pairs.sort_by(|a, b| {
    let key = |pair: &(Option<String>, Option<String>)| {
      let name = pair.0.as_ref().or(pair.1.as_ref()).cloned();
      let directory = [(&pair.0, left), (&pair.1, right)]
        .into_iter()
        .find_map(|(name, map)| name.as_ref().and_then(|n| map.get(n)))
        .is_some_and(is_dir);
      (name, !directory)
    };
    key(a).cmp(&key(b))
  });
  pairs
}

fn stable(metadata: &fs::Metadata, after: &fs::Metadata) -> Result<(), FileError> {
  if !after.is_file()
    || metadata.len() != after.len()
    || metadata.modified()? != after.modified()?
  {
    return Err(FileError("File changed while comparing.".into()));
  }
  Ok(())
}

fn open(path: &Path, metadata: &fs::Metadata, limit: u64) -> Result<fs::File, FileError> {
  checked_path(path, false)?;
  if metadata.len() > limit {
    return Err(FileError(if limit == TEXT_LIMIT {
      "Rules-based text comparison requires each input to be at most 1 MiB.".into()
    } else {
      "Binary comparison requires each input to be at most 100 MiB.".into()
    }));
  }
  let file = fs::File::open(path)?;
  stable(metadata, &file.metadata()?)?;
  Ok(file)
}

fn binary(
  left: &Path,
  right: &Path,
  lm: &fs::Metadata,
  rm: &fs::Metadata,
  cancelled: &AtomicBool,
) -> Result<ComparisonImportance, FileError> {
  cancel(cancelled)?;
  if lm.len() != rm.len() {
    checked_path(left, false)?;
    checked_path(right, false)?;
    return Ok(ComparisonImportance::Important);
  }
  let mut left = open(left, lm, MAX_FILE_BYTES)?;
  let mut right = open(right, rm, MAX_FILE_BYTES)?;
  let mut a = [0u8; 64 * 1024];
  let mut b = [0u8; 64 * 1024];
  let mut offset = 0;
  while offset < lm.len() {
    cancel(cancelled)?;
    let alen = (lm.len().saturating_sub(offset)).min(a.len() as u64) as usize;
    #[cfg(test)]
    BINARY_CHUNK_READS.with(|reads| reads.set(reads.get() + 1));
    left.read_exact(&mut a[..alen])?;
    right.read_exact(&mut b[..alen])?;
    if a[..alen] != b[..alen] {
      stable(lm, &left.metadata()?)?;
      stable(rm, &right.metadata()?)?;
      cancel(cancelled)?;
      return Ok(ComparisonImportance::Important);
    }
    offset += alen as u64;
  }
  if left.read(&mut a[..1])? != 0 || right.read(&mut b[..1])? != 0 {
    return Err(FileError("File grew while comparing.".into()));
  }
  stable(lm, &left.metadata()?)?;
  stable(rm, &right.metadata()?)?;
  cancel(cancelled)?;
  Ok(ComparisonImportance::Equal)
}

fn read_text(
  path: &Path,
  metadata: &fs::Metadata,
  cancelled: &AtomicBool,
) -> Result<Vec<u8>, FileError> {
  let mut file = open(path, metadata, TEXT_LIMIT)?;
  let mut bytes = Vec::new();
  let mut chunk = [0u8; 64 * 1024];
  loop {
    cancel(cancelled)?;
    let count = file.read(&mut chunk)?;
    if count == 0 {
      break;
    }
    if bytes.len() + count > TEXT_LIMIT as usize {
      return Err(FileError(
        "Rules-based text comparison requires each input to be at most 1 MiB.".into(),
      ));
    }
    bytes.extend_from_slice(&chunk[..count]);
  }
  stable(metadata, &file.metadata()?)?;
  if bytes.len() as u64 != metadata.len() {
    return Err(FileError("File changed while comparing.".into()));
  }
  Ok(bytes)
}

fn crc(path: &Path, metadata: &fs::Metadata, cancelled: &AtomicBool) -> Result<u32, FileError> {
  let mut file = open(path, metadata, MAX_FILE_BYTES)?;
  let mut hasher = crc32fast::Hasher::new();
  let mut chunk = [0u8; 64 * 1024];
  let mut remaining = metadata.len();
  while remaining > 0 {
    cancel(cancelled)?;
    let count = remaining.min(chunk.len() as u64) as usize;
    file.read_exact(&mut chunk[..count])?;
    hasher.update(&chunk[..count]);
    remaining -= count as u64;
  }
  if file.read(&mut chunk[..1])? != 0 {
    return Err(FileError("File grew while comparing CRC.".into()));
  }
  stable(metadata, &file.metadata()?)?;
  cancel(cancelled)?;
  Ok(hasher.finalize())
}

fn executable(path: &Path) -> bool {
  path
    .extension()
    .and_then(|s| s.to_str())
    .is_some_and(|ext| {
      ["exe", "dll", "ocx", "sys", "scr", "cpl"]
        .iter()
        .any(|candidate| ext.eq_ignore_ascii_case(candidate))
    })
}

fn version(
  path: &Path,
  metadata: &fs::Metadata,
  cancelled: &AtomicBool,
) -> Result<crate::windows_metadata::ExecutableVersion, FileError> {
  cancel(cancelled)?;
  let file = open(path, metadata, MAX_FILE_BYTES)?;
  let result = crate::windows_metadata::file_version(path)?;
  stable(metadata, &file.metadata()?)?;
  stable(metadata, &fs::metadata(path)?)?;
  cancel(cancelled)?;
  Ok(result)
}

struct ContentComparison<'a> {
  left: &'a Path,
  right: &'a Path,
  lm: &'a fs::Metadata,
  rm: &'a fs::Metadata,
  rules: &'a FolderRules,
  compiled: &'a [UnimportantRule],
  cancelled: &'a AtomicBool,
}

impl ContentComparison<'_> {
  fn run(&self, method: ContentMethod) -> Result<ComparisonImportance, FileError> {
    match method {
      ContentMethod::None => Ok(ComparisonImportance::Equal),
      ContentMethod::Crc => {
        let left = crc(self.left, self.lm, self.cancelled)?;
        let right = crc(self.right, self.rm, self.cancelled)?;
        Ok(if self.lm.len() == self.rm.len() && left == right {
          ComparisonImportance::Equal
        } else {
          ComparisonImportance::Important
        })
      }
      ContentMethod::Binary => binary(self.left, self.right, self.lm, self.rm, self.cancelled),
      ContentMethod::Rules => {
        let a = read_text(self.left, self.lm, self.cancelled)?;
        let b = read_text(self.right, self.rm, self.cancelled)?;
        let left = compare_text::decode(&a, None).map_err(|e| FileError(e.to_string()))?;
        let right = compare_text::decode(&b, None).map_err(|e| FileError(e.to_string()))?;
        let spans = compare_text::compare_with_rules(
          left.text(),
          right.text(),
          CompareOptions {
            ignore_case: self.rules.text_rules.ignore_case,
            ignore_whitespace: self.rules.text_rules.ignore_whitespace,
            ignore_line_endings: self.rules.text_rules.ignore_line_endings,
          },
          self.compiled,
          WorkControl::new(self.cancelled, Duration::from_secs(2)),
        )
        .map_err(|e| FileError(e.to_string()))?;
        Ok(if spans.iter().any(|span| span.kind != DiffKind::Equal) {
          ComparisonImportance::Important
        } else if a == b {
          ComparisonImportance::Equal
        } else {
          ComparisonImportance::Unimportant
        })
      }
    }
  }

  fn compare(&self) -> Result<ComparisonImportance, FileError> {
    if self.rules.quick_test_policy == QuickTestPolicy::Override
      && self.rules.content != ContentMethod::None
    {
      return self.run(self.rules.content);
    }
    let metadata_quick = if self.rules.compare_size || self.rules.compare_modified {
      let same = (!self.rules.compare_size || self.lm.len() == self.rm.len())
        && (!self.rules.compare_modified
          || time_difference(self.lm.modified()?, self.rm.modified()?, self.rules).abs()
            <= i128::from(self.rules.timestamp_tolerance_ms));
      Some(if same {
        ComparisonImportance::Equal
      } else {
        ComparisonImportance::Important
      })
    } else {
      None
    };
    let legacy_quick = match self.rules.quick_test {
      QuickTest::None => None,
      QuickTest::Size | QuickTest::Modified => {
        let same = self.lm.len() == self.rm.len()
          && (self.rules.quick_test == QuickTest::Size
            || time_difference(self.lm.modified()?, self.rm.modified()?, self.rules).abs()
              <= i128::from(self.rules.timestamp_tolerance_ms));
        Some(if same {
          ComparisonImportance::Equal
        } else {
          ComparisonImportance::Important
        })
      }
      QuickTest::Binary => Some(self.run(ContentMethod::Binary)?),
      QuickTest::Rules => Some(self.run(ContentMethod::Rules)?),
      QuickTest::Crc => Some(self.run(ContentMethod::Crc)?),
    };
    let quick = match (metadata_quick, legacy_quick) {
      (None, None) => return self.run(self.rules.content),
      (Some(value), None) | (None, Some(value)) => value,
      (Some(a), Some(b)) => {
        if a == ComparisonImportance::Important || b == ComparisonImportance::Important {
          ComparisonImportance::Important
        } else if a == ComparisonImportance::Unimportant || b == ComparisonImportance::Unimportant {
          ComparisonImportance::Unimportant
        } else {
          ComparisonImportance::Equal
        }
      }
    };
    if self.rules.content == ContentMethod::None {
      return Ok(quick);
    }
    match self.rules.quick_test_policy {
      QuickTestPolicy::Override => self.run(self.rules.content),
      QuickTestPolicy::Skip if quick != ComparisonImportance::Important => Ok(quick),
      QuickTestPolicy::Skip => self.run(self.rules.content),
      QuickTestPolicy::RequireAll => {
        let content = self.run(self.rules.content)?;
        Ok(if quick == ComparisonImportance::Important {
          ComparisonImportance::Important
        } else {
          content
        })
      }
    }
  }
}

#[cfg(windows)]
fn attributes(metadata: &fs::Metadata) -> u32 {
  use std::os::windows::fs::MetadataExt;
  metadata.file_attributes()
}
#[cfg(not(windows))]
fn attributes(_: &fs::Metadata) -> u32 {
  // validate() rejects this capability on non-Windows platforms.
  0
}

fn selected_attribute_mask(rules: &FolderRules) -> u32 {
  (if rules.compare_archive { 0x20 } else { 0 })
    | (if rules.compare_system { 0x4 } else { 0 })
    | (if rules.compare_hidden { 0x2 } else { 0 })
}

/// The legacy criterion is intentionally ignored; `options` supplies exclusions.
/// Error rows carry actual per-side names and never imply equality.
pub fn scan_pair_with_rules(
  left: &Path,
  right: &Path,
  options: &FolderOptions,
  rules: &FolderRules,
  cancelled: &AtomicBool,
  progress: impl FnMut(usize) + Send,
) -> Result<Vec<FolderEntry>, FileError> {
  scan_with_selection(
    left, right, options, rules, None, false, cancelled, progress,
  )
}

/// Enumerate bounded root metadata, but read contents only for selected rows and
/// descendants. Either actual side path identifies an aligned pair.
pub fn scan_selected_with_rules(
  left: &Path,
  right: &Path,
  options: &FolderOptions,
  rules: &FolderRules,
  selected: &[String],
  cancelled: &AtomicBool,
  progress: impl FnMut(usize) + Send,
) -> Result<Vec<FolderEntry>, FileError> {
  validate_selection(selected)?;
  scan_with_selection(
    left,
    right,
    options,
    rules,
    Some(selected),
    false,
    cancelled,
    progress,
  )
}

fn validate_selection(selected: &[String]) -> Result<(), FileError> {
  if selected.is_empty() || selected.len() > MAX_ENTRIES {
    return Err(FileError("Select between 1 and 10,000 folder rows.".into()));
  }
  for name in selected {
    if name.is_empty()
      || name
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
      || Path::new(name)
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
      return Err(FileError(
        "Selection must contain only relative folder row paths.".into(),
      ));
    }
  }
  Ok(())
}

/// Refresh selected contents and all directory metadata/aggregates, retaining
/// unselected file display results. Previous rows are never operation authority.
#[allow(clippy::too_many_arguments)]
pub fn refresh_selection(
  left: &Path,
  right: &Path,
  options: &FolderOptions,
  rules: &FolderRules,
  selected: &[String],
  previous: &[FolderEntry],
  cancelled: &AtomicBool,
  progress: impl FnMut(usize) + Send,
) -> Result<Vec<FolderEntry>, FileError> {
  validate_selection(selected)?;
  if previous.len() > MAX_ENTRIES * 2 {
    return Err(FileError(
      "Previous presentation exceeds the bounded folder limit.".into(),
    ));
  }
  let mut expanded: BTreeSet<String> = selected.iter().cloned().collect();
  let mut names = BTreeSet::new();
  for row in previous {
    cancel(cancelled)?;
    validate_selection(std::slice::from_ref(&row.relative))?;
    for name in [&row.left_relative, &row.right_relative]
      .into_iter()
      .flatten()
    {
      validate_selection(std::slice::from_ref(name))?;
    }
    if !names.insert((row.relative.clone(), row.is_directory)) {
      return Err(FileError(
        "Previous presentation contains duplicate rows.".into(),
      ));
    }
    if [&row.left_relative, &row.right_relative]
      .into_iter()
      .flatten()
      .chain(std::iter::once(&row.relative))
      .any(|name| selected_name(name, selected))
    {
      expanded.extend(
        [row.left_relative.clone(), row.right_relative.clone()]
          .into_iter()
          .flatten(),
      );
    }
  }
  let expanded: Vec<_> = expanded.into_iter().collect();
  let fresh = scan_with_selection(
    left,
    right,
    options,
    rules,
    Some(&expanded),
    true,
    cancelled,
    progress,
  )?;
  let mut merged: BTreeMap<(String, bool), FolderEntry> = previous
    .iter()
    .filter(|row| {
      !row.is_directory
        && ![
          row.left_relative.as_deref(),
          row.right_relative.as_deref(),
          Some(&row.relative),
        ]
        .into_iter()
        .flatten()
        .any(|name| selected_name(name, &expanded))
    })
    .map(|row| ((row.relative.clone(), row.is_directory), row.clone()))
    .collect();
  for row in fresh {
    if row.is_directory
      && !names.contains(&(row.relative.clone(), true))
      && !selected_name(&row.relative, &expanded)
      && !expanded.iter().any(|name| {
        name
          .strip_prefix(&row.relative)
          .is_some_and(|suffix| suffix.starts_with('/'))
      })
    {
      continue;
    }
    merged.insert((row.relative.clone(), row.is_directory), row);
  }
  if merged.len() > MAX_ENTRIES * 2 {
    return Err(FileError(
      "Refreshed presentation exceeds the bounded folder limit.".into(),
    ));
  }
  let mut rows: Vec<_> = merged.into_values().collect();
  aggregate_directories(&mut rows);
  cancel(cancelled)?;
  Ok(rows)
}

fn selected_name(name: &str, selected: &[String]) -> bool {
  selected.iter().any(|parent| {
    name == parent
      || name
        .strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
  })
}

#[allow(clippy::too_many_arguments)]
fn scan_with_selection(
  left: &Path,
  right: &Path,
  options: &FolderOptions,
  rules: &FolderRules,
  selected: Option<&[String]>,
  refresh: bool,
  cancelled: &AtomicBool,
  mut progress: impl FnMut(usize) + Send,
) -> Result<Vec<FolderEntry>, FileError> {
  rules.validate()?;
  cancel(cancelled)?;
  let compiled = compile_rules(&rules.text_rules)?;
  let single_side = left.as_os_str().is_empty() || right.as_os_str().is_empty();
  if left.as_os_str().is_empty() && right.as_os_str().is_empty() {
    return Err(FileError("Choose at least one folder root.".into()));
  }
  if single_side && selected.is_some() {
    return Err(FileError(
      "Selected comparison requires both folder roots.".into(),
    ));
  }
  let (left, right) = if single_side {
    let validate = |path: &Path, side: FolderSide| {
      if path.as_os_str().is_empty() {
        Ok(PathBuf::new())
      } else {
        checked_path(path, false).map_err(|error| {
          error.context(format!(
            "Could not read the {} folder \"{}\"",
            side_label(side),
            crate::display_path(path)
          ))
        })
      }
    };
    (
      validate(left, FolderSide::Left)?,
      validate(right, FolderSide::Right)?,
    )
  } else {
    roots(left, right)?
  };
  let a = if left.as_os_str().is_empty() {
    BTreeMap::new()
  } else {
    collect(&left, FolderSide::Left, options, cancelled, &mut progress)?
  };
  let b = if right.as_os_str().is_empty() {
    BTreeMap::new()
  } else {
    collect(
      &right,
      FolderSide::Right,
      options,
      cancelled,
      &mut |count| progress(a.len() + count),
    )?
  };
  if let Some(selected) = selected {
    if !refresh
      && selected
        .iter()
        .any(|name| !a.contains_key(name) && !b.contains_key(name))
    {
      return Err(FileError(
        "Selected row is missing or excluded; rescan before comparing contents.".into(),
      ));
    }
  }
  let mut rows = Vec::new();
  for (ln, rn) in pair_names(&a, &b, rules) {
    cancel(cancelled)?;
    let is_directory = ln
      .as_ref()
      .and_then(|name| a.get(name))
      .or_else(|| rn.as_ref().and_then(|name| b.get(name)))
      .and_then(|item| item.metadata.as_ref())
      .is_some_and(|m| m.is_dir());
    if !(refresh && is_directory)
      && selected.is_some_and(|selected| {
        ![ln.as_deref(), rn.as_deref()]
          .into_iter()
          .flatten()
          .any(|name| selected_name(name, selected))
      })
    {
      continue;
    }
    let l = ln.as_ref().and_then(|name| a.get(name));
    let r = rn.as_ref().and_then(|name| b.get(name));
    let lm = l.and_then(|item| item.metadata.as_ref());
    let rm = r.and_then(|item| item.metadata.as_ref());
    let mut row = FolderEntry {
      relative: ln.as_ref().or(rn.as_ref()).unwrap().clone(),
      left_relative: ln.clone(),
      right_relative: rn.clone(),
      left_kind: lm.map(|metadata| {
        if metadata.is_dir() {
          FolderEntryKind::Directory
        } else {
          FolderEntryKind::File
        }
      }),
      right_kind: rm.map(|metadata| {
        if metadata.is_dir() {
          FolderEntryKind::Directory
        } else {
          FolderEntryKind::File
        }
      }),
      status: FolderStatus::Error,
      left_size: lm.map(|m| m.len()),
      right_size: rm.map(|m| m.len()),
      left_modified: lm.and_then(|m| m.modified().ok()).and_then(modified_ms),
      right_modified: rm.and_then(|m| m.modified().ok()).and_then(modified_ms),
      newer: None,
      newer_mixed: false,
      importance: ComparisonImportance::Unknown,
      error: None,
      detail: None,
      is_directory: lm.is_some_and(|metadata| metadata.is_dir())
        || rm.is_some_and(|metadata| metadata.is_dir()),
    };
    let result = (|| -> Result<ComparisonImportance, FileError> {
      if !single_side
        && rules.align_case
        && ln != rn
        && (ln.is_none() || rn.is_none())
        && [ln.as_deref(), rn.as_deref()]
          .into_iter()
          .flatten()
          .any(|name| !name.rsplit('/').next().unwrap_or(name).is_ascii())
      {
        return Err(FileError("Capability unavailable: non-ASCII case folding is not supported; Unicode normalization does not imply case folding.".into()));
      }
      let errors: Vec<_> = [("Left", l), ("Right", r)]
        .into_iter()
        .filter_map(|(side, item)| {
          item
            .and_then(|item| item.error.as_ref())
            .map(|error| format!("{side}: {error}"))
        })
        .collect();
      if !errors.is_empty() {
        return Err(FileError(errors.join("; ")));
      }
      let (Some(lm), Some(rm)) = (lm, rm) else {
        row.status = if l.is_some() {
          FolderStatus::LeftOnly
        } else {
          FolderStatus::RightOnly
        };
        if single_side {
          row.detail = Some("Not compared: choose the other folder root.".into());
          return Ok(ComparisonImportance::Unknown);
        }
        return Ok(ComparisonImportance::Important);
      };
      let difference = time_difference(lm.modified()?, rm.modified()?, rules);
      if !lm.is_dir() && difference.abs() > i128::from(rules.timestamp_tolerance_ms) {
        row.newer = Some(if difference > 0 {
          FolderSide::Left
        } else {
          FolderSide::Right
        });
      }
      // Directory timestamps/sizes are not meaningful file-content tests.
      let mut metadata_different = (rules.compare_filename_case && ln != rn)
        || (rules.compare_readonly && lm.permissions().readonly() != rm.permissions().readonly())
        || (rules.compare_attributes && attributes(lm) != attributes(rm))
        || ((attributes(lm) ^ attributes(rm)) & selected_attribute_mask(rules) != 0);
      if rules.executable_version && !lm.is_dir() {
        let left_path = left.join(ln.as_ref().unwrap());
        let right_path = right.join(rn.as_ref().unwrap());
        if executable(&left_path) || executable(&right_path) {
          let left = version(&left_path, lm, cancelled)?;
          let right = version(&right_path, rm, cancelled)?;
          metadata_different |= left != right;
          let display = |v: [u16; 4]| v.map(|part| part.to_string()).join(".");
          row.detail = Some(format!(
            "File versions: left {} / right {}; product versions: left {} / right {}",
            display(left.file),
            display(right.file),
            display(left.product),
            display(right.product),
          ));
        }
      }
      let content = if lm.is_dir() {
        ComparisonImportance::Equal
      } else {
        ContentComparison {
          left: &left.join(ln.as_ref().unwrap()),
          right: &right.join(rn.as_ref().unwrap()),
          lm,
          rm,
          rules,
          compiled: &compiled,
          cancelled,
        }
        .compare()?
      };
      let importance = if metadata_different {
        ComparisonImportance::Important
      } else {
        content
      };
      row.status = if importance == ComparisonImportance::Important {
        FolderStatus::Different
      } else {
        FolderStatus::Same
      };
      Ok(importance)
    })();
    match result {
      Ok(importance) => {
        row.importance = importance;
        if row.status == FolderStatus::Error {
          row.status = if importance == ComparisonImportance::Important {
            FolderStatus::Different
          } else {
            FolderStatus::Same
          };
        }
      }
      Err(error) => {
        cancel(cancelled)?;
        row.status = FolderStatus::Error;
        row.error = Some(error.to_string());
        row.detail = row.error.clone();
      }
    }
    rows.push(row);
  }
  if !refresh {
    aggregate_directories(&mut rows);
  }
  progress(a.len() + b.len());
  Ok(rows)
}

fn aggregate_directories(rows: &mut [FolderEntry]) {
  // Aggregate immediate children deepest-first so each row contributes once.
  // Only directories can be parents; a same-name file row must not shadow its folder.
  let mut by_name = BTreeMap::new();
  for (index, row) in rows.iter().enumerate() {
    if row.is_directory {
      by_name.insert(row.relative.clone(), index);
    }
  }
  let mut order: Vec<_> = (0..rows.len()).collect();
  order.sort_by_key(|&index| std::cmp::Reverse(rows[index].relative.matches('/').count()));
  for index in order {
    let Some((parent, _)) = rows[index].relative.rsplit_once('/') else {
      continue;
    };
    let Some(&parent_index) = by_name.get(parent) else {
      continue;
    };
    let child_status = rows[index].status;
    let child_importance = rows[index].importance;
    let child_newer = rows[index].newer;
    let child_mixed = rows[index].newer_mixed;
    let parent = &mut rows[parent_index];
    if child_status == FolderStatus::Error {
      parent.status = FolderStatus::Error;
      parent.importance = ComparisonImportance::Unknown;
      if parent.error.is_none() {
        parent.error = Some("One or more descendants could not be compared.".into());
        parent.detail = parent.error.clone();
      }
    } else if parent.status != FolderStatus::Error {
      if parent.status == FolderStatus::Same && child_status != FolderStatus::Same {
        parent.status = FolderStatus::Different;
      }
      if child_importance == ComparisonImportance::Important {
        parent.importance = ComparisonImportance::Important;
      } else if child_importance == ComparisonImportance::Unimportant
        && parent.importance == ComparisonImportance::Equal
      {
        parent.importance = ComparisonImportance::Unimportant;
      }
    }
    if child_mixed
      || (parent.newer.is_some() && child_newer.is_some() && parent.newer != child_newer)
    {
      parent.newer_mixed = true;
      parent.newer = None;
    } else if !parent.newer_mixed && child_newer.is_some() {
      parent.newer = child_newer;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Fixture {
    _directory: tempfile::TempDir,
    left: PathBuf,
    right: PathBuf,
  }

  impl Fixture {
    fn new() -> Self {
      let directory = tempfile::Builder::new()
        .prefix(".folder-rules-test-")
        .tempdir_in(std::env::current_dir().unwrap())
        .unwrap();
      let left = directory.path().join("left");
      let right = directory.path().join("right");
      fs::create_dir(&left).unwrap();
      fs::create_dir(&right).unwrap();
      Self {
        _directory: directory,
        left,
        right,
      }
    }

    fn files(&self, left: &[u8], right: &[u8]) {
      fs::write(self.left.join("file"), left).unwrap();
      fs::write(self.right.join("file"), right).unwrap();
    }

    fn scan(&self, rules: &FolderRules) -> Vec<FolderEntry> {
      scan_pair_with_rules(
        &self.left,
        &self.right,
        &FolderOptions::default(),
        rules,
        &AtomicBool::new(false),
        |_| {},
      )
      .unwrap()
    }

    fn times(&self, left: u64, right: u64) {
      for (root, millis) in [(&self.left, left), (&self.right, right)] {
        fs::File::options()
          .write(true)
          .open(root.join("file"))
          .unwrap()
          .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(millis)))
          .unwrap();
      }
    }
  }

  #[test]
  fn missing_left_root_error_names_side_and_path() {
    let fixture = Fixture::new();
    let missing = fixture.left.join("missing");
    let error = scan_pair_with_rules(
      &missing,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules::default(),
      &AtomicBool::new(false),
      |_| {},
    )
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("Could not read the left folder"));
    assert!(error.contains(&crate::display_path(&missing)));
    assert!(error.contains("os error") || error.contains("No such file"));
  }

  #[test]
  fn defaults_compare_exact_bytes_and_legacy_criterion_is_not_reused() {
    let fixture = Fixture::new();
    fixture.files(b"one", b"two");
    let rows = fixture.scan(&FolderRules::default());
    assert_eq!(rows[0].status, FolderStatus::Different);
    assert_eq!(rows[0].importance, ComparisonImportance::Important);
    let rows = scan_pair_with_rules(
      &fixture.left,
      &fixture.right,
      &FolderOptions {
        criterion: Criterion::Size,
        exclude: vec![],
        ..Default::default()
      },
      &FolderRules::default(),
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert_eq!(rows[0].status, FolderStatus::Different);
    assert_eq!(
      scan_pair(
        &fixture.left,
        &fixture.right,
        &FolderOptions {
          criterion: Criterion::Size,
          exclude: vec![],
          ..Default::default()
        },
        &AtomicBool::new(false),
        |_| {},
      )
      .unwrap()[0]
        .status,
      FolderStatus::Same
    );
  }

  #[test]
  fn text_rules_distinguish_unimportant_and_important_differences() {
    let fixture = Fixture::new();
    fixture.files(b"Hello 123\r\n", b"hello 456\n");
    let rules = FolderRules {
      content: ContentMethod::Rules,
      text_rules: FolderTextRules {
        ignore_case: true,
        ignore_line_endings: true,
        unimportant: vec!["[0-9]+".into()],
        ..Default::default()
      },
      ..Default::default()
    };
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Same);
    assert_eq!(rows[0].importance, ComparisonImportance::Unimportant);
    fixture.files(b"Hello 123\r\n", b"goodbye 456\n");
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    fixture.files(b"\xff", b"\xff");
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Error);
    assert_eq!(
      fixture.scan(&FolderRules::default())[0].status,
      FolderStatus::Same
    );
  }

  #[test]
  fn quick_test_override_and_skip_have_explicit_precedence() {
    let fixture = Fixture::new();
    fixture.files(b"HELLO", b"hello");
    let mut rules = FolderRules {
      content: ContentMethod::Rules,
      quick_test: QuickTest::Binary,
      text_rules: FolderTextRules {
        ignore_case: true,
        ..Default::default()
      },
      ..Default::default()
    };
    assert_eq!(
      fixture.scan(&rules)[0].importance,
      ComparisonImportance::Unimportant
    );
    rules.quick_test_policy = QuickTestPolicy::RequireAll;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    rules.quick_test_policy = QuickTestPolicy::Skip;
    assert_eq!(
      fixture.scan(&rules)[0].importance,
      ComparisonImportance::Unimportant
    );
    rules.quick_test = QuickTest::Rules;
    rules.content = ContentMethod::Binary;
    assert_eq!(
      fixture.scan(&rules)[0].importance,
      ComparisonImportance::Unimportant
    );
    rules.compare_size = true;
    fixture.files(b"HELLO ", b"hello");
    rules.text_rules.ignore_whitespace = true;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
  }

  #[test]
  fn metadata_quick_tests_use_size_and_adjusted_time_without_content_reads() {
    let fixture = Fixture::new();
    fixture.files(b"ONE", b"two");
    let base = 1_700_000_000_000;
    fixture.times(base, base + 3_600_000);
    let mut rules = FolderRules {
      compare_size: true,
      content: ContentMethod::None,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    rules.compare_modified = true;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    rules.ignore_dst = true;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    rules.ignore_dst = false;
    rules.content = ContentMethod::Binary;
    // Content, rather than an equal size quick test, is authoritative.
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    rules.quick_test_policy = QuickTestPolicy::Skip;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    fixture.files(b"same", b"same");
    fixture.times(base, base + 3_600_000);
    // A failed timestamp quick check falls back to exact content in skip mode.
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
  }

  #[test]
  fn quick_policy_truth_table_for_size_flags_and_exact_content() {
    let fixture = Fixture::new();
    for (left, right, quick_same, content_same) in [
      (&b"one"[..], &b"two"[..], true, false),
      (&b"one"[..], &b"one"[..], true, true),
      (&b"one"[..], &b"longer"[..], false, false),
    ] {
      fixture.files(left, right);
      for policy in [
        QuickTestPolicy::Override,
        QuickTestPolicy::Skip,
        QuickTestPolicy::RequireAll,
      ] {
        let rules = FolderRules {
          compare_size: true,
          quick_test_policy: policy,
          ..Default::default()
        };
        let equal = match policy {
          QuickTestPolicy::Override => content_same,
          QuickTestPolicy::Skip => quick_same || content_same,
          QuickTestPolicy::RequireAll => quick_same && content_same,
        };
        assert_eq!(fixture.scan(&rules)[0].status == FolderStatus::Same, equal);
      }
    }
    fixture.files(b"same", b"same");
    fixture.times(1_700_000_000_000, 1_700_000_001_000);
    let mut rules = FolderRules {
      compare_modified: true,
      quick_test_policy: QuickTestPolicy::RequireAll,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    rules.quick_test_policy = QuickTestPolicy::Override;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
  }

  #[test]
  fn archive_system_and_hidden_attribute_masks_are_independent() {
    assert_eq!(selected_attribute_mask(&FolderRules::default()), 0);
    assert_eq!(
      selected_attribute_mask(&FolderRules {
        compare_archive: true,
        ..Default::default()
      }),
      0x20
    );
    assert_eq!(
      selected_attribute_mask(&FolderRules {
        compare_system: true,
        ..Default::default()
      }),
      0x4
    );
    assert_eq!(
      selected_attribute_mask(&FolderRules {
        compare_hidden: true,
        ..Default::default()
      }),
      0x2
    );
    assert_eq!(
      selected_attribute_mask(&FolderRules {
        compare_archive: true,
        compare_system: true,
        compare_hidden: true,
        ..Default::default()
      }),
      0x26
    );
  }

  #[test]
  fn tolerance_timezone_and_dst_adjust_the_right_timestamp_explicitly() {
    let fixture = Fixture::new();
    fixture.files(b"same", b"same");
    let base = 1_700_000_000_000;
    fixture.times(base + 1500, base);
    let mut rules = FolderRules {
      content: ContentMethod::None,
      compare_modified: true,
      timestamp_tolerance_ms: 1500,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    rules.timestamp_tolerance_ms = 1499;
    let row = &fixture.scan(&rules)[0];
    assert_eq!(row.status, FolderStatus::Different);
    assert_eq!(row.newer, Some(FolderSide::Left));
    assert_eq!(row.left_modified, Some(base + 1500));
    assert_eq!(row.right_modified, Some(base));
    fixture.times(base, base + 90 * 60_000);
    rules.timezone_offset_minutes = -90;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    fixture.times(base, base + 150 * 60_000);
    assert_eq!(fixture.scan(&rules)[0].newer, Some(FolderSide::Right));
    rules.ignore_dst = true;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    fixture.times(base, base + 30 * 60_000);
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    assert!(modified_ms(UNIX_EPOCH - Duration::from_millis(1)).is_none());
    if let Some(time) = UNIX_EPOCH.checked_add(Duration::from_millis(JS_SAFE_INTEGER + 1)) {
      assert!(modified_ms(time).is_none());
    }
  }

  #[test]
  fn alignment_is_exact_first_unique_and_same_parent_with_actual_names() {
    let fixture = Fixture::new();
    fs::write(fixture.left.join("File.txt"), b"x").unwrap();
    fs::write(fixture.right.join("file.bin"), b"x").unwrap();
    let rules = FolderRules {
      align_case: true,
      align_extensions: true,
      ..Default::default()
    };
    let rows = fixture.scan(&rules);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].left_relative.as_deref(), Some("File.txt"));
    assert_eq!(rows[0].right_relative.as_deref(), Some("file.bin"));
    assert_eq!(rows[0].status, FolderStatus::Same);
    let sensitive = FolderRules {
      compare_filename_case: true,
      ..rules.clone()
    };
    assert_eq!(fixture.scan(&sensitive)[0].status, FolderStatus::Different);
    fs::write(fixture.left.join("file.bin"), b"x").unwrap();
    let rows = fixture.scan(&rules);
    assert_eq!(rows.len(), 2);
    assert!(rows
      .iter()
      .any(|r| r.relative == "file.bin" && r.status == FolderStatus::Same));
    assert!(rows
      .iter()
      .any(|r| r.relative == "File.txt" && r.status == FolderStatus::LeftOnly));
    fs::write(fixture.right.join("file.other"), b"x").unwrap();
    fs::write(fixture.right.join("file.third"), b"x").unwrap();
    let rows = fixture.scan(&rules);
    assert_eq!(rows.len(), 4);
    assert_eq!(
      rows
        .iter()
        .filter(|r| r.status == FolderStatus::RightOnly)
        .count(),
      2
    );
    fs::create_dir(fixture.right.join("sub")).unwrap();
    fs::write(fixture.right.join("sub").join("File.txt"), b"x").unwrap();
    assert!(fixture
      .scan(&rules)
      .iter()
      .any(|r| r.relative == "sub/File.txt" && r.status == FolderStatus::RightOnly));
  }

  #[test]
  fn alignment_does_not_approximate_unicode_normalization_or_case_folding() {
    let fixture = Fixture::new();
    fs::write(fixture.left.join("Ä.txt"), b"x").unwrap();
    fs::write(fixture.right.join("ä.txt"), b"x").unwrap();
    let rules = FolderRules {
      align_case: true,
      ..Default::default()
    };
    let rows = fixture.scan(&rules);
    assert_eq!(rows.len(), 2);
    assert!(rows
      .iter()
      .all(|r| r.status == FolderStatus::Error && r.error.as_ref().unwrap().contains("non-ASCII")));
  }

  #[test]
  fn single_root_listing_is_explicitly_uncompared_and_still_validated() {
    let fixture = Fixture::new();
    fixture.files(b"left", b"right");
    fs::create_dir(fixture.left.join("nested")).unwrap();
    fs::write(fixture.left.join("nested").join("child"), b"child").unwrap();
    let cancelled = AtomicBool::new(false);
    for (left, right, status) in [
      (
        fixture.left.as_path(),
        Path::new(""),
        FolderStatus::LeftOnly,
      ),
      (
        Path::new(""),
        fixture.right.as_path(),
        FolderStatus::RightOnly,
      ),
    ] {
      let rows = scan_pair_with_rules(
        left,
        right,
        &FolderOptions::default(),
        &FolderRules::default(),
        &cancelled,
        |_| {},
      )
      .unwrap();
      assert!(!rows.is_empty());
      assert!(rows
        .iter()
        .all(|row| row.status == status && row.importance == ComparisonImportance::Unknown));
      assert!(rows
        .iter()
        .all(|row| row.detail.as_deref().unwrap().contains("Not compared")));
    }
    assert!(scan_pair_with_rules(
      Path::new(""),
      Path::new(""),
      &FolderOptions::default(),
      &FolderRules::default(),
      &cancelled,
      |_| {}
    )
    .is_err());
    assert!(scan_pair_with_rules(
      &fixture.left.join("missing"),
      Path::new(""),
      &FolderOptions::default(),
      &FolderRules::default(),
      &cancelled,
      |_| {}
    )
    .is_err());
    assert!(scan_selected_with_rules(
      &fixture.left,
      Path::new(""),
      &FolderOptions::default(),
      &FolderRules::default(),
      &["file".into()],
      &cancelled,
      |_| {}
    )
    .is_err());
    let rows = fixture.scan(&FolderRules::default());
    assert_eq!(
      rows
        .iter()
        .find(|row| row.relative == "file")
        .unwrap()
        .status,
      FolderStatus::Different
    );
  }

  #[test]
  fn crc_matches_ieee_vectors_and_streams_every_chunk() {
    let fixture = Fixture::new();
    fixture.files(b"123456789", b"123456789");
    let path = fixture.left.join("file");
    let cancelled = AtomicBool::new(false);
    assert_eq!(
      crc(&path, &fs::metadata(&path).unwrap(), &cancelled).unwrap(),
      0xcbf43926
    );
    let rules = FolderRules {
      content: ContentMethod::Crc,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    fixture.files(b"", b"");
    assert_eq!(
      crc(&path, &fs::metadata(&path).unwrap(), &cancelled).unwrap(),
      0
    );
    let mut bytes = vec![0u8; 128 * 1024 + 1];
    fixture.files(&bytes, &bytes);
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    *bytes.last_mut().unwrap() = 1;
    fs::write(fixture.right.join("file"), &bytes).unwrap();
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    let legacy = FolderRules {
      content: ContentMethod::None,
      quick_test: QuickTest::Crc,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&legacy)[0].status, FolderStatus::Different);
    let old = fs::metadata(&path).unwrap();
    fs::write(&path, b"changed").unwrap();
    assert!(crc(&path, &old, &cancelled).is_err());
    assert!(crc(&path, &fs::metadata(&path).unwrap(), &AtomicBool::new(true)).is_err());
    fs::File::options()
      .write(true)
      .open(&path)
      .unwrap()
      .set_len(MAX_FILE_BYTES + 1)
      .unwrap();
    assert!(crc(&path, &fs::metadata(&path).unwrap(), &cancelled)
      .unwrap_err()
      .to_string()
      .contains("100 MiB"));
  }

  #[test]
  fn unicode_alignment_uses_canonical_nfc_without_compatibility_or_case_folding() {
    let fixture = Fixture::new();
    fs::write(fixture.left.join("\u{e9}.txt"), b"x").unwrap();
    fs::write(fixture.right.join("e\u{301}.txt"), b"x").unwrap();
    assert_eq!(fixture.scan(&FolderRules::default()).len(), 2);
    let mut rules = FolderRules {
      text_rules: FolderTextRules {
        unicode_normalization: true,
        ..Default::default()
      },
      ..Default::default()
    };
    let rows = fixture.scan(&rules);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, FolderStatus::Same);
    assert_ne!(rows[0].left_relative, rows[0].right_relative);
    rules.align_case = true;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    rules.compare_filename_case = true;
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    rules.compare_filename_case = false;
    rules.align_case = false;
    fs::write(fixture.right.join("\u{e9}.txt"), b"x").unwrap();
    let rows = fixture.scan(&rules);
    assert_eq!(rows.len(), 2);
    assert!(rows
      .iter()
      .any(|row| row.left_relative == row.right_relative && row.status == FolderStatus::Same));
    assert!(rows.iter().any(|row| row.status == FolderStatus::RightOnly));
    assert_ne!(
      alignment_key("\u{fb01}.txt", &rules),
      alignment_key("fi.txt", &rules)
    );
    assert_ne!(
      alignment_key("\u{c4}.txt", &rules),
      alignment_key("\u{e4}.txt", &rules)
    );
    assert_ne!(
      alignment_key("a/\u{e9}.txt", &rules),
      alignment_key("b/e\u{301}.txt", &rules)
    );
    rules.align_extensions = true;
    assert_eq!(
      alignment_key("\u{e9}.txt", &rules),
      alignment_key("e\u{301}.bin", &rules)
    );
  }

  #[cfg(windows)]
  #[test]
  fn executable_versions_are_independent_tests_and_fail_explicitly() {
    let fixture = Fixture::new();
    let left = fixture.left.join("fixture.exe");
    let right = fixture.right.join("fixture.exe");
    crate::windows_metadata::tests::write_versioned_fixture(&left, [1, 2, 3, 4]);
    fs::copy(&left, &right).unwrap();
    let rules = FolderRules {
      executable_version: true,
      content: ContentMethod::None,
      ..Default::default()
    };
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Same);
    assert!(rows[0].detail.as_ref().unwrap().contains("1.2.3.4"));
    crate::windows_metadata::tests::write_versioned_fixture(&right, [1, 2, 3, 5]);
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    let override_rules = FolderRules {
      compare_size: true,
      content: ContentMethod::Crc,
      quick_test_policy: QuickTestPolicy::Skip,
      ..rules.clone()
    };
    assert_eq!(
      fixture.scan(&override_rules)[0].status,
      FolderStatus::Different
    );
    crate::windows_metadata::tests::write_versioned_fixture_versions(
      &right,
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    );
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Different);
    assert!(rows[0]
      .detail
      .as_ref()
      .unwrap()
      .contains("product versions: left 1.2.3.4 / right 5.6.7.8"));
    fs::write(&right, b"invalid executable").unwrap();
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Error);
    assert!(rows[0].error.as_ref().unwrap().contains("version"));
    fixture.files(b"plain", b"plain");
    assert!(fixture
      .scan(&rules)
      .iter()
      .any(|row| row.relative == "file" && row.status == FolderStatus::Same));
  }

  #[test]
  fn bounded_text_errors_are_rows_and_metadata_only_does_not_read_content() {
    let fixture = Fixture::new();
    fixture.files(b"", b"");
    for root in [&fixture.left, &fixture.right] {
      fs::File::options()
        .write(true)
        .open(root.join("file"))
        .unwrap()
        .set_len(TEXT_LIMIT + 1)
        .unwrap();
    }
    let rules = FolderRules {
      content: ContentMethod::Rules,
      ..Default::default()
    };
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Error);
    assert_eq!(rows[0].importance, ComparisonImportance::Unknown);
    assert!(rows[0].error.as_ref().unwrap().contains("1 MiB"));
    assert_eq!(
      fixture.scan(&FolderRules::default())[0].status,
      FolderStatus::Same
    );
    for root in [&fixture.left, &fixture.right] {
      fs::File::options()
        .write(true)
        .open(root.join("file"))
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    }
    assert_eq!(
      fixture.scan(&FolderRules::default())[0].status,
      FolderStatus::Error
    );
    let rules = FolderRules {
      content: ContentMethod::None,
      compare_size: true,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
  }

  #[test]
  fn byte_streaming_checks_all_chunks_and_detects_changed_snapshots() {
    let fixture = Fixture::new();
    let mut bytes = vec![0u8; 128 * 1024 + 1];
    fixture.files(&bytes, &bytes);
    let left = fixture.left.join("file");
    let right = fixture.right.join("file");
    let compare = || {
      binary(
        &left,
        &right,
        &fs::metadata(&left).unwrap(),
        &fs::metadata(&right).unwrap(),
        &AtomicBool::new(false),
      )
      .unwrap()
    };
    BINARY_CHUNK_READS.with(|reads| reads.set(0));
    assert_eq!(compare(), ComparisonImportance::Equal);
    assert_eq!(BINARY_CHUNK_READS.with(std::cell::Cell::get), 3);
    *bytes.last_mut().unwrap() = 1;
    fs::write(&right, bytes).unwrap();
    BINARY_CHUNK_READS.with(|reads| reads.set(0));
    assert_eq!(compare(), ComparisonImportance::Important);
    assert_eq!(BINARY_CHUNK_READS.with(std::cell::Cell::get), 3);
    let old = fs::metadata(&left).unwrap();
    fs::write(&left, b"changed").unwrap();
    assert!(open(&left, &old, MAX_FILE_BYTES).is_err());
  }

  #[test]
  fn binary_length_mismatch_returns_without_reading_file_chunks() {
    let fixture = Fixture::new();
    let left = fixture.left.join("file");
    let right = fixture.right.join("file");
    let length = 10 * 1024 * 1024;
    fs::File::create(&left).unwrap().set_len(length).unwrap();
    fs::File::create(&right)
      .unwrap()
      .set_len(length - 1)
      .unwrap();
    let left_metadata = fs::metadata(&left).unwrap();
    let right_metadata = fs::metadata(&right).unwrap();
    BINARY_CHUNK_READS.with(|reads| reads.set(0));

    assert_eq!(
      binary(
        &left,
        &right,
        &left_metadata,
        &right_metadata,
        &AtomicBool::new(false),
      )
      .unwrap(),
      ComparisonImportance::Important
    );
    assert_eq!(BINARY_CHUNK_READS.with(std::cell::Cell::get), 0);
  }

  #[test]
  fn binary_content_mismatch_stops_after_the_first_chunk() {
    let fixture = Fixture::new();
    let left = fixture.left.join("file");
    let right = fixture.right.join("file");
    let left_bytes = vec![0u8; 10 * 1024 * 1024];
    let mut right_bytes = left_bytes.clone();
    right_bytes[0] = 1;
    fs::write(&left, &left_bytes).unwrap();
    fs::write(&right, &right_bytes).unwrap();
    let left_metadata = fs::metadata(&left).unwrap();
    let right_metadata = fs::metadata(&right).unwrap();
    BINARY_CHUNK_READS.with(|reads| reads.set(0));

    assert_eq!(
      binary(
        &left,
        &right,
        &left_metadata,
        &right_metadata,
        &AtomicBool::new(false),
      )
      .unwrap(),
      ComparisonImportance::Important
    );
    assert_eq!(BINARY_CHUNK_READS.with(std::cell::Cell::get), 1);
  }

  #[test]
  fn same_name_file_and_folder_are_independent_rows() {
    let fixture = Fixture::new();
    fs::write(fixture.left.join(".git"), b"gitdir: elsewhere").unwrap();
    fs::create_dir(fixture.right.join(".git")).unwrap();
    fs::write(fixture.right.join(".git").join("HEAD"), b"ref").unwrap();

    let rows = fixture.scan(&FolderRules::default());

    assert_eq!(rows.len(), 3, "rows: {rows:#?}");
    let file = rows
      .iter()
      .find(|row| row.relative == ".git" && !row.is_directory)
      .expect("file row for .git");
    assert_eq!(file.status, FolderStatus::LeftOnly);
    assert_eq!(file.left_kind, Some(FolderEntryKind::File));
    assert_eq!(file.right_kind, None);
    assert!(file.right_relative.is_none());
    assert!(file.error.is_none());

    let folder = rows
      .iter()
      .find(|row| row.relative == ".git" && row.is_directory)
      .expect("folder row for .git");
    assert_eq!(folder.status, FolderStatus::RightOnly);
    assert_eq!(folder.left_kind, None);
    assert_eq!(folder.right_kind, Some(FolderEntryKind::Directory));
    assert!(folder.left_relative.is_none());
    assert!(folder.error.is_none());

    let child = rows
      .iter()
      .find(|row| row.relative == ".git/HEAD")
      .expect("child row under the folder");
    assert_eq!(child.status, FolderStatus::RightOnly);
  }

  #[test]
  fn readonly_type_mismatches_and_missing_sides_are_explicit() {
    let fixture = Fixture::new();
    fixture.files(b"x", b"x");
    let path = fixture.right.join("file");
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let rules = FolderRules {
      compare_readonly: true,
      ..Default::default()
    };
    let result = fixture.scan(&rules);
    #[cfg(windows)]
    let attributes_result = fixture.scan(&FolderRules {
      compare_attributes: true,
      ..Default::default()
    });
    fs::set_permissions(&path, permissions).unwrap();
    assert_eq!(result[0].status, FolderStatus::Different);
    #[cfg(windows)]
    assert_eq!(attributes_result[0].status, FolderStatus::Different);
    fs::create_dir(fixture.left.join("collision")).unwrap();
    fs::write(fixture.right.join("collision"), b"x").unwrap();
    fs::write(fixture.left.join("reverse"), b"x").unwrap();
    fs::create_dir(fixture.right.join("reverse")).unwrap();
    fs::write(fixture.right.join("reverse").join("child"), b"x").unwrap();
    fs::write(fixture.left.join("only"), b"x").unwrap();
    let rows = fixture.scan(&FolderRules::default());
    let collision_folder = rows
      .iter()
      .find(|row| row.relative == "collision" && row.is_directory)
      .unwrap();
    assert_eq!(collision_folder.status, FolderStatus::LeftOnly);
    assert_eq!(collision_folder.left_kind, Some(FolderEntryKind::Directory));
    assert_eq!(collision_folder.right_kind, None);
    assert_eq!(collision_folder.importance, ComparisonImportance::Important);
    assert!(collision_folder.error.is_none());
    let collision_file = rows
      .iter()
      .find(|row| row.relative == "collision" && !row.is_directory)
      .unwrap();
    assert_eq!(collision_file.status, FolderStatus::RightOnly);
    assert_eq!(collision_file.left_kind, None);
    assert_eq!(collision_file.right_kind, Some(FolderEntryKind::File));
    assert!(collision_file.error.is_none());
    let reverse_file = rows
      .iter()
      .find(|row| row.relative == "reverse" && !row.is_directory)
      .unwrap();
    assert_eq!(reverse_file.status, FolderStatus::LeftOnly);
    assert_eq!(reverse_file.left_kind, Some(FolderEntryKind::File));
    assert!(reverse_file.error.is_none());
    let reverse_folder = rows
      .iter()
      .find(|row| row.relative == "reverse" && row.is_directory)
      .unwrap();
    assert_eq!(reverse_folder.status, FolderStatus::RightOnly);
    assert_eq!(reverse_folder.right_kind, Some(FolderEntryKind::Directory));
    assert!(reverse_folder.error.is_none());
    let child = rows
      .iter()
      .find(|row| row.relative == "reverse/child")
      .unwrap();
    assert_eq!(child.status, FolderStatus::RightOnly);
    let refreshed = refresh_selection(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules::default(),
      &["collision".into()],
      &rows,
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    let refreshed_folder = refreshed
      .iter()
      .find(|row| row.relative == "collision" && row.is_directory)
      .unwrap();
    assert_eq!(refreshed_folder.status, FolderStatus::LeftOnly);
    assert!(refreshed_folder.error.is_none());
    let refreshed_file = refreshed
      .iter()
      .find(|row| row.relative == "collision" && !row.is_directory)
      .unwrap();
    assert_eq!(refreshed_file.status, FolderStatus::RightOnly);
    assert!(refreshed_file.error.is_none());
    let row = rows.iter().find(|r| r.relative == "only").unwrap();
    assert_eq!(row.status, FolderStatus::LeftOnly);
    assert!(row.right_relative.is_none());
    assert!(row.right_modified.is_none());
  }

  #[test]
  fn capabilities_and_invalid_rule_combinations_fail_before_scanning() {
    for rules in [
      FolderRules {
        content: ContentMethod::Crc,
        ..Default::default()
      },
      FolderRules {
        quick_test: QuickTest::Crc,
        ..Default::default()
      },
      FolderRules {
        text_rules: FolderTextRules {
          unicode_normalization: true,
          ..Default::default()
        },
        ..Default::default()
      },
    ] {
      rules.validate().unwrap();
    }
    #[cfg(not(windows))]
    assert!(FolderRules {
      executable_version: true,
      ..Default::default()
    }
    .validate()
    .unwrap_err()
    .to_string()
    .contains("requires Windows"));
    for rules in [
      FolderRules {
        content: ContentMethod::None,
        ..Default::default()
      },
      FolderRules {
        quick_test_policy: QuickTestPolicy::Skip,
        ..Default::default()
      },
      FolderRules {
        timezone_offset_minutes: i32::MIN,
        ..Default::default()
      },
      FolderRules {
        timestamp_tolerance_ms: JS_SAFE_INTEGER + 1,
        ..Default::default()
      },
      FolderRules {
        text_rules: FolderTextRules {
          unimportant: vec!["[".into()],
          ..Default::default()
        },
        ..Default::default()
      },
    ] {
      assert!(rules.validate().is_err());
    }
    #[cfg(not(windows))]
    assert!(FolderRules {
      compare_attributes: true,
      ..Default::default()
    }
    .validate()
    .is_err());
  }

  #[test]
  fn serialization_defaults_unknown_fields_and_entry_shapes_are_stable() {
    let rules: FolderRules = serde_json::from_str("{}").unwrap();
    assert_eq!(rules.content, ContentMethod::Binary);
    assert_eq!(rules.quick_test, QuickTest::None);
    assert!(serde_json::from_str::<FolderRules>(r#"{"misspelled":true}"#).is_err());
    assert!(serde_json::from_str::<FolderRules>(r#"{"textRules":{"misspelled":true}}"#).is_err());
    let fixture = Fixture::new();
    fixture.files(b"x", b"x");
    let value = serde_json::to_value(&fixture.scan(&rules)[0]).unwrap();
    assert_eq!(value["leftRelative"], "file");
    assert_eq!(value["rightRelative"], "file");
    assert!(value["leftModified"].is_number());
    assert!(value["newer"].is_null() || value["newer"] == "left" || value["newer"] == "right");
    assert_eq!(value["importance"], "equal");
    assert!(value["error"].is_null());
  }

  #[test]
  fn exclusions_and_mid_scan_cancellation_are_honored() {
    let fixture = Fixture::new();
    fixture.files(b"x", b"x");
    let options = FolderOptions {
      exclude: vec!["file".into()],
      ..Default::default()
    };
    assert!(scan_pair_with_rules(
      &fixture.left,
      &fixture.right,
      &options,
      &FolderRules::default(),
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap()
    .is_empty());
    let flag = AtomicBool::new(false);
    assert!(scan_pair_with_rules(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules::default(),
      &flag,
      |_| flag.store(true, Ordering::Relaxed),
    )
    .is_err());
  }

  #[test]
  fn directory_exclusions_prune_both_sides_but_preserve_same_name_files() {
    let fixture = Fixture::new();
    fs::write(fixture.left.join("hello"), b"file").unwrap();
    fs::create_dir(fixture.right.join("hello")).unwrap();
    fs::write(fixture.right.join("hello").join("child.txt"), b"child").unwrap();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir(root.join("paired")).unwrap();
      fs::write(root.join("paired").join("child.txt"), b"content").unwrap();
    }
    let options = FolderOptions {
      exclude_directories: vec!["hello".into(), "paired".into()],
      ..Default::default()
    };
    let rows = scan_pair_with_rules(
      &fixture.left,
      &fixture.right,
      &options,
      &FolderRules::default(),
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].relative, "hello");
    assert_eq!(rows[0].status, FolderStatus::LeftOnly);
    assert_eq!(rows[0].left_kind, Some(FolderEntryKind::File));
    assert_eq!(rows[0].right_kind, None);
  }

  #[test]
  fn descendant_globs_prune_directory_roots_and_keep_same_name_files() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      for relative in ["node_modules/package", "packages/app/node_modules/package"] {
        fs::create_dir_all(root.join(relative)).unwrap();
        fs::write(root.join(relative).join("index.js"), b"excluded").unwrap();
      }
      fs::write(root.join("visible.txt"), b"visible").unwrap();
    }
    let options = FolderOptions {
      exclude: vec!["**/node_modules/**".into()],
      ..Default::default()
    };
    let rows = scan_pair_with_rules(
      &fixture.left,
      &fixture.right,
      &options,
      &FolderRules::default(),
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert!(rows
      .iter()
      .all(|row| !row.relative.split('/').any(|part| part == "node_modules")));
    assert!(rows.iter().any(|row| row.relative == "visible.txt"));

    let fixture = Fixture::new();
    fs::write(fixture.left.join("node_modules"), b"file").unwrap();
    fs::create_dir(fixture.right.join("node_modules")).unwrap();
    fs::write(
      fixture.right.join("node_modules").join("package.json"),
      b"excluded",
    )
    .unwrap();
    let rows = scan_pair_with_rules(
      &fixture.left,
      &fixture.right,
      &options,
      &FolderRules::default(),
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].relative, "node_modules");
    assert_eq!(rows[0].status, FolderStatus::LeftOnly);
    assert_eq!(rows[0].left_kind, Some(FolderEntryKind::File));
    assert_eq!(rows[0].right_kind, None);
  }

  #[test]
  fn display_rules_do_not_weaken_plan_content_hash_revalidation() {
    let fixture = Fixture::new();
    fixture.files(b"one", b"two");
    let rules = FolderRules {
      content: ContentMethod::None,
      compare_size: true,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    let flag = AtomicBool::new(false);
    let plan = Plan::preview(
      &fixture.left,
      &fixture.right,
      FolderOptions::default(),
      SyncMode::Update,
      &flag,
    )
    .unwrap();
    let old_time = fs::metadata(fixture.left.join("file"))
      .unwrap()
      .modified()
      .unwrap();
    fs::write(fixture.left.join("file"), b"new").unwrap();
    fs::File::options()
      .write(true)
      .open(fixture.left.join("file"))
      .unwrap()
      .set_times(fs::FileTimes::new().set_modified(old_time))
      .unwrap();
    assert!(plan.execute(&flag, |_| {}).is_err());
    assert_eq!(fs::read(fixture.right.join("file")).unwrap(), b"two");
  }

  #[test]
  fn selected_content_does_not_read_oversized_unselected_files() {
    let fixture = Fixture::new();
    fixture.files(b"same", b"same");
    for root in [&fixture.left, &fixture.right] {
      fs::File::create(root.join("large"))
        .unwrap()
        .set_len(TEXT_LIMIT + 1)
        .unwrap();
    }
    let rules = FolderRules {
      content: ContentMethod::Rules,
      ..Default::default()
    };
    assert!(fixture
      .scan(&rules)
      .iter()
      .any(|row| row.relative == "large" && row.status == FolderStatus::Error));
    let rows = scan_selected_with_rules(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &rules,
      &["file".into()],
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].relative, "file");
    assert_eq!(rows[0].status, FolderStatus::Same);
  }

  #[test]
  fn selected_directories_include_descendants_once_and_alignment_accepts_right_name() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir(root.join("sub")).unwrap();
      fs::create_dir(root.join("submarine")).unwrap();
      fs::write(root.join("sub").join("file"), b"x").unwrap();
      fs::write(root.join("submarine").join("file"), b"x").unwrap();
    }
    let rows = scan_selected_with_rules(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules::default(),
      &["sub".into(), "sub/file".into(), "sub".into()],
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows
      .iter()
      .all(|row| row.relative == "sub" || row.relative == "sub/file"));
    fs::write(fixture.left.join("name.txt"), b"x").unwrap();
    fs::write(fixture.right.join("name.bin"), b"x").unwrap();
    let rows = scan_selected_with_rules(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules {
        align_extensions: true,
        ..Default::default()
      },
      &["name.bin".into()],
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].left_relative.as_deref(), Some("name.txt"));
    assert_eq!(rows[0].right_relative.as_deref(), Some("name.bin"));
  }

  #[test]
  fn invalid_or_stale_selected_rows_fail_explicitly() {
    let fixture = Fixture::new();
    fixture.files(b"x", b"x");
    for selected in [
      vec![],
      vec!["".into()],
      vec!["../file".into()],
      vec!["/file".into()],
      vec!["sub//file".into()],
      vec!["sub/./file".into()],
      vec!["missing".into()],
    ] {
      assert!(scan_selected_with_rules(
        &fixture.left,
        &fixture.right,
        &FolderOptions::default(),
        &FolderRules::default(),
        &selected,
        &AtomicBool::new(false),
        |_| {},
      )
      .is_err());
    }
  }

  #[test]
  fn directory_aggregation_uses_descendants_not_directory_timestamps() {
    let fixture = Fixture::new();
    let base = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir(root.join("parent")).unwrap();
      fs::create_dir(root.join("parent").join("nested")).unwrap();
      fs::write(root.join("parent").join("nested").join("file"), b"same").unwrap();
      fs::write(root.join("parent").join("other"), b"same").unwrap();
    }
    let left_file = fixture.left.join("parent").join("nested").join("file");
    let right_file = fixture.right.join("parent").join("nested").join("file");
    fs::write(&left_file, b"left").unwrap();
    for (path, modified) in [
      (&left_file, base + Duration::from_secs(2)),
      (&right_file, base),
      (&fixture.left.join("parent").join("other"), base),
      (
        &fixture.right.join("parent").join("other"),
        base + Duration::from_secs(2),
      ),
    ] {
      fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    }
    // Directory mtimes are equal despite descendant content/recency changes.
    for root in [&fixture.left, &fixture.right] {
      let mut options = fs::File::options();
      options.read(true);
      #[cfg(windows)]
      {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(0x100).custom_flags(0x0200_0000);
      }
      options
        .open(root.join("parent"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(base))
        .unwrap();
    }
    assert_eq!(
      fs::metadata(fixture.left.join("parent"))
        .unwrap()
        .modified()
        .unwrap(),
      fs::metadata(fixture.right.join("parent"))
        .unwrap()
        .modified()
        .unwrap()
    );
    let rows = fixture.scan(&FolderRules::default());
    let nested = rows.iter().find(|r| r.relative == "parent/nested").unwrap();
    assert_eq!(nested.status, FolderStatus::Different);
    assert_eq!(nested.newer, Some(FolderSide::Left));
    assert!(!nested.newer_mixed);
    let parent = rows.iter().find(|r| r.relative == "parent").unwrap();
    assert_eq!(parent.status, FolderStatus::Different);
    assert!(parent.newer.is_none());
    assert!(parent.newer_mixed);
    let value = serde_json::to_value(parent).unwrap();
    assert_eq!(value["newerMixed"], true);
  }

  #[test]
  fn directory_descendant_orphans_and_errors_remain_visible() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir(root.join("parent")).unwrap();
    }
    fs::write(fixture.left.join("parent").join("orphan"), b"x").unwrap();
    let rows = fixture.scan(&FolderRules::default());
    assert_eq!(
      rows.iter().find(|r| r.relative == "parent").unwrap().status,
      FolderStatus::Different
    );
    fs::File::create(fixture.right.join("parent").join("large"))
      .unwrap()
      .set_len(TEXT_LIMIT + 1)
      .unwrap();
    fs::File::create(fixture.left.join("parent").join("large"))
      .unwrap()
      .set_len(TEXT_LIMIT + 1)
      .unwrap();
    let rows = fixture.scan(&FolderRules {
      content: ContentMethod::Rules,
      ..Default::default()
    });
    let parent = rows.iter().find(|r| r.relative == "parent").unwrap();
    assert_eq!(parent.status, FolderStatus::Error);
    assert_eq!(parent.importance, ComparisonImportance::Unknown);
    assert!(parent.error.as_ref().unwrap().contains("descendants"));
    assert!(rows
      .iter()
      .any(|r| r.relative == "parent/large" && r.error.as_ref().unwrap().contains("1 MiB")));
  }

  #[test]
  fn configuration_validation_checks_numeric_rules_and_exclusions_without_io() {
    assert!(
      validate_folder_configuration(&FolderRules::default(), &FolderOptions::default()).is_ok()
    );
    for rules in [
      FolderRules {
        timestamp_tolerance_ms: JS_SAFE_INTEGER + 1,
        ..Default::default()
      },
      FolderRules {
        timezone_offset_minutes: 1441,
        ..Default::default()
      },
      FolderRules {
        timezone_offset_minutes: -1441,
        ..Default::default()
      },
    ] {
      assert!(validate_folder_configuration(&rules, &FolderOptions::default()).is_err());
    }
    for exclude in [
      vec!["[".into()],
      vec!["x".repeat(4097)],
      vec!["*.log".into(); 33],
    ] {
      assert!(validate_folder_configuration(
        &FolderRules::default(),
        &FolderOptions {
          exclude,
          ..Default::default()
        },
      )
      .is_err());
    }
    assert!(validate_folder_configuration(
      &FolderRules::default(),
      &FolderOptions {
        exclude: vec!["**/*.log".into()],
        ..Default::default()
      },
    )
    .is_ok());
    assert!(validate_folder_configuration(
      &FolderRules::default(),
      &FolderOptions {
        exclude_directories: vec!["../outside".into()],
        ..Default::default()
      },
    )
    .is_err());
    assert!(
      serde_json::from_str::<FolderOptions>(r#"{"criterion":"content","exclude":[]}"#).is_ok()
    );
    assert!(serde_json::from_str::<FolderRules>(r#"{"timestampToleranceMs":1.5}"#).is_err());
    assert!(serde_json::from_str::<FolderRules>(r#"{"timezoneOffsetMinutes":"bad"}"#).is_err());
    assert!(serde_json::from_str::<FolderRules>(r#"{"timestampToleranceMs":-1}"#).is_err());
  }

  #[test]
  fn refresh_selection_replaces_subtrees_and_preserves_unselected_file_results() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir(root.join("parent")).unwrap();
      fs::create_dir(root.join("parent").join("selected")).unwrap();
      fs::write(root.join("parent").join("selected").join("old"), b"x").unwrap();
      fs::write(root.join("untouched"), b"same").unwrap();
    }
    let previous = fixture.scan(&FolderRules::default());
    for root in [&fixture.left, &fixture.right] {
      fs::remove_file(root.join("parent").join("selected").join("old")).unwrap();
    }
    fs::write(
      fixture.left.join("parent").join("selected").join("new"),
      b"x",
    )
    .unwrap();
    fs::File::options()
      .write(true)
      .open(fixture.left.join("untouched"))
      .unwrap()
      .set_len(TEXT_LIMIT + 1)
      .unwrap();
    let rules = FolderRules {
      content: ContentMethod::Rules,
      ..Default::default()
    };
    let refreshed = refresh_selection(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &rules,
      &["parent/selected".into()],
      &previous,
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert!(!refreshed.iter().any(|r| r.relative.ends_with("/old")));
    assert!(refreshed
      .iter()
      .any(|r| r.relative == "parent/selected/new" && r.status == FolderStatus::LeftOnly));
    assert_eq!(
      refreshed
        .iter()
        .find(|r| r.relative == "parent")
        .unwrap()
        .status,
      FolderStatus::Different
    );
    assert_eq!(
      refreshed.iter().find(|r| r.relative == "untouched"),
      previous.iter().find(|r| r.relative == "untouched")
    );
    fs::remove_file(fixture.left.join("parent").join("selected").join("new")).unwrap();
    for root in [&fixture.left, &fixture.right] {
      fs::remove_dir(root.join("parent").join("selected")).unwrap();
    }
    let deleted = refresh_selection(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &rules,
      &["parent/selected".into()],
      &refreshed,
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    assert!(!deleted
      .iter()
      .any(|r| r.relative.starts_with("parent/selected")));
    assert_eq!(
      deleted
        .iter()
        .find(|r| r.relative == "parent")
        .unwrap()
        .status,
      FolderStatus::Same
    );
  }

  #[test]
  fn refresh_selection_rejects_invalid_selection_and_root_failures() {
    let fixture = Fixture::new();
    for selected in [vec![], vec!["../escape".into()]] {
      assert!(refresh_selection(
        &fixture.left,
        &fixture.right,
        &FolderOptions::default(),
        &FolderRules::default(),
        &selected,
        &[],
        &AtomicBool::new(false),
        |_| {},
      )
      .is_err());
    }
    fs::remove_dir(&fixture.left).unwrap();
    assert!(refresh_selection(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules::default(),
      &["missing".into()],
      &[],
      &AtomicBool::new(false),
      |_| {},
    )
    .is_err());
  }
}
