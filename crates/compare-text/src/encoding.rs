use encoding_rs::{Encoding, REPLACEMENT, UTF_16BE, UTF_16LE, UTF_8};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
  Utf8,
  Utf16Le,
  Utf16Be,
  Legacy(&'static Encoding),
}

impl TextEncoding {
  pub fn for_label(label: &str) -> Result<Self, TextError> {
    match Encoding::for_label(label.as_bytes()) {
      Some(encoding) if encoding == UTF_8 => Ok(Self::Utf8),
      Some(encoding) if encoding == UTF_16LE => Ok(Self::Utf16Le),
      Some(encoding) if encoding == UTF_16BE => Ok(Self::Utf16Be),
      Some(encoding) if encoding != REPLACEMENT => Ok(Self::Legacy(encoding)),
      _ => Err(TextError::UnsupportedEncoding),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextError {
  UnsupportedEncoding,
  ConflictingEncoding,
  InvalidBytes,
  UnrepresentableEdit,
  NonRoundTripEncoding,
  InputTooLarge,
}

impl fmt::Display for TextError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(match self {
      Self::UnsupportedEncoding => "Unknown or unsupported encoding.",
      Self::ConflictingEncoding => "Selected encoding conflicts with the byte-order mark.",
      Self::InvalidBytes => {
        "Invalid text bytes. Select the correct encoding; no replacement was made."
      }
      Self::UnrepresentableEdit => "The edit cannot be represented in the original encoding.",
      Self::NonRoundTripEncoding => {
        "This byte sequence cannot round-trip safely in the selected encoding."
      }
      Self::InputTooLarge => "Text exceeds the 1 MiB prototype limit.",
    })
  }
}

impl std::error::Error for TextError {}

#[derive(Debug)]
pub struct DecodedText {
  text: String,
  encoding: TextEncoding,
  bom: bool,
}

impl DecodedText {
  pub fn text(&self) -> &str {
    &self.text
  }
  pub fn encoding(&self) -> TextEncoding {
    self.encoding
  }
  pub fn has_bom(&self) -> bool {
    self.bom
  }

  /// Strictly encode an edit; never substitute entities or replacement bytes.
  pub fn encode(&self, text: &str) -> Result<Vec<u8>, TextError> {
    if text.len() > 1024 * 1024 {
      return Err(TextError::InputTooLarge);
    }
    let mut bytes = Vec::new();
    match self.encoding {
      TextEncoding::Utf8 => {
        if self.bom {
          bytes.extend_from_slice(b"\xef\xbb\xbf");
        }
        bytes.extend_from_slice(text.as_bytes());
      }
      TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
        let little = self.encoding == TextEncoding::Utf16Le;
        if self.bom {
          bytes.extend_from_slice(if little { b"\xff\xfe" } else { b"\xfe\xff" });
        }
        for unit in text.encode_utf16() {
          bytes.extend_from_slice(&if little {
            unit.to_le_bytes()
          } else {
            unit.to_be_bytes()
          });
        }
      }
      TextEncoding::Legacy(encoding) => {
        if encoding.output_encoding() != encoding {
          return Err(TextError::UnsupportedEncoding);
        }
        let (encoded, _, had_errors) = encoding.encode(text);
        if had_errors {
          return Err(TextError::UnrepresentableEdit);
        }
        bytes.extend_from_slice(&encoded);
      }
    }
    if bytes.len() > 1024 * 1024 {
      return Err(TextError::InputTooLarge);
    }
    Ok(bytes)
  }
}

/// Detect Unicode BOMs; absent a BOM, default to strict UTF-8.
///
/// Legacy encodings must be selected explicitly rather than silently guessed.
pub fn decode(bytes: &[u8], selected: Option<TextEncoding>) -> Result<DecodedText, TextError> {
  if bytes.len() > 1024 * 1024 {
    return Err(TextError::InputTooLarge);
  }
  if selected.is_none()
    && (bytes.starts_with(b"\xff\xfe\0\0") || bytes.starts_with(b"\0\0\xfe\xff"))
  {
    return Err(TextError::UnsupportedEncoding);
  }
  let detected = if bytes.starts_with(b"\xef\xbb\xbf") {
    Some((TextEncoding::Utf8, 3))
  } else if bytes.starts_with(b"\xff\xfe") {
    Some((TextEncoding::Utf16Le, 2))
  } else if bytes.starts_with(b"\xfe\xff") {
    Some((TextEncoding::Utf16Be, 2))
  } else {
    None
  };
  let (encoding, bom, payload) = if let Some((encoding, length)) = detected {
    if selected.is_some_and(|value| value != encoding) {
      return Err(TextError::ConflictingEncoding);
    }
    (encoding, true, &bytes[length..])
  } else {
    (selected.unwrap_or(TextEncoding::Utf8), false, bytes)
  };
  let text = match encoding {
    TextEncoding::Utf8 => std::str::from_utf8(payload)
      .map_err(|_| TextError::InvalidBytes)?
      .to_owned(),
    TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
      if payload.len() % 2 != 0 {
        return Err(TextError::InvalidBytes);
      }
      let units: Vec<_> = payload
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
          if encoding == TextEncoding::Utf16Le {
            u16::from_le_bytes([pair[0], pair[1]])
          } else {
            u16::from_be_bytes([pair[0], pair[1]])
          }
        })
        .collect();
      String::from_utf16(&units).map_err(|_| TextError::InvalidBytes)?
    }
    TextEncoding::Legacy(encoding) => encoding
      .decode_without_bom_handling_and_without_replacement(payload)
      .ok_or(TextError::InvalidBytes)?
      .into_owned(),
  };
  let decoded = DecodedText {
    text,
    encoding,
    bom,
  };
  if decoded.encode(&decoded.text)? != bytes {
    return Err(TextError::NonRoundTripEncoding);
  }
  Ok(decoded)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn unicode_boms_and_mixed_eols_round_trip() {
    let text = "a\r\n\u{1f980}\rb\n";
    for encoding in [
      TextEncoding::Utf8,
      TextEncoding::Utf16Le,
      TextEncoding::Utf16Be,
    ] {
      for bom in [false, true] {
        let document = DecodedText {
          text: text.to_owned(),
          encoding,
          bom,
        };
        let bytes = document.encode(text).unwrap();
        let decoded = decode(&bytes, Some(encoding)).unwrap();
        assert_eq!(decoded.text(), text);
        assert_eq!(decoded.has_bom(), bom);
        assert_eq!(decoded.encode(decoded.text()).unwrap(), bytes);
      }
    }
  }

  #[test]
  fn invalid_input_is_not_replaced() {
    assert_eq!(decode(&[0xff], None).unwrap_err(), TextError::InvalidBytes);
    assert_eq!(
      decode(&[0xff, 0xfe, 0], None).unwrap_err(),
      TextError::InvalidBytes
    );
    assert_eq!(
      decode(&[0xff, 0xfe, 0, 0xd8], None).unwrap_err(),
      TextError::InvalidBytes
    );
    assert_eq!(
      decode(b"\xef\xbb\xbftext", Some(TextEncoding::Utf16Le)).unwrap_err(),
      TextError::ConflictingEncoding
    );
    assert_eq!(
      decode(b"\xff\xfe\0\0a\0\0\0", None).unwrap_err(),
      TextError::UnsupportedEncoding
    );
  }

  #[test]
  fn explicit_legacy_encoding_rejects_unrepresentable_edits() {
    let encoding = TextEncoding::for_label("windows-1252").unwrap();
    let document = decode(b"caf\xe9\r\n", Some(encoding)).unwrap();
    assert_eq!(document.text(), "caf\u{e9}\r\n");
    assert_eq!(document.encode(document.text()).unwrap(), b"caf\xe9\r\n");
    assert_eq!(
      document.encode("\u{1f980}").unwrap_err(),
      TextError::UnrepresentableEdit
    );
    assert!(TextEncoding::for_label("not-an-encoding").is_err());
  }

  #[test]
  fn explicit_utf16_preserves_leading_null() {
    let bytes = b"\xff\xfe\0\0a\0";
    let document = decode(bytes, Some(TextEncoding::Utf16Le)).unwrap();
    assert_eq!(document.text(), "\0a");
    assert_eq!(document.encode(document.text()).unwrap(), bytes);
  }
}
