use compare_fs::{Document, FolderOptions};
use compare_merge::MergeBlock;
use compare_text::{compare, CompareOptions, DiffKind};
use std::path::Path;
use std::sync::atomic::AtomicBool;

fn run(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
  match args {
        [command, left, right] if command == "diff" => {
            let a = Document::open(Path::new(left), None)?;
            let b = Document::open(Path::new(right), None)?;
            let spans = compare(a.text(), b.text(), CompareOptions::default())?;
            let mut different = false;
            for span in spans {
                if span.kind != DiffKind::Equal {
                    different = true;
                    println!("{:?} left {:?} right {:?}", span.kind, span.left, span.right);
                }
            }
            Ok(i32::from(different))
        }
        [command, left, right] if command == "folder" => {
            let entries = compare_fs::scan_pair(Path::new(left), Path::new(right), &FolderOptions::default(), &AtomicBool::new(false), |_| {})?;
            let mut different = false;
            let mut errors = false;
            for entry in entries {
                different |= entry.status != "same";
                errors |= entry.status == "error";
                println!("{}\t{}", entry.status, entry.relative);
                if let Some(detail) = entry.detail { eprintln!("{detail}"); }
            }
            Ok(if errors { 2 } else { i32::from(different) })
        }
        [command, base, left, right, output] if command == "merge" => {
            let a = Document::open(Path::new(base), None)?;
            let l = Document::open(Path::new(left), None)?;
            let r = Document::open(Path::new(right), None)?;
            let blocks = compare_merge::merge(a.text(), l.text(), r.text())?;
            let mut text = String::new();
            for block in blocks {
                match block {
                    MergeBlock::Resolved(value) => text.push_str(&value),
                    MergeBlock::Conflict { .. } => {
                        eprintln!("Unresolved conflicts; output was not modified.");
                        return Ok(1);
                    }
                }
            }
            a.save_as(&text, Path::new(output), false)?;
            Ok(0)
        }
        [command, rest @ ..] if (command == "gui" && [0, 2].contains(&rest.len())) || (command == "git-merge" && rest.len() == 4) || (command == "git-diff" && rest.len() == 2) => {
            let exe = std::env::var_os("COMPARE_DESKTOP").ok_or("Set COMPARE_DESKTOP to the absolute desktop executable path.")?;
            if !Path::new(&exe).is_absolute() { return Err("COMPARE_DESKTOP must be absolute.".into()); }
            let mut process = std::process::Command::new(exe);
            if !rest.is_empty() {
                let paths = rest.iter().map(|path| std::path::absolute(Path::new(path))).collect::<Result<Vec<_>, _>>()?;
                process.arg(command).args(paths);
            }
            let status = process.status()?;
            Ok(status.code().unwrap_or(2))
        }
        _ => Err("Usage: compare diff LEFT RIGHT | folder LEFT RIGHT | merge BASE LEFT RIGHT NEW_OUTPUT | gui [ARGS] | git-diff LEFT RIGHT | git-merge BASE LEFT RIGHT OUTPUT".into()),
    }
}

fn main() {
  let args: Vec<_> = std::env::args().skip(1).collect();
  let code = match run(&args) {
    Ok(code) => code,
    Err(error) => {
      eprintln!("compare: {error}");
      2
    }
  };
  std::process::exit(code);
}
