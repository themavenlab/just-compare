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
  // Explorer passes drive-root backgrounds as "C:\", which argv parsing turns into C:".
  let restored;
  let path = match path.trim_end().strip_suffix('"') {
    Some(prefix) if cfg!(windows) => {
      restored = format!("{prefix}\\");
      &restored
    }
    _ => path,
  };
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
    let (selected, selected_directory) = selected_source(&config)?.ok_or_else(|| {
            FileError("No selected path. Right-click a file or folder and choose Select as left file/folder for compare first.".into())
        })?;
    if selected_directory != directory {
      return Err(FileError(
        "Select two files or two folders, not a file and a folder.".into(),
      ));
    }
    selected
  } else {
    path.clone()
  };
  let result = ShellAction::Compare {
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
  };
  if command == "shell-compare" {
    clear_selection(&config)?;
  }
  Ok(result)
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

pub fn registration(
  executable: &Path,
  config: &Path,
  enabled: Option<bool>,
) -> Result<bool, FileError> {
  #[cfg(windows)]
  {
    windows::registration(executable, config, enabled, false)
  }
  #[cfg(not(windows))]
  {
    let _ = (executable, config, enabled);
    Err(FileError(
      "Explorer integration is available only on Windows.".into(),
    ))
  }
}

pub fn refresh_registration(executable: &Path, config: &Path) -> Result<(), FileError> {
  #[cfg(windows)]
  windows::registration(executable, config, None, true)?;
  #[cfg(not(windows))]
  let _ = (executable, config);
  Ok(())
}

fn selected_source(config: &Path) -> Result<Option<(String, bool)>, FileError> {
  let selection = config.join("shell-selection.json");
  if !selection.try_exists()? {
    return Ok(None);
  }
  checked_path(&selection, false)?;
  let bytes = crate::document::read_bounded(&selection, 128 * 1024)?;
  let selected: String = serde_json::from_slice(&bytes).map_err(|e| {
    FileError(format!(
      "Cannot read selected path: {e}. Clear the shell selection and select again."
    ))
  })?;
  source(&selected).map(Some)
}

#[cfg(windows)]
mod windows {
  use super::*;
  use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ},
    RegKey,
  };

  const VERBS: [&str; 3] = ["select", "compare", "open"];
  // Folder-background verbs receive the open folder through %V rather than %1.
  // Explorer omits background verbs that declare MultiSelectModel.
  const CLASSES: [(&str, bool, &str); 3] = [
    ("*", false, "%1"),
    ("Directory", true, "%1"),
    (r"Directory\Background", true, "%V"),
  ];

  fn shell_path(executable: &str) -> String {
    if let Some(unc) = executable.strip_prefix(r"\\?\UNC\") {
      format!(r"\\{unc}")
    } else {
      executable
        .strip_prefix(r"\\?\")
        .unwrap_or(executable)
        .into()
    }
  }
  fn base() -> Result<String, FileError> {
    #[cfg(debug_assertions)]
    if let Some(config) = std::env::var_os("COMPARE_TEST_CONFIG") {
      let path = checked_path(Path::new(&config), false)?;
      use std::hash::{Hash, Hasher};
      let mut hash = std::hash::DefaultHasher::new();
      path.hash(&mut hash);
      return Ok(format!(
        r"Software\JustCompare\Tests\{:x}\Classes",
        hash.finish()
      ));
    }
    Ok(r"Software\Classes".into())
  }
  pub(super) fn registration(
    executable: &Path,
    config: &Path,
    enabled: Option<bool>,
    refresh: bool,
  ) -> Result<bool, FileError> {
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
    if refresh {
      let path = format!(r"{base}\*\shell\JustCompare.select");
      match root.open_subkey_with_flags(path, KEY_READ) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
      }
    }
    let selection = if enabled == Some(false) {
      None
    } else {
      selected_source(config)?
    };
    let result = registration_at(
      &root,
      &base,
      executable,
      if refresh { Some(true) } else { enabled },
      selection.as_ref(),
    )?;
    let testing = cfg!(debug_assertions) && std::env::var_os("COMPARE_TEST_CONFIG").is_some();
    if (enabled.is_some() || refresh) && !testing {
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
    selection: Option<&(String, bool)>,
  ) -> Result<bool, FileError> {
    // Check every legacy/current key before changing any of them.
    for (class, _, _) in CLASSES {
      for action in VERBS {
        let path = format!(r"{base}\{class}\shell\JustCompare.{action}");
        match root.open_subkey_with_flags(path, KEY_READ) {
          Ok(key) => {
            let owner: String = key.get_value("JustCompareOwner")?;
            if owner != executable {
              return Err(FileError("Shell entries belong to another executable. Remove them from that installation first.".into()));
            }
          }
          Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
          Err(e) => return Err(e.into()),
        }
      }
    }
    let launch_path = shell_path(executable);
    let mut complete = true;
    for (class, directory, argument) in CLASSES {
      let kind = if directory { "folder" } else { "file" };
      for action in VERBS {
        let path = format!(r"{base}\{class}\shell\JustCompare.{action}");
        let command = format!("\"{launch_path}\" shell-{action} \"{argument}\"");
        let key = match root.open_subkey_with_flags(&path, KEY_READ) {
          Ok(key) => Some(key),
          Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
          Err(e) => return Err(e.into()),
        };
        if action == "open" {
          if enabled.is_some() && key.is_some() {
            root.delete_subkey_all(&path)?;
          } else if key.is_some() {
            complete = false;
          }
          continue;
        }
        let title = if action == "select" {
          format!("Select as left {kind} for compare")
        } else {
          selection.map_or_else(
            || "Compare to selected item".into(),
            |(path, _)| {
              let name = Path::new(path).file_name().map_or_else(
                || shell_path(path),
                |name| name.to_string_lossy().into_owned(),
              );
              format!("Compare to {}", name.replace('&', "&&"))
            },
          )
        };
        let background = argument == "%V";
        let hidden = action == "compare"
          && selection.is_none_or(|(_, selected_directory)| *selected_directory != directory);
        let remove = |key: &RegKey, name: &str| match key.delete_value(name) {
          Ok(()) => Ok(()),
          Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
          Err(e) => Err(FileError::from(e)),
        };
        let present = |key: &RegKey, name: &str| match key.get_value::<String, _>(name) {
          Ok(_) => Ok(true),
          Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
          Err(e) => Err(FileError::from(e)),
        };
        match enabled {
          Some(true) => {
            let old_path = format!(r"{base}\{class}\shell\CompareWorkbench.{action}");
            let _ = root.delete_subkey_all(&old_path);
            let (key, _) = root.create_subkey(&path)?;
            key.set_value("JustCompareOwner", &executable)?;
            key.set_value("", &title)?;
            key.set_value("Icon", &format!("\"{launch_path}\",0"))?;
            if background {
              remove(&key, "MultiSelectModel")?;
            } else {
              key.set_value("MultiSelectModel", &"Single")?;
            }
            if hidden {
              key.set_value("LegacyDisable", &"")?;
            } else {
              remove(&key, "LegacyDisable")?;
            }
            let (command_key, _) = key.create_subkey("command")?;
            command_key.set_value("", &command)?;
          }
          Some(false) => {
            if key.is_some() {
              root.delete_subkey_all(&path)?;
            }
            let old_path = format!(r"{base}\{class}\shell\CompareWorkbench.{action}");
            let _ = root.delete_subkey_all(&old_path);
          }
          None => {
            complete &= match key {
              Some(key) => {
                let command_key = key.open_subkey("command")?;
                let actual: String = command_key.get_value("")?;
                let actual_title: String = key.get_value("")?;
                let actual_hidden = present(&key, "LegacyDisable")?;
                actual == command
                  && actual_title == title
                  && actual_hidden == hidden
                  && present(&key, "MultiSelectModel")? != background
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
      let base = format!(r"Software\JustCompare\Tests\unit-{}", std::process::id());
      let exe = r"\\?\C:\Synthetic Folder\Unicode-é\just-compare.exe";
      assert!(!registration_at(&root, &base, exe, None, None).unwrap());
      assert!(registration_at(&root, &base, exe, Some(true), None).unwrap());
      assert!(registration_at(&root, &base, exe, None, None).unwrap());
      let key = root
        .open_subkey(format!(r"{base}\*\shell\JustCompare.compare\command"))
        .unwrap();
      assert_eq!(
        key.get_value::<String, _>("").unwrap(),
        "\"C:\\Synthetic Folder\\Unicode-é\\just-compare.exe\" shell-compare \"%1\""
      );
      let menu = |class: &str, action: &str| {
        root
          .open_subkey(format!(r"{base}\{class}\shell\JustCompare.{action}"))
          .unwrap()
      };
      assert_eq!(
        menu("*", "select").get_value::<String, _>("").unwrap(),
        "Select as left file for compare"
      );
      assert_eq!(
        menu("Directory", "select")
          .get_value::<String, _>("")
          .unwrap(),
        "Select as left folder for compare"
      );
      assert!(menu("*", "compare")
        .get_value::<String, _>("LegacyDisable")
        .is_ok());
      assert!(menu("Directory", "compare")
        .get_value::<String, _>("LegacyDisable")
        .is_ok());
      let selected = (r"C:\Fixtures\left & café.txt".into(), false);
      registration_at(&root, &base, exe, Some(true), Some(&selected)).unwrap();
      assert_eq!(
        menu("*", "compare").get_value::<String, _>("").unwrap(),
        "Compare to left && café.txt"
      );
      assert!(menu("*", "compare")
        .get_value::<String, _>("LegacyDisable")
        .is_err());
      assert!(menu("Directory", "compare")
        .get_value::<String, _>("LegacyDisable")
        .is_ok());
      let folder = (r"C:\Fixtures\left folder".into(), true);
      registration_at(&root, &base, exe, Some(true), Some(&folder)).unwrap();
      assert!(menu("*", "compare")
        .get_value::<String, _>("LegacyDisable")
        .is_ok());
      assert!(menu("Directory", "compare")
        .get_value::<String, _>("LegacyDisable")
        .is_err());
      assert_eq!(
        menu("Directory", "compare")
          .get_value::<String, _>("")
          .unwrap(),
        "Compare to left folder"
      );
      let background = |action: &str| menu(r"Directory\Background", action);
      assert_eq!(
        background("select").get_value::<String, _>("").unwrap(),
        "Select as left folder for compare"
      );
      assert_eq!(
        background("compare")
          .open_subkey("command")
          .unwrap()
          .get_value::<String, _>("")
          .unwrap(),
        "\"C:\\Synthetic Folder\\Unicode-é\\just-compare.exe\" shell-compare \"%V\""
      );
      assert!(background("compare")
        .get_value::<String, _>("LegacyDisable")
        .is_err());
      assert!(background("select")
        .get_value::<String, _>("MultiSelectModel")
        .is_err());
      assert!(menu("Directory", "select")
        .get_value::<String, _>("MultiSelectModel")
        .is_ok());
      root
        .open_subkey_with_flags(
          format!(r"{base}\Directory\Background\shell\JustCompare.select"),
          winreg::enums::KEY_SET_VALUE,
        )
        .unwrap()
        .set_value("MultiSelectModel", &"Single")
        .unwrap();
      assert!(!registration_at(&root, &base, exe, None, Some(&folder)).unwrap());
      registration_at(&root, &base, exe, Some(true), Some(&folder)).unwrap();
      assert!(registration_at(&root, &base, exe, None, Some(&folder)).unwrap());
      let drive = (r"\\?\C:\".into(), true);
      registration_at(&root, &base, exe, Some(true), Some(&drive)).unwrap();
      assert_eq!(
        background("compare").get_value::<String, _>("").unwrap(),
        r"Compare to C:\"
      );
      registration_at(&root, &base, exe, Some(true), Some(&selected)).unwrap();
      assert!(background("compare")
        .get_value::<String, _>("LegacyDisable")
        .is_ok());
      registration_at(&root, &base, exe, Some(true), Some(&folder)).unwrap();
      let (legacy, _) = root
        .create_subkey(format!(r"{base}\*\shell\JustCompare.open"))
        .unwrap();
      legacy.set_value("JustCompareOwner", &exe).unwrap();
      assert!(!registration_at(&root, &base, exe, None, Some(&folder)).unwrap());
      registration_at(&root, &base, exe, Some(true), None).unwrap();
      assert!(root
        .open_subkey(format!(r"{base}\*\shell\JustCompare.open"))
        .is_err());
      assert!(menu("*", "compare")
        .get_value::<String, _>("LegacyDisable")
        .is_ok());
      assert!(registration_at(&root, &base, r"C:\another.exe", Some(false), None).is_err());
      assert!(!registration_at(&root, &base, exe, Some(false), None).unwrap());
      assert!(!registration_at(&root, &base, exe, None, None).unwrap());
      root.delete_subkey_all(base).unwrap();
    }

    #[test]
    fn shell_launch_paths_support_drive_and_unc_without_device_prefix() {
      assert_eq!(
        shell_path(r"\\?\C:\Program Files\Compare.exe"),
        r"C:\Program Files\Compare.exe"
      );
      assert_eq!(
        shell_path(r"\\?\UNC\server\share\Compare.exe"),
        r"\\server\share\Compare.exe"
      );
      assert_eq!(shell_path(r"C:\Compare.exe"), r"C:\Compare.exe");
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
    assert!(selected_source(root.path()).unwrap().is_none());
    assert!(request(root.path(), &args("shell-compare", root.path())).is_err());
    assert!(request(root.path(), &args("shell-open", Path::new("relative"))).is_err());
    assert!(request(root.path(), &[]).is_err());
    #[cfg(windows)]
    {
      let drive = std::env::current_dir()
        .unwrap()
        .ancestors()
        .last()
        .unwrap()
        .to_owned();
      let escaped = drive.display().to_string().replace('\\', "\" ");
      assert!(matches!(
          request(root.path(), &["shell-open".into(), escaped]).unwrap(),
          ShellAction::Compare { mode, .. } if mode == "folder"
      ));
    }
    assert_eq!(std::fs::read_to_string(&right).unwrap(), "right");
    std::fs::remove_file(&left).unwrap();
    assert!(request(root.path(), &args("shell-compare", &right)).is_err());
    clear_selection(root.path()).unwrap();
    clear_selection(root.path()).unwrap();
  }
}
