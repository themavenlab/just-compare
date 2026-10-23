use compare_text::{decode, DecodedText, TextEncoding};
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

#[derive(Debug)]
pub struct FileError(pub String);

impl fmt::Display for FileError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(&self.0)
  }
}
impl std::error::Error for FileError {}
impl From<std::io::Error> for FileError {
  fn from(error: std::io::Error) -> Self {
    Self(error.to_string())
  }
}

pub fn checked_path(path: &Path, allow_missing_leaf: bool) -> Result<PathBuf, FileError> {
  if !path.is_absolute()
    || path
      .components()
      .any(|c| matches!(c, std::path::Component::ParentDir))
  {
    return Err(FileError(
      "An absolute path without parent traversal is required.".into(),
    ));
  }
  for ancestor in path.ancestors() {
    match fs::symlink_metadata(ancestor) {
      Ok(metadata) => {
        #[cfg(windows)]
        {
          use std::os::windows::fs::MetadataExt;
          if metadata.file_attributes() & 0x400 != 0 {
            return Err(FileError(
              "Reparse points and junctions are not followed.".into(),
            ));
          }
        }
        if metadata.file_type().is_symlink() {
          return Err(FileError("Symbolic links are not followed.".into()));
        }
      }
      Err(error)
        if allow_missing_leaf
          && ancestor == path
          && error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(error.into()),
    }
  }
  if path.exists() {
    Ok(fs::canonicalize(path)?)
  } else {
    let parent = path
      .parent()
      .ok_or_else(|| FileError("Missing parent.".into()))?;
    Ok(
      fs::canonicalize(parent)?.join(
        path
          .file_name()
          .ok_or_else(|| FileError("Missing filename.".into()))?,
      ),
    )
  }
}

pub(crate) fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, FileError> {
  let file = fs::File::open(path)?;
  if !file.metadata()?.is_file() {
    return Err(FileError("Only regular files are supported.".into()));
  }
  let mut bytes = Vec::new();
  file.take(limit + 1).read_to_end(&mut bytes)?;
  if bytes.len() as u64 > limit {
    return Err(FileError(format!("File exceeds the {limit}-byte limit.")));
  }
  Ok(bytes)
}

/// A snapshot used to reject stale saves. Saving never resets its baseline on failure.
pub struct Document {
  path: PathBuf,
  original: Vec<u8>,
  decoded: DecodedText,
  modified: std::time::SystemTime,
}

impl Document {
  pub fn open(path: &Path, encoding: Option<TextEncoding>) -> Result<Self, FileError> {
    let path = checked_path(path, false)?;
    let before = fs::metadata(&path)?.modified()?;
    let original = read_bounded(&path, 1024 * 1024)?;
    if before != fs::metadata(&path)?.modified()? {
      return Err(FileError("File changed while opening. Retry.".into()));
    }
    let decoded = decode(&original, encoding).map_err(|e| FileError(e.to_string()))?;
    Ok(Self {
      path,
      original,
      decoded,
      modified: before,
    })
  }
  pub fn text(&self) -> &str {
    self.decoded.text()
  }
  pub fn path(&self) -> &Path {
    &self.path
  }
  pub fn encoding(&self) -> TextEncoding {
    self.decoded.encoding()
  }
  pub fn has_bom(&self) -> bool {
    self.decoded.has_bom()
  }

  pub fn restore_endings(&self, edited: &str) -> Result<String, FileError> {
    let old: Vec<_> = compare_text::lines(self.text()).collect();
    let new: Vec<_> = compare_text::lines(edited).collect();
    let options = compare_text::CompareOptions {
      ignore_line_endings: true,
      ..Default::default()
    };
    let spans =
      compare_text::compare(self.text(), edited, options).map_err(|e| FileError(e.to_string()))?;
    let default_ending = old
      .iter()
      .find(|line| line.ending != compare_text::LineEnding::None)
      .map_or("\n", |line| line.ending.as_str());
    let mut result = String::new();
    for span in spans {
      for (offset, line) in new[span.right.clone()].iter().enumerate() {
        result.push_str(line.content);
        if line.ending != compare_text::LineEnding::None {
          let previous = if span.kind == compare_text::DiffKind::Equal || offset < span.left.len() {
            old.get(span.left.start + offset)
          } else {
            None
          };
          result.push_str(
            previous
              .filter(|l| l.ending != compare_text::LineEnding::None)
              .map_or(default_ending, |l| l.ending.as_str()),
          );
        }
      }
    }
    Ok(result)
  }

  pub fn save(&mut self, text: &str) -> Result<(), FileError> {
    let bytes = self
      .decoded
      .encode(text)
      .map_err(|e| FileError(e.to_string()))?;
    let parent = self
      .path
      .parent()
      .ok_or_else(|| FileError("Missing destination parent.".into()))?;
    let mut temp = NamedTempFile::new_in(parent)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    let current = checked_path(&self.path, false)?;
    if current != self.path
      || fs::metadata(&current)?.modified()? != self.modified
      || read_bounded(&current, 1024 * 1024)? != self.original
    {
      return Err(FileError(
        "File changed externally. Reopen or save to a new path.".into(),
      ));
    }
    let permissions = fs::metadata(&current)?.permissions();
    if permissions.readonly() {
      return Err(FileError("Destination is read-only.".into()));
    }
    temp.as_file().set_permissions(permissions)?;
    temp
      .persist(&current)
      .map_err(|e| FileError(format!("Safe replacement failed: {}", e.error)))?;
    let refreshed = Self::open(&current, Some(self.encoding()))?;
    *self = refreshed;
    Ok(())
  }

  /// Save As never overwrites an existing destination.
  pub fn save_as(&self, text: &str, destination: &Path, utf8: bool) -> Result<Self, FileError> {
    let path = checked_path(destination, true)?;
    let bytes = if utf8 {
      if text.len() > 1024 * 1024 {
        return Err(FileError("Text exceeds 1 MiB.".into()));
      }
      text.as_bytes().to_vec()
    } else {
      self
        .decoded
        .encode(text)
        .map_err(|e| FileError(e.to_string()))?
    };
    let parent = path
      .parent()
      .ok_or_else(|| FileError("Missing destination parent.".into()))?;
    let mut temp = NamedTempFile::new_in(parent)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    checked_path(&path, true)?;
    temp
      .persist_noclobber(&path)
      .map_err(|e| FileError(format!("New-file save failed: {}", e.error)))?;
    Self::open(
      &path,
      Some(if utf8 {
        TextEncoding::Utf8
      } else {
        self.encoding()
      }),
    )
  }

  pub fn create(text: &str, destination: &Path) -> Result<Self, FileError> {
    if text.len() > 1024 * 1024 {
      return Err(FileError("Text exceeds 1 MiB.".into()));
    }
    let path = checked_path(destination, true)?;
    let mut temp = NamedTempFile::new_in(
      path
        .parent()
        .ok_or_else(|| FileError("Missing parent.".into()))?,
    )?;
    temp.write_all(text.as_bytes())?;
    temp.as_file().sync_all()?;
    temp
      .persist_noclobber(&path)
      .map_err(|e| FileError(format!("New-file save failed: {}", e.error)))?;
    Self::open(&path, Some(TextEncoding::Utf8))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn stale_save_and_clobber_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("input.txt");
    fs::write(&path, b"a\r\n").unwrap();
    let mut document = Document::open(&path, None).unwrap();
    fs::write(&path, b"external\r\n").unwrap();
    assert!(document.save("edit\r\n").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"external\r\n");
    assert!(document.save_as("edit", &path, true).is_err());
    let mut document = Document::open(&path, None).unwrap();
    document.save("new\r\n").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new\r\n");
    assert_eq!(
      document.restore_endings("new\nadded\n").unwrap(),
      "new\r\nadded\r\n"
    );
  }
  #[test]
  fn encoding_is_preserved_and_conversion_is_explicit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("legacy.txt");
    fs::write(&path, b"caf\xe9\r\n").unwrap();
    let mut document = Document::open(
      &path,
      Some(TextEncoding::for_label("windows-1252").unwrap()),
    )
    .unwrap();
    assert!(document.save("\u{1f980}").is_err());
    let out = root.path().join("utf8.txt");
    document.save_as("\u{1f980}", &out, true).unwrap();
    assert_eq!(fs::read_to_string(out).unwrap(), "\u{1f980}");
  }

  #[test]
  fn readonly_destination_is_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("readonly.txt");
    fs::write(&path, "original").unwrap();
    let original_permissions = fs::metadata(&path).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();
    let mut document = Document::open(&path, None).unwrap();
    assert!(document.save("changed").is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    fs::set_permissions(&path, original_permissions).unwrap();
  }

  #[test]
  fn replacement_does_not_mutate_other_hardlink_names() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source");
    let alias = root.path().join("alias");
    fs::write(&path, "old").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let mut document = Document::open(&path, None).unwrap();
    document.save("new").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    assert_eq!(fs::read_to_string(&alias).unwrap(), "old");
  }

  #[cfg(windows)]
  #[test]
  fn junction_ancestors_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let junction = root.path().join("junction");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("file.txt"), "safe").unwrap();
    let result = std::process::Command::new("cmd")
      .args(["/C", "mklink", "/J"])
      .arg(&junction)
      .arg(&target)
      .output()
      .unwrap();
    assert!(
      result.status.success(),
      "{}",
      String::from_utf8_lossy(&result.stderr)
    );
    assert!(Document::open(&junction.join("file.txt"), None).is_err());
    assert!(checked_path(&junction.join("new.txt"), true).is_err());
    assert_eq!(fs::read_to_string(target.join("file.txt")).unwrap(), "safe");
  }

  #[cfg(unix)]
  #[test]
  fn symbolic_link_ancestors_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let link = root.path().join("link");
    fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(checked_path(&link.join("new"), true).is_err());
  }
}
