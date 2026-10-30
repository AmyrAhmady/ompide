//! Read-only dependency review for the pinned PawnKit lock formats.
//! PawnKit still owns resolution, validation, acquisition and installation.
use crate::workspace::{self, FileSnapshot, Workspace};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, fs, io, path::PathBuf};
use url::Url;

const MAX_LOCK_BYTES: u64 = 1024 * 1024;
const MAX_PACKAGES: usize = 1024;
const MAX_RESOURCE_FILES: usize = 4096;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReview {
    pub lock_path: PathBuf,
    pub lock: Option<FileSnapshot>,
    pub declarations: Vec<Declaration>,
    pub packages: Vec<Package>,
    pub resources: Vec<Resource>,
}

#[derive(Debug, Serialize)]
pub struct Declaration {
    pub specification: String,
    pub development: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub source_type: String,
    pub source: String,
    pub commit: String,
    pub checksum: Option<String>,
    pub destination: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct Resource {
    pub package: String,
    pub name: String,
    pub target: String,
    pub url: String,
    pub checksum: String,
    pub destinations: Vec<PathBuf>,
}

fn invalid(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

fn field<'a>(value: &'a Value, name: &str) -> io::Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("dependency record is missing a string field"))
}

/// Check even missing targets without following a junction outside the project.
/// This is a read-time boundary check, not a filesystem transaction or a grant
/// to execute the reviewed operation later without checking it again.
fn scoped_path(scope: &Workspace, relative: &str) -> io::Result<PathBuf> {
    if relative.is_empty() || relative.contains(['\\', ':']) {
        return Err(invalid("dependency path must be project-relative"));
    }
    let mut result = scope.root().to_owned();
    for part in relative.split('/') {
        // Use the same portable name rules as Explorer, even below a missing
        // directory. Checking against the root here only validates each name.
        scope.new_child(scope.root(), part)?;
        result.push(part);
        match fs::symlink_metadata(&result) {
            Ok(metadata) => {
                if metadata.is_symlink() {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "dependency path contains a symbolic link",
                    ));
                }
                scope.resolve(&result)?;
            }
            Err(failure) if failure.kind() == io::ErrorKind::NotFound => {}
            Err(failure) => return Err(failure),
        }
    }
    Ok(result)
}

fn https(raw: &str) -> io::Result<String> {
    let url = Url::parse(raw).map_err(|_| invalid("invalid dependency source URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid("dependency source must be credential-free HTTPS"));
    }
    Ok(raw.to_owned())
}

fn checksum(value: &str) -> io::Result<String> {
    if value.strip_prefix("sha256:").is_none_or(|digest| {
        digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        return Err(invalid("invalid dependency SHA-256 checksum"));
    }
    Ok(value.to_owned())
}

fn package(
    scope: &Workspace,
    name: &str,
    source_type: &str,
    source: &str,
    commit: &str,
    integrity: Option<&str>,
) -> io::Result<Package> {
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                })
        })
    {
        return Err(invalid("invalid dependency package name"));
    }
    for part in &parts {
        scope.new_child(scope.root(), part)?;
    }
    let (source, destination) = match source_type {
        "git" => {
            if !(7..=40).contains(&commit.len())
                || !commit
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(invalid("dependency has no valid locked Git commit"));
            }
            (
                https(source)?,
                scoped_path(scope, &format!("dependencies/{}", parts[1]))?,
            )
        }
        "local" => (source.to_owned(), scoped_path(scope, source)?),
        _ => return Err(invalid("dependency source type is not supported by restore")),
    };
    Ok(Package {
        name: name.to_owned(),
        source_type: source_type.to_owned(),
        source,
        commit: commit.to_owned(),
        checksum: integrity.filter(|value| !value.is_empty()).map(checksum).transpose()?,
        destination,
    })
}

fn declarations(configuration: &Value) -> io::Result<Vec<Declaration>> {
    let mut declarations = Vec::new();
    for (key, development) in [("dependencies", false), ("dev_dependencies", true)] {
        let Some(values) = configuration.get(key) else {
            continue;
        };
        let values = values
            .as_array()
            .ok_or_else(|| invalid("dependency declarations must be arrays"))?;
        if declarations.len() + values.len() > MAX_PACKAGES {
            return Err(invalid("too many dependency declarations"));
        }
        for value in values {
            declarations.push(Declaration {
                specification: value
                    .as_str()
                    .ok_or_else(|| invalid("dependency declaration must be a string"))?
                    .to_owned(),
                development,
            });
        }
    }
    Ok(declarations)
}

pub fn review(scope: &Workspace, configuration: &Value) -> io::Result<DependencyReview> {
    let lock_name = configuration
        .get("pawnkit")
        .and_then(|extension| extension.get("lockfile"))
        .map(|value| value.as_str().ok_or_else(|| invalid("invalid lockfile path")))
        .transpose()?
        .filter(|name| !name.is_empty())
        .unwrap_or("pawn.lock");
    let lock_path = scoped_path(scope, lock_name)?;
    let mut result = DependencyReview {
        lock_path: lock_path.clone(),
        lock: None,
        declarations: declarations(configuration)?,
        packages: vec![],
        resources: vec![],
    };
    match fs::metadata(&lock_path) {
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(result),
        Err(failure) => return Err(failure),
        Ok(metadata) if metadata.len() > MAX_LOCK_BYTES => {
            return Err(invalid("dependency lockfile exceeds 1 MiB"));
        }
        Ok(_) => {}
    }
    let snapshot = workspace::read_document(&scope.resolve(&lock_path)?)?;
    if snapshot.text.len() as u64 > MAX_LOCK_BYTES {
        return Err(invalid("dependency lockfile exceeds 1 MiB"));
    }
    let lock: Value = serde_json::from_str(&snapshot.text)?;
    let resources = if lock.get("version").is_some() {
        if lock["version"] != 1 {
            return Err(invalid("unsupported sampctl lockfile version"));
        }
        let entries = lock["dependencies"]
            .as_object()
            .ok_or_else(|| invalid("lockfile dependencies must be an object"))?;
        if entries.len() > MAX_PACKAGES {
            return Err(invalid("too many locked dependencies"));
        }
        for value in entries.values() {
            let name = format!("{}/{}", field(value, "user")?, field(value, "repo")?);
            let local = value.get("local").and_then(Value::as_str).filter(|s| !s.is_empty());
            let source = match local {
                Some(path) => path.to_owned(),
                None => format!(
                    "https://{}/{}",
                    value.get("site").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("github.com"),
                    name
                ),
            };
            let integrity = value.get("integrity").and_then(Value::as_str);
            if integrity.is_some_and(|value| !value.is_empty() && !value.starts_with("commit:") && !value.starts_with("sha256:")) {
                return Err(invalid("invalid dependency integrity"));
            }
            result.packages.push(package(
                scope,
                &name,
                if local.is_some() { "local" } else { "git" },
                &source,
                value.get("commit").and_then(Value::as_str).unwrap_or(""),
                integrity.filter(|value| value.starts_with("sha256:")),
            )?);
        }
        if let Some(extension) = lock.get("pawnkit") {
            if extension["schema_version"] != 1 {
                return Err(invalid("unsupported PawnKit resource schema"));
            }
            extension.get("resources")
        } else {
            None
        }
    } else {
        if lock["schemaVersion"] != 1 {
            return Err(invalid("unsupported PawnKit lockfile schema"));
        }
        let entries = lock["packages"]
            .as_array()
            .ok_or_else(|| invalid("lockfile packages must be an array"))?;
        if entries.len() > MAX_PACKAGES {
            return Err(invalid("too many locked dependencies"));
        }
        for value in entries {
            result.packages.push(package(
                scope,
                field(value, "name")?,
                field(&value["source"], "type")?,
                field(&value["source"], "url")?,
                value.get("commit").and_then(Value::as_str).unwrap_or(""),
                value.get("checksum").and_then(Value::as_str),
            )?);
        }
        lock.get("resources")
    };
    let mut names = HashSet::new();
    let mut destinations = HashSet::new();
    for package in &result.packages {
        if !names.insert(&package.name)
            || (package.source_type != "local"
                && !destinations.insert(package.destination.to_string_lossy().to_lowercase()))
        {
            return Err(invalid("duplicate package name or install destination"));
        }
    }
    if let Some(resources) = resources {
        let resources = resources.as_array().ok_or_else(|| invalid("resources must be an array"))?;
        if resources.len() > MAX_PACKAGES {
            return Err(invalid("too many locked resources"));
        }
        let mut file_count = 0;
        for value in resources {
            let files = value["files"].as_array().ok_or_else(|| invalid("resource files must be an array"))?;
            file_count += files.len();
            if file_count > MAX_RESOURCE_FILES {
                return Err(invalid("too many locked resource files"));
            }
            result.resources.push(Resource {
                package: field(value, "package")?.to_owned(),
                name: field(value, "resource")?.to_owned(),
                target: field(value, "target")?.to_owned(),
                url: https(field(value, "url")?)?,
                checksum: checksum(field(value, "checksum")?)?,
                destinations: files.iter().map(|file| scoped_path(scope, field(file, "destination")?)).collect::<io::Result<_>>()?,
            });
        }
    }
    result.packages.sort_by(|left, right| left.name.cmp(&right.name));
    result.lock = Some(snapshot);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn git_package() -> Value {
        json!({
            "name": "openmultiplayer/omp-stdlib",
            "source": {"type": "git", "url": "https://github.com/openmultiplayer/omp-stdlib"},
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "kind": "includes"
        })
    }

    fn fixture(lock: &Value) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("pawn.lock"), lock.to_string()).unwrap();
        directory
    }

    #[test]
    fn reviews_both_lock_formats_without_creating_dependency_directories() {
        let modern = json!({"schemaVersion": 1, "packages": [git_package()]});
        let compatible = json!({
            "version": 1,
            "generated": "2026-07-30T00:00:00Z",
            "sampctl_version": "1.14.1",
            "dependencies": {
                "github.com/openmultiplayer/omp-stdlib": {
                    "user": "openmultiplayer", "repo": "omp-stdlib",
                    "commit": "0123456789abcdef0123456789abcdef01234567",
                    "integrity": "commit:0123456789abcdef0123456789abcdef01234567"
                }
            }
        });
        for lock in [modern, compatible] {
            let directory = fixture(&lock);
            let scope = Workspace::open(directory.path()).unwrap();
            let before = fs::read(directory.path().join("pawn.lock")).unwrap();
            let review = review(&scope, &json!({"dependencies": ["openmultiplayer/omp-stdlib"]})).unwrap();
            assert_eq!(review.packages.len(), 1);
            assert_eq!(review.packages[0].name, "openmultiplayer/omp-stdlib");
            assert_eq!(review.packages[0].source, "https://github.com/openmultiplayer/omp-stdlib");
            assert_eq!(review.packages[0].destination, scope.root().join("dependencies/omp-stdlib"));
            assert_eq!(review.declarations[0].specification, "openmultiplayer/omp-stdlib");
            assert_eq!(review.lock.unwrap().text, lock.to_string());
            assert!(!directory.path().join("dependencies").exists());
            assert_eq!(fs::read(directory.path().join("pawn.lock")).unwrap(), before);
        }
    }

    #[test]
    fn reports_missing_and_custom_lockfiles_and_development_declarations() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        let configuration = json!({
            "pawnkit": {"schemaVersion": 1, "lockfile": "config/dependencies.lock"},
            "dev_dependencies": ["user/test-library:1.0.0"]
        });
        let missing = review(&scope, &configuration).unwrap();
        assert!(missing.lock.is_none());
        assert_eq!(missing.lock_path, scope.root().join("config/dependencies.lock"));
        assert!(missing.declarations[0].development);
        assert!(!directory.path().join("config").exists());
        fs::create_dir(directory.path().join("config")).unwrap();
        fs::write(directory.path().join("config/dependencies.lock"), r#"{"schemaVersion":1,"packages":[]}"#).unwrap();
        assert!(review(&scope, &configuration).unwrap().lock.is_some());
    }

    #[test]
    fn shows_local_sources_and_locked_assets_with_their_target_and_checksum() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let directory = fixture(&json!({
            "schemaVersion": 1,
            "packages": [{"name": "local/include", "source": {"type": "local", "url": "include"}}],
            "resources": [{
                "package": "local/include", "resource": "headers", "target": "windows-amd64",
                "url": "https://example.org/headers.zip", "checksum": digest,
                "files": [{"destination": "include/library.inc"}]
            }]
        }));
        fs::create_dir(directory.path().join("include")).unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        let review = review(&scope, &json!({})).unwrap();
        assert_eq!(review.packages[0].source_type, "local");
        assert_eq!(review.resources[0].target, "windows-amd64");
        assert_eq!(review.resources[0].checksum, digest);
        assert_eq!(review.resources[0].destinations, vec![scope.root().join("include/library.inc")]);
        assert!(!directory.path().join("include/library.inc").exists());
    }

    #[test]
    fn rejects_escaping_paths_git_metadata_and_portable_device_names() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        for name in ["../outside.lock", "/outside.lock", "C:/outside.lock", "config\\outside.lock", ".git/config", "CON", "config/../outside.lock", "config/COM1.txt"] {
            assert!(review(&scope, &json!({"pawnkit": {"lockfile": name}})).is_err(), "{name}");
        }
        let mut lock = json!({"schemaVersion": 1, "packages": [git_package()]});
        for name in ["user/..", "user/.git", "user/NUL", "user/repo/extra"] {
            lock["packages"][0]["name"] = name.into();
            fs::write(directory.path().join("pawn.lock"), lock.to_string()).unwrap();
            assert!(review(&scope, &json!({})).is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_unpinned_credentialed_and_colliding_sources() {
        let mut lock = json!({"schemaVersion": 1, "packages": [git_package()]});
        let directory = fixture(&lock);
        let scope = Workspace::open(directory.path()).unwrap();
        for url in ["http://example.org/repo", "file:///tmp/repo", "https://secret@example.org/repo", "https://example.org/repo#fragment"] {
            lock["packages"][0]["source"]["url"] = url.into();
            fs::write(directory.path().join("pawn.lock"), lock.to_string()).unwrap();
            assert!(review(&scope, &json!({})).is_err());
        }
        lock["packages"][0] = git_package();
        lock["packages"][0]["commit"] = "master".into();
        fs::write(directory.path().join("pawn.lock"), lock.to_string()).unwrap();
        assert!(review(&scope, &json!({})).is_err());
        lock["packages"][0] = git_package();
        let mut other = git_package();
        other["name"] = "another/OMP-stdlib".into();
        lock["packages"].as_array_mut().unwrap().push(other);
        fs::write(directory.path().join("pawn.lock"), lock.to_string()).unwrap();
        assert!(review(&scope, &json!({})).is_err());
    }

    #[test]
    fn rejects_unsupported_malformed_and_oversized_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        for text in ["not JSON", "[]", r#"{"schemaVersion":2,"packages":[]}"#, r#"{"version":2,"dependencies":{}}"#, r#"{"schemaVersion":1}"#] {
            fs::write(directory.path().join("pawn.lock"), text).unwrap();
            assert!(review(&scope, &json!({})).is_err());
        }
        fs::write(directory.path().join("pawn.lock"), " ".repeat(MAX_LOCK_BYTES as usize + 1)).unwrap();
        assert!(review(&scope, &json!({})).is_err());
        assert!(review(&scope, &json!({"dependencies": [42]})).is_err());
    }

    #[test]
    fn rejects_links_in_lock_and_dependency_paths() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("pawn.lock"), r#"{"schemaVersion":1,"packages":[]}"#).unwrap();
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(directory.path().join("linked"))
                .arg(outside.path())
                .output()
                .unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), directory.path().join("linked")).unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        assert!(review(&scope, &json!({"pawnkit": {"lockfile": "linked/pawn.lock"}})).is_err());
        let mut lock = json!({"schemaVersion": 1, "packages": [git_package()]});
        lock["packages"][0]["source"] = json!({"type": "local", "url": "linked"});
        fs::write(directory.path().join("pawn.lock"), lock.to_string()).unwrap();
        assert!(review(&scope, &json!({})).is_err());
        // Unlink only the junction, leaving the external sentinel intact.
        #[cfg(windows)]
        fs::remove_dir(directory.path().join("linked")).unwrap();
        #[cfg(unix)]
        fs::remove_file(directory.path().join("linked")).unwrap();
        assert!(outside.path().join("pawn.lock").is_file());
    }
}
