use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use url::Url;

pub const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub path: PathBuf,
    pub uri: String,
    pub text: String,
    pub bom: bool,
    pub revision: String,
    pub encoding: String,
    pub encoding_guessed: bool,
    pub size_bytes: u64,
    pub large_file: bool,
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
    read_document_with_encoding(path, None)
}

pub fn read_document_with_encoding(
    path: &Path,
    encoding: Option<&str>,
) -> io::Result<FileSnapshot> {
    let path = canonical(path)?;
    let bytes = read_bytes(&path)?;
    let decoded = crate::text::decode(&bytes, encoding)?;
    check_size(decoded.text.len() as u64)?;
    Ok(FileSnapshot {
        uri: file_uri(&path)?,
        path,
        large_file: decoded.text.len() >= 8 * 1024 * 1024 || bytes.len() >= 8 * 1024 * 1024,
        text: decoded.text,
        bom: decoded.bom,
        revision: format!("{:x}", Sha256::digest(&bytes)),
        encoding: decoded.encoding,
        encoding_guessed: decoded.guessed,
        size_bytes: bytes.len() as u64,
    })
}

fn check_size(size: u64) -> io::Result<()> {
    if size > MAX_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "file exceeds 128 MiB",
        ));
    }
    Ok(())
}

fn read_bytes(path: &Path) -> io::Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    check_size(metadata.len())?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(metadata.len() as usize)
        .map_err(io::Error::other)?;
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    check_size(bytes.len() as u64)?;
    Ok(bytes)
}

/// Hash without decoding or allocating a second large editor buffer.
pub fn document_revision(path: &Path) -> io::Result<String> {
    let file = fs::File::open(path)?;
    check_size(file.metadata()?.len())?;
    let mut reader = file.take(MAX_FILE_BYTES + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut size = 0;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        check_size(size)?;
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Compare against the version the editor opened, then atomically replace in the same directory.
/// `None` means create a new file and must never overwrite an existing file.
pub fn write_document(
    path: &Path,
    text: &str,
    bom: bool,
    expected: Option<&str>,
) -> io::Result<FileSnapshot> {
    write_document_with_encoding(path, text, "utf-8", bom, expected)
}

pub fn write_document_with_encoding(
    path: &Path,
    text: &str,
    encoding: &str,
    bom: bool,
    expected: Option<&str>,
) -> io::Result<FileSnapshot> {
    check_size(text.len() as u64)?;
    if encoding.starts_with("utf-16") {
        check_size(text.encode_utf16().count() as u64 * 2 + if bom { 2 } else { 0 })?;
    } else if encoding.starts_with("utf-32") {
        check_size(text.chars().count() as u64 * 4 + if bom { 4 } else { 0 })?;
    }
    let bytes = crate::text::encode(text, encoding, bom)?;
    check_size(bytes.len() as u64)?;
    let parent = canonical(
        path.parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?,
    )?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing file name"))?;
    let target = parent.join(name);
    let existing = match document_revision(&target) {
        Ok(revision) => Some(revision),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if existing.as_deref() != expected {
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
    if existing.is_some() {
        temporary
            .as_file()
            .set_permissions(fs::metadata(&target)?.permissions())?;
    }
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    if expected.is_some() {
        temporary.persist(&target).map_err(|error| error.error)?;
    } else {
        temporary
            .persist_noclobber(&target)
            .map_err(|error| error.error)?;
    }
    let saved = read_document_with_encoding(&target, Some(encoding))?;
    if saved.text != text || saved.revision != format!("{:x}", Sha256::digest(&bytes)) {
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
            || name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
            || name.ends_with(['.', ' '])
            || name.chars().any(char::is_control)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid file name",
            ));
        }
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        }) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "reserved file name",
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
        let parent = self.resolve(parent)?;
        if !parent.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "parent must be a directory",
            ));
        }
        let target = parent.join(name);
        self.protect(&target)?;
        Ok(target)
    }

    fn protect(&self, path: &Path) -> io::Result<()> {
        if path == self.root
            || path
                .strip_prefix(&self.root)
                .map_err(io::Error::other)?
                .components()
                .any(|part| {
                    part.as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(".git")
                })
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "workspace root and Git metadata are protected",
            ));
        }
        Ok(())
    }
    pub fn mutable_entry(&self, path: &Path) -> io::Result<PathBuf> {
        let lexical = if path.is_absolute() {
            path.to_owned()
        } else {
            self.root.join(path)
        };
        if fs::symlink_metadata(&lexical)?.is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "symbolic links are not mutable explorer entries",
            ));
        }
        let path = self.resolve(&lexical)?;
        self.protect(&path)?;
        Ok(path)
    }
    pub fn create(&self, parent: &Path, name: &str, directory: bool) -> io::Result<PathBuf> {
        let target = self.new_child(parent, name)?;
        if directory {
            fs::create_dir(&target)?;
        } else {
            fs::File::create_new(&target)?.sync_all()?;
        }
        canonical(&target)
    }
    pub fn rename(&self, source: &Path, name: &str) -> io::Result<PathBuf> {
        let source = self.mutable_entry(source)?;
        let parent = source
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?;
        let destination = self.new_child(parent, name)?;
        if source == destination {
            return Ok(source);
        }
        rename_without_replacement(&source, &destination)?;
        canonical(&destination)
    }
    pub fn trash(&self, path: &Path) -> io::Result<()> {
        let path = self.mutable_entry(path)?;
        recycle(&path)
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

#[cfg(windows)]
fn recycle(path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{System::Com::*, UI::Shell::*},
        core::PCWSTR,
    };
    // Request recycling explicitly. Do not offer a permanent-delete fallback for
    // network/removable volumes where the Windows Recycle Bin is unavailable.
    let drive = match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            std::path::Prefix::Disk(drive) => drive,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Recycle Bin requires a local fixed drive",
                ));
            }
        },
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Recycle Bin requires a local fixed drive",
            ));
        }
    };
    let drive = [drive as u16, ':' as u16, '\\' as u16, 0];
    if unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(drive.as_ptr()) }
        != windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Recycle Bin requires a local fixed drive",
        ));
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // A dedicated apartment avoids incompatible COM initialization on worker-pool threads.
    std::thread::spawn(move || -> io::Result<()> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(io::Error::other)?;
            struct Apartment;
            impl Drop for Apartment {
                fn drop(&mut self) {
                    unsafe {
                        CoUninitialize();
                    }
                }
            }
            let _apartment = Apartment;
            let operation: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(io::Error::other)?;
            operation
                .SetOperationFlags(
                    FOF_NO_UI | FOFX_EARLYFAILURE | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD,
                )
                .map_err(io::Error::other)?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                .map_err(io::Error::other)?;
            operation
                .DeleteItem(&item, None)
                .map_err(io::Error::other)?;
            operation.PerformOperations().map_err(io::Error::other)?;
            if operation
                .GetAnyOperationsAborted()
                .map_err(io::Error::other)?
                .as_bool()
            {
                return Err(io::Error::other("Recycle Bin operation was cancelled"));
            }
            Ok(())
        }
    })
    .join()
    .map_err(|_| io::Error::other("Recycle Bin worker failed"))?
}
#[cfg(not(windows))]
fn recycle(path: &Path) -> io::Result<()> {
    trash::delete(path).map_err(io::Error::other)
}

#[cfg(windows)]
fn rename_without_replacement(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // No MOVEFILE_REPLACE_EXISTING: collisions must fail atomically, including races.
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_without_replacement(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn rename_without_replacement(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic non-replacing rename is not supported on this target",
    ))
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
            "CON.pwn",
            "com1.inc",
            "LPT¹",
            "bad?name",
            "bad*name",
            "bad|name",
        ] {
            assert!(workspace.new_child(root.path(), name).is_err(), "{name}");
        }
        assert_eq!(
            workspace.new_child(root.path(), "valid.inc").unwrap(),
            canonical(root.path()).unwrap().join("valid.inc")
        );
    }

    #[test]
    fn explorer_operations_are_scoped_and_never_overwrite_existing_entries() {
        let root = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(root.path()).unwrap();
        let first = workspace.create(root.path(), "first.pwn", false).unwrap();
        fs::write(&first, "first").unwrap();
        let second = workspace.create(root.path(), "second.pwn", false).unwrap();
        fs::write(&second, "second").unwrap();
        assert!(workspace.rename(&first, "second.pwn").is_err());
        assert_eq!(fs::read_to_string(&first).unwrap(), "first");
        assert_eq!(fs::read_to_string(&second).unwrap(), "second");
        assert!(workspace.create(root.path(), "first.pwn", false).is_err());
        let renamed = workspace.rename(&first, "renamed.pwn").unwrap();
        assert!(!first.exists());
        assert_eq!(fs::read_to_string(renamed).unwrap(), "first");
        assert!(workspace.mutable_entry(root.path()).is_err());
        assert!(workspace.trash(root.path()).is_err());
        assert!(workspace.rename(root.path(), "moved-root").is_err());
        assert!(workspace.new_child(root.path(), ".git").is_err());
        let outside = tempfile::tempdir().unwrap();
        assert!(workspace.create(outside.path(), "outside", false).is_err());
        let folder = workspace.create(root.path(), "folder", true).unwrap();
        fs::write(folder.join("child.inc"), "preserved").unwrap();
        let folder = workspace.rename(&folder, "new-folder").unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("child.inc")).unwrap(),
            "preserved"
        );
    }
    #[test]
    #[cfg(windows)]
    fn windows_case_only_rename_preserves_contents() {
        let root = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(root.path()).unwrap();
        let path = workspace.create(root.path(), "name.pwn", false).unwrap();
        fs::write(&path, "case").unwrap();
        let renamed = workspace.rename(&path, "NAME.pwn").unwrap();
        assert_eq!(renamed.file_name().unwrap(), "NAME.pwn");
        assert_eq!(fs::read_to_string(renamed).unwrap(), "case");
    }

    #[test]
    #[cfg(windows)]
    fn recycle_bin_roundtrip_preserves_a_scoped_fixture() {
        let root = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(root.path()).unwrap();
        let file = workspace
            .create(root.path(), "pawn-ide-trash-🦀.inc", false)
            .unwrap();
        fs::write(&file, "recoverable fixture").unwrap();
        workspace.trash(&file).unwrap();
        assert!(!file.exists());
        let items: Vec<_> = trash::os_limited::list()
            .unwrap()
            .into_iter()
            .filter(|item| item.original_path() == file)
            .collect();
        assert_eq!(items.len(), 1, "the exact test fixture must be recoverable");
        trash::os_limited::restore_all(items).unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), "recoverable fixture");
    }

    // Called explicitly by scripts/explorer-smoke.mjs after the desktop app recycles
    // its disposable fixtures. Never enumerate/restore unrelated user items.
    #[test]
    #[cfg(windows)]
    #[ignore = "requires the disposable workspace created by explorer-smoke.mjs"]
    fn restore_explorer_smoke_items() {
        let root = canonical(Path::new(
            &std::env::var("PAWN_IDE_EXPLORER_SMOKE_ROOT").expect("smoke workspace required"),
        ))
        .unwrap();
        assert_eq!(
            root.parent(),
            Some(canonical(&std::env::temp_dir()).unwrap().as_path())
        );
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pawn-explorer-smoke-")
        );
        let items: Vec<_> = trash::os_limited::list()
            .unwrap()
            .into_iter()
            .filter(|item| {
                let path = item.original_path();
                path.parent() == Some(root.as_path())
                    && matches!(
                        path.file_name().and_then(|name| name.to_str()),
                        Some("renamed-scripts" | "temporary.inc")
                    )
            })
            .collect();
        trash::os_limited::restore_all(items).unwrap();
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
    fn encoded_saves_preserve_bytes_and_refuse_loss_or_disk_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("encoded.pwn");
        let source = "// سلام دنيا\r\nmain() {}\r\n";
        let original =
            write_document_with_encoding(&path, source, "windows-1256", false, None).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(
            write_document_with_encoding(
                &path,
                "// 😀",
                "windows-1256",
                false,
                Some(&original.revision)
            )
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        let unicode =
            write_document_with_encoding(&path, source, "utf-16le", true, Some(&original.revision))
                .unwrap();
        assert_eq!(unicode.encoding, "utf-16le");
        assert!(unicode.bom);
        assert_eq!(unicode.text, source);
        fs::write(&path, "external").unwrap();
        assert!(
            write_document_with_encoding(&path, source, "utf-16le", true, Some(&unicode.revision))
                .is_err()
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "external");
    }

    #[test]
    fn large_text_above_eight_mib_opens_and_saves_with_a_bounded_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.pwn");
        let source = "// large file\r\n".repeat(800_000);
        assert!(source.len() > 8 * 1024 * 1024);
        let original = write_document(&path, &source, false, None).unwrap();
        assert!(original.large_file);
        assert_eq!(original.text, source);
        assert_eq!(document_revision(&path).unwrap(), original.revision);
        let changed = format!("{source}// saved\r\n");
        let saved = write_document(&path, &changed, false, Some(&original.revision)).unwrap();
        assert_eq!(saved.text, changed);
        let oversized = directory.path().join("oversized.pwn");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_document(&oversized).unwrap_err().kind(),
            io::ErrorKind::FileTooLarge
        );
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
