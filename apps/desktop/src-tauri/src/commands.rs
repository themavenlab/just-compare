use compare_fs::{Document, FolderOptions, Plan, Settings, SyncMode};
use compare_text::{
  compare_classified_with_anchors, compare_with_anchors, find_matches, intraline, AlignmentAnchor,
  CompareOptions, DiffKind, MoveDirection, MovedBlock, SearchOptions, UnimportantRule, WorkControl,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct Resources {
  documents: Mutex<HashMap<String, Document>>,
  plans: Mutex<HashMap<String, Plan>>,
  file_plans: Mutex<HashMap<String, compare_fs::file_actions::FileActionPlan>>,
  jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
  next: AtomicU64,
  pub git_accepted: AtomicBool,
  merge_blocks: Mutex<Option<Vec<Block>>>,
  saved_output: Mutex<Option<String>>,
  shell_requests: Mutex<std::collections::VecDeque<Vec<String>>>,
}

impl Resources {
  #[cfg(windows)]
  pub fn queue_shell(&self, args: Vec<String>) -> Result<(), String> {
    let mut queue = self.shell_requests.lock().map_err(|e| e.to_string())?;
    if queue.len() >= 32 {
      return Err("Too many pending shell requests; wait and retry.".into());
    }
    queue.push_back(args);
    Ok(())
  }
  fn id(&self) -> String {
    self.next.fetch_add(1, Ordering::Relaxed).to_string()
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
  ignore_case: bool,
  ignore_whitespace: bool,
  ignore_line_endings: bool,
  patterns: Vec<String>,
  #[serde(default)]
  alignment_anchors: Vec<Anchor>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
  kind: &'static str,
  left_start: usize,
  left_end: usize,
  right_start: usize,
  right_end: usize,
  #[serde(skip_serializing_if = "Option::is_none")]
  minor: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  moved: Option<MoveInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveInfo {
  id: usize,
  direction: &'static str,
  counterpart_start: usize,
  line_count: usize,
}

impl From<MovedBlock> for MoveInfo {
  fn from(value: MovedBlock) -> Self {
    Self {
      id: value.id,
      direction: match value.direction {
        MoveDirection::From => "from",
        MoveDirection::To => "to",
      },
      counterpart_start: value.counterpart_start,
      line_count: value.line_count,
    }
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Anchor {
  left: usize,
  right: usize,
}
fn kind(kind: DiffKind) -> &'static str {
  match kind {
    DiffKind::Equal => "equal",
    DiffKind::Delete => "delete",
    DiffKind::Insert => "insert",
    DiffKind::Replace => "replace",
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentView {
  id: String,
  path: String,
  text: String,
  encoding: String,
  bom: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
  start: usize,
  end: usize,
  source_start: usize,
  source_end: usize,
}
fn document_view(id: String, document: &Document) -> DocumentView {
  DocumentView {
    id,
    path: compare_fs::display_path(document.path()),
    text: document.text().into(),
    encoding: format!("{:?}", document.encoding()),
    bom: document.has_bom(),
  }
}

async fn worker<T: Send + 'static>(
  operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(operation)
    .await
    .map_err(|e| format!("Worker failed: {e}"))?
}

fn begin(resources: &Resources, id: &str) -> Result<Arc<AtomicBool>, String> {
  if id.len() > 128 {
    return Err("Invalid job identifier.".into());
  }
  let mut jobs = resources.jobs.lock().map_err(|e| e.to_string())?;
  if jobs.len() >= 4 || jobs.contains_key(id) {
    return Err("Too many active jobs or duplicate identifier.".into());
  }
  let flag = Arc::new(AtomicBool::new(false));
  jobs.insert(id.into(), flag.clone());
  Ok(flag)
}

#[derive(Deserialize)]
pub struct CompareDocuments {
  left: Option<String>,
  right: Option<String>,
}

#[tauri::command]
pub async fn compare_text(
  left: String,
  right: String,
  documents: Option<CompareDocuments>,
  options: Options,
  show_minor: Option<bool>,
  job_id: String,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<Span>, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let anchors = options
    .alignment_anchors
    .into_iter()
    .map(|anchor| AlignmentAnchor {
      left: anchor.left,
      right: anchor.right,
    })
    .collect::<Vec<_>>();
  let snapshots = resources.clone();
  let result = worker(move || {
    let restore = |text: String, id: Option<String>| -> Result<String, String> {
      match id {
        Some(id) => snapshots
          .documents
          .lock()
          .map_err(|e| e.to_string())?
          .get(&id)
          .ok_or("Document is closed.")?
          .restore_endings(&text)
          .map_err(|e| e.to_string()),
        None => Ok(text),
      }
    };
    let (left_document, right_document) = documents
      .map(|documents| (documents.left, documents.right))
      .unwrap_or_default();
    let left = restore(left, left_document)?;
    let right = restore(right, right_document)?;
    if options.patterns.len() > 16 {
      return Err("At most 16 rules are supported.".into());
    }
    let rules: Result<Vec<_>, _> = options
      .patterns
      .iter()
      .map(|p| UnimportantRule::compile(p))
      .collect();
    let rules = rules.map_err(|e| e.to_string())?;
    let compare_options = CompareOptions {
      ignore_case: options.ignore_case,
      ignore_whitespace: options.ignore_whitespace,
      ignore_line_endings: options.ignore_line_endings,
    };
    if show_minor == Some(true) {
      return compare_classified_with_anchors(
        &left,
        &right,
        compare_options,
        &rules,
        &anchors,
        WorkControl::new(&flag, Duration::from_secs(2)),
      )
      .map(|spans| {
        spans
          .into_iter()
          .map(|item| Span {
            kind: kind(item.span.kind),
            left_start: item.span.left.start,
            left_end: item.span.left.end,
            right_start: item.span.right.start,
            right_end: item.span.right.end,
            minor: Some(item.minor),
            moved: item.span.moved.map(MoveInfo::from),
          })
          .collect()
      })
      .map_err(|e| e.to_string());
    }
    compare_with_anchors(
      &left,
      &right,
      CompareOptions {
        ignore_case: options.ignore_case,
        ignore_whitespace: options.ignore_whitespace,
        ignore_line_endings: options.ignore_line_endings,
      },
      &rules,
      &anchors,
      WorkControl::new(&flag, Duration::from_secs(2)),
    )
    .map(|spans| {
      spans
        .into_iter()
        .map(|s| Span {
          kind: kind(s.kind),
          left_start: s.left.start,
          left_end: s.left.end,
          right_start: s.right.start,
          right_end: s.right.end,
          minor: None,
          moved: s.moved.map(MoveInfo::from),
        })
        .collect()
    })
    .map_err(|e| e.to_string())
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[tauri::command]
pub fn cancel_job(job_id: String, state: State<'_, Arc<Resources>>) -> Result<(), String> {
  let jobs = state.jobs.lock().map_err(|e| e.to_string())?;
  let flag = jobs.get(&job_id).ok_or("Job is not active.")?;
  flag.store(true, Ordering::Relaxed);
  Ok(())
}

#[tauri::command]
pub async fn search_text(
  text: String,
  query: String,
  match_case: bool,
  whole_word: bool,
  regex: bool,
) -> Result<Vec<SearchResult>, String> {
  worker(move || {
    find_matches(
      &text,
      &query,
      SearchOptions {
        match_case,
        whole_word,
        regex,
      },
    )
    .map(|matches| {
      matches
        .into_iter()
        .map(|found| SearchResult {
          start: found.start,
          end: found.end,
          source_start: found.source_start,
          source_end: found.source_end,
        })
        .collect()
    })
  })
  .await
}

#[tauri::command]
pub async fn refine_text(left: String, right: String) -> Result<Vec<Span>, String> {
  worker(move || {
    intraline(
      &left,
      &right,
      WorkControl::new(&AtomicBool::new(false), Duration::from_secs(2)),
    )
    .map(|spans| {
      spans
        .into_iter()
        .map(|s| Span {
          kind: kind(s.kind),
          left_start: s.left.start,
          left_end: s.left.end,
          right_start: s.right.start,
          right_end: s.right.end,
          minor: None,
          moved: None,
        })
        .collect()
    })
    .map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
pub async fn open_document(
  path: String,
  encoding: Option<String>,
  state: State<'_, Arc<Resources>>,
) -> Result<DocumentView, String> {
  let resources = state.inner().clone();
  worker(move || {
    let selected = encoding
      .as_deref()
      .map(compare_text::TextEncoding::for_label)
      .transpose()
      .map_err(|e| e.to_string())?;
    let document = Document::open(Path::new(&path), selected).map_err(|e| e.to_string())?;
    let id = resources.id();
    let view = document_view(id.clone(), &document);
    let mut documents = resources.documents.lock().map_err(|e| e.to_string())?;
    if documents.len() >= 32 {
      return Err("Too many open documents; close a document first.".into());
    }
    documents.insert(id, document);
    Ok(view)
  })
  .await
}

#[tauri::command]
pub fn close_document(id: String, state: State<'_, Arc<Resources>>) -> Result<(), String> {
  state
    .documents
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&id)
    .ok_or("Document is already closed.")?;
  Ok(())
}

#[tauri::command]
pub async fn document_changed(
  id: String,
  state: State<'_, Arc<Resources>>,
) -> Result<bool, String> {
  let resources = state.inner().clone();
  worker(move || {
    let documents = resources.documents.lock().map_err(|e| e.to_string())?;
    documents
      .get(&id)
      .ok_or("Document is closed.")?
      .has_changed()
      .map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
pub async fn save_document(
  id: Option<String>,
  text: String,
  destination: Option<String>,
  convert_utf8: bool,
  state: State<'_, Arc<Resources>>,
) -> Result<DocumentView, String> {
  let resources = state.inner().clone();
  worker(move || {
    let mut documents = resources.documents.lock().map_err(|e| e.to_string())?;
    if let Some(id) = id {
      let document = documents.get_mut(&id).ok_or("Document is closed.")?;
      let text = document.restore_endings(&text).map_err(|e| e.to_string())?;
      if let Some(destination) = destination {
        let saved = document
          .save_as(&text, Path::new(&destination), convert_utf8)
          .map_err(|e| e.to_string())?;
        *document = saved;
      } else {
        if convert_utf8 {
          return Err("Conversion requires Save As to a new file.".into());
        }
        document.save(&text).map_err(|e| e.to_string())?;
      }
      let view = document_view(id.clone(), document);
      *resources.saved_output.lock().map_err(|e| e.to_string())? = Some(id);
      Ok(view)
    } else {
      if documents.len() >= 32 {
        return Err("Too many open documents.".into());
      }
      let destination = destination.ok_or("Choose a new destination.")?;
      let document = Document::create(&text, Path::new(&destination)).map_err(|e| e.to_string())?;
      let id = resources.id();
      let view = document_view(id.clone(), &document);
      documents.insert(id, document);
      *resources.saved_output.lock().map_err(|e| e.to_string())? = Some(view.id.clone());
      Ok(view)
    }
  })
  .await
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
  Resolved {
    text: String,
  },
  Conflict {
    base: String,
    left: String,
    right: String,
  },
}

#[tauri::command]
pub async fn merge_text(
  base: String,
  left: String,
  right: String,
  git_session: bool,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<Block>, String> {
  if git_session && std::env::args().nth(1).as_deref() != Some("git-merge") {
    return Err("This app was not launched as a Git merge tool.".into());
  }
  let resources = state.inner().clone();
  if git_session {
    *resources.merge_blocks.lock().map_err(|e| e.to_string())? = None;
    *resources.saved_output.lock().map_err(|e| e.to_string())? = None;
  }
  worker(move || {
    let blocks: Vec<Block> = compare_merge::merge(&base, &left, &right)
      .map(|blocks| {
        blocks
          .into_iter()
          .map(|block| match block {
            compare_merge::MergeBlock::Resolved(text) => Block::Resolved { text },
            compare_merge::MergeBlock::Conflict { base, left, right } => {
              Block::Conflict { base, left, right }
            }
          })
          .collect()
      })
      .map_err(|e| e.to_string())?;
    if git_session {
      *resources.merge_blocks.lock().map_err(|e| e.to_string())? = Some(blocks.clone());
    }
    Ok(blocks)
  })
  .await
}

#[tauri::command]
pub async fn normalize_folder_roots(left: String, right: String) -> Result<FolderRoots, String> {
  worker(move || {
    let normalize = |path: &str| {
      let path = compare_fs::checked_path(Path::new(path), false).map_err(|e| e.to_string())?;
      if !std::fs::metadata(&path)
        .map_err(|e| e.to_string())?
        .is_dir()
      {
        return Err("Folder roots must be directories.".to_string());
      }
      path
        .into_os_string()
        .into_string()
        .map_err(|_| "Non-Unicode folder roots are unsupported.".to_string())
    };
    Ok(FolderRoots {
      left: normalize(&left)?,
      right: normalize(&right)?,
    })
  })
  .await
}

#[tauri::command]
pub async fn relative_folder_path(
  left: String,
  right: String,
  path: String,
) -> Result<Option<String>, String> {
  worker(move || {
    compare_fs::relative_folder_path(Path::new(&left), Path::new(&right), Path::new(&path))
      .map_err(|error| error.to_string())
  })
  .await
}

#[derive(Serialize)]
pub struct FolderRoots {
  left: String,
  right: String,
}

#[tauri::command]
pub async fn disk_space(path: String) -> Result<compare_fs::DiskSpace, String> {
  worker(move || compare_fs::disk_space(Path::new(&path)).map_err(|e| e.to_string())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMetadata {
  bytes: u64,
  modified: Option<u64>,
  directory: bool,
  read_only: bool,
}

#[tauri::command]
pub async fn path_metadata(path: String) -> Result<PathMetadata, String> {
  worker(move || {
    let path = compare_fs::checked_path(Path::new(&path), false).map_err(|e| e.to_string())?;
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = metadata
      .modified()
      .map_err(|e| e.to_string())?
      .duration_since(std::time::UNIX_EPOCH)
      .ok()
      .map(|duration| u64::try_from(duration.as_millis()).map_err(|e| e.to_string()))
      .transpose()?;
    if metadata.len() > 9_007_199_254_740_991
      || modified.is_some_and(|value| value > 8_640_000_000_000_000)
    {
      return Err("Metadata exceeds the supported display range.".into());
    }

    Ok(PathMetadata {
      bytes: metadata.len(),
      modified,
      directory: metadata.is_dir(),
      read_only: metadata.permissions().readonly(),
    })
  })
  .await
}

#[tauri::command]
pub async fn parent_folder(path: String) -> Result<String, String> {
  worker(move || {
    let path = compare_fs::checked_path(Path::new(&path), false).map_err(|e| e.to_string())?;
    if !path.is_dir() {
      return Err("Choose an existing directory before navigating to its parent.".into());
    }
    let parent = path.parent().ok_or("This folder has no parent.")?;
    compare_fs::checked_path(parent, false)
      .map(|path| compare_fs::display_path(&path))
      .map_err(|e| e.to_string())
  })
  .await
}

fn launch_external(
  mut command: std::process::Command,
  description: &'static str,
) -> Result<(), String> {
  let mut child = command
    .spawn()
    .map_err(|error| format!("Cannot launch {description}: {error}"))?;
  tauri::async_runtime::spawn_blocking(move || match child.wait() {
    Ok(status) if !status.success() => {
      eprintln!("{description} exited unsuccessfully: {status}")
    }
    Err(error) => eprintln!("Cannot wait for {description}: {error}"),
    Ok(_) => {}
  });
  Ok(())
}

#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
  worker(move || {
    let path = compare_fs::checked_path(Path::new(&path), false).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let command = {
      let mut command = std::process::Command::new("explorer.exe");
      if path.is_dir() {
        command.arg(&path);
      } else {
        command.arg(format!("/select,{}", path.display()));
      }
      command
    };
    #[cfg(target_os = "macos")]
    let command = {
      let mut command = std::process::Command::new("open");
      command.arg("-R").arg(&path);
      command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let command = {
      let mut command = std::process::Command::new("xdg-open");
      command.arg(if path.is_dir() {
        path.as_path()
      } else {
        path.parent().ok_or("Path has no parent directory.")?
      });
      command
    };
    launch_external(command, "the file manager")
  })
  .await
}

#[tauri::command]
pub async fn open_with(path: String, application: String) -> Result<(), String> {
  worker(move || {
    let path = compare_fs::checked_path(Path::new(&path), false).map_err(|e| e.to_string())?;
    let application =
      compare_fs::checked_path(Path::new(&application), false).map_err(|e| e.to_string())?;
    if !path.is_file() || !application.is_file() {
      return Err("Open With requires a regular file and an application executable.".into());
    }
    #[cfg(target_os = "windows")]
    if !application
      .extension()
      .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
      return Err(
        "Select a Windows .exe application; scripts and shell commands are not accepted.".into(),
      );
    }
    let mut command = std::process::Command::new(application);
    command.arg(path);
    launch_external(command, "the selected application")
  })
  .await
}

#[tauri::command]
pub fn validate_folder_rules(
  rules: compare_fs::FolderRules,
  options: FolderOptions,
) -> Result<(), String> {
  compare_fs::validate_folder_configuration(&rules, &options).map_err(|error| error.to_string())
}

struct ProgressThrottle {
  last_emit: Instant,
  last_count: usize,
}

impl ProgressThrottle {
  fn new(now: Instant) -> Self {
    Self {
      last_emit: now,
      last_count: 0,
    }
  }

  fn should_emit(&mut self, count: usize, now: Instant) -> bool {
    if count.saturating_sub(self.last_count) < 500
      && now.duration_since(self.last_emit) < Duration::from_millis(100)
    {
      return false;
    }
    self.last_emit = now;
    self.last_count = count;
    true
  }

  fn emit_final(&mut self, count: usize, emit: impl FnOnce(usize)) {
    self.last_emit = Instant::now();
    self.last_count = count;
    emit(count);
  }
}

#[tauri::command]
pub async fn scan_folders(
  left: String,
  right: String,
  options: FolderOptions,
  rules: Option<compare_fs::FolderRules>,
  job_id: String,
  app: tauri::AppHandle,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<compare_fs::FolderEntry>, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let event_id = job_id.clone();
  let result = worker(move || {
    let mut event_error = None;
    let mut throttle = ProgressThrottle::new(Instant::now());
    let mut final_count = 0;
    let mut progress = |count| {
      final_count = count;
      if throttle.should_emit(count, Instant::now()) {
        if let Err(e) = app.emit("operation-progress", (&event_id, count)) {
          event_error = Some(e.to_string());
        }
      }
    };
    let result = if let Some(rules) = rules {
      compare_fs::scan_pair_with_rules(
        Path::new(&left),
        Path::new(&right),
        &options,
        &rules,
        &flag,
        &mut progress,
      )
    } else {
      compare_fs::scan_pair(
        Path::new(&left),
        Path::new(&right),
        &options,
        &flag,
        &mut progress,
      )
    }
    .map_err(|e| e.to_string());
    drop(progress);
    throttle.emit_final(final_count, |count| {
      if let Err(e) = app.emit("operation-progress", (&event_id, count)) {
        event_error = Some(e.to_string());
      }
    });
    if let Some(error) = event_error {
      return Err(format!("Progress delivery failed: {error}"));
    }
    result
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
  id: String,
  operations: Vec<Operation>,
}
#[derive(Serialize)]
pub struct Operation {
  relative: String,
  action: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
  id: String,
  operations: Vec<compare_fs::file_actions::FileActionOperation>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn compare_folder_selection(
  left: String,
  right: String,
  options: FolderOptions,
  rules: compare_fs::FolderRules,
  selected: Vec<String>,
  previous: Option<Vec<compare_fs::FolderEntry>>,
  job_id: String,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<compare_fs::FolderEntry>, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let result = worker(move || {
    if let Some(previous) = previous {
      compare_fs::refresh_selection(
        Path::new(&left),
        Path::new(&right),
        &options,
        &rules,
        &selected,
        &previous,
        &flag,
        |_| {},
      )
    } else {
      compare_fs::scan_selected_with_rules(
        Path::new(&left),
        Path::new(&right),
        &options,
        &rules,
        &selected,
        &flag,
        |_| {},
      )
    }
    .map_err(|e| e.to_string())
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[tauri::command]
pub async fn preview_local_action(
  request: compare_fs::file_actions::FileActionRequest,
  job_id: String,
  state: State<'_, Arc<Resources>>,
) -> Result<FilePreview, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let retained = resources.clone();
  let result = worker(move || {
    let plan = compare_fs::file_actions::FileActionPlan::preview(request, &flag)
      .map_err(|e| e.to_string())?;
    let operations = plan.operations().to_vec();
    let id = retained.id();
    retained.plans.lock().map_err(|e| e.to_string())?.clear();
    let mut plans = retained.file_plans.lock().map_err(|e| e.to_string())?;
    plans.clear();
    plans.insert(id.clone(), plan);
    Ok(FilePreview { id, operations })
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[tauri::command]
pub async fn execute_local_action(
  id: String,
  job_id: String,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<compare_fs::file_actions::FileActionOutcome>, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let plan = resources
    .file_plans
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&id);
  let result = worker(move || {
    Ok(
      plan
        .ok_or("Preview is missing or consumed.")?
        .execute(&flag, |_, _| {}),
    )
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[tauri::command]
pub async fn preview_sync(
  left: String,
  right: String,
  options: FolderOptions,
  mode: SyncMode,
  selected: Option<Vec<String>>,
  job_id: Option<String>,
  state: State<'_, Arc<Resources>>,
) -> Result<Preview, String> {
  let resources = state.inner().clone();
  let job_id = job_id.unwrap_or_else(|| resources.id());
  let flag = begin(&resources, &job_id)?;
  let worker_resources = resources.clone();
  let result = worker(move || {
    let mut plan = Plan::preview(Path::new(&left), Path::new(&right), options, mode, &flag)
      .map_err(|e| e.to_string())?;
    if let Some(names) = selected {
      if names.is_empty()
        || names.len() > 10_000
        || names.iter().any(|name| {
          name.is_empty()
            || name.starts_with('/')
            || name.split('/').any(|part| part == ".." || part.is_empty())
        })
      {
        return Err("Select valid relative entries for synchronization.".into());
      }
      let actionable: Vec<_> = plan
        .operations
        .iter()
        .filter(|operation| {
          names.iter().any(|name| {
            operation.relative == *name || operation.relative.starts_with(&format!("{name}/"))
          })
        })
        .map(|operation| operation.relative.clone())
        .collect();
      if actionable.is_empty() {
        return Err("No changes are required for the selected entries.".into());
      }
      plan.select(&actionable).map_err(|e| e.to_string())?;
    }
    let operations = plan
      .operations
      .iter()
      .map(|o| Operation {
        relative: o.relative.clone(),
        action: o.action.clone(),
      })
      .collect();
    let id = worker_resources.id();
    worker_resources
      .file_plans
      .lock()
      .map_err(|e| e.to_string())?
      .clear();
    let mut plans = worker_resources.plans.lock().map_err(|e| e.to_string())?;
    plans.clear();
    plans.insert(id.clone(), plan);
    Ok(Preview { id, operations })
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[tauri::command]
pub async fn preview_file_action(
  left: String,
  right: String,
  options: FolderOptions,
  relative: String,
  action: String,
  job_id: Option<String>,
  state: State<'_, Arc<Resources>>,
) -> Result<Preview, String> {
  let resources = state.inner().clone();
  let job_id = job_id.unwrap_or_else(|| resources.id());
  let flag = begin(&resources, &job_id)?;
  let worker_resources = resources.clone();
  let result = worker(move || {
    let plan = Plan::file_action(
      Path::new(&left),
      Path::new(&right),
      options,
      &relative,
      &action,
      &flag,
    )
    .map_err(|e| e.to_string())?;
    let operations = plan
      .operations
      .iter()
      .map(|o| Operation {
        relative: o.relative.clone(),
        action: o.action.clone(),
      })
      .collect();
    let id = worker_resources.id();
    worker_resources
      .file_plans
      .lock()
      .map_err(|e| e.to_string())?
      .clear();
    let mut plans = worker_resources.plans.lock().map_err(|e| e.to_string())?;
    plans.clear();
    plans.insert(id.clone(), plan);
    Ok(Preview { id, operations })
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[derive(Serialize)]
pub struct Outcome {
  relative: String,
  error: Option<String>,
}
#[tauri::command]
pub async fn execute_sync(
  id: String,
  job_id: String,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<Outcome>, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let plan = resources
    .plans
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&id);
  let result = worker(move || {
    plan
      .ok_or("Preview is missing or consumed.")?
      .execute(&flag, |_| {})
      .map(|results| {
        results
          .into_iter()
          .map(|(relative, result)| Outcome {
            relative,
            error: result.err(),
          })
          .collect()
      })
      .map_err(|e| e.to_string())
  })
  .await;
  resources
    .jobs
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&job_id);
  result
}

#[tauri::command]
pub async fn read_settings(app: tauri::AppHandle) -> Result<Settings, String> {
  let path = settings_path(&app)?;
  worker(move || compare_fs::load_settings(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn remember_history(
  folders: Vec<String>,
  comparison: Option<compare_fs::RecentComparison>,
  app: tauri::AppHandle,
) -> Result<Settings, String> {
  let path = settings_path(&app)?;
  worker(move || {
    let mut settings = compare_fs::load_settings(&path).map_err(|e| e.to_string())?;
    compare_fs::remember_history(&mut settings, folders, comparison).map_err(|e| e.to_string())?;
    compare_fs::save_settings(&path, &settings).map_err(|e| e.to_string())?;
    Ok(settings)
  })
  .await
}

#[tauri::command]
pub async fn write_history(
  recent_folders: Option<Vec<String>>,
  recent_comparisons: Option<Vec<compare_fs::RecentComparison>>,
  app: tauri::AppHandle,
) -> Result<Settings, String> {
  let path = settings_path(&app)?;
  worker(move || {
    let mut settings = compare_fs::load_settings(&path).map_err(|e| e.to_string())?;
    if let Some(folders) = recent_folders {
      settings.recent_folders = Some(folders);
    }
    if let Some(comparisons) = recent_comparisons {
      settings.recent_comparisons = comparisons;
    }
    compare_fs::save_settings(&path, &settings).map_err(|e| e.to_string())?;
    Ok(settings)
  })
  .await
}

#[tauri::command]
pub async fn write_line_detail(
  line_detail: compare_fs::LineDetail,
  app: tauri::AppHandle,
) -> Result<(), String> {
  let path = settings_path(&app)?;
  worker(move || {
    let mut settings = compare_fs::load_settings(&path).map_err(|e| e.to_string())?;
    settings.line_detail = Some(line_detail);
    compare_fs::save_settings(&path, &settings).map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
pub async fn write_settings(settings: Settings, app: tauri::AppHandle) -> Result<(), String> {
  let path = settings_path(&app)?;
  worker(move || compare_fs::save_settings(&path, &settings).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn load_recoveries(
  app: tauri::AppHandle,
) -> Result<Vec<compare_fs::DraftRecovery>, String> {
  let path = recovery_path(&app)?;
  let settings = settings_path(&app)?;
  worker(move || {
    if !compare_fs::load_settings(&settings)
      .map_err(|e| e.to_string())?
      .recover_drafts
    {
      return Err("Draft recovery is disabled.".into());
    }
    compare_fs::load_recoveries(&path).map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
pub async fn save_recoveries(
  recoveries: Vec<compare_fs::DraftRecovery>,
  app: tauri::AppHandle,
) -> Result<Vec<compare_fs::DraftRecovery>, String> {
  let path = recovery_path(&app)?;
  let settings = settings_path(&app)?;
  worker(move || {
    if !compare_fs::load_settings(&settings)
      .map_err(|e| e.to_string())?
      .recover_drafts
    {
      return Err("Draft recovery is disabled.".into());
    }
    compare_fs::save_recoveries(&path, &recoveries).map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
pub async fn discard_recovery(
  id: String,
  app: tauri::AppHandle,
) -> Result<Vec<compare_fs::DraftRecovery>, String> {
  let path = recovery_path(&app)?;
  let settings = settings_path(&app)?;
  worker(move || {
    if !compare_fs::load_settings(&settings)
      .map_err(|e| e.to_string())?
      .recover_drafts
    {
      return Err("Draft recovery is disabled.".into());
    }
    compare_fs::discard_recovery(&path, &id).map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
pub async fn set_draft_recovery(enabled: bool, app: tauri::AppHandle) -> Result<Settings, String> {
  let settings = settings_path(&app)?;
  let recovery = recovery_path(&app)?;
  worker(move || {
    let mut current = compare_fs::load_settings(&settings).map_err(|e| e.to_string())?;
    if !enabled {
      compare_fs::clear_recoveries(&recovery).map_err(|e| e.to_string())?;
    }
    current.recover_drafts = enabled;
    compare_fs::save_settings(&settings, &current).map_err(|e| e.to_string())?;
    Ok(current)
  })
  .await
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  #[cfg(debug_assertions)]
  if let Some(directory) = std::env::var_os("COMPARE_TEST_CONFIG") {
    let path = compare_fs::checked_path(Path::new(&directory), false).map_err(|e| e.to_string())?;
    if !path.is_dir() {
      return Err("Test config must be an existing directory.".into());
    }
    return Ok(path.join("settings.json"));
  }
  Ok(
    app
      .path()
      .app_config_dir()
      .map_err(|e| e.to_string())?
      .join("settings.json"),
  )
}

fn recovery_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  settings_path(app)?
    .parent()
    .map(|directory| directory.join("draft-recovery.json"))
    .ok_or_else(|| "Missing configuration directory.".into())
}

#[tauri::command]
pub fn launch_arguments() -> Vec<String> {
  std::env::args().skip(1).collect()
}

#[tauri::command]
pub fn take_shell_requests(state: State<'_, Arc<Resources>>) -> Result<Vec<Vec<String>>, String> {
  Ok(
    state
      .shell_requests
      .lock()
      .map_err(|e| e.to_string())?
      .drain(..)
      .collect(),
  )
}

#[tauri::command]
pub async fn shell_action(
  args: Vec<String>,
  app: tauri::AppHandle,
) -> Result<compare_fs::shell::ShellAction, String> {
  let config = settings_path(&app)?
    .parent()
    .ok_or("Missing configuration directory.")?
    .to_owned();
  worker(move || {
    let ancestor = config
      .ancestors()
      .find(|path| path.exists())
      .ok_or("Missing configuration ancestor.")?;
    compare_fs::checked_path(ancestor, false).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config).map_err(|e| e.to_string())?;
    let result = compare_fs::shell::request(&config, &args).map_err(|e| e.to_string())?;
    if matches!(result, compare_fs::shell::ShellAction::Selected { .. }) {
      let executable = std::env::current_exe().map_err(|e| e.to_string())?;
      compare_fs::shell::refresh_registration(&executable, &config).map_err(|e| e.to_string())?;
    }
    Ok(result)
  })
  .await
}

#[tauri::command]
pub async fn clear_shell_selection(app: tauri::AppHandle) -> Result<(), String> {
  let config = settings_path(&app)?
    .parent()
    .ok_or("Missing configuration directory.")?
    .to_owned();
  worker(move || {
    compare_fs::shell::clear_selection(&config).map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    compare_fs::shell::refresh_registration(&executable, &config).map_err(|e| e.to_string())
  })
  .await
}

#[tauri::command]
pub async fn explorer_integration(
  enabled: Option<bool>,
  app: tauri::AppHandle,
) -> Result<bool, String> {
  let executable = std::env::current_exe().map_err(|e| e.to_string())?;
  let config = settings_path(&app)?
    .parent()
    .ok_or("Missing configuration directory.")?
    .to_owned();
  worker(move || {
    compare_fs::shell::registration(&executable, &config, enabled).map_err(|e| e.to_string())
  })
  .await
  .and_then(|installed| {
    if enabled == Some(false) {
      let config = settings_path(&app)?
        .parent()
        .ok_or("Missing configuration directory.")?
        .to_owned();
      if config.exists() {
        compare_fs::shell::clear_selection(&config).map_err(|e| e.to_string())?;
      }
    }
    Ok(installed)
  })
}

#[tauri::command]
pub async fn open_git_output(
  state: State<'_, Arc<Resources>>,
) -> Result<Option<DocumentView>, String> {
  let args: Vec<_> = std::env::args().skip(1).collect();
  if args.first().map(String::as_str) != Some("git-merge") || args.len() != 5 {
    return Err("Not launched as a Git merge tool.".into());
  }
  let path = Path::new(&args[4]);
  compare_fs::checked_path(path, true).map_err(|e| e.to_string())?;
  if !path.try_exists().map_err(|e| e.to_string())? {
    return Ok(None);
  }
  open_document(args[4].clone(), None, state).await.map(Some)
}

#[tauri::command]
pub fn finish_git_merge(
  success: bool,
  output_id: Option<String>,
  resolutions: Option<Vec<Option<String>>>,
  app: tauri::AppHandle,
  state: State<'_, Arc<Resources>>,
) -> Result<(), String> {
  if std::env::args().nth(1).as_deref() != Some("git-merge") {
    return Err("This app was not launched as a Git merge tool.".into());
  }
  if success {
    let id = output_id.ok_or("Save resolved output before accepting the merge.")?;
    let choices = resolutions.ok_or("Conflict resolutions are required.")?;
    let blocks = state.merge_blocks.lock().map_err(|e| e.to_string())?;
    let blocks = blocks.as_ref().ok_or("Generate a merge first.")?;
    if choices.len() != blocks.len()
      || blocks
        .iter()
        .zip(&choices)
        .any(|(block, choice)| matches!(block, Block::Conflict { .. }) && choice.is_none())
    {
      return Err("Resolve every conflict before accepting the merge.".into());
    }
    let documents = state.documents.lock().map_err(|e| e.to_string())?;
    let document = documents.get(&id).ok_or("Output document is closed.")?;
    if state
      .saved_output
      .lock()
      .map_err(|e| e.to_string())?
      .as_ref()
      != Some(&id)
    {
      return Err("Merge output has not been saved since generating this merge.".into());
    }
    let destination = std::env::args().nth(5).ok_or("Missing Git output path.")?;
    let path =
      compare_fs::checked_path(Path::new(&destination), false).map_err(|e| e.to_string())?;
    if document.path() != path
      || Document::open(&path, Some(document.encoding()))
        .map_err(|e| e.to_string())?
        .text()
        != document.text()
    {
      return Err("Git output differs from the saved merge output.".into());
    }
  }
  state.git_accepted.store(success, Ordering::Relaxed);
  app.exit(if success { 0 } else { 1 });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn progress_throttle_bounds_large_same_instant_updates_and_emits_final_count() {
    let now = Instant::now();
    let mut throttle = ProgressThrottle::new(now);
    let mut emitted = Vec::new();
    for count in 1..=10_000 {
      if throttle.should_emit(count, now) {
        emitted.push(count);
      }
    }
    throttle.emit_final(10_000, |count| emitted.push(count));

    assert!(emitted.len() <= 21);
    assert_eq!(emitted.last(), Some(&10_000));
  }
}
