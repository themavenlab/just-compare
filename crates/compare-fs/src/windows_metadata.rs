use crate::{checked_path, FileError};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
  // Decimal strings preserve byte counts beyond JavaScript's integer range.
  pub available_bytes: String,
  pub total_bytes: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ExecutableVersion {
  pub file: [u16; 4],
  pub product: [u16; 4],
}

pub fn disk_space(path: &Path) -> Result<DiskSpace, FileError> {
  let path = checked_path(path, false)?;
  if !std::fs::metadata(&path)?.is_dir() {
    return Err(FileError("Disk-space queries require a directory.".into()));
  }
  platform::disk_space(&path)
}

pub(crate) fn file_version(path: &Path) -> Result<ExecutableVersion, FileError> {
  platform::file_version(path)
}

#[cfg(not(windows))]
mod platform {
  use super::*;

  pub(super) fn disk_space(_: &Path) -> Result<DiskSpace, FileError> {
    Err(FileError(
      "Capability unavailable: available disk space currently requires Windows.".into(),
    ))
  }

  pub(super) fn file_version(_: &Path) -> Result<ExecutableVersion, FileError> {
    Err(FileError(
      "Capability unavailable: executable-version comparison requires Windows.".into(),
    ))
  }
}

#[cfg(windows)]
mod platform {
  use super::*;
  use std::os::windows::ffi::OsStrExt;
  use windows_sys::Win32::Foundation::{
    ERROR_RESOURCE_DATA_NOT_FOUND, ERROR_RESOURCE_LANG_NOT_FOUND, ERROR_RESOURCE_NAME_NOT_FOUND,
    ERROR_RESOURCE_TYPE_NOT_FOUND,
  };
  use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    VS_FIXEDFILEINFO,
  };

  fn wide(path: &Path) -> Result<Vec<u16>, FileError> {
    let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
      return Err(FileError("Paths must not contain NUL characters.".into()));
    }
    value.push(0);
    Ok(value)
  }

  pub(super) fn disk_space(path: &Path) -> Result<DiskSpace, FileError> {
    let path = wide(path)?;
    let (mut available, mut total) = (0, 0);
    // The path is NUL-terminated and the two output pointers remain valid.
    if unsafe {
      GetDiskFreeSpaceExW(
        path.as_ptr(),
        &mut available,
        &mut total,
        std::ptr::null_mut(),
      )
    } == 0
    {
      return Err(FileError(format!(
        "Cannot query available disk space: {}",
        std::io::Error::last_os_error()
      )));
    }
    Ok(DiskSpace {
      available_bytes: available.to_string(),
      total_bytes: total.to_string(),
    })
  }

  pub(super) fn file_version(path: &Path) -> Result<ExecutableVersion, FileError> {
    let path = wide(path)?;
    let mut ignored = 0;
    // Both the terminated path and the output handle pointer are valid.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 {
      let error = std::io::Error::last_os_error();
      if error.raw_os_error().is_some_and(|code| {
        matches!(
          code as u32,
          ERROR_RESOURCE_DATA_NOT_FOUND
            | ERROR_RESOURCE_LANG_NOT_FOUND
            | ERROR_RESOURCE_NAME_NOT_FOUND
            | ERROR_RESOURCE_TYPE_NOT_FOUND
        )
      }) {
        return Err(FileError(format!(
          "No version metadata in executable: {error}"
        )));
      }
      return Err(FileError(format!(
        "Cannot read executable version (a valid version resource is required): {}",
        error
      )));
    }
    if size > 1024 * 1024 {
      return Err(FileError(
        "Executable version resource exceeds 1 MiB.".into(),
      ));
    }
    let mut data = vec![0u8; size as usize];
    // Windows writes no more than size bytes into this owned buffer.
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
      return Err(FileError(format!(
        "Cannot read executable version: {}",
        std::io::Error::last_os_error()
      )));
    }
    let mut info = std::ptr::null_mut();
    let mut length = 0;
    let root = [b'\\' as u16, 0];
    // The query returns a pointer into data, which remains alive below.
    if unsafe { VerQueryValueW(data.as_ptr().cast(), root.as_ptr(), &mut info, &mut length) } == 0
      || length < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
      || (info as usize) < data.as_ptr() as usize
      || (info as usize)
        .checked_add(std::mem::size_of::<VS_FIXEDFILEINFO>())
        .is_none_or(|end| end > data.as_ptr() as usize + data.len())
    {
      return Err(FileError(
        "Executable has no valid fixed file version.".into(),
      ));
    }
    // Bounds are checked above; the resource's alignment is not assumed.
    let info = unsafe { std::ptr::read_unaligned(info.cast::<VS_FIXEDFILEINFO>()) };
    if info.dwSignature != 0xfeef04bd {
      return Err(FileError(
        "Executable has an invalid version signature.".into(),
      ));
    }
    let parts = |ms: u32, ls: u32| [(ms >> 16) as u16, ms as u16, (ls >> 16) as u16, ls as u16];
    Ok(ExecutableVersion {
      file: parts(info.dwFileVersionMS, info.dwFileVersionLS),
      product: parts(info.dwProductVersionMS, info.dwProductVersionLS),
    })
  }
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  #[cfg(windows)]
  pub(crate) fn write_versioned_fixture(path: &Path, version: [u16; 4]) {
    write_versioned_fixture_versions(path, version, version);
  }

  #[cfg(windows)]
  pub(crate) fn write_versioned_fixture_versions(
    path: &Path,
    version: [u16; 4],
    product: [u16; 4],
  ) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{
      BeginUpdateResourceW, EndUpdateResourceW, UpdateResourceW,
    };
    std::fs::copy(std::env::current_exe().unwrap(), path).unwrap();
    let mut resource = Vec::new();
    for value in [92u16, 52, 0]
      .into_iter()
      .chain("VS_VERSION_INFO\0".encode_utf16())
      .chain([0])
    {
      resource.extend_from_slice(&value.to_le_bytes());
    }
    let ms = (u32::from(version[0]) << 16) | u32::from(version[1]);
    let ls = (u32::from(version[2]) << 16) | u32::from(version[3]);
    let product_ms = (u32::from(product[0]) << 16) | u32::from(product[1]);
    let product_ls = (u32::from(product[2]) << 16) | u32::from(product[3]);
    for value in [
      0xfeef04bd_u32,
      0x10000,
      ms,
      ls,
      product_ms,
      product_ls,
      0x3f,
      0,
      0x40004,
      1,
      0,
      0,
      0,
    ] {
      resource.extend_from_slice(&value.to_le_bytes());
    }
    assert_eq!(resource.len(), 92);
    let wide: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    // Only this test-owned copy is updated; integer resource identifiers are
    // the Windows MAKEINTRESOURCE convention, not dereferenceable pointers.
    unsafe {
      let handle = BeginUpdateResourceW(wide.as_ptr(), 1);
      assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
      let updated = UpdateResourceW(
        handle,
        std::ptr::without_provenance::<u16>(16),
        std::ptr::without_provenance::<u16>(1),
        0,
        resource.as_ptr().cast(),
        resource.len() as u32,
      );
      let update_error = std::io::Error::last_os_error();
      let ended = EndUpdateResourceW(handle, i32::from(updated == 0));
      assert_ne!(updated, 0, "{update_error}");
      assert_ne!(ended, 0, "{}", std::io::Error::last_os_error());
    }
  }

  #[cfg(windows)]
  #[test]
  fn fixed_versions_are_read_from_original_synthetic_resources() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("fixture.exe");
    write_versioned_fixture_versions(&file, [1, 2, 300, 65535], [7, 8, 9, 10]);
    assert_eq!(
      file_version(&file).unwrap(),
      ExecutableVersion {
        file: [1, 2, 300, 65535],
        product: [7, 8, 9, 10],
      }
    );
  }

  #[test]
  fn disk_space_validates_paths_and_reports_platform_capability() {
    let directory = tempfile::tempdir().unwrap();
    let result = disk_space(directory.path());
    #[cfg(windows)]
    {
      let space = result.unwrap();
      let available: u64 = space.available_bytes.parse().unwrap();
      let total: u64 = space.total_bytes.parse().unwrap();
      assert!(total > 0 && available <= total);
    }
    #[cfg(not(windows))]
    assert!(result.unwrap_err().to_string().contains("requires Windows"));
    let file = directory.path().join("file");
    std::fs::write(&file, b"fixture").unwrap();
    assert!(disk_space(&file)
      .unwrap_err()
      .to_string()
      .contains("directory"));
    assert!(disk_space(&directory.path().join("missing")).is_err());
  }

  #[test]
  fn missing_or_invalid_executable_versions_are_errors() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("invalid.exe");
    std::fs::write(&file, b"not an executable").unwrap();
    assert!(file_version(&file).is_err());
    assert!(file_version(&directory.path().join("missing.exe")).is_err());
  }
}
