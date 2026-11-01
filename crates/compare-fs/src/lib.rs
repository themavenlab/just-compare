mod document;
pub mod file_actions;
mod folder;
mod recovery;
mod settings;
pub mod shell;
mod windows_metadata;

pub use document::{checked_path, display_path, Document, FileError};
pub use folder::{
  refresh_selection, scan_pair, scan_pair_with_rules, scan_selected_with_rules,
  validate_folder_configuration, ComparisonImportance, ContentMethod, Criterion, FolderEntry,
  FolderOptions, FolderRules, FolderSide, FolderTextRules, Plan, QuickTest, QuickTestPolicy,
  SyncMode,
};
pub use recovery::{
  clear_recoveries, discard_recovery, load_recoveries, save_recoveries, DraftRecovery,
  RECOVERY_RETENTION_SECONDS,
};
pub use settings::{
  load_settings, remember_history, save_settings, LineDetail, RecentComparison, Session, Settings,
};
pub use windows_metadata::{disk_space, DiskSpace};
