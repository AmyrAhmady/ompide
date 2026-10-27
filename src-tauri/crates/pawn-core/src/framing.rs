//! Bounded LSP Content-Length frames. One read may contain part of a frame or many frames.
use std::io::{self, BufRead, Write};

pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8192;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut header = Vec::new();
    loop {
        let mut byte = [0];
        if reader.read(&mut byte)? == 0 {
            return if header.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "partial LSP header",
                ))
            };
        }
        header.push(byte[0]);
        if header.len() > MAX_HEADER_BYTES {
            return Err(invalid("LSP header too large"));
        }
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header = std::str::from_utf8(&header).map_err(|_| invalid("invalid LSP header"))?;
    let mut length = None;
    for line in header.trim_end().split("\r\n") {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid("invalid LSP header"))?;
        if name.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                return Err(invalid("duplicate LSP Content-Length"));
            }
            let count = value
                .trim()
                .parse::<usize>()
                .map_err(|_| invalid("invalid LSP length"))?;
            if count > MAX_MESSAGE_BYTES || count == 0 {
                return Err(invalid("LSP message length out of bounds"));
            }
            length = Some(count);
        }
    }
    let mut body = vec![0; length.ok_or_else(|| invalid("missing LSP Content-Length"))?];
    reader.read_exact(&mut body)?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|_| invalid("invalid LSP UTF-8"))
}

pub fn write_frame(writer: &mut impl Write, message: &str) -> io::Result<()> {
    if message.is_empty() || message.len() > MAX_MESSAGE_BYTES {
        return Err(invalid("LSP message length out of bounds"));
    }
    write!(writer, "Content-Length: {}\r\n\r\n", message.len())?;
    writer.write_all(message.as_bytes())?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn unicode_partial_reads_and_multiple_frames() {
        let messages = [
            r#"{"id":"a","text":"Pawn 🦀 فارسی\r\n"}"#,
            r#"{"id":2,"result":null}"#,
        ];
        let mut bytes = Vec::new();
        for message in messages {
            write_frame(&mut bytes, message).unwrap();
        }
        // A one-byte buffer forces partial header and UTF-8 body reads.
        let mut reader = BufReader::with_capacity(1, Cursor::new(bytes));
        for message in messages {
            assert_eq!(read_frame(&mut reader).unwrap().as_deref(), Some(message));
        }
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_truncation_duplicates_missing_and_unbounded_lengths() {
        for input in [
            "Content-Length: 10\r\n\r\n{}",
            "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            "Content-Type: x\r\n\r\n{}",
            "Content-Length: -1\r\n\r\n",
            "Content-Length: 16777217\r\n\r\n",
            "Content-Length: 0\r\n\r\n",
            "Content-",
        ] {
            assert!(read_frame(&mut Cursor::new(input)).is_err(), "{input:?}");
        }
        assert!(read_frame(&mut Cursor::new(vec![b'x'; MAX_HEADER_BYTES + 1])).is_err());
    }

    #[test]
    fn supports_large_messages_and_extra_headers() {
        let text = "🦀".repeat(300_000);
        let mut bytes = format!(
            "content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n",
            text.len()
        )
        .into_bytes();
        bytes.extend_from_slice(text.as_bytes());
        assert_eq!(read_frame(&mut Cursor::new(bytes)).unwrap(), Some(text));
    }
}
