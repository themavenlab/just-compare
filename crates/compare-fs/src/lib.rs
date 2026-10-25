mod document;
pub mod file_actions;
mod folder;
mod settings;
mod windows_metadata;

pub use document::{checked_path, Document, FileError};
pub use folder::{
  refresh_selection, scan_pair, scan_pair_with_rules, scan_selected_with_rules,
  validate_folder_configuration, ComparisonImportance, ContentMethod, Criterion, FolderEntry,
  FolderOptions, FolderRules, FolderSide, FolderTextRules, Plan, QuickTest, QuickTestPolicy,
  SyncMode,
};
pub use settings::{
  load_settings, remember_history, save_settings, RecentComparison, Session, Settings,
};
pub use windows_metadata::{disk_space, DiskSpace};
