//! Read-only display rules. Operation plans deliberately retain their independent
//! exact-path, content-hashed snapshots and never consume these display results.
use super::*;
use compare_text::{
  compare_with_rules, CompareError, CompareOptions, DiffKind, TextError, UnimportantRule,
  WorkControl,
};
use rayon::prelude::*;
use std::sync::atomic::AtomicUsize;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const TEXT_LIMIT: u64 = 8 * 1024 * 1024;
const STREAM_CHUNK: usize = 256 * 1024;
const TEXT_FALLBACK_DETAIL: &str = "Compared as binary: file too large for text rules.";

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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

/// Must match the desktop `defaultFolderRules`: a size/modified quick test
/// with a 2 s tolerance and no content reads.
impl Default for FolderRules {
  fn default() -> Self {
    Self {
      compare_size: false,
      compare_modified: false,
      timestamp_tolerance_ms: 2000,
      timezone_offset_minutes: 0,
      ignore_dst: false,
      compare_filename_case: false,
      align_case: true,
      align_extensions: false,
      compare_readonly: false,
      compare_archive: false,
      compare_system: false,
      compare_hidden: false,
      compare_attributes: false,
      content: ContentMethod::None,
      quick_test: QuickTest::Modified,
      quick_test_policy: QuickTestPolicy::Override,
      text_rules: FolderTextRules::default(),
      executable_version: false,
    }
  }
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
  /// Set for symbolic links and junctions. Their targets are never listed or compared.
  link_target: Option<String>,
  error: Option<String>,
}

impl Item {
  fn is_dir(&self) -> bool {
    self.link_target.is_none() && self.metadata.as_ref().is_some_and(|m| m.is_dir())
  }

  fn is_link(&self) -> bool {
    self.link_target.is_some()
  }
}

fn side_label(side: FolderSide) -> &'static str {
  match side {
    FolderSide::Left => "left",
    FolderSide::Right => "right",
  }
}

/// Combined walk progress for both sides. The count and the callback share one lock,
/// so the callback always receives a monotonic total even when the walks run concurrently.
struct ScanProgress<F> {
  count: AtomicUsize,
  report: Mutex<F>,
}

impl<F: FnMut(usize)> ScanProgress<F> {
  fn new(report: F) -> Self {
    Self {
      count: AtomicUsize::new(0),
      report: Mutex::new(report),
    }
  }

  fn advance(&self) {
    let mut report = self.report.lock().unwrap_or_else(PoisonError::into_inner);
    let total = self.count.fetch_add(1, Ordering::Relaxed) + 1;
    report(total);
  }

  fn finish(&self, total: usize) {
    let mut report = self.report.lock().unwrap_or_else(PoisonError::into_inner);
    report(total);
  }
}

const NON_UNICODE_NAME: &str = "Name is not valid Unicode; it cannot be compared or copied.";

/// Rows from one scan. `truncated` means a root held more entries than
/// `MAX_FOLDER_ENTRIES`; the rows then cover only part of that root.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
  /// Assigned by the caller that caches the scan; the engine leaves it empty.
  pub scan_id: String,
  pub entries: Vec<FolderEntry>,
  pub truncated: bool,
}

/// Identity of a folder row. Kind is part of identity: a file and a folder may share a name.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowId {
  pub relative: String,
  pub is_directory: bool,
}

/// Row changes produced by [`refresh_paths`]. Applying it to the previous rows yields the new rows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPatch {
  pub removed: Vec<RowId>,
  pub upserted: Vec<FolderEntry>,
}

impl FolderPatch {
  pub fn apply_to(&self, entries: &mut Vec<FolderEntry>) {
    let changed: BTreeSet<(&str, bool)> = self
      .removed
      .iter()
      .map(|id| (id.relative.as_str(), id.is_directory))
      .chain(
        self
          .upserted
          .iter()
          .map(|row| (row.relative.as_str(), row.is_directory)),
      )
      .collect();
    entries.retain(|row| !changed.contains(&(row.relative.as_str(), row.is_directory)));
    entries.extend(self.upserted.iter().cloned());
  }
}

struct Walk {
  items: BTreeMap<String, Item>,
  truncated: bool,
}

fn collect(
  root: &Path,
  side: FolderSide,
  options: &FolderOptions,
  cancelled: &AtomicBool,
  limit: usize,
  on_item: &(dyn Fn() + Sync),
) -> Result<Walk, FileError> {
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
  let mut truncated = false;
  let mut stack = vec![(root.to_path_buf(), String::new())];
  'walk: while let Some((directory, directory_name)) = stack.pop() {
    cancel(cancelled)?;
    // Roots are validated once by the caller; the walk never descends into links.
    let children = match fs::read_dir(&directory) {
      Ok(children) => children,
      Err(error) if !directory_name.is_empty() => {
        if let Some(item) = items.get_mut(&directory_name) {
          item.error = Some(error.to_string());
        }
        continue;
      }
      Err(error) => {
        return Err(FileError::from(error).context(format!(
          "Could not read the {} folder \"{}\"",
          side_label(side),
          crate::display_path(root)
        )));
      }
    };
    for child in children {
      cancel(cancelled)?;
      let child = match child {
        Ok(child) => child,
        Err(error) if !directory_name.is_empty() => {
          // The failing entry cannot be named, so its directory row carries the error.
          if let Some(item) = items.get_mut(&directory_name) {
            item.error = Some(error.to_string());
          }
          continue;
        }
        Err(error) => {
          return Err(FileError::from(error).context(format!(
            "Could not read the {} folder \"{}\"",
            side_label(side),
            crate::display_path(root)
          )));
        }
      };
      let path = child.path();
      let relative_path = path
        .strip_prefix(root)
        .map_err(|e| FileError(e.to_string()))?;
      let unicode_name = relative_path
        .components()
        .all(|part| part.as_os_str().to_str().is_some());
      let relative = relative_path
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
      if filters.patterns.is_match(&relative) {
        continue;
      }
      let glob_excludes_directory =
        !options.exclude.is_empty() && filters.matches_directory_pattern(&relative);
      // DirEntry::metadata does not follow links.
      let metadata = child.metadata();
      if let Ok(metadata) = &metadata {
        if (glob_excludes_directory && metadata.is_dir())
          || (filters.files.contains(&relative) && metadata.is_file())
          || (filters.directories.contains(&relative) && metadata.is_dir())
        {
          continue;
        }
      }
      if items.len() >= limit {
        truncated = true;
        break 'walk;
      }
      let mut item = match metadata {
        Ok(metadata) if metadata.is_symlink() => match fs::read_link(&path) {
          Ok(target) => Item {
            metadata: Some(metadata),
            link_target: Some(target.to_string_lossy().into_owned()),
            error: None,
          },
          Err(error) => Item {
            metadata: Some(metadata),
            link_target: Some(String::new()),
            error: Some(format!("Could not read the link target: {error}")),
          },
        },
        Ok(metadata) if metadata.is_file() || metadata.is_dir() => {
          // Children of a name that cannot round-trip would get mangled paths.
          if metadata.is_dir() && unicode_name {
            stack.push((path, relative.clone()));
          }
          let error = metadata.modified().err().map(|e| e.to_string());
          Item {
            metadata: Some(metadata),
            link_target: None,
            error,
          }
        }
        Ok(_) => Item {
          metadata: None,
          link_target: None,
          error: Some("Only regular files and directories are supported.".into()),
        },
        Err(error) => Item {
          metadata: None,
          link_target: None,
          error: Some(error.to_string()),
        },
      };
      if !unicode_name {
        item.error = Some(NON_UNICODE_NAME.into());
      }
      items.insert(relative, item);
      on_item();
    }
  }
  Ok(Walk { items, truncated })
}

fn split_name(name: &str) -> (&str, &str) {
  name.rsplit_once('/').unwrap_or(("", name))
}

fn join_name(parent: &str, file: &str) -> String {
  if parent.is_empty() {
    file.to_owned()
  } else {
    format!("{parent}/{file}")
  }
}

fn alignment_key(name: &str, directory: bool, rules: &FolderRules) -> (String, String) {
  let (parent, filename) = split_name(name);
  // Folder names have no extension to ignore.
  let filename = if rules.align_extensions && !directory {
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

/// One row of a folder comparison. `relative` is the left-side spelling of the
/// path, so every row under an aligned folder shares its folder's tree node.
struct NamePair {
  left: Option<String>,
  right: Option<String>,
  relative: String,
  /// Set when the name cannot be aligned because it differs only by Unicode case.
  case_fold_unsupported: bool,
}

impl NamePair {
  fn both(left: &str, right: &str, relative: &str) -> Self {
    Self {
      left: Some(left.to_owned()),
      right: Some(right.to_owned()),
      relative: relative.to_owned(),
      case_fold_unsupported: false,
    }
  }

  fn left_only(left: &str) -> Self {
    Self {
      left: Some(left.to_owned()),
      right: None,
      relative: left.to_owned(),
      case_fold_unsupported: false,
    }
  }

  fn right_only(right: &str, relative: String) -> Self {
    Self {
      left: None,
      right: Some(right.to_owned()),
      relative,
      case_fold_unsupported: false,
    }
  }
}

/// The left-side spelling of a right-side path, mapping each parent folder through its pairing.
fn left_form(right_name: &str, right_to_left: &BTreeMap<String, String>) -> String {
  let (parent, file) = split_name(right_name);
  match right_to_left.get(parent) {
    Some(left_parent) => join_name(left_parent, file),
    None => right_name.to_owned(),
  }
}

/// Pairs the entries of each folder depth in turn. Folders are paired before
/// their children, so a child's expected right-side path follows its folder's pairing.
fn pair_names(
  left: &BTreeMap<String, Item>,
  right: &BTreeMap<String, Item>,
  rules: &FolderRules,
) -> Vec<NamePair> {
  let aligning =
    rules.align_case || rules.align_extensions || rules.text_rules.unicode_normalization;
  let eligible = |item: &Item| {
    if item.is_link() {
      false
    } else if item.is_dir() {
      rules.align_case || rules.text_rules.unicode_normalization
    } else {
      aligning
    }
  };
  // A link pairs only with a link; a link beside a same-named file or folder stays separate.
  let same_kind = |a: &Item, b: &Item| a.is_dir() == b.is_dir() && a.is_link() == b.is_link();
  let depth = |name: &str| name.matches('/').count();
  let mut left_by_depth = BTreeMap::<usize, Vec<&str>>::new();
  for name in left.keys() {
    left_by_depth.entry(depth(name)).or_default().push(name);
  }
  let mut right_by_depth = BTreeMap::<usize, Vec<&str>>::new();
  for name in right.keys() {
    right_by_depth.entry(depth(name)).or_default().push(name);
  }
  let depths: BTreeSet<usize> = left_by_depth
    .keys()
    .chain(right_by_depth.keys())
    .copied()
    .collect();
  // Paired folders, in both directions; the root folders pair with each other.
  let mut left_to_right = BTreeMap::from([(String::new(), String::new())]);
  let mut right_to_left = BTreeMap::from([(String::new(), String::new())]);
  let mut claimed_right = BTreeSet::new();
  let mut pairs = Vec::new();
  for depth in depths {
    let mut unmatched_left = BTreeMap::<(String, String, bool), Vec<&str>>::new();
    for &name in left_by_depth.get(&depth).into_iter().flatten() {
      let item = &left[name];
      let (parent, file) = split_name(name);
      let Some(target_parent) = left_to_right.get(parent).cloned() else {
        pairs.push(NamePair::left_only(name));
        continue;
      };
      let target = join_name(&target_parent, file);
      match right.get(&target) {
        Some(other) => {
          claimed_right.insert(target.clone());
          if same_kind(item, other) {
            if item.is_dir() {
              left_to_right.insert(name.to_owned(), target.clone());
              right_to_left.insert(target.clone(), name.to_owned());
            }
            pairs.push(NamePair::both(name, &target, name));
          } else {
            // A file and a folder with the same name are separate rows.
            pairs.push(NamePair::left_only(name));
            pairs.push(NamePair::right_only(
              &target,
              left_form(&target, &right_to_left),
            ));
          }
        }
        None if eligible(item) => {
          let (_, key) = alignment_key(&target, item.is_dir(), rules);
          unmatched_left
            .entry((target_parent, key, item.is_dir()))
            .or_default()
            .push(name);
        }
        None => pairs.push(NamePair::left_only(name)),
      }
    }
    let mut unmatched_right = BTreeMap::<(String, String, bool), Vec<&str>>::new();
    for &name in right_by_depth.get(&depth).into_iter().flatten() {
      if claimed_right.contains(name) {
        continue;
      }
      let item = &right[name];
      let (parent, _) = split_name(name);
      if !right_to_left.contains_key(parent) || !eligible(item) {
        pairs.push(NamePair::right_only(name, left_form(name, &right_to_left)));
        continue;
      }
      let (_, key) = alignment_key(name, item.is_dir(), rules);
      unmatched_right
        .entry((parent.to_owned(), key, item.is_dir()))
        .or_default()
        .push(name);
    }
    for (key, names) in unmatched_left {
      let others = unmatched_right.remove(&key).unwrap_or_default();
      match (names.as_slice(), others.as_slice()) {
        ([left_name], [right_name]) => {
          if left[*left_name].is_dir() {
            left_to_right.insert((*left_name).to_owned(), (*right_name).to_owned());
            right_to_left.insert((*right_name).to_owned(), (*left_name).to_owned());
          }
          pairs.push(NamePair::both(left_name, right_name, left_name));
        }
        _ => {
          pairs.extend(names.into_iter().map(NamePair::left_only));
          pairs.extend(
            others
              .into_iter()
              .map(|name| NamePair::right_only(name, left_form(name, &right_to_left))),
          );
        }
      }
    }
    for names in unmatched_right.into_values() {
      pairs.extend(
        names
          .into_iter()
          .map(|name| NamePair::right_only(name, left_form(name, &right_to_left))),
      );
    }
  }
  if rules.align_case {
    flag_case_only_orphans(&mut pairs);
  }
  // Same-name rows sort folder-first so a file row never precedes its folder.
  pairs.sort_by(|a, b| {
    let directory = |pair: &NamePair| {
      [(&pair.left, left), (&pair.right, right)]
        .into_iter()
        .find_map(|(name, map)| name.as_ref().and_then(|n| map.get(n)))
        .is_some_and(Item::is_dir)
    };
    (&a.relative, !directory(a)).cmp(&(&b.relative, !directory(b)))
  });
  pairs
}

/// Unpaired names that differ only by Unicode case cannot be aligned by the ASCII
/// rules, so they are reported as unsupported rather than silently listed as orphans.
fn flag_case_only_orphans(pairs: &mut [NamePair]) {
  let mut sides = BTreeMap::<(String, String), (bool, bool, bool)>::new();
  for pair in pairs
    .iter()
    .filter(|pair| pair.left.is_some() != pair.right.is_some())
  {
    let (parent, file) = split_name(&pair.relative);
    let entry = sides
      .entry((parent.to_owned(), file.to_lowercase()))
      .or_default();
    entry.0 |= pair.left.is_some();
    entry.1 |= pair.right.is_some();
    entry.2 |= !file.is_ascii();
  }
  for pair in pairs
    .iter_mut()
    .filter(|pair| pair.left.is_some() != pair.right.is_some())
  {
    let (parent, file) = split_name(&pair.relative);
    if sides
      .get(&(parent.to_owned(), file.to_lowercase()))
      .is_some_and(|(left, right, non_ascii)| *left && *right && *non_ascii)
    {
      pair.case_fold_unsupported = true;
    }
  }
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

fn open(path: &Path, metadata: &fs::Metadata) -> Result<fs::File, FileError> {
  let current = fs::symlink_metadata(path)?;
  if current.is_symlink() || !current.is_file() {
    return Err(FileError("File changed while comparing.".into()));
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
  let mut left = open(left, lm)?;
  let mut right = open(right, rm)?;
  let mut a = vec![0u8; STREAM_CHUNK];
  let mut b = vec![0u8; STREAM_CHUNK];
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
  let mut file = open(path, metadata)?;
  let mut bytes = Vec::new();
  let mut chunk = vec![0u8; STREAM_CHUNK];
  loop {
    cancel(cancelled)?;
    let count = file.read(&mut chunk)?;
    if count == 0 {
      break;
    }
    if bytes.len() + count > TEXT_LIMIT as usize {
      return Err(FileError("File changed while comparing.".into()));
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
  let mut file = open(path, metadata)?;
  let mut hasher = crc32fast::Hasher::new();
  let mut chunk = vec![0u8; STREAM_CHUNK];
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
  let file = open(path, metadata)?;
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
  fell_back_to_binary: std::cell::Cell<bool>,
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
        if self.lm.len() > TEXT_LIMIT || self.rm.len() > TEXT_LIMIT {
          return self.fall_back_to_binary();
        }
        let a = read_text(self.left, self.lm, self.cancelled)?;
        let b = read_text(self.right, self.rm, self.cancelled)?;
        let left = match compare_text::decode(&a, None) {
          Ok(text) => text,
          Err(TextError::InputTooLarge) => return self.fall_back_to_binary(),
          Err(e) => return Err(FileError(e.to_string())),
        };
        let right = match compare_text::decode(&b, None) {
          Ok(text) => text,
          Err(TextError::InputTooLarge) => return self.fall_back_to_binary(),
          Err(e) => return Err(FileError(e.to_string())),
        };
        let spans = match compare_with_rules(
          left.text(),
          right.text(),
          CompareOptions {
            ignore_case: self.rules.text_rules.ignore_case,
            ignore_whitespace: self.rules.text_rules.ignore_whitespace,
            ignore_line_endings: self.rules.text_rules.ignore_line_endings,
          },
          self.compiled,
          WorkControl::new(self.cancelled, Duration::from_secs(2)),
        ) {
          Ok(spans) => spans,
          Err(CompareError::InputTooLarge) => return self.fall_back_to_binary(),
          Err(e) => return Err(FileError(e.to_string())),
        };
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

  fn fall_back_to_binary(&self) -> Result<ComparisonImportance, FileError> {
    self.fell_back_to_binary.set(true);
    binary(self.left, self.right, self.lm, self.rm, self.cancelled)
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
) -> Result<FolderScan, FileError> {
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
) -> Result<FolderScan, FileError> {
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
  if selected.is_empty() || selected.len() > MAX_FOLDER_ENTRIES {
    return Err(FileError(
      "Select between 1 and 250,000 folder rows.".into(),
    ));
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

/// Recompute the rows under `paths` (relative folder row paths; `""` is the whole root) and
/// return only what changed. Every folder row is recomputed so aggregates stay exact, while
/// file contents are compared only under `paths`. A path missing on both sides has no fresh
/// rows, so its previous rows are removed.
#[allow(clippy::too_many_arguments)]
pub fn refresh_paths(
  left: &Path,
  right: &Path,
  options: &FolderOptions,
  rules: &FolderRules,
  previous: &[FolderEntry],
  paths: &[String],
  cancelled: &AtomicBool,
  progress: impl FnMut(usize) + Send,
) -> Result<FolderPatch, FileError> {
  cancel(cancelled)?;
  if paths.is_empty() {
    return Ok(FolderPatch::default());
  }
  if previous.len() > MAX_FOLDER_ENTRIES * 2 {
    return Err(FileError(
      "Previous presentation exceeds the bounded folder limit.".into(),
    ));
  }
  let whole_root = paths.iter().any(String::is_empty)
    || left.as_os_str().is_empty()
    || right.as_os_str().is_empty();
  let named: Vec<String> = paths.iter().filter(|p| !p.is_empty()).cloned().collect();
  if !named.is_empty() {
    validate_selection(&named)?;
  }
  let named = normalize_paths(named);
  let scope = (!whole_root).then_some(named.as_slice());
  let fresh = scan_with_selection(
    left,
    right,
    options,
    rules,
    scope,
    scope.is_some(),
    cancelled,
    progress,
  )?;
  let in_scope = |row: &FolderEntry| {
    scope.is_none_or(|scope| {
      [
        Some(row.relative.as_str()),
        row.left_relative.as_deref(),
        row.right_relative.as_deref(),
      ]
      .into_iter()
      .flatten()
      .any(|name| selected_name(name, scope))
    })
  };
  let key = |row: &FolderEntry| (row.relative.clone(), row.is_directory);
  // Folder rows are always fresh (they carry aggregates); file rows are kept outside scope.
  let mut merged: BTreeMap<(String, bool), FolderEntry> = previous
    .iter()
    .filter(|row| !row.is_directory && !in_scope(row))
    .map(|row| (key(row), row.clone()))
    .collect();
  for row in fresh.entries {
    if row.is_directory || in_scope(&row) {
      merged.insert(key(&row), row);
    }
  }
  if merged.len() > MAX_FOLDER_ENTRIES * 2 {
    return Err(FileError(
      "Refreshed presentation exceeds the bounded folder limit.".into(),
    ));
  }
  let mut rows: Vec<_> = merged.into_values().collect();
  aggregate_directories(&mut rows);
  cancel(cancelled)?;

  let previous_by_key: BTreeMap<(String, bool), &FolderEntry> =
    previous.iter().map(|row| (key(row), row)).collect();
  let current_keys: BTreeSet<(String, bool)> = rows.iter().map(key).collect();
  let removed = previous_by_key
    .keys()
    .filter(|id| !current_keys.contains(*id))
    .map(|(relative, is_directory)| RowId {
      relative: relative.clone(),
      is_directory: *is_directory,
    })
    .collect();
  let upserted = rows
    .into_iter()
    .filter(|row| previous_by_key.get(&key(row)).is_none_or(|old| *old != row))
    .collect();
  Ok(FolderPatch { removed, upserted })
}

/// Sorts and deduplicates paths, then drops every path already covered by a listed ancestor.
/// Sorting places an ancestor before its descendants, so one pass suffices.
fn normalize_paths(mut paths: Vec<String>) -> Vec<String> {
  paths.sort();
  paths.dedup();
  let mut kept: Vec<String> = Vec::with_capacity(paths.len());
  for path in paths {
    if !kept
      .iter()
      .any(|ancestor| selected_name(&path, std::slice::from_ref(ancestor)))
    {
      kept.push(path);
    }
  }
  kept
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
  progress: impl FnMut(usize) + Send,
) -> Result<FolderScan, FileError> {
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
  let progress = ScanProgress::new(progress);
  let walk = |root: &Path, side: FolderSide| {
    if root.as_os_str().is_empty() {
      Ok(Walk {
        items: BTreeMap::new(),
        truncated: false,
      })
    } else {
      collect(root, side, options, cancelled, MAX_FOLDER_ENTRIES, &|| {
        progress.advance()
      })
    }
  };
  let (a, b) = rayon::join(
    || walk(&left, FolderSide::Left),
    || walk(&right, FolderSide::Right),
  );
  let (a, b) = (a?, b?);
  let truncated = a.truncated || b.truncated;
  let (a, b) = (a.items, b.items);
  let pairs = pair_names(&a, &b, rules);
  if let Some(selected) = selected {
    if !refresh
      && selected.iter().any(|name| {
        !pairs.iter().any(|pair| {
          [
            pair.left.as_ref(),
            pair.right.as_ref(),
            Some(&pair.relative),
          ]
          .into_iter()
          .flatten()
          .any(|candidate| candidate == name)
        })
      })
    {
      return Err(FileError(
        "Selected row is missing or excluded; rescan before comparing contents.".into(),
      ));
    }
  }
  let mut jobs = Vec::new();
  for pair in pairs {
    cancel(cancelled)?;
    let is_directory = pair
      .left
      .as_ref()
      .and_then(|name| a.get(name))
      .or_else(|| pair.right.as_ref().and_then(|name| b.get(name)))
      .is_some_and(Item::is_dir);
    if !(refresh && is_directory)
      && selected.is_some_and(|selected| {
        ![
          pair.left.as_deref(),
          pair.right.as_deref(),
          Some(pair.relative.as_str()),
        ]
        .into_iter()
        .flatten()
        .any(|name| selected_name(name, selected))
      })
    {
      continue;
    }
    jobs.push(pair);
  }
  // Rows are evaluated in parallel; `collect` keeps them in pair order.
  let mut rows = jobs
        .into_par_iter()
        .map(
            |NamePair {
                 left: ln,
                 right: rn,
                 relative,
                 case_fold_unsupported,
             }|
             -> Result<FolderEntry, FileError> {
                cancel(cancelled)?;
                let l = ln.as_ref().and_then(|name| a.get(name));
        let r = rn.as_ref().and_then(|name| b.get(name));
        let lm = l.and_then(|item| item.metadata.as_ref());
        let rm = r.and_then(|item| item.metadata.as_ref());
        let kind = |item: Option<&Item>| {
            item.and_then(|item| {
                item.metadata.as_ref().map(|_| {
                    if item.is_link() {
                        FolderEntryKind::Link
                    } else if item.is_dir() {
                        FolderEntryKind::Directory
                    } else {
                        FolderEntryKind::File
                    }
                })
            })
        };
        let mut row = FolderEntry {
            relative: relative.clone(),
            left_relative: ln.clone(),
            right_relative: rn.clone(),
            left_kind: kind(l),
            right_kind: kind(r),
            status: FolderStatus::Error,
            left_size: lm.map(|m| m.len()),
            right_size: rm.map(|m| m.len()),
            left_modified: lm.and_then(|m| m.modified().ok()).and_then(modified_ms),
            right_modified: rm.and_then(|m| m.modified().ok()).and_then(modified_ms),
            newer: None,
            newer_mixed: false,
            counts: FolderCounts::default(),
            importance: ComparisonImportance::Unknown,
            error: None,
            detail: None,
            is_directory: l.is_some_and(Item::is_dir) || r.is_some_and(Item::is_dir),
        };
        let result = (|| -> Result<ComparisonImportance, FileError> {
            if !single_side && case_fold_unsupported {
                return Err(FileError("Capability unavailable: non-ASCII case folding is not supported; Unicode normalization does not imply case folding.".into()));
            }
            let errors: Vec<_> = [("Left", l), ("Right", r)]
                .into_iter()
                .filter_map(|(side, item)| {
                    item.and_then(|item| item.error.as_ref())
                        .map(|error| format!("{side}: {error}"))
                })
                .collect();
            if !errors.is_empty() {
                return Err(FileError(errors.join("; ")));
            }
            let link_targets = (
                l.and_then(|item| item.link_target.as_deref()),
                r.and_then(|item| item.link_target.as_deref()),
            );
            match link_targets {
                (Some(left), Some(right)) => {
                    row.detail = Some(format!("Link targets: left \"{left}\"; right \"{right}\""));
                }
                (Some(target), None) | (None, Some(target)) => {
                    row.detail = Some(format!("Link to \"{target}\""));
                }
                (None, None) => {}
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
            if let (Some(left), Some(right)) = link_targets {
                // Links are compared by target text only; their targets are never read.
                let same = left == right;
                row.status = if same {
                    FolderStatus::Same
                } else {
                    FolderStatus::Different
                };
                return Ok(if same {
                    ComparisonImportance::Equal
                } else {
                    ComparisonImportance::Important
                });
            }
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
                || (rules.compare_readonly
                    && lm.permissions().readonly() != rm.permissions().readonly())
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
                let comparison = ContentComparison {
                    left: &left.join(ln.as_ref().unwrap()),
                    right: &right.join(rn.as_ref().unwrap()),
                    lm,
                    rm,
                    rules,
                    compiled: &compiled,
                    cancelled,
                    fell_back_to_binary: std::cell::Cell::new(false),
                };
                let importance = comparison.compare()?;
                if comparison.fell_back_to_binary.get() {
                    row.detail = Some(match row.detail.take() {
                        Some(detail) => format!("{detail}; {TEXT_FALLBACK_DETAIL}"),
                        None => TEXT_FALLBACK_DETAIL.into(),
                    });
                }
                importance
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
        Ok(row)
            }
        )
        .collect::<Result<Vec<_>, FileError>>()?;
  if !refresh {
    aggregate_directories(&mut rows);
  }
  progress.finish(a.len() + b.len());
  Ok(FolderScan {
    scan_id: String::new(),
    entries: rows,
    truncated,
  })
}

fn aggregate_directories(rows: &mut [FolderEntry]) {
  // Every descendant row contributes to each ancestor directory row exactly once.
  // Status and importance come from all descendants; counts and newer/newerMixed
  // come from descendant files only. Only a paired `same` folder is promoted to
  // `different`; one-sided and self-errored folders keep their own status.
  let mut by_name = BTreeMap::new();
  for (index, row) in rows.iter().enumerate() {
    if row.is_directory {
      by_name.insert(row.relative.clone(), index);
    }
  }
  let mut order: Vec<_> = (0..rows.len()).collect();
  order.sort_by_key(|&index| std::cmp::Reverse(rows[index].relative.matches('/').count()));
  for row in rows.iter_mut().filter(|row| row.is_directory) {
    row.counts = FolderCounts::default();
  }
  for index in order {
    let child = rows[index].clone();
    let mut ancestor = child.relative.as_str();
    while let Some((parent, _)) = ancestor.rsplit_once('/') {
      ancestor = parent;
      let Some(&parent_index) = by_name.get(parent) else {
        continue;
      };
      let parent = &mut rows[parent_index];
      if matches!(
        child.status,
        FolderStatus::Different | FolderStatus::LeftOnly | FolderStatus::RightOnly
      ) && parent.status == FolderStatus::Same
      {
        parent.status = FolderStatus::Different;
      }
      if child.importance == ComparisonImportance::Important {
        parent.importance = ComparisonImportance::Important;
      } else if child.importance == ComparisonImportance::Unimportant
        && parent.importance == ComparisonImportance::Equal
      {
        parent.importance = ComparisonImportance::Unimportant;
      }
      if child.is_directory {
        continue;
      }
      match child.status {
        FolderStatus::Different => parent.counts.different += 1,
        FolderStatus::LeftOnly => parent.counts.left_only += 1,
        FolderStatus::RightOnly => parent.counts.right_only += 1,
        FolderStatus::Error => parent.counts.error += 1,
        FolderStatus::Same => {}
      }
      if child.newer_mixed
        || (parent.newer.is_some() && child.newer.is_some() && parent.newer != child.newer)
      {
        parent.newer_mixed = true;
        parent.newer = None;
      } else if !parent.newer_mixed && child.newer.is_some() {
        parent.newer = child.newer;
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Seek, SeekFrom, Write};

  /// Exact byte comparison, no quick test, zero timestamp tolerance: the pre-Phase 3 default.
  fn binary_rules() -> FolderRules {
    FolderRules {
      content: ContentMethod::Binary,
      quick_test: QuickTest::None,
      timestamp_tolerance_ms: 0,
      ..Default::default()
    }
  }

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
      .entries
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
  fn a_walk_stops_at_the_limit_and_reports_truncation() {
    let fixture = Fixture::new();
    for index in 0..50 {
      fs::write(fixture.left.join(format!("file-{index:02}")), b"x").unwrap();
    }
    let walk = collect(
      &fixture.left,
      FolderSide::Left,
      &FolderOptions::default(),
      &AtomicBool::new(false),
      20,
      &|| {},
    )
    .unwrap();
    assert!(walk.truncated);
    assert_eq!(walk.items.len(), 20);

    let complete = collect(
      &fixture.left,
      FolderSide::Left,
      &FolderOptions::default(),
      &AtomicBool::new(false),
      50,
      &|| {},
    )
    .unwrap();
    assert!(!complete.truncated);
    assert_eq!(complete.items.len(), 50);
  }

  #[cfg(unix)]
  #[test]
  fn a_name_that_is_not_unicode_becomes_an_error_row() {
    use std::os::unix::ffi::OsStrExt;

    let fixture = Fixture::new();
    let name = std::ffi::OsStr::from_bytes(b"bad-\xff");
    fs::write(fixture.left.join(name), b"x").unwrap();
    let walk = collect(
      &fixture.left,
      FolderSide::Left,
      &FolderOptions::default(),
      &AtomicBool::new(false),
      10,
      &|| {},
    )
    .unwrap();
    let item = walk.items.values().next().unwrap();
    assert_eq!(item.error.as_deref(), Some(NON_UNICODE_NAME));
  }

  #[test]
  fn cancelling_a_parallel_scan_stops_it_with_an_error() {
    let fixture = Fixture::new();
    for index in 0..2_000 {
      fs::write(fixture.left.join(format!("file-{index:04}")), b"left").unwrap();
      fs::write(fixture.right.join(format!("file-{index:04}")), b"right").unwrap();
    }
    let cancelled = AtomicBool::new(false);
    let error = scan_pair_with_rules(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &binary_rules(),
      &cancelled,
      |count| {
        if count >= 100 {
          cancelled.store(true, Ordering::Relaxed);
        }
      },
    )
    .unwrap_err();
    assert!(error.to_string().contains("cancelled"), "{error}");
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
  fn defaults_use_metadata_quick_test_and_legacy_criterion_is_not_reused() {
    let fixture = Fixture::new();
    fixture.files(b"one", b"two");
    let base = 1_700_000_000_000;
    fixture.times(base, base);
    // Same size and equal mtime: the default quick test passes without reading content.
    assert_eq!(
      fixture.scan(&FolderRules::default())[0].status,
      FolderStatus::Same
    );
    let rows = fixture.scan(&binary_rules());
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
      &binary_rules(),
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap()
    .entries;
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
  fn links_compare_targets_and_are_never_traversed() {
    let fixture = Fixture::new();
    let parent = fixture.left.parent().unwrap().to_path_buf();
    let target = parent.join("target");
    let other = parent.join("other");
    fs::create_dir(&target).unwrap();
    fs::create_dir(&other).unwrap();
    fs::write(target.join("inside.txt"), b"contents").unwrap();
    make_directory_link(&target, &fixture.left.join("link")).unwrap();
    make_directory_link(&target, &fixture.right.join("link")).unwrap();
    make_directory_link(&other, &fixture.right.join("moved")).unwrap();
    make_directory_link(&target, &fixture.left.join("moved")).unwrap();
    let rows = fixture.scan(&FolderRules::default());
    let row = |name: &str| rows.iter().find(|row| row.relative == name).unwrap();
    assert_eq!(row("link").left_kind, Some(FolderEntryKind::Link));
    assert_eq!(row("link").status, FolderStatus::Same);
    assert_eq!(row("moved").status, FolderStatus::Different);
    assert!(
      rows.iter().all(|row| !row.relative.starts_with("link/")),
      "link targets must not be listed: {rows:?}"
    );
  }

  #[test]
  fn open_refuses_a_link_that_replaced_a_file_after_the_scan() {
    let fixture = Fixture::new();
    let parent = fixture.left.parent().unwrap().to_path_buf();
    let target = parent.join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("inside.txt"), b"contents").unwrap();
    let scanned = fs::metadata(target.join("inside.txt")).unwrap();
    let swapped = parent.join("swapped");
    make_directory_link(&target, &swapped).unwrap();
    let error = open(&swapped, &scanned).unwrap_err();
    assert_eq!(error.0, "File changed while comparing.");
  }

  #[cfg(windows)]
  fn make_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    let status = std::process::Command::new("cmd")
      .args(["/C", "mklink", "/J"])
      .arg(link)
      .arg(target)
      .stdout(std::process::Stdio::null())
      .status()?;
    if status.success() {
      Ok(())
    } else {
      Err(std::io::Error::other("mklink /J failed"))
    }
  }

  #[cfg(unix)]
  fn make_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
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
      quick_test: QuickTest::None,
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
          ..binary_rules()
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
      ..binary_rules()
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
  fn folder_case_alignment_pairs_the_folder_and_its_children_under_one_node() {
    assert!(FolderRules::default().align_case);
    let fixture = Fixture::new();
    fs::create_dir(fixture.left.join("Docs")).unwrap();
    fs::create_dir(fixture.right.join("docs")).unwrap();
    fs::write(fixture.left.join("Docs").join("a.txt"), b"x").unwrap();
    fs::write(fixture.right.join("docs").join("a.txt"), b"x").unwrap();
    fs::write(fixture.right.join("docs").join("extra.txt"), b"x").unwrap();
    let rows = fixture.scan(&FolderRules::default());
    let folder = rows.iter().find(|r| r.relative == "Docs").unwrap();
    assert!(folder.is_directory);
    assert_eq!(folder.left_relative.as_deref(), Some("Docs"));
    assert_eq!(folder.right_relative.as_deref(), Some("docs"));
    let same = rows.iter().find(|r| r.relative == "Docs/a.txt").unwrap();
    assert_eq!(same.status, FolderStatus::Same);
    assert_eq!(same.right_relative.as_deref(), Some("docs/a.txt"));
    let extra = rows
      .iter()
      .find(|r| r.relative == "Docs/extra.txt")
      .unwrap();
    assert_eq!(extra.status, FolderStatus::RightOnly);
    assert_eq!(extra.left_relative, None);
    assert_eq!(extra.right_relative.as_deref(), Some("docs/extra.txt"));
    assert!(rows.iter().all(|r| !r.relative.starts_with("docs/")));
  }

  fn synthetic_dir() -> Item {
    Item {
      metadata: Some(fs::metadata(".").unwrap()),
      link_target: None,
      error: None,
    }
  }

  #[test]
  fn ambiguous_folder_case_alignment_is_not_paired() {
    let rules = FolderRules::default();
    let left = BTreeMap::from([
      ("Docs".to_owned(), synthetic_dir()),
      ("DOCS".to_owned(), synthetic_dir()),
    ]);
    let right = BTreeMap::from([("docs".to_owned(), synthetic_dir())]);
    let pairs = pair_names(&left, &right, &rules);
    assert_eq!(pairs.len(), 3);
    assert!(pairs
      .iter()
      .all(|pair| pair.left.is_none() || pair.right.is_none()));
    assert_eq!(pairs.iter().filter(|pair| pair.left.is_some()).count(), 2);
    assert!(pairs
      .iter()
      .any(|pair| pair.right.as_deref() == Some("docs") && pair.relative == "docs"));

    let unique_left = BTreeMap::from([("Docs".to_owned(), synthetic_dir())]);
    let pairs = pair_names(&unique_left, &right, &rules);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].left.as_deref(), Some("Docs"));
    assert_eq!(pairs[0].right.as_deref(), Some("docs"));
  }

  #[test]
  fn non_ascii_orphans_error_only_when_a_case_only_counterpart_exists() {
    let fixture = Fixture::new();
    fs::write(fixture.left.join("\u{c4}.txt"), b"x").unwrap();
    fs::write(fixture.right.join("\u{e4}.txt"), b"x").unwrap();
    fs::write(fixture.left.join("\u{e9}.log"), b"x").unwrap();
    fs::write(fixture.right.join("plain.txt"), b"x").unwrap();
    let rows = fixture.scan(&FolderRules::default());
    let unsupported: Vec<_> = rows
      .iter()
      .filter(|r| r.status == FolderStatus::Error)
      .map(|r| r.relative.as_str())
      .collect();
    assert_eq!(unsupported.len(), 2);
    assert!(unsupported.contains(&"\u{c4}.txt"));
    assert!(unsupported.contains(&"\u{e4}.txt"));
    let lone = rows.iter().find(|r| r.relative == "\u{e9}.log").unwrap();
    assert_eq!(lone.status, FolderStatus::LeftOnly);
    assert!(lone.error.is_none());
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
      .unwrap()
      .entries;
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
    let mut bytes = vec![0u8; STREAM_CHUNK * 2 + 1];
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
  }

  #[test]
  fn files_above_one_hundred_mebibytes_are_compared_without_a_cap() {
    const LARGE: u64 = 120 * 1024 * 1024;
    let fixture = Fixture::new();
    fixture.files(b"", b"");
    for root in [&fixture.left, &fixture.right] {
      fs::File::options()
        .write(true)
        .open(root.join("file"))
        .unwrap()
        .set_len(LARGE)
        .unwrap();
    }
    let left = fixture.left.join("file");
    let right = fixture.right.join("file");
    let cancelled = AtomicBool::new(false);
    assert_eq!(
      crc(&left, &fs::metadata(&left).unwrap(), &cancelled).unwrap(),
      crc(&right, &fs::metadata(&right).unwrap(), &cancelled).unwrap()
    );
    assert_eq!(fixture.scan(&binary_rules())[0].status, FolderStatus::Same);
    let rules = FolderRules {
      content: ContentMethod::Crc,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
    fs::File::options()
      .write(true)
      .open(&right)
      .unwrap()
      .set_len(LARGE + 1)
      .unwrap();
    assert_eq!(
      fixture.scan(&binary_rules())[0].status,
      FolderStatus::Different
    );
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
    fs::File::options()
      .write(true)
      .open(&right)
      .unwrap()
      .set_len(LARGE)
      .unwrap();
    let mut last = fs::File::options().write(true).open(&right).unwrap();
    last.seek(SeekFrom::Start(LARGE - 1)).unwrap();
    last.write_all(&[1]).unwrap();
    drop(last);
    assert_eq!(
      fixture.scan(&binary_rules())[0].status,
      FolderStatus::Different
    );
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Different);
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
      alignment_key("\u{fb01}.txt", false, &rules),
      alignment_key("fi.txt", false, &rules)
    );
    assert_ne!(
      alignment_key("\u{c4}.txt", false, &rules),
      alignment_key("\u{e4}.txt", false, &rules)
    );
    assert_ne!(
      alignment_key("a/\u{e9}.txt", false, &rules),
      alignment_key("b/e\u{301}.txt", false, &rules)
    );
    rules.align_extensions = true;
    assert_eq!(
      alignment_key("\u{e9}.txt", false, &rules),
      alignment_key("e\u{301}.bin", false, &rules)
    );
  }

  #[test]
  fn folder_names_align_without_extension_stripping() {
    let rules = FolderRules {
      align_case: true,
      align_extensions: true,
      ..Default::default()
    };
    assert_eq!(
      alignment_key("Docs.v1", true, &rules),
      ("".into(), "docs.v1".into())
    );
    assert_eq!(
      alignment_key("Docs.v1", false, &rules),
      ("".into(), "docs".into())
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
  fn oversized_text_falls_back_to_binary_with_a_row_detail() {
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
    assert_eq!(rows[0].status, FolderStatus::Same);
    assert_eq!(rows[0].error, None);
    assert_eq!(rows[0].detail.as_deref(), Some(TEXT_FALLBACK_DETAIL));
    let mut right = fs::File::options()
      .write(true)
      .open(fixture.right.join("file"))
      .unwrap();
    right.seek(SeekFrom::Start(TEXT_LIMIT)).unwrap();
    right.write_all(&[1]).unwrap();
    drop(right);
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Different);
    assert_eq!(rows[0].detail.as_deref(), Some(TEXT_FALLBACK_DETAIL));
    assert_eq!(
      fixture.scan(&binary_rules())[0].status,
      FolderStatus::Different
    );
    for root in [&fixture.left, &fixture.right] {
      fs::File::options()
        .write(true)
        .open(root.join("file"))
        .unwrap()
        .set_len(TEXT_LIMIT)
        .unwrap();
    }
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Same);
    assert_eq!(rows[0].detail.as_deref(), Some(TEXT_FALLBACK_DETAIL));
    let rules = FolderRules {
      content: ContentMethod::None,
      compare_size: true,
      ..Default::default()
    };
    assert_eq!(fixture.scan(&rules)[0].status, FolderStatus::Same);
  }

  #[test]
  fn text_between_the_engine_cap_and_text_limit_falls_back_to_binary() {
    let fixture = Fixture::new();
    let line = b"shared line of text\n";
    let body: Vec<u8> = line.iter().copied().cycle().take(2 * 1024 * 1024).collect();
    let mut changed = body.clone();
    *changed.last_mut().unwrap() = b'X';
    fixture.files(&body, &changed);
    let rules = FolderRules {
      content: ContentMethod::Rules,
      ..Default::default()
    };
    let rows = fixture.scan(&rules);
    assert_eq!(rows[0].status, FolderStatus::Different);
    assert_eq!(rows[0].error, None);
    assert_eq!(rows[0].detail.as_deref(), Some(TEXT_FALLBACK_DETAIL));
  }

  #[test]
  fn byte_streaming_checks_all_chunks_and_detects_changed_snapshots() {
    let fixture = Fixture::new();
    let mut bytes = vec![0u8; STREAM_CHUNK * 2 + 1];
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
    assert!(open(&left, &old).is_err());
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
    let mut refreshed = rows.clone();
    refresh_paths(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules::default(),
      &rows,
      &["collision".into()],
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap()
    .apply_to(&mut refreshed);
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
        quick_test: QuickTest::None,
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
    assert_eq!(rules, FolderRules::default());
    assert_eq!(rules.content, ContentMethod::None);
    assert_eq!(rules.quick_test, QuickTest::Modified);
    assert_eq!(rules.quick_test_policy, QuickTestPolicy::Override);
    assert_eq!(rules.timestamp_tolerance_ms, 2000);
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
    .entries
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
    .unwrap()
    .entries;
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
    .unwrap()
    .entries;
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
    .unwrap()
    .entries;
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
    assert!(plan
      .execute(&flag, |_| {})
      .unwrap()
      .iter()
      .all(|(_, result)| result.is_err()));
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
      .any(|row| row.relative == "large" && row.status == FolderStatus::Same));
    let rows = scan_selected_with_rules(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &rules,
      &["file".into()],
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap()
    .entries;
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
    .unwrap()
    .entries;
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
    .unwrap()
    .entries;
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
    let rows = fixture.scan(&binary_rules());
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
  fn refreshed_selection_recomputes_directory_counts_without_double_counting() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("parent").join("sub")).unwrap();
    }
    fs::write(fixture.left.join("parent").join("sub").join("diff"), b"a").unwrap();
    fs::write(fixture.right.join("parent").join("sub").join("diff"), b"b").unwrap();
    fs::write(fixture.left.join("parent").join("left-only"), b"x").unwrap();
    let rules = FolderRules {
      content: ContentMethod::Rules,
      ..Default::default()
    };
    let full = fixture.scan(&rules);
    let mut refreshed = full.clone();
    refresh_paths(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &rules,
      &full,
      &["parent/sub".into()],
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap()
    .apply_to(&mut refreshed);
    let counts_of = |rows: &[FolderEntry], relative: &str| {
      rows.iter().find(|r| r.relative == relative).unwrap().counts
    };
    assert_eq!(counts_of(&refreshed, "parent"), counts_of(&full, "parent"));
    assert_eq!(
      counts_of(&refreshed, "parent"),
      FolderCounts {
        different: 1,
        left_only: 1,
        ..Default::default()
      }
    );
  }

  #[test]
  fn directory_counts_and_status_follow_the_descendant_aggregation_rules() {
    let fixture = Fixture::new();
    let parent = |root: &Path| root.join("parent");
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(parent(root).join("nested")).unwrap();
    }
    // Differs in content at depth 2; counted once per file, not per ancestor.
    fs::write(parent(&fixture.left).join("nested").join("diff"), b"a").unwrap();
    fs::write(parent(&fixture.right).join("nested").join("diff"), b"b").unwrap();
    // Left-only and right-only files at depth 1.
    fs::write(parent(&fixture.left).join("left-only"), b"x").unwrap();
    fs::write(parent(&fixture.right).join("right-only"), b"x").unwrap();
    // An unreadable-as-text descendant on both sides: the file errors, the folder does not.
    fs::write(parent(&fixture.left).join("bad"), b"\xff").unwrap();
    fs::write(parent(&fixture.right).join("bad"), b"\xff").unwrap();
    // An empty orphan folder is a LeftOnly descendant row and must mark the parent different.
    fs::create_dir(parent(&fixture.left).join("orphan-dir")).unwrap();
    // An unreadable-as-text file deep in an otherwise identical tree: ancestors stay same.
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("quiet").join("deep")).unwrap();
      fs::write(root.join("quiet").join("deep").join("bad"), b"\xff").unwrap();
    }
    let rows = fixture.scan(&FolderRules {
      content: ContentMethod::Rules,
      ..Default::default()
    });
    let row = |relative: &str| rows.iter().find(|r| r.relative == relative).unwrap();
    assert_eq!(row("quiet/deep/bad").status, FolderStatus::Error);
    assert_eq!(row("quiet/deep").status, FolderStatus::Same);
    assert_eq!(row("quiet").status, FolderStatus::Same);
    assert_eq!(
      row("quiet").counts,
      FolderCounts {
        error: 1,
        ..Default::default()
      }
    );

    let parent_row = row("parent");
    assert_eq!(parent_row.status, FolderStatus::Different);
    assert_eq!(
      parent_row.counts,
      FolderCounts {
        different: 1,
        left_only: 1,
        right_only: 1,
        error: 1,
      }
    );
    assert_eq!(row("parent/nested").status, FolderStatus::Different);
    assert_eq!(
      row("parent/nested").counts,
      FolderCounts {
        different: 1,
        ..Default::default()
      }
    );
    assert_eq!(row("parent/bad").status, FolderStatus::Error);
    assert_eq!(row("parent/orphan-dir").status, FolderStatus::LeftOnly);
    let value = serde_json::to_value(parent_row).unwrap();
    assert_eq!(value["counts"]["leftOnly"], 1);
    assert_eq!(value["counts"]["rightOnly"], 1);
  }

  #[test]
  fn one_sided_and_identical_folders_keep_their_own_status_and_fold_descendants() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.left.join("solo").join("deep")).unwrap();
    fs::write(fixture.left.join("solo").join("deep").join("file"), b"x").unwrap();
    // Same-name folder on both sides with identical files stays same.
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("paired")).unwrap();
      fs::write(root.join("paired").join("file"), b"same").unwrap();
    }
    let rows = fixture.scan(&binary_rules());
    let row = |relative: &str| rows.iter().find(|r| r.relative == relative).unwrap();
    assert_eq!(row("solo").status, FolderStatus::LeftOnly);
    assert_eq!(row("solo").counts.left_only, 1);
    assert_eq!(row("paired").status, FolderStatus::Same);
    assert_eq!(row("paired").counts, FolderCounts::default());
  }

  /// Makes a directory unreadable until dropped. Returns `None` when this process can still
  /// list it anyway (for example as root), so the caller can skip the scenario.
  struct UnreadableDir(PathBuf);

  impl UnreadableDir {
    #[cfg(unix)]
    fn new(path: &Path) -> Option<Self> {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
      let guard = Self(path.to_path_buf());
      fs::read_dir(path).is_err().then_some(guard)
    }

    #[cfg(windows)]
    fn new(path: &Path) -> Option<Self> {
      let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/deny", "*S-1-1-0:(R)"])
        .status()
        .expect("run icacls");
      assert!(status.success(), "icacls could not deny read access");
      let guard = Self(path.to_path_buf());
      fs::read_dir(path).is_err().then_some(guard)
    }
  }

  impl Drop for UnreadableDir {
    fn drop(&mut self) {
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
      }
      #[cfg(windows)]
      {
        let _ = std::process::Command::new("icacls")
          .arg(&self.0)
          .arg("/reset")
          .status();
      }
    }
  }

  #[test]
  fn unreadable_folder_is_error_and_its_ancestors_stay_same() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("outer").join("locked")).unwrap();
      fs::write(root.join("outer").join("same"), b"x").unwrap();
    }
    let Some(_locked) = UnreadableDir::new(&fixture.left.join("outer").join("locked")) else {
      eprintln!("skipped: this process can still read a denied folder");
      return;
    };
    let rows = fixture.scan(&binary_rules());
    let row = |relative: &str| rows.iter().find(|r| r.relative == relative).unwrap();
    let locked = row("outer/locked");
    assert_eq!(locked.status, FolderStatus::Error);
    assert!(locked.error.as_deref().unwrap().starts_with("Left:"));
    assert_eq!(row("outer").status, FolderStatus::Same);
    // Counts cover descendant files only, so the unreadable folder itself is not counted.
    assert_eq!(row("outer").counts, FolderCounts::default());
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
    assert_eq!(parent.status, FolderStatus::Different);
    assert!(rows
      .iter()
      .any(|r| r.relative == "parent/orphan" && r.status == FolderStatus::LeftOnly));
    let large = rows.iter().find(|r| r.relative == "parent/large").unwrap();
    assert_eq!(large.status, FolderStatus::Same);
    assert_eq!(large.detail.as_deref(), Some(TEXT_FALLBACK_DETAIL));
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
  fn refresh_paths_rejects_invalid_paths_and_root_failures() {
    let fixture = Fixture::new();
    for paths in [vec!["../escape".to_string()], vec!["a//b".to_string()]] {
      assert!(refresh_paths(
        &fixture.left,
        &fixture.right,
        &FolderOptions::default(),
        &FolderRules::default(),
        &[],
        &paths,
        &AtomicBool::new(false),
        |_| {},
      )
      .is_err());
    }
    fs::remove_dir(&fixture.left).unwrap();
    assert!(refresh_paths(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      &FolderRules::default(),
      &[],
      &["missing".into()],
      &AtomicBool::new(false),
      |_| {},
    )
    .is_err());
  }

  fn sorted_rows(rows: &[FolderEntry]) -> Vec<FolderEntry> {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| (&a.relative, a.is_directory).cmp(&(&b.relative, b.is_directory)));
    rows
  }

  /// Refreshing `paths` and applying the patch to `previous` must reproduce a full rescan
  /// of the current disk state exactly.
  fn refresh_matches_full_scan(
    fixture: &Fixture,
    rules: &FolderRules,
    previous: &[FolderEntry],
    paths: &[&str],
  ) -> FolderPatch {
    let paths: Vec<String> = paths.iter().map(|path| path.to_string()).collect();
    let patch = refresh_paths(
      &fixture.left,
      &fixture.right,
      &FolderOptions::default(),
      rules,
      previous,
      &paths,
      &AtomicBool::new(false),
      |_| {},
    )
    .unwrap();
    let mut patched = previous.to_vec();
    patch.apply_to(&mut patched);
    // NTFS updates a directory's own timestamp lazily in its parent's index, so a
    // directory's modified time read right after a write can lag a later scan.
    // Directory status is aggregated from children, so compare directory times loosely.
    let normalize = |rows: Vec<FolderEntry>| -> Vec<FolderEntry> {
      rows
        .into_iter()
        .map(|mut row| {
          if row.is_directory {
            row.left_modified = None;
            row.right_modified = None;
          }
          row
        })
        .collect()
    };
    assert_eq!(
      normalize(sorted_rows(&patched)),
      normalize(sorted_rows(&fixture.scan(rules)))
    );
    patch
  }

  fn row<'a>(rows: &'a [FolderEntry], relative: &str) -> &'a FolderEntry {
    rows.iter().find(|row| row.relative == relative).unwrap()
  }

  #[test]
  fn refresh_paths_picks_up_a_file_added_inside_a_refreshed_folder() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir(root.join("parent")).unwrap();
    }
    fs::write(fixture.left.join("parent").join("same"), b"a").unwrap();
    fs::write(fixture.right.join("parent").join("same"), b"a").unwrap();
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    fs::write(fixture.left.join("parent").join("added"), b"x").unwrap();

    let patch = refresh_matches_full_scan(&fixture, &rules, &previous, &["parent"]);

    assert!(patch.removed.is_empty());
    assert_eq!(
      row(&patch.upserted, "parent/added").status,
      FolderStatus::LeftOnly
    );
    assert_eq!(
      row(&patch.upserted, "parent").status,
      FolderStatus::Different
    );
  }

  #[test]
  fn refresh_paths_one_sided_deletion_turns_the_folder_one_sided() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("parent").join("sub")).unwrap();
      fs::write(root.join("parent").join("sub").join("file"), b"a").unwrap();
    }
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    fs::remove_dir_all(fixture.left.join("parent")).unwrap();

    let patch = refresh_matches_full_scan(&fixture, &rules, &previous, &["parent"]);

    assert!(patch.removed.is_empty());
    assert_eq!(
      row(&patch.upserted, "parent").status,
      FolderStatus::RightOnly
    );
    assert_eq!(
      row(&patch.upserted, "parent/sub/file").status,
      FolderStatus::RightOnly
    );
  }

  #[test]
  fn refresh_paths_removes_rows_for_a_folder_deleted_on_both_sides() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("gone").join("sub")).unwrap();
      fs::write(root.join("gone").join("sub").join("file"), b"a").unwrap();
    }
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    fs::remove_dir_all(fixture.left.join("gone")).unwrap();
    fs::remove_dir_all(fixture.right.join("gone")).unwrap();

    let patch = refresh_matches_full_scan(&fixture, &rules, &previous, &["gone"]);

    assert!(patch.upserted.is_empty());
    for (relative, is_directory) in [("gone", true), ("gone/sub", true), ("gone/sub/file", false)] {
      assert!(patch.removed.contains(&RowId {
        relative: relative.into(),
        is_directory,
      }));
    }
  }

  #[test]
  fn refresh_paths_turns_an_orphan_folder_same_when_the_other_side_matches() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.left.join("orphan")).unwrap();
    fs::write(fixture.left.join("orphan").join("x"), b"a").unwrap();
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    assert_eq!(row(&previous, "orphan").status, FolderStatus::LeftOnly);
    fs::create_dir(fixture.right.join("orphan")).unwrap();
    fs::write(fixture.right.join("orphan").join("x"), b"a").unwrap();

    let patch = refresh_matches_full_scan(&fixture, &rules, &previous, &["orphan"]);

    assert_eq!(row(&patch.upserted, "orphan").status, FolderStatus::Same);
    assert_eq!(row(&patch.upserted, "orphan/x").status, FolderStatus::Same);
  }

  #[test]
  fn refresh_paths_replaces_a_file_with_a_folder_of_the_same_name() {
    let fixture = Fixture::new();
    fixture.files(b"a", b"a");
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    fs::remove_file(fixture.left.join("file")).unwrap();
    fs::create_dir(fixture.left.join("file")).unwrap();
    fs::write(fixture.left.join("file").join("inner"), b"x").unwrap();

    let patch = refresh_matches_full_scan(&fixture, &rules, &previous, &["file"]);

    // The right side still has a file, so the old file row becomes right-only rather than
    // disappearing; the new folder row and its child are added.
    assert!(!patch.removed.contains(&RowId {
      relative: "file".into(),
      is_directory: false,
    }));
    let old_file = patch
      .upserted
      .iter()
      .find(|row| row.relative == "file" && !row.is_directory)
      .unwrap();
    assert_eq!(old_file.status, FolderStatus::RightOnly);
    assert!(patch.upserted.iter().any(|row| row.relative == "file"
      && row.is_directory
      && row.left_kind == Some(FolderEntryKind::Directory)));
    assert!(patch
      .upserted
      .iter()
      .any(|row| row.relative == "file/inner"));
  }

  #[test]
  fn refresh_paths_makes_an_ancestor_same_after_the_last_missing_file_is_copied() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.left.join("parent")).unwrap();
    fs::create_dir(fixture.right.join("parent")).unwrap();
    fs::write(fixture.left.join("parent").join("missing"), b"a").unwrap();
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    assert_eq!(row(&previous, "parent").status, FolderStatus::Different);
    fs::write(fixture.right.join("parent").join("missing"), b"a").unwrap();

    let patch = refresh_matches_full_scan(&fixture, &rules, &previous, &["parent/missing"]);

    assert_eq!(row(&patch.upserted, "parent").status, FolderStatus::Same);
  }

  #[test]
  fn refresh_paths_root_request_matches_a_full_rescan() {
    let fixture = Fixture::new();
    fixture.files(b"a", b"b");
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    fs::write(fixture.left.join("added"), b"x").unwrap();

    refresh_matches_full_scan(&fixture, &rules, &previous, &[""]);
  }

  #[test]
  fn refresh_paths_walks_up_from_a_path_missing_on_both_sides() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("parent")).unwrap();
      fs::write(root.join("parent").join("keep"), b"k").unwrap();
      fs::write(root.join("parent").join("gone"), b"g").unwrap();
    }
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);
    fs::remove_file(fixture.left.join("parent").join("gone")).unwrap();
    fs::remove_file(fixture.right.join("parent").join("gone")).unwrap();

    let patch = refresh_matches_full_scan(&fixture, &rules, &previous, &["parent/gone"]);

    assert!(patch.removed.contains(&RowId {
      relative: "parent/gone".into(),
      is_directory: false,
    }));
  }

  #[test]
  fn refresh_paths_treats_duplicate_and_nested_paths_as_their_ancestor() {
    let fixture = Fixture::new();
    for root in [&fixture.left, &fixture.right] {
      fs::create_dir_all(root.join("parent").join("sub")).unwrap();
    }
    fs::write(fixture.left.join("parent").join("sub").join("new"), b"x").unwrap();
    let rules = FolderRules::default();
    let previous = fixture.scan(&rules);

    let plain = refresh_matches_full_scan(&fixture, &rules, &previous, &["parent"]);
    let noisy = refresh_matches_full_scan(
      &fixture,
      &rules,
      &previous,
      &["parent/sub", "parent", "parent/sub"],
    );

    assert_eq!(plain, noisy);
  }
}
