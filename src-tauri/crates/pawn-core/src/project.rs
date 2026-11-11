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

/// Structured configuration failures survive the io boundary for localization.
#[derive(Clone, Debug)]
pub struct ConfigError {
    pub code: &'static str,
    pub parameters: Value,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.parameters)
    }
}

impl std::error::Error for ConfigError {}

fn invalid(code: &'static str, parameters: Value) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        ConfigError { code, parameters },
    )
}

fn path_error(field: &str, path: &std::path::Path, failure: io::Error) -> io::Error {
    invalid(
        "projectConfigPath",
        serde_json::json!({
            "field": field, "path": path, "reason": failure.to_string()
        }),
    )
}

fn with_parameter(failure: io::Error, key: &str, value: Value) -> io::Error {
    if let Some(diagnostic) = failure
        .get_ref()
        .and_then(|detail| detail.downcast_ref::<ConfigError>())
    {
        let mut parameters = diagnostic.parameters.clone();
        parameters[key] = value;
        invalid(diagnostic.code, parameters)
    } else {
        failure
    }
}

fn nested_field(failure: io::Error, parent: &str) -> io::Error {
    let field = failure
        .get_ref()
        .and_then(|detail| detail.downcast_ref::<ConfigError>())
        .and_then(|diagnostic| diagnostic.parameters["field"].as_str())
        .map(|field| format!("{parent}.{field}"));
    match field {
        Some(field) => with_parameter(failure, "field", Value::String(field)),
        None => failure,
    }
}

fn text<'a>(value: &'a Value, key: &str) -> io::Result<&'a str> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(text)) => Ok(text),
        _ => Err(invalid(
            "projectConfigString",
            serde_json::json!({"field": key}),
        )),
    }
}

fn strings(value: &Value, key: &str) -> io::Result<Vec<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(items)) if items.len() <= 256 => items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                item.as_str()
                    .filter(|item| item.len() <= 32768 && !item.contains('\0'))
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        invalid(
                            "projectConfigStringItem",
                            serde_json::json!({"field": format!("{key}[{index}]")}),
                        )
                    })
            })
            .collect(),
        _ => Err(invalid(
            "projectConfigStringArray",
            serde_json::json!({"field": key}),
        )),
    }
}

fn selected(configuration: &Value, name: &str) -> io::Result<Value> {
    let defaults = configuration.get("build").filter(|value| !value.is_null());
    if defaults.is_some_and(|value| !value.is_object()) {
        return Err(invalid(
            "projectConfigObject",
            serde_json::json!({"field": "build"}),
        ));
    }
    let builds = match configuration.get("builds") {
        None => &[][..],
        Some(Value::Array(builds)) if builds.len() <= 128 => builds.as_slice(),
        _ => return Err(invalid("projectConfigBuilds", serde_json::json!({}))),
    };
    let mut names = std::collections::HashSet::new();
    for build in builds {
        let name = text(build, "name")?;
        if !build.is_object() || name.is_empty() || !names.insert(name) {
            return Err(invalid(
                "projectConfigBuildName",
                serde_json::json!({"name": name}),
            ));
        }
    }
    let chosen = if name.is_empty() {
        defaults.or_else(|| builds.first())
    } else {
        Some(
            builds
                .iter()
                .find(|build| build.get("name").and_then(Value::as_str) == Some(name))
                .ok_or_else(|| {
                    invalid(
                        "projectConfigUnknownBuild",
                        serde_json::json!({"name": name}),
                    )
                })?,
        )
    };
    let mut merged = defaults.cloned().unwrap_or_else(|| serde_json::json!({}));
    if let Some(chosen) = chosen {
        for (key, value) in chosen
            .as_object()
            .ok_or_else(|| invalid("projectConfigObject", serde_json::json!({"field": "build"})))?
        {
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
                let values = value.as_object().ok_or_else(|| {
                    invalid(
                        "projectConfigObject",
                        serde_json::json!({"field": "constants"}),
                    )
                })?;
                let target = constants.as_object_mut().ok_or_else(|| {
                    invalid(
                        "projectConfigObject",
                        serde_json::json!({"field": "constants"}),
                    )
                })?;
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
    let extension = text(&configuration["pawnkit"], "profile")
        .map_err(|failure| nested_field(failure, "pawnkit"))?;
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
    let path = workspace::canonical(&path)
        .map_err(|failure| path_error("includePaths", &path, failure))?;
    if !path.is_dir() {
        return Err(invalid(
            "projectConfigDirectory",
            serde_json::json!({"path": path}),
        ));
    }
    Ok(path)
}

/// Express a picked include directory relative to the workspace on the same volume.
pub fn relative_include_directory(scope: &Workspace, path: &std::path::Path) -> io::Result<String> {
    let path = include_directory(scope, path)?;
    let base = scope.root();
    let shared = base
        .components()
        .zip(path.components())
        .take_while(|(left, right)| left == right)
        .count();
    if shared == 0 {
        return Err(invalid(
            "projectConfigRelativeInclude",
            serde_json::json!({"path": path}),
        ));
    }
    let mut relative = PathBuf::new();
    for _ in base.components().skip(shared) {
        relative.push("..");
    }
    relative.extend(path.components().skip(shared));
    Ok(if relative.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        relative.to_string_lossy().replace('\\', "/")
    })
}

/// Authorize a navigation target only through declared include roots, without
/// broadening workspace file operations. Callers grant access to this file only.
pub fn include_document(scope: &Workspace, path: &std::path::Path) -> io::Result<PathBuf> {
    let path = workspace::canonical(path)?;
    if !path.is_file() {
        return Err(invalid(
            "projectConfigFile",
            serde_json::json!({"path": path}),
        ));
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
        return Err(invalid(
            "projectConfigObject",
            serde_json::json!({"field": "manifest"}),
        ));
    }
    if configuration
        .get("pawnkit")
        .is_some_and(|value| !value.is_null() && !value.is_object())
    {
        return Err(invalid(
            "projectConfigObject",
            serde_json::json!({"field": "pawnkit"}),
        ));
    }
    let chosen = selected(configuration, name)?;
    let input = text(&chosen, "input")?;
    let entry = if input.is_empty() {
        text(configuration, "entry")?
    } else {
        input
    };
    if entry.is_empty() {
        return Err(invalid("projectConfigEntryMissing", serde_json::json!({})));
    }
    let field = if input.is_empty() {
        "entry"
    } else {
        "build.input"
    };
    let entry_path = scope.root().join(entry);
    let entry = scope
        .resolve(&entry_path)
        .map_err(|failure| path_error(field, &entry_path, failure))?;
    if !entry.is_file()
        || !entry
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pwn"))
    {
        return Err(invalid(
            "projectConfigEntry",
            serde_json::json!({"field": field, "path": entry}),
        ));
    }
    let mut includes = vec![scope.root().to_owned(), entry.parent().unwrap().to_owned()];
    let include = text(configuration, "include_path")?;
    let mut declared = if include.is_empty() {
        vec![]
    } else {
        vec![("include_path".to_owned(), include.to_owned())]
    };
    declared.extend(
        strings(&configuration["pawnkit"], "includePaths")
            .map_err(|failure| nested_field(failure, "pawnkit"))?
            .into_iter()
            .enumerate()
            .map(|(index, path)| (format!("pawnkit.includePaths[{index}]"), path)),
    );
    declared.extend(
        strings(&chosen, "includes")
            .map_err(|failure| nested_field(failure, "build"))?
            .into_iter()
            .enumerate()
            .map(|(index, path)| (format!("build.includes[{index}]"), path)),
    );
    let arguments = strings(&chosen, "args").map_err(|failure| nested_field(failure, "build"))?;
    declared.extend(
        arguments
            .iter()
            .enumerate()
            .filter_map(|(index, argument)| {
                argument
                    .strip_prefix("-i")
                    .filter(|path| !path.is_empty())
                    .map(|path| (format!("build.args[{index}]"), path.to_owned()))
            }),
    );
    for (field, path) in declared {
        let path = include_directory(scope, std::path::Path::new(&path))
            .map_err(|failure| with_parameter(failure, "field", Value::String(field)))?;
        if !includes.contains(&path) {
            includes.push(path);
        }
    }
    let mut defines = std::collections::BTreeMap::new();
    if let Some(constants) = chosen.get("constants") {
        let constants = constants
            .as_object()
            .filter(|values| values.len() <= 256)
            .ok_or_else(|| invalid("projectConfigConstants", serde_json::json!({})))?;
        for (name, value) in constants {
            let value = match value {
                Value::String(value) => value.clone(),
                Value::Number(value) => value.to_string(),
                Value::Bool(value) => if *value { "1" } else { "0" }.to_owned(),
                Value::Null => "1".to_owned(),
                _ => {
                    return Err(invalid(
                        "projectConfigConstant",
                        serde_json::json!({"name": name}),
                    ));
                }
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
            "projectConfigManifestCount",
            serde_json::json!({"path": scope.root(), "count": manifests.len()}),
        ));
    }
    let manifest = workspace::read_document(&scope.resolve(&manifests[0])?)
        .map_err(|failure| path_error("manifest", &manifests[0], failure))?;
    if manifest.text.len() > 256 * 1024 {
        return Err(invalid(
            "projectConfigSize",
            serde_json::json!({"path": manifest.path}),
        ));
    }
    let configuration: Value = if manifest.path.extension().is_some_and(|ext| ext == "json") {
        serde_json::from_str(&manifest.text).map_err(|failure| {
            invalid(
                "projectConfigSyntax",
                serde_json::json!({
                    "path": manifest.path,
                    "line": failure.line(),
                    "column": failure.column(),
                    "reason": failure.to_string()
                }),
            )
        })?
    } else {
        serde_yaml_ng::from_str(&manifest.text).map_err(|failure| {
            let location = failure.location();
            invalid(
                "projectConfigSyntax",
                serde_json::json!({
                    "path": manifest.path,
                    "line": location.as_ref().map_or(1, |location| location.line()),
                    "column": location.as_ref().map_or(1, |location| location.column()),
                    "reason": failure.to_string()
                }),
            )
        })?
    };
    let build = build_configuration(scope, &configuration, "")
        .map_err(|failure| with_parameter(failure, "manifest", serde_json::json!(manifest.path)))?;
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
        return Err(invalid("projectConfigSetup", serde_json::json!({})));
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
        .map(|input| {
            let input = std::path::Path::new(input);
            let path = include_directory(scope, input)?;
            let value = path
                .strip_prefix(scope.root())
                .unwrap_or(if input.is_absolute() { &path } else { input })
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
    fn picked_include_folders_stay_relative_in_project_preview() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        let local = root.join("include");
        let sdk = parent.path().join("shared SDK");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&sdk).unwrap();
        fs::write(root.join("main.pwn"), "main() {}").unwrap();
        let scope = Workspace::open(&root).unwrap();
        assert_eq!(relative_include_directory(&scope, &root).unwrap(), ".");
        let includes = [&local, &sdk].map(|path| relative_include_directory(&scope, path).unwrap());
        assert_eq!(includes, ["include", "../shared SDK"]);
        let text = preview(&scope, &root.join("main.pwn"), "openmp", &includes).unwrap();
        let configuration: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            configuration["pawnkit"]["includePaths"],
            json!(["include", "../shared SDK"])
        );
        let build = build_configuration(&scope, &configuration, "").unwrap();
        assert!(
            build
                .includes
                .contains(&workspace::canonical(&sdk).unwrap())
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
    fn configuration_failures_identify_the_field_path_and_manifest() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        let manifest = root.path().join("pawn.json");
        for (configuration, code, field) in [
            (
                json!({"entry":"main.pwn", "pawnkit":{"includePaths":["missing SDK"]}}),
                "projectConfigPath",
                "pawnkit.includePaths[0]",
            ),
            (
                json!({"entry":"main.pwn", "include_path":"other.pwn"}),
                "projectConfigDirectory",
                "include_path",
            ),
            (json!({"entry":"missing.pwn"}), "projectConfigPath", "entry"),
            (json!({"entry":"include"}), "projectConfigEntry", "entry"),
            (json!({"entry":42}), "projectConfigString", "entry"),
            (
                json!({"entry":"main.pwn", "pawnkit":42}),
                "projectConfigObject",
                "pawnkit",
            ),
            (
                json!({"entry":"main.pwn", "pawnkit":{"includePaths":42}}),
                "projectConfigStringArray",
                "pawnkit.includePaths",
            ),
            (
                json!({"entry":"main.pwn", "pawnkit":{"includePaths":[42]}}),
                "projectConfigStringItem",
                "pawnkit.includePaths[0]",
            ),
            (
                json!({"entry":"main.pwn", "build":{"args":42}}),
                "projectConfigStringArray",
                "build.args",
            ),
        ] {
            fs::write(&manifest, serde_json::to_vec(&configuration).unwrap()).unwrap();
            let failure = inspect(&scope).unwrap_err();
            let diagnostic = failure
                .get_ref()
                .unwrap()
                .downcast_ref::<ConfigError>()
                .unwrap();
            assert_eq!(diagnostic.code, code, "{configuration}");
            assert_eq!(diagnostic.parameters["field"], field);
            assert_eq!(
                diagnostic.parameters["manifest"],
                serde_json::json!(scope.root().join("pawn.json"))
            );
            if code == "projectConfigPath"
                || code == "projectConfigDirectory"
                || code == "projectConfigEntry"
            {
                let path = diagnostic.parameters["path"].as_str().unwrap();
                assert!(std::path::Path::new(path).is_absolute());
            }
        }
    }

    #[test]
    fn malformed_manifests_report_parser_location_and_recover_after_correction() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        for (name, source) in [
            ("pawn.json", "{\n  \"entry\":\n}"),
            ("pawn.yaml", "entry: main.pwn\npawnkit: [\n"),
        ] {
            let path = root.path().join(name);
            fs::write(&path, source).unwrap();
            let failure = inspect(&scope).unwrap_err();
            let diagnostic = failure
                .get_ref()
                .unwrap()
                .downcast_ref::<ConfigError>()
                .unwrap();
            assert_eq!(diagnostic.code, "projectConfigSyntax");
            assert_eq!(
                diagnostic.parameters["path"],
                serde_json::json!(scope.root().join(name))
            );
            assert!(diagnostic.parameters["line"].as_u64().unwrap() >= 2);
            assert!(diagnostic.parameters["column"].as_u64().unwrap() >= 1);
            assert!(!diagnostic.parameters["reason"].as_str().unwrap().is_empty());
            fs::write(
                &path,
                if name.ends_with("json") {
                    "{\"entry\":\"main.pwn\"}"
                } else {
                    "entry: main.pwn\n"
                },
            )
            .unwrap();
            assert!(inspect(&scope).is_ok());
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn named_build_failures_preserve_the_problem_instead_of_generic_invalid_input() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        for (configuration, name, code) in [
            (
                json!({"entry":"main.pwn", "builds":[{"name":"same"},{"name":"same"}]}),
                "",
                "projectConfigBuildName",
            ),
            (
                json!({"entry":"main.pwn"}),
                "missing",
                "projectConfigUnknownBuild",
            ),
            (
                json!({"entry":"main.pwn", "build":{"constants":{"FEATURE":[]}}}),
                "",
                "projectConfigConstant",
            ),
            (
                json!({"entry":"main.pwn", "builds":{}}),
                "",
                "projectConfigBuilds",
            ),
            (json!({}), "", "projectConfigEntryMissing"),
        ] {
            let failure = build_configuration(&scope, &configuration, name).unwrap_err();
            assert_eq!(
                failure
                    .get_ref()
                    .unwrap()
                    .downcast_ref::<ConfigError>()
                    .unwrap()
                    .code,
                code
            );
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
