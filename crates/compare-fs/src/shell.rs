use crate::{checked_path, FileError};
use serde::Serialize;
use std::io::Write;
use std::path::Path;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShellAction {
  Selected {
    path: String,
  },
  Compare {
    mode: String,
    left: String,
    right: String,
  },
}

fn source(path: &str) -> Result<(String, bool), FileError> {
  let path = checked_path(Path::new(path), false)?;
  let metadata = std::fs::metadata(&path)?;
  if !metadata.is_dir() && !metadata.is_file() {
    return Err(FileError(
      "Shell comparison requires a regular file or folder.".into(),
    ));
  }
  Ok((
    path
      .to_str()
      .ok_or_else(|| FileError("Non-Unicode shell paths are unsupported.".into()))?
      .into(),
    metadata.is_dir(),
  ))
}

pub fn request(config: &Path, args: &[String]) -> Result<ShellAction, FileError> {
  let [command, path] = args else {
    return Err(FileError(
      "Shell actions require exactly one absolute path.".into(),
    ));
  };
  if !["shell-select", "shell-compare", "shell-open"].contains(&command.as_str()) {
    return Err(FileError("Unknown shell action.".into()));
  }
  let (path, directory) = source(path)?;
  let config = checked_path(config, false)?;
  if !config.is_dir() {
    return Err(FileError("Shell configuration must be a directory.".into()));
  }
  let selection = config.join("shell-selection.json");
  if command == "shell-select" {
    checked_path(&selection, true)?;
    let mut temp = tempfile::NamedTempFile::new_in(&config)?;
    let bytes = serde_json::to_vec(&path).map_err(|e| FileError(e.to_string()))?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp
      .persist(selection)
      .map_err(|e| FileError(format!("Cannot save shell selection: {}", e.error)))?;
    return Ok(ShellAction::Selected { path });
  }
  let left = if command == "shell-compare" {
    if !selection.try_exists()? {
      return Err(FileError(
        "No selected path. Right-click a file or folder and choose Select for Compare first."
          .into(),
      ));
    }
    checked_path(&selection, false)?;
    let bytes = crate::document::read_bounded(&selection, 128 * 1024)?;
    let selected: String = serde_json::from_slice(&bytes).map_err(|e| {
      FileError(format!(
        "Cannot read selected path: {e}. Clear the shell selection and select again."
      ))
    })?;
    let (selected, selected_directory) = source(&selected)?;
    if selected_directory != directory {
      return Err(FileError(
        "Select two files or two folders, not a file and a folder.".into(),
      ));
    }
    selected
  } else {
    path.clone()
  };
  Ok(ShellAction::Compare {
    mode: if directory { "folder" } else { "text" }.into(),
    left: if command == "shell-open" {
      path.clone()
    } else {
      left
    },
    right: if command == "shell-open" {
      String::new()
    } else {
      path
    },
  })
}

pub fn clear_selection(config: &Path) -> Result<(), FileError> {
  let config = checked_path(config, false)?;
  let path = config.join("shell-selection.json");
  if path.try_exists()? {
    checked_path(&path, false)?;
    std::fs::remove_file(path)?;
  }
  Ok(())
}

pub fn registration(executable: &Path, enabled: Option<bool>) -> Result<bool, FileError> {
  #[cfg(windows)]
  {
    windows::registration(executable, enabled)
  }
  #[cfg(not(windows))]
  {
    let _ = (executable, enabled);
    Err(FileError(
      "Explorer integration is available only on Windows.".into(),
    ))
  }
}

#[cfg(windows)]
mod windows {
  use super::*;
  use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ},
    RegKey,
  };

  const VERBS: [(&str, &str); 3] = [
    ("select", "Select for Compare"),
    ("compare", "Compare with Selected"),
    ("open", "Compare"),
  ];
  fn base() -> Result<String, FileError> {
    #[cfg(debug_assertions)]
    if let Some(config) = std::env::var_os("COMPARE_TEST_CONFIG") {
      let path = checked_path(Path::new(&config), false)?;
      use std::hash::{Hash, Hasher};
      let mut hash = std::hash::DefaultHasher::new();
      path.hash(&mut hash);
      return Ok(format!(
        r"Software\CompareWorkbench\Tests\{:x}\Classes",
        hash.finish()
      ));
    }
    Ok(r"Software\Classes".into())
  }
  pub(super) fn registration(executable: &Path, enabled: Option<bool>) -> Result<bool, FileError> {
    let executable = checked_path(executable, false)?;
    if !executable.is_file() {
      return Err(FileError(
        "Shell registration requires the desktop executable.".into(),
      ));
    }
    let executable = executable
      .to_str()
      .ok_or_else(|| FileError("Non-Unicode executable path.".into()))?;
    if executable.contains(['"', '\0', '%']) {
      return Err(FileError(
        "Executable path cannot contain quotes, NUL or percent signs.".into(),
      ));
    }
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let base = base()?;
    let result = registration_at(&root, &base, executable, enabled)?;
    let testing = cfg!(debug_assertions) && std::env::var_os("COMPARE_TEST_CONFIG").is_some();
    if enabled.is_some() && !testing {
      use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
      // Association notification has no item pointers and does not restart Explorer.
      unsafe {
        SHChangeNotify(
          SHCNE_ASSOCCHANGED as i32,
          SHCNF_IDLIST,
          std::ptr::null(),
          std::ptr::null(),
        );
      }
    }
    #[cfg(debug_assertions)]
    if enabled == Some(false) && testing {
      match root.delete_subkey_all(&base) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
      }
      let parent = base
        .strip_suffix(r"\Classes")
        .ok_or_else(|| FileError("Invalid test registry scope.".into()))?;
      match root.delete_subkey(parent) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
      }
    }
    Ok(result)
  }

  fn registration_at(
    root: &RegKey,
    base: &str,
    executable: &str,
    enabled: Option<bool>,
  ) -> Result<bool, FileError> {
    let mut complete = true;
    for class in ["*", "Directory"] {
      for (action, title) in VERBS {
        let path = format!(r"{base}\{class}\shell\CompareWorkbench.{action}");
        let command = format!("\"{executable}\" shell-{action} \"%1\"");
        let key = match root.open_subkey_with_flags(&path, KEY_READ) {
          Ok(key) => Some(key),
          Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
          Err(e) => return Err(e.into()),
        };
        if let Some(key) = &key {
          let owner: String = key
            .get_value("CompareWorkbenchOwner")
            .map_err(|e| FileError(format!("Shell entry is not owned by this application: {e}")))?;
          if owner != executable {
            return Err(FileError("Shell entries belong to another executable. Remove them from that installation first.".into()));
          }
        }
        match enabled {
          Some(true) => {
            let (key, _) = root.create_subkey(&path)?;
            key.set_value("CompareWorkbenchOwner", &executable)?;
            key.set_value("", &format!("{title} - Compare Workbench"))?;
            key.set_value("Icon", &format!("\"{executable}\",0"))?;
            key.set_value("MultiSelectModel", &"Single")?;
            let (command_key, _) = key.create_subkey("command")?;
            command_key.set_value("", &command)?;
          }
          Some(false) => {
            if key.is_some() {
              root.delete_subkey_all(&path)?;
            }
          }
          None => {
            complete &= match key {
              Some(key) => {
                let command_key = key.open_subkey("command")?;
                let actual: String = command_key.get_value("")?;
                actual == command
              }
              None => false,
            };
          }
        }
      }
    }
    Ok(enabled.unwrap_or(complete))
  }

  #[cfg(test)]
  mod tests {
    use super::*;
    #[test]
    fn scoped_registration_is_quoted_owned_and_removable() {
      let root = RegKey::predef(HKEY_CURRENT_USER);
      let base = format!(
        r"Software\CompareWorkbench\Tests\unit-{}",
        std::process::id()
      );
      let exe = r"C:\Synthetic Folder\Unicode-é\compare-desktop.exe";
      assert!(!registration_at(&root, &base, exe, None).unwrap());
      assert!(registration_at(&root, &base, exe, Some(true)).unwrap());
      assert!(registration_at(&root, &base, exe, None).unwrap());
      let key = root
        .open_subkey(format!(r"{base}\*\shell\CompareWorkbench.compare\command"))
        .unwrap();
      assert_eq!(
        key.get_value::<String, _>("").unwrap(),
        format!("\"{exe}\" shell-compare \"%1\"")
      );
      assert!(registration_at(&root, &base, r"C:\another.exe", Some(false)).is_err());
      assert!(!registration_at(&root, &base, exe, Some(false)).unwrap());
      assert!(!registration_at(&root, &base, exe, None).unwrap());
      root.delete_subkey_all(base).unwrap();
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn selection_restart_validation_and_read_only_pairs() {
    let root = tempfile::tempdir().unwrap();
    let left = root.path().join("left & café.txt");
    let right = root.path().join("right % name.txt");
    std::fs::write(&left, "left").unwrap();
    std::fs::write(&right, "right").unwrap();
    let args = |command: &str, path: &Path| vec![command.into(), path.display().to_string()];
    assert!(request(root.path(), &args("shell-compare", &right)).is_err());
    request(root.path(), &args("shell-select", &left)).unwrap();
    assert!(
      matches!(request(root.path(), &args("shell-compare", &right)).unwrap(), ShellAction::Compare { mode, .. } if mode == "text")
    );
    assert!(request(root.path(), &args("shell-compare", root.path())).is_err());
    assert!(request(root.path(), &args("shell-open", Path::new("relative"))).is_err());
    assert!(request(root.path(), &[]).is_err());
    assert_eq!(std::fs::read_to_string(&right).unwrap(), "right");
    std::fs::remove_file(&left).unwrap();
    assert!(request(root.path(), &args("shell-compare", &right)).is_err());
    clear_selection(root.path()).unwrap();
    clear_selection(root.path()).unwrap();
  }
}
