#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
#[cfg(windows)]
use tauri::Emitter;
use tauri::Manager;

fn main() {
  let is_merge = std::env::args().nth(1).as_deref() == Some("git-merge");
  #[cfg(not(windows))]
  let builder = tauri::Builder::default();
  #[cfg(windows)]
  let mut builder = tauri::Builder::default();
  #[cfg(all(windows, debug_assertions))]
  let mut context = tauri::generate_context!();
  #[cfg(not(all(windows, debug_assertions)))]
  let context = tauri::generate_context!();
  #[cfg(windows)]
  let handoff_gate;
  #[cfg(windows)]
  {
    #[cfg(debug_assertions)]
    if let Some(config) = std::env::var_os("COMPARE_TEST_CONFIG") {
      use std::hash::{Hash, Hasher};
      let mut hash = std::hash::DefaultHasher::new();
      match compare_fs::checked_path(std::path::Path::new(&config), false) {
        Ok(path) => path.hash(&mut hash),
        Err(error) => {
          eprintln!("Invalid test configuration: {error}");
          std::process::exit(2);
        }
      }
      context.config_mut().identifier = format!("dev.compare-workbench.test-{:x}", hash.finish());
    }
    // Explorer selection only records state; failures fall through so the window can report them.
    match select_without_window(&context.config().identifier) {
      Ok(true) => std::process::exit(0),
      Ok(false) => {}
      Err(error) => eprintln!("Explorer selection failed: {error}"),
    }
    let is_git = std::env::args()
      .nth(1)
      .is_some_and(|arg| arg == "git-diff" || arg == "git-merge");
    let waiting = std::env::var("COMPARE_WAIT_FOR_CLOSE").as_deref() == Ok("1");
    let identifier = context.config().identifier.clone();
    handoff_gate = HandoffGate::acquire(&identifier);
    // Git/CLI waiting launches must never forward their arguments and exit, but they
    // may receive later shell launches when no primary exists. The gate makes that
    // check-then-register atomic with respect to other launches.
    let receive_only = is_git || waiting;
    let register = if receive_only {
      handoff_gate.is_some() && !primary_running(&identifier)
    } else {
      true
    };
    if !receive_only {
      // Explorer grants foreground rights to this launch, not to an already-running
      // instance; share them so the primary can raise itself after handoff.
      unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(
          windows_sys::Win32::UI::WindowsAndMessaging::ASFW_ANY,
        );
      }
    }
    if register {
      builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        let result = app
          .state::<std::sync::Arc<commands::Resources>>()
          .queue_shell(args.into_iter().skip(1).collect())
          .and_then(|()| app.emit("shell-requests", ()).map_err(|e| e.to_string()));
        if let Err(error) = result {
          eprintln!("Shell handoff failed: {error}");
          if let Err(error) = app.emit("shell-error", error) {
            eprintln!("Cannot report shell handoff failure: {error}");
          }
        }
        if let Some(window) = app.get_webview_window("main") {
          if let Err(error) = window
            .unminimize()
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus())
          {
            eprintln!("Cannot focus comparison window: {error}");
          }
        }
      }));
    }
  }
  let result = builder
    .plugin(tauri_plugin_dialog::init())
    .manage(std::sync::Arc::new(commands::Resources::default()))
    .invoke_handler(tauri::generate_handler![
      commands::compare_text,
      commands::search_text,
      commands::refine_text,
      commands::cancel_job,
      commands::open_document,
      commands::open_git_output,
      commands::close_document,
      commands::document_changed,
      commands::save_document,
      commands::merge_text,
      commands::scan_folders,
      commands::validate_folder_rules,
      commands::normalize_folder_roots,
      commands::disk_space,
      commands::path_metadata,
      commands::parent_folder,
      commands::reveal_path,
      commands::open_with,
      commands::preview_sync,
      commands::preview_file_action,
      commands::execute_sync,
      commands::preview_local_action,
      commands::execute_local_action,
      commands::compare_folder_selection,
      commands::read_settings,
      commands::write_settings,
      commands::load_recoveries,
      commands::save_recoveries,
      commands::discard_recovery,
      commands::set_draft_recovery,
      commands::remember_history,
      commands::write_history,
      commands::write_line_detail,
      commands::launch_arguments,
      commands::take_shell_requests,
      commands::shell_action,
      commands::clear_shell_selection,
      commands::explorer_integration,
      commands::finish_git_merge,
    ])
    .build(context);
  // Plugin setup has created the singleton mutex and receiver window by now.
  #[cfg(windows)]
  drop(handoff_gate);
  match result {
    Ok(app) => app.run(move |handle, event| {
      if is_merge && matches!(event, tauri::RunEvent::Exit) {
        // Git cancellation must not be confused with a successful resolution.
        let accepted = handle
          .state::<std::sync::Arc<commands::Resources>>()
          .git_accepted
          .load(std::sync::atomic::Ordering::Relaxed);
        std::process::exit(if accepted { 0 } else { 1 });
      }
    }),
    Err(error) => {
      eprintln!("Desktop application failed: {error}");
      std::process::exit(2);
    }
  }
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
  value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Named mutex held from singleton registration until the receiver window exists.
#[cfg(windows)]
struct HandoffGate(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl HandoffGate {
  fn acquire(identifier: &str) -> Option<Self> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
    let name = wide(&format!("{identifier}-handoff-gate"));
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
      eprintln!("Cannot create shell handoff gate.");
      return None;
    }
    // An abandoned gate means its previous owner exited during startup; ownership transfers.
    match unsafe { WaitForSingleObject(handle, 30_000) } {
      WAIT_OBJECT_0 | WAIT_ABANDONED => Some(Self(handle)),
      _ => {
        eprintln!("Timed out waiting for the shell handoff gate.");
        unsafe { CloseHandle(handle) };
        None
      }
    }
  }
}

#[cfg(windows)]
impl Drop for HandoffGate {
  fn drop(&mut self) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::ReleaseMutex;
    unsafe {
      ReleaseMutex(self.0);
      CloseHandle(self.0);
    }
  }
}

/// Must match the mutex name used by tauri-plugin-single-instance without its semver feature.
#[cfg(windows)]
fn primary_running(identifier: &str) -> bool {
  use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND};
  use windows_sys::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
  let name = wide(&format!("{identifier}-sim"));
  let handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr()) };
  if handle.is_null() {
    // Unknown failures keep the waiting launch independent rather than risk an exit.
    return unsafe { GetLastError() } != ERROR_FILE_NOT_FOUND;
  }
  unsafe { CloseHandle(handle) };
  true
}

#[cfg(windows)]
fn select_without_window(identifier: &str) -> Result<bool, String> {
  let args: Vec<String> = std::env::args().skip(1).collect();
  if args.len() != 2 || args[0] != "shell-select" {
    return Ok(false);
  }
  #[cfg(debug_assertions)]
  let test_config = std::env::var_os("COMPARE_TEST_CONFIG");
  #[cfg(not(debug_assertions))]
  let test_config: Option<std::ffi::OsString> = None;
  // Must match the directory resolved by commands::settings_path.
  let config = match test_config {
    Some(directory) => {
      let path = compare_fs::checked_path(std::path::Path::new(&directory), false)
        .map_err(|e| e.to_string())?;
      if !path.is_dir() {
        return Err("Test config must be an existing directory.".into());
      }
      path
    }
    None => dirs::config_dir()
      .ok_or("Missing configuration directory.")?
      .join(identifier),
  };
  let ancestor = config
    .ancestors()
    .find(|path| path.exists())
    .ok_or("Missing configuration ancestor.")?;
  compare_fs::checked_path(ancestor, false).map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&config).map_err(|e| e.to_string())?;
  compare_fs::shell::request(&config, &args).map_err(|e| e.to_string())?;
  let executable = std::env::current_exe().map_err(|e| e.to_string())?;
  compare_fs::shell::refresh_registration(&executable, &config).map_err(|e| e.to_string())?;
  Ok(true)
}
