mod document;
pub mod file_actions;
mod folder;
mod recovery;
mod settings;
pub mod shell;
mod windows_metadata;

pub use document::{checked_path, display_path, Document, FileError};
pub use folder::{
  refresh_selection, relative_folder_path, scan_pair, scan_pair_with_rules,
  scan_selected_with_rules, validate_folder_configuration, ComparisonImportance, ContentMethod,
  Criterion, FolderEntry, FolderEntryKind, FolderOptions, FolderRules, FolderScan, FolderSide,
  FolderStatus, FolderTextRules, Plan, QuickTest, QuickTestPolicy, SyncMode, MAX_FOLDER_ENTRIES,
};
pub use recovery::{
  clear_recoveries, discard_recovery, load_recoveries, save_recoveries, DraftRecovery,
  RECOVERY_RETENTION_SECONDS,
};
pub use settings::{
  load_settings, remember_history, save_settings, LineDetail, RecentComparison, Session, Settings,
};
pub use windows_metadata::{disk_space, DiskSpace};
