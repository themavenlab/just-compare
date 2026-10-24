#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
use tauri::Manager;

fn main() {
  let is_merge = std::env::args().nth(1).as_deref() == Some("git-merge");
  let result = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(std::sync::Arc::new(commands::Resources::default()))
    .invoke_handler(tauri::generate_handler![
      commands::compare_text,
      commands::refine_text,
      commands::cancel_job,
      commands::open_document,
      commands::open_git_output,
      commands::close_document,
      commands::save_document,
      commands::merge_text,
      commands::scan_folders,
      commands::normalize_folder_roots,
      commands::preview_sync,
      commands::preview_file_action,
      commands::execute_sync,
      commands::read_settings,
      commands::write_settings,
      commands::launch_arguments,
      commands::finish_git_merge,
    ])
    .build(tauri::generate_context!());
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
