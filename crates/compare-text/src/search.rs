use regex::RegexBuilder;

const MAX_PATTERN_LENGTH: usize = 4096;
const MAX_REGEX_SIZE: usize = 1024 * 1024;
const MAX_RESULTS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchMatch {
  pub start: usize,
  pub end: usize,
  pub source_start: usize,
  pub source_end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchOptions {
  pub match_case: bool,
  pub whole_word: bool,
  pub regex: bool,
}

pub fn find_matches(
  text: &str,
  query: &str,
  options: SearchOptions,
) -> Result<Vec<SearchMatch>, String> {
  if query.is_empty() {
    return Err("Enter text to find.".into());
  }
  if query.len() > MAX_PATTERN_LENGTH {
    return Err(format!(
      "Search patterns cannot exceed {MAX_PATTERN_LENGTH} bytes."
    ));
  }

  let pattern = if options.regex {
    query.to_owned()
  } else {
    regex::escape(query)
  };
  let pattern = if options.whole_word {
    format!(r"\b(?:{pattern})\b")
  } else {
    pattern
  };
  let regex = RegexBuilder::new(&pattern)
    .case_insensitive(!options.match_case)
    .size_limit(MAX_REGEX_SIZE)
    .dfa_size_limit(MAX_REGEX_SIZE)
    .build()
    .map_err(|error| format!("Invalid search pattern: {error}"))?;

  let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
  let mut matches = Vec::new();
  let mut source_byte = 0;
  let mut editor_byte = 0;
  let mut editor_utf16 = 0;
  let mut source_utf16 = 0;
  for found in regex.find_iter(&normalized).take(MAX_RESULTS + 1) {
    if found.start() == found.end() {
      return Err("Search patterns must not match empty text.".into());
    }
    if matches.len() == MAX_RESULTS {
      return Err(format!(
        "Search result limit of {MAX_RESULTS} matches exceeded."
      ));
    }
    advance_source_position(
      text,
      found.start(),
      &mut source_byte,
      &mut editor_byte,
      &mut editor_utf16,
      &mut source_utf16,
    )?;
    let start = editor_utf16;
    let source_start = source_utf16;
    advance_source_position(
      text,
      found.end(),
      &mut source_byte,
      &mut editor_byte,
      &mut editor_utf16,
      &mut source_utf16,
    )?;
    matches.push(SearchMatch {
      start,
      end: editor_utf16,
      source_start,
      source_end: source_utf16,
    });
  }
  Ok(matches)
}

fn advance_source_position(
  source: &str,
  editor_target: usize,
  source_byte: &mut usize,
  editor_byte: &mut usize,
  editor_utf16: &mut usize,
  source_utf16: &mut usize,
) -> Result<(), String> {
  while *editor_byte < editor_target {
    let remaining = source
      .get(*source_byte..)
      .ok_or("Invalid normalized search position.")?;
    if remaining.starts_with("\r\n") {
      *source_byte += 2;
      *editor_byte += 1;
      *editor_utf16 += 1;
      *source_utf16 += 2;
      continue;
    }
    let character = remaining
      .chars()
      .next()
      .ok_or("Invalid normalized search position.")?;
    *source_byte += character.len_utf8();
    *editor_byte += character.len_utf8();
    *editor_utf16 += character.len_utf16();
    *source_utf16 += character.len_utf16();
  }
  if *editor_byte != editor_target {
    return Err("Search position split a Unicode character.".into());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{find_matches, SearchMatch, SearchOptions};

  const DEFAULTS: SearchOptions = SearchOptions {
    match_case: true,
    whole_word: false,
    regex: false,
  };

  #[test]
  fn finds_literal_matches_with_utf16_offsets() {
    assert_eq!(
      find_matches("a 🦀 x", "x", DEFAULTS).unwrap(),
      [SearchMatch {
        start: 5,
        end: 6,
        source_start: 5,
        source_end: 6,
      }]
    );
  }

  #[test]
  fn maps_normalized_editor_offsets_back_to_original_line_endings() {
    assert_eq!(
      find_matches("a\r\n🦀 x", "x", DEFAULTS).unwrap(),
      [SearchMatch {
        start: 5,
        end: 6,
        source_start: 6,
        source_end: 7,
      }]
    );
  }

  #[test]
  fn applies_case_and_whole_word_options() {
    assert_eq!(
      find_matches(
        "Foo food foo",
        "foo",
        SearchOptions {
          match_case: false,
          whole_word: true,
          ..DEFAULTS
        }
      )
      .unwrap()
      .len(),
      2
    );
  }

  #[test]
  fn compiles_bounded_regex_and_reports_invalid_patterns() {
    assert_eq!(
      find_matches(
        "cat1 cat2",
        r"cat\d",
        SearchOptions {
          regex: true,
          ..DEFAULTS
        }
      )
      .unwrap()
      .len(),
      2
    );
    assert!(find_matches(
      "text",
      "(",
      SearchOptions {
        regex: true,
        ..DEFAULTS
      }
    )
    .unwrap_err()
    .starts_with("Invalid search pattern:"));
  }

  #[test]
  fn rejects_empty_queries_matches_and_excessive_results() {
    assert!(find_matches("text", "", DEFAULTS).is_err());
    assert!(find_matches(
      "",
      r"^",
      SearchOptions {
        regex: true,
        ..DEFAULTS
      }
    )
    .is_err());
    assert!(find_matches(&"x".repeat(10_001), "x", DEFAULTS).is_err());
  }
}
