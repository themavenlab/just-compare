use crate::lines;
use regex::{Regex, RegexBuilder};
use similar::{capture_diff_slices_deadline, Algorithm, DiffTag};
use std::fmt;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MAX_BYTES_PER_INPUT: usize = 1024 * 1024;
const MAX_LINES_PER_INPUT: usize = 20_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CompareOptions {
  pub ignore_case: bool,
  pub ignore_whitespace: bool,
  pub ignore_line_endings: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
  Equal,
  Delete,
  Insert,
  Replace,
}

/// Zero-based, half-open logical line ranges in the original inputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSpan {
  pub kind: DiffKind,
  pub left: Range<usize>,
  pub right: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompareError {
  InputTooLarge,
  TooManyLines,
  IntralineTooLarge,
  InvalidRule(String),
  Cancelled,
  TimedOut,
}

impl fmt::Display for CompareError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::InputTooLarge => write!(f, "Each input must be at most 1 MiB in this prototype."),
      Self::TooManyLines => write!(f, "Each input must have at most 20,000 lines."),
      Self::IntralineTooLarge => write!(
        f,
        "Intraline inputs must not exceed 64 KiB or 8192 Unicode scalars."
      ),
      Self::InvalidRule(reason) => write!(f, "Invalid unimportant-difference rule: {reason}"),
      Self::Cancelled => write!(f, "Comparison was cancelled."),
      Self::TimedOut => write!(f, "Comparison exceeded its time budget."),
    }
  }
}

impl std::error::Error for CompareError {}

pub struct UnimportantRule(Regex);

impl UnimportantRule {
  pub fn compile(pattern: &str) -> Result<Self, CompareError> {
    if pattern.len() > 4096 {
      return Err(CompareError::InvalidRule(
        "Pattern exceeds 4096 bytes.".into(),
      ));
    }
    RegexBuilder::new(pattern)
      .size_limit(1024 * 1024)
      .dfa_size_limit(1024 * 1024)
      .build()
      .map(Self)
      .map_err(|error| CompareError::InvalidRule(error.to_string()))
  }
}

/// Cooperative cancellation, with a deadline bounding the library diff phase.
#[derive(Clone, Copy)]
pub struct WorkControl<'a> {
  cancelled: &'a AtomicBool,
  deadline: Instant,
}

impl<'a> WorkControl<'a> {
  pub fn new(cancelled: &'a AtomicBool, budget: Duration) -> Self {
    Self {
      cancelled,
      deadline: Instant::now() + budget.min(Duration::from_secs(2)),
    }
  }

  fn check(&self) -> Result<(), CompareError> {
    if self.cancelled.load(Ordering::Relaxed) {
      Err(CompareError::Cancelled)
    } else if Instant::now() >= self.deadline {
      Err(CompareError::TimedOut)
    } else {
      Ok(())
    }
  }
}

/// Compare UTF-8 strings without altering their original contents.
///
/// Whitespace ignoring removes Unicode whitespace from line contents; case
/// ignoring uses Unicode lowercase mapping, not full Unicode case folding.
/// Final-newline state remains significant even when EOL style is ignored.
pub fn compare(
  left: &str,
  right: &str,
  options: CompareOptions,
) -> Result<Vec<DiffSpan>, CompareError> {
  compare_with_rules(
    left,
    right,
    options,
    &[],
    WorkControl::new(&AtomicBool::new(false), Duration::from_secs(2)),
  )
}

pub fn compare_with_rules(
  left: &str,
  right: &str,
  options: CompareOptions,
  rules: &[UnimportantRule],
  control: WorkControl<'_>,
) -> Result<Vec<DiffSpan>, CompareError> {
  control.check()?;
  if rules.len() > 16 {
    return Err(CompareError::InvalidRule(
      "At most 16 rules are supported.".into(),
    ));
  }
  if left.len() > MAX_BYTES_PER_INPUT || right.len() > MAX_BYTES_PER_INPUT {
    return Err(CompareError::InputTooLarge);
  }
  let keys = |text: &str| -> Result<Vec<(String, &'static str)>, CompareError> {
    let mut result = Vec::new();
    for line in lines(text) {
      control.check()?;
      if result.len() == MAX_LINES_PER_INPUT {
        return Err(CompareError::TooManyLines);
      }
      let mut content = line.content.to_owned();
      for rule in rules {
        content = rule.0.replace_all(&content, "").into_owned();
      }
      if options.ignore_whitespace {
        content.retain(|c| !c.is_whitespace());
      }
      if options.ignore_case {
        content = content.to_lowercase();
      }
      let ending = if options.ignore_line_endings && !line.ending.as_str().is_empty() {
        "\n"
      } else {
        line.ending.as_str()
      };
      result.push((content, ending));
    }
    Ok(result)
  };
  let left_keys = keys(left)?;
  let right_keys = keys(right)?;
  let operations = capture_diff_slices_deadline(
    Algorithm::Histogram,
    &left_keys,
    &right_keys,
    Some(control.deadline),
  );
  // The library can return a coarser diff on expiry; do not report it as success.
  control.check()?;
  Ok(
    operations
      .into_iter()
      .map(|op| {
        let (tag, left, right) = op.as_tag_tuple();
        DiffSpan {
          kind: match tag {
            DiffTag::Equal => DiffKind::Equal,
            DiffTag::Delete => DiffKind::Delete,
            DiffTag::Insert => DiffKind::Insert,
            DiffTag::Replace => DiffKind::Replace,
          },
          left,
          right,
        }
      })
      .collect(),
  )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedSpan {
  pub span: DiffSpan,
  pub minor: bool,
}

pub fn compare_classified(
  left: &str,
  right: &str,
  options: CompareOptions,
  rules: &[UnimportantRule],
  control: WorkControl<'_>,
) -> Result<Vec<ClassifiedSpan>, CompareError> {
  let spans = compare_with_rules(left, right, CompareOptions::default(), &[], control)?;
  let offsets = |text: &str| {
    let mut offsets: Vec<_> = lines(text).map(|line| line.byte_offset).collect();
    offsets.push(text.len());
    offsets
  };
  let left_offsets = offsets(left);
  let right_offsets = offsets(right);
  spans
    .into_iter()
    .map(|span| {
      control.check()?;
      let minor = span.kind != DiffKind::Equal
        && compare_with_rules(
          &left[left_offsets[span.left.start]..left_offsets[span.left.end]],
          &right[right_offsets[span.right.start]..right_offsets[span.right.end]],
          options,
          rules,
          control,
        )?
        .iter()
        .all(|item| item.kind == DiffKind::Equal);
      Ok(ClassifiedSpan { span, minor })
    })
    .collect()
}

/// Original UTF-8 byte ranges for character-level refinement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntralineSpan {
  pub kind: DiffKind,
  pub left: Range<usize>,
  pub right: Range<usize>,
}

pub fn intraline(
  left: &str,
  right: &str,
  control: WorkControl<'_>,
) -> Result<Vec<IntralineSpan>, CompareError> {
  control.check()?;
  if left.len() > 65536 || right.len() > 65536 {
    return Err(CompareError::IntralineTooLarge);
  }
  let characters = |text: &str| {
    let chars: Vec<_> = text.chars().collect();
    let mut offsets: Vec<_> = text.char_indices().map(|(offset, _)| offset).collect();
    offsets.push(text.len());
    (chars, offsets)
  };
  let (left_chars, left_offsets) = characters(left);
  let (right_chars, right_offsets) = characters(right);
  if left_chars.len() > 8192 || right_chars.len() > 8192 {
    return Err(CompareError::IntralineTooLarge);
  }
  let operations = capture_diff_slices_deadline(
    Algorithm::Myers,
    &left_chars,
    &right_chars,
    Some(control.deadline),
  );
  control.check()?;
  Ok(
    operations
      .into_iter()
      .map(|op| {
        let (kind, left, right) = op.as_tag_tuple();
        IntralineSpan {
          kind: match kind {
            DiffTag::Equal => DiffKind::Equal,
            DiffTag::Delete => DiffKind::Delete,
            DiffTag::Insert => DiffKind::Insert,
            DiffTag::Replace => DiffKind::Replace,
          },
          left: left_offsets[left.start]..left_offsets[left.end],
          right: right_offsets[right.start]..right_offsets[right.end],
        }
      })
      .collect(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn classified_differences_keep_original_coordinates_and_minor_text() {
    let flag = AtomicBool::new(false);
    let result = compare_classified(
      "Keep\nCASE\nend\n",
      "Keep\ncase\nend\n",
      CompareOptions {
        ignore_case: true,
        ..CompareOptions::default()
      },
      &[],
      WorkControl::new(&flag, Duration::from_secs(2)),
    )
    .unwrap();
    assert!(result
      .iter()
      .any(|item| item.minor && item.span.left == (1..2)));
    assert!(result
      .iter()
      .filter(|item| item.span.kind == DiffKind::Equal)
      .all(|item| !item.minor));
    flag.store(true, Ordering::Relaxed);
    assert_eq!(
      compare_classified(
        "a",
        "b",
        CompareOptions::default(),
        &[],
        WorkControl::new(&flag, Duration::from_secs(2))
      ),
      Err(CompareError::Cancelled)
    );
  }

  fn reconstruct(left: &str, right: &str) {
    let left_lines: Vec<_> = lines(left).collect();
    let right_lines: Vec<_> = lines(right).collect();
    let mut output = String::new();
    let mut left_end = 0;
    let mut right_end = 0;
    for span in compare(left, right, CompareOptions::default()).unwrap() {
      assert_eq!(span.left.start, left_end);
      assert_eq!(span.right.start, right_end);
      let source = if span.kind == DiffKind::Equal {
        &left_lines[span.left.clone()]
      } else {
        &right_lines[span.right.clone()]
      };
      for line in source {
        output.push_str(line.content);
        output.push_str(line.ending.as_str());
      }
      left_end = span.left.end;
      right_end = span.right.end;
    }
    assert_eq!(left_end, left_lines.len());
    assert_eq!(right_end, right_lines.len());
    assert_eq!(output, right);
  }

  #[test]
  fn edits_reconstruct_exact_target() {
    let inputs = [
      "", "a", "a\n", "a\r\n", "b\rc", "\n\n", "a\nb\n", "b\na\n", "a\na\n", "\u{e9}\n",
    ];
    for left in inputs {
      for right in inputs {
        reconstruct(left, right);
      }
    }
  }

  #[test]
  fn ignore_options_do_not_hide_missing_final_newline() {
    let options = CompareOptions {
      ignore_case: true,
      ignore_whitespace: true,
      ignore_line_endings: true,
    };
    assert_eq!(
      compare(" A\t\r\n", "a\n", options).unwrap()[0].kind,
      DiffKind::Equal
    );
    assert_eq!(
      compare("a\n", "a", options).unwrap()[0].kind,
      DiffKind::Replace
    );
  }

  #[test]
  fn rejects_inputs_above_prototype_limits() {
    assert_eq!(
      compare(
        &"x".repeat(MAX_BYTES_PER_INPUT + 1),
        "",
        CompareOptions::default()
      ),
      Err(CompareError::InputTooLarge)
    );
    assert_eq!(
      compare(
        &"\n".repeat(MAX_LINES_PER_INPUT + 1),
        "",
        CompareOptions::default()
      ),
      Err(CompareError::TooManyLines)
    );
  }

  #[test]
  fn reports_line_ranges_for_insertions() {
    let spans = compare("a\nc\n", "a\nb\nc\n", CompareOptions::default()).unwrap();
    assert_eq!(
      spans[1],
      DiffSpan {
        kind: DiffKind::Insert,
        left: 1..1,
        right: 1..2
      }
    );
  }

  #[test]
  fn regex_rules_are_bounded() {
    let rules = [UnimportantRule::compile(r"\d+").unwrap()];
    let cancelled = AtomicBool::new(false);
    let result = compare_with_rules(
      "version 12\n",
      "version 34\n",
      CompareOptions::default(),
      &rules,
      WorkControl::new(&cancelled, Duration::from_secs(2)),
    )
    .unwrap();
    assert_eq!(result[0].kind, DiffKind::Equal);
    assert!(UnimportantRule::compile("[").is_err());
    assert!(UnimportantRule::compile(&"a".repeat(4097)).is_err());
  }

  #[test]
  fn cancellation_and_timeout_are_errors() {
    let cancelled = AtomicBool::new(true);
    assert_eq!(
      compare_with_rules(
        "a",
        "b",
        CompareOptions::default(),
        &[],
        WorkControl::new(&cancelled, Duration::from_secs(1))
      ),
      Err(CompareError::Cancelled)
    );
    let cancelled = AtomicBool::new(false);
    assert_eq!(
      compare_with_rules(
        "a",
        "b",
        CompareOptions::default(),
        &[],
        WorkControl::new(&cancelled, Duration::ZERO)
      ),
      Err(CompareError::TimedOut)
    );
  }

  #[test]
  fn intraline_ranges_reconstruct_unicode() {
    let left = "a\u{1f980}b";
    let right = "a\u{e9}b!";
    let cancelled = AtomicBool::new(false);
    let spans = intraline(
      left,
      right,
      WorkControl::new(&cancelled, Duration::from_secs(2)),
    )
    .unwrap();
    let mut output = String::new();
    for span in spans {
      output.push_str(if span.kind == DiffKind::Equal {
        &left[span.left]
      } else {
        &right[span.right]
      });
    }
    assert_eq!(output, right);
  }
}
