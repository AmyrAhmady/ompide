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
