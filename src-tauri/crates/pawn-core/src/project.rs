//! Local project configuration and bounded workspace discovery.
use crate::workspace::{self, FileSnapshot, Workspace};
use serde::Serialize;
use serde_json::Value;
use std::{fs, io, path::PathBuf};

pub const MANIFESTS: [&str; 3] = ["pawn.json", "pawn.yaml", "pawn.yml"];
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub manifests: Vec<PathBuf>,
    pub entries: Vec<PathBuf>,
    pub truncated: bool,
}

pub fn discover(workspace: &Workspace) -> io::Result<Discovery> {
    let mut result = Discovery {
        manifests: vec![],
        entries: vec![],
        truncated: false,
    };
    let mut pending = vec![workspace.root().to_path_buf()];
    let mut visited = 0;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(workspace.resolve(&directory)?)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            visited += 1;
            if visited > 20_000 {
                result.truncated = true;
                break;
            }
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if kind.is_dir() {
                if !matches!(
                    name.as_ref(),
                    ".git"
                        | "node_modules"
                        | "target"
                        | ".tools-cache"
                        | "dependencies"
                        | "vendor"
                        | ".vendor"
                        | "generated"
                        | "output"
                        | "build"
                        | "dist"
                ) {
                    pending.push(entry.path());
                }
            } else if kind.is_file() {
                if MANIFESTS.contains(&name.as_ref()) {
                    result.manifests.push(entry.path());
                }
                if entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pwn"))
                {
                    result.entries.push(entry.path());
                }
            }
        }
        if result.truncated {
            break;
        }
    }
    result.manifests.sort();
    result.entries.sort();
    Ok(result)
}

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub project: ProjectDetails,
    pub manifest: FileSnapshot,
    pub configuration: Value,
}

#[derive(Debug, Serialize)]
pub struct ProjectDetails {
    pub root: PathBuf,
    pub manifest: PathBuf,
    pub entry: PathBuf,
    pub profile: String,
    pub build: String,
}

#[derive(Debug)]
pub struct BuildConfiguration {
    pub entry: PathBuf,
    pub includes: Vec<PathBuf>,
    pub arguments: Vec<String>,
    pub defines: std::collections::BTreeMap<String, String>,
}

fn invalid(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, reason.into())
}

fn text<'a>(value: &'a Value, key: &str) -> io::Result<&'a str> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(text)) => Ok(text),
        _ => Err(invalid(format!("{key} must be a string"))),
    }
}

fn strings(value: &Value, key: &str) -> io::Result<Vec<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(items)) if items.len() <= 256 => items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|item| item.len() <= 32768 && !item.contains('\0'))
                    .map(str::to_owned)
                    .ok_or_else(|| invalid(format!("invalid {key} item")))
            })
            .collect(),
        _ => Err(invalid(format!(
            "{key} must be an array with at most 256 strings"
        ))),
    }
}

fn selected(configuration: &Value, name: &str) -> io::Result<Value> {
    let defaults = configuration.get("build").filter(|value| !value.is_null());
    if defaults.is_some_and(|value| !value.is_object()) {
        return Err(invalid("build must be an object"));
    }
    let builds = match configuration.get("builds") {
        None => &[][..],
        Some(Value::Array(builds)) if builds.len() <= 128 => builds.as_slice(),
        _ => return Err(invalid("builds must be an array with at most 128 entries")),
    };
    let mut names = std::collections::HashSet::new();
    for build in builds {
        let name = text(build, "name")?;
        if !build.is_object() || name.is_empty() || !names.insert(name) {
            return Err(invalid("named builds need unique nonempty names"));
        }
    }
    let chosen = if name.is_empty() {
        defaults.or_else(|| builds.first())
    } else {
        Some(
            builds
                .iter()
                .find(|build| build.get("name").and_then(Value::as_str) == Some(name))
                .ok_or_else(|| invalid("unknown named build"))?,
        )
    };
    let mut merged = defaults.cloned().unwrap_or_else(|| serde_json::json!({}));
    if let Some(chosen) = chosen {
        for (key, value) in chosen.as_object().ok_or_else(|| invalid("invalid build"))? {
            if value.is_null()
                || value.as_str().is_some_and(str::is_empty)
                || value.as_array().is_some_and(Vec::is_empty)
            {
                continue;
            }
            if key == "constants" {
                let mut constants = merged
                    .get(key)
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let values = value
                    .as_object()
                    .ok_or_else(|| invalid("constants must be an object"))?;
                let target = constants
                    .as_object_mut()
                    .ok_or_else(|| invalid("constants must be an object"))?;
                target.extend(
                    values
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone())),
                );
                merged[key] = constants;
            } else {
                merged[key] = value.clone();
            }
        }
    }
    Ok(merged)
}

pub fn profile(configuration: &Value) -> io::Result<String> {
    let extension = text(&configuration["pawnkit"], "profile")?;
    if !extension.is_empty() {
        return Ok(extension.to_owned());
    }
    Ok(match text(configuration, "preset")? {
        "" | "openmp" => "openmp",
        other => other,
    }
    .to_owned())
}

/// Include directories are compiler inputs and may belong to a shared SDK.
/// Keep this separate from Workspace::resolve, which scopes project mutations.
pub fn include_directory(scope: &Workspace, path: &std::path::Path) -> io::Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        scope.root().join(path)
    };
    let path = workspace::canonical(&path)?;
    if !path.is_dir() {
        return Err(invalid("include path must be an existing directory"));
    }
    Ok(path)
}

/// Authorize a navigation target only through declared include roots, without
/// broadening workspace file operations. Callers grant access to this file only.
pub fn include_document(scope: &Workspace, path: &std::path::Path) -> io::Result<PathBuf> {
    let path = workspace::canonical(path)?;
    if !path.is_file() {
        return Err(invalid("include document must be a regular file"));
    }
    for manifest in discover(scope)?.manifests {
        let project = Workspace::open(manifest.parent().unwrap())?;
        let Ok(info) = inspect(&project) else {
            continue;
        };
        let mut names = vec![""];
        if let Some(builds) = info.configuration.get("builds").and_then(Value::as_array) {
            names.extend(
                builds
                    .iter()
                    .filter_map(|build| build.get("name").and_then(Value::as_str)),
            );
        }
        for name in names {
            let Ok(build) = build_configuration(&project, &info.configuration, name) else {
                continue;
            };
            if build
                .includes
                .iter()
                .any(|include| path.starts_with(include))
            {
                return Ok(path);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "file is outside the workspace and configured include directories",
    ))
}

pub fn build_configuration(
    scope: &Workspace,
    configuration: &Value,
    name: &str,
) -> io::Result<BuildConfiguration> {
    if !configuration.is_object() {
        return Err(invalid("manifest must be an object"));
    }
    let chosen = selected(configuration, name)?;
    let input = text(&chosen, "input")?;
    let entry = if input.is_empty() {
        text(configuration, "entry")?
    } else {
        input
    };
    if entry.is_empty() {
        return Err(invalid("select a Pawn entry point in the manifest"));
    }
    let entry = scope.resolve(std::path::Path::new(entry))?;
    if !entry.is_file()
        || !entry
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pwn"))
    {
        return Err(invalid("entry must be an existing .pwn file"));
    }
    let mut includes = vec![scope.root().to_owned(), entry.parent().unwrap().to_owned()];
    let include = text(configuration, "include_path")?;
    let mut declared = if include.is_empty() {
        vec![]
    } else {
        vec![include.to_owned()]
    };
    declared.extend(strings(&configuration["pawnkit"], "includePaths")?);
    declared.extend(strings(&chosen, "includes")?);
    let arguments = strings(&chosen, "args")?;
    declared.extend(arguments.iter().filter_map(|argument| {
        argument
            .strip_prefix("-i")
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
    }));
    for path in declared {
        let path = include_directory(scope, std::path::Path::new(&path))?;
        if !includes.contains(&path) {
            includes.push(path);
        }
    }
    let mut defines = std::collections::BTreeMap::new();
    if let Some(constants) = chosen.get("constants") {
        let constants = constants
            .as_object()
            .filter(|values| values.len() <= 256)
            .ok_or_else(|| invalid("constants must be an object with at most 256 entries"))?;
        for (name, value) in constants {
            let value = match value {
                Value::String(value) => value.clone(),
                Value::Number(value) => value.to_string(),
                Value::Bool(value) => if *value { "1" } else { "0" }.to_owned(),
                Value::Null => "1".to_owned(),
                _ => return Err(invalid("constant values must be scalar")),
            };
            defines.insert(name.clone(), value);
        }
    }
    Ok(BuildConfiguration {
        entry,
        includes,
        arguments,
        defines,
    })
}

pub fn inspect(scope: &Workspace) -> io::Result<ProjectInfo> {
    let manifests: Vec<_> = MANIFESTS
        .iter()
        .map(|name| scope.root().join(name))
        .filter(|path| path.exists())
        .collect();
    if manifests.len() != 1 {
        return Err(invalid(
            "select a folder containing exactly one Pawn manifest",
        ));
    }
    let manifest = workspace::read_document(&scope.resolve(&manifests[0])?)?;
    if manifest.text.len() > 256 * 1024 {
        return Err(invalid("manifest exceeds 256 KiB"));
    }
    let configuration: Value = if manifest.path.extension().is_some_and(|ext| ext == "json") {
        serde_json::from_str(&manifest.text).map_err(|failure| invalid(failure.to_string()))?
    } else {
        serde_yaml_ng::from_str(&manifest.text).map_err(|failure| invalid(failure.to_string()))?
    };
    let build = build_configuration(scope, &configuration, "")?;
    let project = ProjectDetails {
        root: scope.root().to_owned(),
        manifest: manifest.path.clone(),
        entry: build.entry,
        profile: profile(&configuration)?,
        build: text(&selected(&configuration, "")?, "name")?.to_owned(),
    };
    Ok(ProjectInfo {
        project,
        manifest,
        configuration,
    })
}

pub fn preview(
    scope: &Workspace,
    entry: &std::path::Path,
    preset: &str,
    includes: &[String],
) -> io::Result<String> {
    if preset != "openmp" || includes.len() > 64 {
        return Err(invalid("invalid project setup"));
    }
    let entry = scope.resolve(entry)?;
    let relative = |path: &std::path::Path| -> io::Result<String> {
        let path = scope.resolve(path)?;
        let value = path
            .strip_prefix(scope.root())
            .map_err(io::Error::other)?
            .to_string_lossy()
            .replace('\\', "/");
        Ok(if value.is_empty() {
            ".".to_owned()
        } else {
            value
        })
    };
    let paths: Vec<_> = includes
        .iter()
        .map(|path| {
            let path = include_directory(scope, std::path::Path::new(path))?;
            let value = path
                .strip_prefix(scope.root())
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            Ok(if value.is_empty() {
                ".".to_owned()
            } else {
                value
            })
        })
        .collect::<io::Result<_>>()?;
    let configuration = serde_json::json!({
        "entry": relative(&entry)?, "preset": preset, "experimental": {"build_file": false},
        "pawnkit": {"schemaVersion": 1, "profile": "openmp", "includePaths": paths}
    });
    build_configuration(scope, &configuration, "")?;
    Ok(serde_json::to_string_pretty(&configuration)? + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("main.pwn"), "main() {}\n").unwrap();
        fs::write(root.path().join("other.pwn"), "main() {}\n").unwrap();
        fs::create_dir(root.path().join("include")).unwrap();
        root
    }

    #[test]
    fn named_builds_inherit_inputs_arguments_includes_and_merge_constants() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        let configuration = json!({
            "entry": "main.pwn", "preset": "openmp",
            "build": {"input": "main.pwn", "args": ["-d1"], "includes": ["include"], "constants": {"SHARED": 1, "OVERRIDE": 1}},
            "builds": [{"name": "other", "input": "other.pwn", "constants": {"OVERRIDE": 2}}]
        });
        let result = build_configuration(&scope, &configuration, "other").unwrap();
        assert_eq!(result.entry, scope.root().join("other.pwn"));
        assert_eq!(result.arguments, vec!["-d1"]);
        assert!(result.includes.contains(&scope.root().join("include")));
        assert_eq!(result.defines["SHARED"], "1");
        assert_eq!(result.defines["OVERRIDE"], "2");
        assert_eq!(
            build_configuration(&scope, &configuration, "")
                .unwrap()
                .entry,
            scope.root().join("main.pwn")
        );
        assert!(build_configuration(&scope, &configuration, "missing").is_err());
    }

    #[test]
    fn inspects_json_and_yaml_without_an_external_tool_or_lockfile() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        for (name, text) in [
            (
                "pawn.json",
                r#"{"entry":"main.pwn","preset":"openmp","pawnkit":{"schemaVersion":1,"includePaths":["include"]}}"#,
            ),
            (
                "pawn.yaml",
                "entry: main.pwn\npreset: openmp\npawnkit:\n  schemaVersion: 1\n  includePaths: [include]\n",
            ),
        ] {
            fs::write(root.path().join(name), text).unwrap();
            let info = inspect(&scope).unwrap();
            assert_eq!(info.project.entry, scope.root().join("main.pwn"));
            assert_eq!(info.project.profile, "openmp");
            assert_eq!(info.manifest.text, text);
            assert!(info.configuration["pawnkit"]["schemaVersion"] == 1);
            fs::remove_file(root.path().join(name)).unwrap();
        }
    }

    #[test]
    fn setup_preview_is_scoped_and_does_not_create_a_manifest() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        let text = preview(
            &scope,
            &root.path().join("main.pwn"),
            "openmp",
            &["include".into()],
        )
        .unwrap();
        let configuration: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(configuration["entry"], "main.pwn");
        assert_eq!(profile(&configuration).unwrap(), "openmp");
        assert!(!root.path().join("pawn.json").exists());
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.pwn"), "main() {}").unwrap();
        assert!(preview(&scope, &outside.path().join("outside.pwn"), "openmp", &[]).is_err());
        let configuration = build_configuration(
            &scope,
            &json!({"entry": "main.pwn", "include_path": outside.path()}),
            "",
        )
        .unwrap();
        assert!(
            configuration
                .includes
                .contains(&workspace::canonical(outside.path()).unwrap())
        );
        let preview: Value = serde_json::from_str(
            &preview(
                &scope,
                &root.path().join("main.pwn"),
                "openmp",
                &[outside.path().to_string_lossy().into_owned()],
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            std::path::Path::new(preview["pawnkit"]["includePaths"][0].as_str().unwrap())
                .is_absolute()
        );
    }

    #[test]
    fn rejects_ambiguous_malformed_and_missing_configuration() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        assert!(inspect(&scope).is_err());
        fs::write(root.path().join("pawn.json"), r#"{"entry":"main.pwn"}"#).unwrap();
        fs::write(root.path().join("pawn.yaml"), "entry: main.pwn").unwrap();
        assert!(inspect(&scope).is_err());
        for value in [
            json!([]),
            json!({"entry": "main.pwn", "build": 42}),
            json!({"entry": "missing.pwn"}),
            json!({"entry": "main.pwn", "builds": [{"name": "x"}, {"name": "x"}]}),
        ] {
            assert!(build_configuration(&scope, &value, "").is_err());
        }
    }

    #[test]
    fn shared_sdk_includes_support_absolute_relative_and_named_build_paths() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        let sdk = parent.path().join("shared SDK");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sdk).unwrap();
        fs::write(root.join("main.pwn"), "main() {}\n").unwrap();
        fs::write(sdk.join("header.inc"), "stock Helper() {}\n").unwrap();
        let scope = Workspace::open(&root).unwrap();
        let sdk = workspace::canonical(&sdk).unwrap();
        for configuration in [
            json!({"entry":"main.pwn", "include_path":sdk}),
            json!({"entry":"main.pwn", "pawnkit":{"includePaths":["../shared SDK"]}}),
            json!({"entry":"main.pwn", "build":{"includes":[sdk.clone()]}}),
            json!({"entry":"main.pwn", "build":{"args":["-i../shared SDK"]}}),
            json!({"entry":"main.pwn", "builds":[{"name":"release", "includes":["../shared SDK"]}]}),
        ] {
            let build = build_configuration(&scope, &configuration, "").unwrap();
            assert!(build.includes.contains(&sdk));
        }
        assert!(include_directory(&scope, &sdk.join("missing")).is_err());
        assert!(include_directory(&scope, &sdk.join("header.inc")).is_err());
        // Include inputs do not expand the workspace's source/output authority.
        assert!(scope.resolve(&sdk).is_err());
        assert!(scope.new_child(&sdk, "output").is_err());
        fs::write(sdk.join("outside.pwn"), "main() {}\n").unwrap();
        assert!(
            build_configuration(&scope, &json!({"entry":sdk.join("outside.pwn")}), "").is_err()
        );
    }

    #[test]
    fn include_navigation_only_authorizes_files_under_declared_sdk_roots() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("workspace");
        let project = root.join("nested");
        let sdk = parent.path().join("shared SDK");
        let other = parent.path().join("shared SDK-other");
        for directory in [&root, &project, &sdk, &other] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(project.join("main.pwn"), "main() {}\n").unwrap();
        fs::write(sdk.join("shared.inc"), "stock Shared() {}\n").unwrap();
        fs::write(other.join("private.inc"), "private\n").unwrap();
        fs::write(project.join("pawn.json"), serde_json::to_vec(&json!({"entry":"main.pwn", "builds":[{"name":"local"},{"name":"sdk","includes":[sdk]}]})).unwrap()).unwrap();
        let scope = Workspace::open(&root).unwrap();
        let header = workspace::canonical(&sdk.join("shared.inc")).unwrap();
        assert_eq!(include_document(&scope, &header).unwrap(), header);
        assert!(include_document(&scope, &other.join("private.inc")).is_err());
        assert!(include_document(&scope, &sdk).is_err());
        assert!(scope.resolve(&header).is_err());
        #[cfg(unix)]
        {
            let escape = sdk.join("escape.inc");
            std::os::unix::fs::symlink(other.join("private.inc"), &escape).unwrap();
            assert!(include_document(&scope, &escape).is_err());
        }
    }

    #[test]
    fn discovers_nested_projects_without_scanning_vendor_and_output_trees() {
        let root = fixture();
        for name in ["nested", "vendor", "output"] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        for name in [
            "nested/pawn.yaml",
            "vendor/pawn.json",
            "vendor/ignore.pwn",
            "output/ignore.pwn",
        ] {
            fs::write(root.path().join(name), "").unwrap();
        }
        let result = discover(&Workspace::open(root.path()).unwrap()).unwrap();
        assert_eq!(result.manifests.len(), 1);
        assert_eq!(result.entries.len(), 2);
        assert!(!result.truncated);
    }
}
