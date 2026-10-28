//! Lossless UTF-8 line boundaries for future comparison and editing.
//!
//! Offsets are zero-based UTF-8 byte offsets, not character or display columns.
//! Line iteration performs no file IO or decoding. Comparison uses normalized
//! keys without modifying the original inputs.

mod comparison;
mod encoding;
mod search;
pub use comparison::{
  compare, compare_classified, compare_classified_with_anchors, compare_with_anchors,
  compare_with_rules, intraline, AlignmentAnchor, ClassifiedSpan, CompareError, CompareOptions,
  DiffKind, DiffSpan, IntralineSpan, MoveDirection, MovedBlock, UnimportantRule, WorkControl,
};
pub use encoding::{decode, DecodedText, TextEncoding, TextError};
pub use search::{find_matches, SearchMatch, SearchOptions};

/// The exact terminator of a logical line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
  Lf,
  CrLf,
  Cr,
  None,
}

impl LineEnding {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Lf => "\n",
      Self::CrLf => "\r\n",
      Self::Cr => "\r",
      Self::None => "",
    }
  }
}

/// A borrowed line without its terminator, retaining the original byte offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line<'a> {
  pub content: &'a str,
  pub ending: LineEnding,
  pub byte_offset: usize,
}

/// Iterate over lines without copying contents or collecting the entire file.
///
/// Empty input has no lines. A trailing terminator belongs to its preceding
/// line and does not create an extra phantom line. LF, CRLF, and lone CR are
/// recognized independently, including in mixed-ending input.
pub fn lines(text: &str) -> Lines<'_> {
  Lines {
    text,
    next_offset: 0,
  }
}

#[derive(Debug, Clone)]
pub struct Lines<'a> {
  text: &'a str,
  next_offset: usize,
}

impl<'a> Iterator for Lines<'a> {
  type Item = Line<'a>;

  fn next(&mut self) -> Option<Self::Item> {
    let start = self.next_offset;
    if start == self.text.len() {
      return None;
    }

    let bytes = self.text.as_bytes();
    let mut end = start;
    while end < bytes.len() && bytes[end] != b'\r' && bytes[end] != b'\n' {
      end += 1;
    }

    let ending = match bytes.get(end) {
      Some(b'\r') if bytes.get(end + 1) == Some(&b'\n') => LineEnding::CrLf,
      Some(b'\r') => LineEnding::Cr,
      Some(b'\n') => LineEnding::Lf,
      _ => LineEnding::None,
    };
    self.next_offset = end + ending.as_str().len();

    // ASCII terminators cannot occur inside a UTF-8 multibyte sequence.
    Some(Line {
      content: &self.text[start..end],
      ending,
      byte_offset: start,
    })
  }
}

impl std::iter::FusedIterator for Lines<'_> {}

#[cfg(test)]
mod tests {
  use super::*;

  fn assert_lossless(text: &str) {
    let mut reconstructed = String::new();
    for line in lines(text) {
      assert_eq!(line.byte_offset, reconstructed.len());
      reconstructed.push_str(line.content);
      reconstructed.push_str(line.ending.as_str());
    }
    assert_eq!(reconstructed, text);
  }

  #[test]
  fn empty_input_has_no_lines() {
    assert_eq!(lines("").count(), 0);
  }

  #[test]
  fn unterminated_line_is_preserved() {
    assert_eq!(
      lines("hello").collect::<Vec<_>>(),
      vec![Line {
        content: "hello",
        ending: LineEnding::None,
        byte_offset: 0,
      }]
    );
  }

  #[test]
  fn trailing_terminator_does_not_create_a_phantom_line() {
    for ending in ["\n", "\r\n", "\r"] {
      let text = format!("hello{ending}");
      assert_eq!(lines(&text).count(), 1);
      assert_lossless(&text);
    }
  }

  #[test]
  fn mixed_endings_and_offsets_are_preserved() {
    assert_eq!(
      lines("a\r\nb\rc\nd").collect::<Vec<_>>(),
      vec![
        Line {
          content: "a",
          ending: LineEnding::CrLf,
          byte_offset: 0,
        },
        Line {
          content: "b",
          ending: LineEnding::Cr,
          byte_offset: 3,
        },
        Line {
          content: "c",
          ending: LineEnding::Lf,
          byte_offset: 5,
        },
        Line {
          content: "d",
          ending: LineEnding::None,
          byte_offset: 7,
        },
      ]
    );
  }

  #[test]
  fn blank_lines_are_not_discarded() {
    let result = lines("\r\n\n\r").collect::<Vec<_>>();
    assert_eq!(result.len(), 3);
    assert!(result.iter().all(|line| line.content.is_empty()));
    assert_eq!(result[0].ending, LineEnding::CrLf);
    assert_eq!(result[1].ending, LineEnding::Lf);
    assert_eq!(result[2].ending, LineEnding::Cr);
    assert_lossless("\r\n\n\r");
  }

  #[test]
  fn unicode_offsets_use_bytes_not_characters() {
    let text = "\u{e9}\r\n\u{1f980}\n\u{65e5}";
    let result = lines(text).collect::<Vec<_>>();
    assert_eq!(result[1].byte_offset, 4);
    assert_eq!(result[2].byte_offset, 9);
    assert_lossless(text);
  }

  #[test]
  fn bom_null_and_unicode_separators_remain_content() {
    let text = "\u{feff}a\0b\u{2028}c\u{2029}d";
    assert_eq!(lines(text).count(), 1);
    assert_eq!(lines(text).next().unwrap().content, text);
    assert_lossless(text);
  }

  #[test]
  fn consecutive_cr_and_crlf_are_distinct_lines() {
    let result = lines("\r\r\n").collect::<Vec<_>>();
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].ending, LineEnding::Cr);
    assert_eq!(result[1].ending, LineEnding::CrLf);
    assert_lossless("\r\r\n");
  }

  #[test]
  fn completed_iterator_stays_completed() {
    let mut iterator = lines("x\n");
    assert!(iterator.next().is_some());
    assert_eq!(iterator.next(), None);
    assert_eq!(iterator.next(), None);
  }

  #[test]
  fn short_combinations_reconstruct_exactly() {
    let alphabet = ["a", "\r", "\n", "\u{e9}", "\u{1f980}", "\0"];
    for length in 0..=5 {
      for mut index in 0..alphabet.len().pow(length) {
        let mut text = String::new();
        for _ in 0..length {
          text.push_str(alphabet[index % alphabet.len()]);
          index /= alphabet.len();
        }
        assert_lossless(&text);
      }
    }
  }
}
