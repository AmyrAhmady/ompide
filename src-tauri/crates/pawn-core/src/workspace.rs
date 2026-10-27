use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use url::Url;

pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct FileSnapshot {
    pub path: PathBuf,
    pub uri: String,
    pub text: String,
    pub bom: bool,
    pub revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub directory: bool,
    pub symlink: bool,
}

pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

pub fn file_uri(path: &Path) -> io::Result<String> {
    Url::from_file_path(path)
        .map(|uri| uri.to_string())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid absolute file path"))
}

pub fn read_document(path: &Path) -> io::Result<FileSnapshot> {
    let path = canonical(path)?;
    let file = fs::File::open(&path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "file exceeds 8 MiB",
        ));
    }
    if bytes.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "binary or UTF-16 file; convert to UTF-8 before opening",
        ));
    }
    let revision = format!("{:x}", Sha256::digest(&bytes));
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let text = String::from_utf8(if bom { bytes[3..].to_vec() } else { bytes }).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported encoding; convert to UTF-8 before opening",
        )
    })?;
    Ok(FileSnapshot {
        uri: file_uri(&path)?,
        path,
        text,
        bom,
        revision,
    })
}

/// Compare against the version the editor opened, then atomically replace in the same directory.
/// `None` means create a new file and must never overwrite an existing file.
pub fn write_document(
    path: &Path,
    text: &str,
    bom: bool,
    expected: Option<&str>,
) -> io::Result<FileSnapshot> {
    if text.len() as u64 + if bom { 3 } else { 0 } > MAX_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "file exceeds 8 MiB",
        ));
    }
    let parent = canonical(
        path.parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?,
    )?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing file name"))?;
    let target = parent.join(name);
    let existing = match read_document(&target) {
        Ok(snapshot) => Some(snapshot),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if existing.as_ref().map(|snapshot| snapshot.revision.as_str()) != expected {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "file changed on disk; reload or save a copy",
        ));
    }
    // Refuse a symlink target; replacement must not silently alter an alias's identity.
    if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.is_symlink()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "cannot replace a symbolic link",
        ));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    if let Some(snapshot) = &existing {
        temporary
            .as_file()
            .set_permissions(fs::metadata(&snapshot.path)?.permissions())?;
    }
    if bom {
        temporary.write_all(&[0xef, 0xbb, 0xbf])?;
    }
    temporary.write_all(text.as_bytes())?;
    temporary.as_file().sync_all()?;
    if expected.is_some() {
        temporary.persist(&target).map_err(|error| error.error)?;
    } else {
        temporary
            .persist_noclobber(&target)
            .map_err(|error| error.error)?;
    }
    let saved = read_document(&target)?;
    if saved.text != text || saved.bom != bom {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "file changed immediately after saving",
        ));
    }
    Ok(saved)
}

#[derive(Debug)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn open(root: &Path) -> io::Result<Self> {
        let root = canonical(root)?;
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "workspace must be a directory",
            ));
        }
        Ok(Self { root })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve(&self, path: &Path) -> io::Result<PathBuf> {
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            self.root.join(path)
        };
        let path = canonical(&path)?;
        if !path.starts_with(&self.root) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "path outside workspace",
            ));
        }
        Ok(path)
    }

    pub fn new_child(&self, parent: &Path, name: &str) -> io::Result<PathBuf> {
        if name.is_empty()
            || name.contains(['/', '\\', ':'])
            || name.ends_with(['.', ' '])
            || name.chars().any(char::is_control)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid file name",
            ));
        }
        if !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        ) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid file name",
            ));
        }
        Ok(self.resolve(parent)?.join(name))
    }

    pub fn entries(&self, path: &Path) -> io::Result<Vec<Entry>> {
        let path = self.resolve(path)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            entries.push(Entry {
                name: entry.file_name().to_string_lossy().into(),
                path: entry.path(),
                directory: file_type.is_dir(),
                symlink: file_type.is_symlink(),
            });
        }
        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_save_preserves_bom_crlf_and_detects_conflicts() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.pwn");
        let original = write_document(&path, "main() {}\r\n// 🦀", true, None).unwrap();
        assert!(original.bom);
        assert_eq!(read_document(&path).unwrap().text, "main() {}\r\n// 🦀");
        let next = write_document(
            &path,
            "main() { return 1; }\r\n",
            true,
            Some(&original.revision),
        )
        .unwrap();
        assert_ne!(original.revision, next.revision);
        assert_eq!(
            write_document(&path, "lost update", false, Some(&original.revision))
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(read_document(&path).unwrap().text, next.text);
        assert!(write_document(&path, "overwrite", false, None).is_err());
    }

    #[test]
    fn traversal_and_outside_paths_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(root.path()).unwrap();
        assert!(workspace.resolve(outside.path()).is_err());
        assert!(workspace.resolve(Path::new("..")).is_err());
        for name in [
            "..",
            ".",
            "../bad",
            "..\\bad",
            "C:\\bad",
            "file:stream",
            "bad.",
            "bad ",
        ] {
            assert!(workspace.new_child(root.path(), name).is_err(), "{name}");
        }
        assert_eq!(
            workspace.new_child(root.path(), "valid.inc").unwrap(),
            canonical(root.path()).unwrap().join("valid.inc")
        );
    }

    #[test]
    fn rejects_non_utf8_and_binary_text() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("binary.inc");
        for bytes in [vec![0xff, 0xfe, 1], vec![0, 65]] {
            fs::write(&path, bytes).unwrap();
            assert!(read_document(&path).is_err());
        }
    }

    #[test]
    fn file_uri_roundtrip_preserves_reserved_and_unicode_characters() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Pawn 🦀 # percent%.inc");
        fs::write(&path, "main() {}\n").unwrap();
        let path = canonical(&path).unwrap();
        let uri = file_uri(&path).unwrap();
        assert!(uri.contains("%20") && uri.contains("%23") && uri.contains("%25"));
        assert_eq!(Url::parse(&uri).unwrap().to_file_path().unwrap(), path);
        #[cfg(windows)]
        assert!(uri.starts_with("file:///"));
    }
}
