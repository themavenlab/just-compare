use compare_fs::{Document, FolderOptions, Plan, Settings, SyncMode};
use compare_text::{
  compare_with_rules, intraline, CompareOptions, DiffKind, UnimportantRule, WorkControl,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct Resources {
  documents: Mutex<HashMap<String, Document>>,
  plans: Mutex<HashMap<String, Plan>>,
  jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
  next: AtomicU64,
  pub git_accepted: AtomicBool,
  merge_blocks: Mutex<Option<Vec<Block>>>,
  saved_output: Mutex<Option<String>>,
}

impl Resources {
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
  kind: &'static str,
  left_start: usize,
  left_end: usize,
  right_start: usize,
  right_end: usize,
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
fn document_view(id: String, document: &Document) -> DocumentView {
  DocumentView {
    id,
    path: document.path().to_string_lossy().into_owned(),
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

#[tauri::command]
pub async fn compare_text(
  left: String,
  right: String,
  options: Options,
  job_id: String,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<Span>, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let result = worker(move || {
    if options.patterns.len() > 16 {
      return Err("At most 16 rules are supported.".into());
    }
    let rules: Result<Vec<_>, _> = options
      .patterns
      .iter()
      .map(|p| UnimportantRule::compile(p))
      .collect();
    let rules = rules.map_err(|e| e.to_string())?;
    compare_with_rules(
      &left,
      &right,
      CompareOptions {
        ignore_case: options.ignore_case,
        ignore_whitespace: options.ignore_whitespace,
        ignore_line_endings: options.ignore_line_endings,
      },
      &rules,
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

#[derive(Serialize)]
pub struct FolderRoots {
  left: String,
  right: String,
}

#[tauri::command]
pub async fn scan_folders(
  left: String,
  right: String,
  options: FolderOptions,
  job_id: String,
  app: tauri::AppHandle,
  state: State<'_, Arc<Resources>>,
) -> Result<Vec<compare_fs::FolderEntry>, String> {
  let resources = state.inner().clone();
  let flag = begin(&resources, &job_id)?;
  let event_id = job_id.clone();
  let result = worker(move || {
    let mut event_error = None;
    let result = compare_fs::scan_pair(
      Path::new(&left),
      Path::new(&right),
      &options,
      &flag,
      |count| {
        if let Err(e) = app.emit("operation-progress", (&event_id, count)) {
          event_error = Some(e.to_string());
        }
      },
    )
    .map_err(|e| e.to_string());
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
      plan.select(&names).map_err(|e| e.to_string())?;
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
pub async fn write_settings(settings: Settings, app: tauri::AppHandle) -> Result<(), String> {
  let path = settings_path(&app)?;
  worker(move || compare_fs::save_settings(&path, &settings).map_err(|e| e.to_string())).await
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

#[tauri::command]
pub fn launch_arguments() -> Vec<String> {
  std::env::args().skip(1).collect()
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
