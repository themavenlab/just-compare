use compare_text::{compare, lines, CompareError, CompareOptions, DiffKind};
use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeBlock {
  Resolved(String),
  Conflict {
    base: String,
    left: String,
    right: String,
  },
}

struct Edit {
  range: Range<usize>,
  replacement: String,
  side: bool,
}

fn slice(lines: &[compare_text::Line<'_>], range: Range<usize>) -> String {
  let mut result = String::new();
  for line in &lines[range] {
    result.push_str(line.content);
    result.push_str(line.ending.as_str());
  }
  result
}

fn apply(base: &[compare_text::Line<'_>], range: Range<usize>, edits: &[&Edit]) -> String {
  let mut result = String::new();
  let mut cursor = range.start;
  for edit in edits {
    result.push_str(&slice(base, cursor..edit.range.start));
    result.push_str(&edit.replacement);
    cursor = edit.range.end;
  }
  result.push_str(&slice(base, cursor..range.end));
  result
}

/// Conservative diff3: adjacent boundary insertions may conflict rather than
/// auto-resolve in an ambiguous order. No conflict markers are injected silently.
pub fn merge(base: &str, left: &str, right: &str) -> Result<Vec<MergeBlock>, CompareError> {
  let base_lines: Vec<_> = lines(base).collect();
  let mut edits = Vec::new();
  for (text, side) in [(left, false), (right, true)] {
    let text_lines: Vec<_> = lines(text).collect();
    for span in compare(base, text, CompareOptions::default())? {
      if span.kind != DiffKind::Equal {
        edits.push(Edit {
          range: span.left,
          replacement: slice(&text_lines, span.right),
          side,
        });
      }
    }
  }
  edits.sort_by_key(|edit| (edit.range.start, edit.range.end, edit.side));
  let mut result = Vec::new();
  let mut cursor = 0;
  let mut index = 0;
  while index < edits.len() {
    let start = edits[index].range.start;
    if cursor < start {
      result.push(MergeBlock::Resolved(slice(&base_lines, cursor..start)));
    }
    let first = index;
    let mut end = edits[index].range.end;
    index += 1;
    while index < edits.len() {
      let next = &edits[index];
      let overlaps = next.range.start < end
        || (next.range.start == end && (next.range.is_empty() || start == end));
      if !overlaps {
        break;
      }
      end = end.max(next.range.end);
      index += 1;
    }
    let group = &edits[first..index];
    let left_edits: Vec<_> = group.iter().filter(|e| !e.side).collect();
    let right_edits: Vec<_> = group.iter().filter(|e| e.side).collect();
    let original = slice(&base_lines, start..end);
    let l = apply(&base_lines, start..end, &left_edits);
    let r = apply(&base_lines, start..end, &right_edits);
    result.push(if l == r {
      MergeBlock::Resolved(l)
    } else if left_edits.is_empty() {
      MergeBlock::Resolved(r)
    } else if right_edits.is_empty() {
      MergeBlock::Resolved(l)
    } else {
      MergeBlock::Conflict {
        base: original,
        left: l,
        right: r,
      }
    });
    cursor = end;
  }
  if cursor < base_lines.len() {
    result.push(MergeBlock::Resolved(slice(
      &base_lines,
      cursor..base_lines.len(),
    )));
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;
  fn output(blocks: Vec<MergeBlock>) -> String {
    blocks
      .into_iter()
      .map(|block| match block {
        MergeBlock::Resolved(text) => text,
        MergeBlock::Conflict { .. } => panic!("unexpected conflict"),
      })
      .collect()
  }
  #[test]
  fn independent_edits_and_identical_edits_merge() {
    assert_eq!(
      output(merge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n").unwrap()),
      "A\nb\nC\n"
    );
    assert_eq!(output(merge("a\n", "b\n", "b\n").unwrap()), "b\n");
    assert_eq!(output(merge("", "new", "").unwrap()), "new");
    assert_eq!(output(merge("a\n", "", "a\n").unwrap()), "");
  }
  #[test]
  fn conflicting_edits_are_explicit() {
    assert!(matches!(
      &merge("a\n", "left\n", "right\n").unwrap()[0],
      MergeBlock::Conflict { .. }
    ));
    assert!(matches!(
      &merge("", "left", "right").unwrap()[0],
      MergeBlock::Conflict { .. }
    ));
  }
  #[test]
  fn single_sided_changes_reconstruct_target() {
    let inputs = ["", "a", "a\n", "a\r\n", "a\nb\n", "b\na\n", "a\na\n", "\n"];
    for base in inputs {
      for target in inputs {
        assert_eq!(output(merge(base, target, base).unwrap()), target);
        assert_eq!(output(merge(base, base, target).unwrap()), target);
      }
    }
  }
  #[test]
  fn adjacent_changes_and_boundary_conflicts_are_conservative() {
    assert_eq!(
      output(merge("a\nb\n", "A\nb\n", "a\nB\n").unwrap()),
      "A\nB\n"
    );
    assert!(merge("a\n", "x\na\n", "A\n")
      .unwrap()
      .iter()
      .any(|b| matches!(b, MergeBlock::Conflict { .. })));
    assert_eq!(
      output(merge("a\r\nb\r\n", "A\r\nb\r\n", "a\r\nB\r\n").unwrap()),
      "A\r\nB\r\n"
    );
  }
  #[test]
  fn identical_repeated_empty_and_deleted_inputs_reconstruct() {
    let inputs = ["", "\n", "a", "a\na\n", "a\r\nb\rc\n", "\0\n"];
    for base in inputs {
      for target in inputs {
        assert_eq!(output(merge(base, target, target).unwrap()), target);
      }
    }
  }
}
