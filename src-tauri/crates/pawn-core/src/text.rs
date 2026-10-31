//! Strict disk codecs. Never substitute replacement characters or HTML entities
//! when an encoding cannot represent an edit. LSP/editor text remains Unicode.
use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use std::{fmt, io};

#[derive(Debug)]
pub struct TextError(pub &'static str);

impl fmt::Display for TextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for TextError {}

fn invalid(code: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, TextError(code))
}

pub struct Decoded {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub guessed: bool,
}

fn codec(label: &str) -> io::Result<&'static Encoding> {
    Encoding::for_label(label.as_bytes())
        .filter(|encoding| !matches!(encoding.name(), "replacement" | "x-user-defined"))
        .ok_or_else(|| invalid("encodingUnknown"))
}

fn signature(bytes: &[u8]) -> Option<(&'static str, usize)> {
    for (marker, name) in [
        (&[0xff, 0xfe, 0, 0][..], "utf-32le"),
        (&[0, 0, 0xfe, 0xff][..], "utf-32be"),
        (&[0xef, 0xbb, 0xbf][..], "utf-8"),
        (&[0xff, 0xfe][..], "utf-16le"),
        (&[0xfe, 0xff][..], "utf-16be"),
    ] {
        if bytes.starts_with(marker) {
            return Some((name, marker.len()));
        }
    }
    None
}

fn guess(bytes: &[u8]) -> &'static str {
    // A small prefix keeps detection bounded even for large files. Recognize
    // unmarked UTF-16 only with enough alternating NULs to avoid binary guesses.
    let sample = &bytes[..bytes.len().min(64 * 1024)];
    if sample.len() >= 8 && sample.len().is_multiple_of(2) {
        let pairs = sample.len() / 2;
        let low = sample.chunks_exact(2).filter(|pair| pair[0] == 0).count();
        let high = sample.chunks_exact(2).filter(|pair| pair[1] == 0).count();
        if high * 4 >= pairs * 3 && low * 4 < pairs {
            return UTF_16LE.name();
        }
        if low * 4 >= pairs * 3 && high * 4 < pairs {
            return UTF_16BE.name();
        }
    }
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(sample, sample.len() == bytes.len());
    detector.guess(None, Utf8Detection::Deny).name()
}

pub fn decode(bytes: &[u8], requested: Option<&str>) -> io::Result<Decoded> {
    let marker = signature(bytes);
    let label = requested.or_else(|| marker.map(|(label, _)| label));
    let guessed = label.is_none()
        && (bytes.contains(&0) || bytes.contains(&0x1b) || std::str::from_utf8(bytes).is_err());
    let label = label.unwrap_or_else(|| if guessed { guess(bytes) } else { "utf-8" });
    let label = label.to_ascii_lowercase();
    let special = matches!(
        label.as_str(),
        "utf-32le" | "utf-32be" | "iso-8859-1" | "ascii"
    );
    let encoding = if special { None } else { Some(codec(&label)?) };
    let name = encoding.map_or(label.as_str(), |encoding| encoding.name());
    // An explicit choice wins over a different BOM; only strip a matching BOM.
    let bom_bytes = marker
        .filter(|(marker, _)| marker.eq_ignore_ascii_case(name))
        .map_or(0, |(_, count)| count);
    let bytes = &bytes[bom_bytes..];
    let text = if label.starts_with("utf-32") {
        if !bytes.len().is_multiple_of(4) {
            return Err(invalid("encodingInvalid"));
        }
        bytes
            .chunks_exact(4)
            .map(|chunk| {
                let value = if label == "utf-32le" {
                    u32::from_le_bytes(chunk.try_into().unwrap())
                } else {
                    u32::from_be_bytes(chunk.try_into().unwrap())
                };
                char::from_u32(value).ok_or_else(|| invalid("encodingInvalid"))
            })
            .collect::<io::Result<String>>()?
    } else if label == "iso-8859-1" || label == "ascii" {
        if label == "ascii" && !bytes.is_ascii() {
            return Err(invalid("encodingInvalid"));
        }
        bytes.iter().map(|byte| char::from(*byte)).collect()
    } else {
        encoding
            .unwrap()
            .decode_without_bom_handling_and_without_replacement(bytes)
            .ok_or_else(|| invalid("encodingInvalid"))?
            .into_owned()
    };
    if text.contains('\0') {
        return Err(invalid("binaryFile"));
    }
    Ok(Decoded {
        text,
        encoding: name.to_ascii_lowercase(),
        bom: bom_bytes > 0,
        guessed,
    })
}

pub fn encode(text: &str, label: &str, bom: bool) -> io::Result<Vec<u8>> {
    if text.contains('\0') {
        return Err(invalid("binaryFile"));
    }
    let label = label.to_ascii_lowercase();
    let mut bytes = Vec::new();
    if label == "utf-32le" || label == "utf-32be" {
        if bom {
            bytes.extend(if label == "utf-32le" {
                [0xff, 0xfe, 0, 0]
            } else {
                [0, 0, 0xfe, 0xff]
            });
        }
        for character in text.chars() {
            let value = u32::from(character);
            bytes.extend(if label == "utf-32le" {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            });
        }
    } else if label == "iso-8859-1" || label == "ascii" {
        let maximum = if label == "ascii" { 127 } else { 255 };
        for character in text.chars() {
            if u32::from(character) > maximum {
                return Err(invalid("encodingLossy"));
            }
            bytes.push(character as u8);
        }
    } else {
        let encoding = codec(&label)?;
        if encoding == UTF_16LE || encoding == UTF_16BE {
            if bom {
                bytes.extend(if encoding == UTF_16LE {
                    [0xff, 0xfe]
                } else {
                    [0xfe, 0xff]
                });
            }
            for unit in text.encode_utf16() {
                bytes.extend(if encoding == UTF_16LE {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
        } else {
            let (encoded, _, errors) = encoding.encode(text);
            if errors {
                return Err(invalid("encodingLossy"));
            }
            if bom && encoding == UTF_8 {
                bytes.extend([0xef, 0xbb, 0xbf]);
            }
            bytes.extend_from_slice(&encoded);
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_legacy_roundtrip_without_loss() {
        for (encoding, source) in [
            ("utf-8", "سلام λ😀\r\n"),
            ("utf-16le", "سلام λ😀\r\n"),
            ("utf-16be", "سلام λ😀\r\n"),
            ("utf-32le", "سلام λ😀\r\n"),
            ("utf-32be", "سلام λ😀\r\n"),
            ("windows-1256", "سلام دنيا\r\n"),
            ("windows-1251", "Привет мир\r\n"),
            ("windows-1252", "café €\r\n"),
            ("shift_jis", "日本語\r\n"),
            ("gb18030", "中文\r\n"),
            ("iso-8859-1", "café\r\n"),
        ] {
            for bom in [false, true] {
                let bytes = encode(source, encoding, bom)
                    .unwrap_or_else(|error| panic!("{encoding}: {error}"));
                let decoded = decode(&bytes, Some(encoding)).unwrap();
                assert_eq!(decoded.text, source, "{encoding}");
                assert_eq!(encode(&decoded.text, encoding, decoded.bom).unwrap(), bytes);
            }
        }
    }

    #[test]
    fn detects_boms_and_rejects_invalid_and_unrepresentable_text() {
        for encoding in ["utf-8", "utf-16le", "utf-16be", "utf-32le", "utf-32be"] {
            let bytes = encode("main() {}\r\n// λ😀", encoding, true).unwrap();
            let detected = decode(&bytes, None).unwrap();
            assert_eq!(detected.encoding, encoding);
            assert!(detected.bom);
            assert!(!detected.guessed);
        }
        assert!(encode("😀", "windows-1252", false).is_err());
        assert!(encode("é", "ascii", false).is_err());
        assert!(decode(&[0xff, 0xfe, 1], None).is_err());
        assert!(decode(&[0, 65], None).is_err());
        assert!(decode(&[0xff], Some("utf-8")).is_err());
        assert!(decode(&[0, 0x11, 0, 0], Some("utf-32be")).is_err());
        assert!(decode(b"text", Some("unknown-charset")).is_err());
        assert_eq!(decode(b"text", None).unwrap().encoding, "utf-8");
        let unmarked = encode("main() {}\r\n", "utf-16le", false).unwrap();
        let detected = decode(&unmarked, None).unwrap();
        assert_eq!(detected.encoding, "utf-16le");
        assert!(!detected.bom);
    }
}
