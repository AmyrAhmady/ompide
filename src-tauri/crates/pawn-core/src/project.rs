//! Filesystem discovery only. PawnKit remains responsible for project semantics.
use crate::workspace::{self, Workspace};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReport {
    pub schema_version: u32,
    pub root: PathBuf,
    pub manifest: PathBuf,
    pub entry: PathBuf,
    pub profile: String,
    pub build: String,
}
pub fn parse_project(text: &str, scope: &Workspace) -> io::Result<ProjectReport> {
    let report: ProjectReport = serde_json::from_str(text)?;
    if report.schema_version != 1 || workspace::canonical(&report.root)? != scope.root() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported project report",
        ));
    }
    scope.resolve(&report.manifest)?;
    scope.resolve(&report.entry)?;
    Ok(report)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildReport {
    pub kind: String,
    pub schema_version: u32,
    pub status: String,
    pub artifacts: Vec<Artifact>,
    pub diagnostics: Vec<Diagnostic>,
    pub process: BuildProcess,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Artifact {
    pub path: PathBuf,
    pub size: u64,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub primary: Location,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Location {
    pub uri: String,
    pub range: Option<Range>,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildProcess {
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub truncated: bool,
}
pub fn parse_build(text: &str, exit_code: Option<i32>) -> io::Result<BuildReport> {
    let report: BuildReport = serde_json::from_str(text)?;
    if report.schema_version != 2
        || report.kind != "result"
        || !matches!(report.status.as_str(), "passed" | "failed" | "cancelled")
        || (report.status == "passed"
            && (exit_code != Some(0)
                || report.process.exit_code != Some(0)
                || report.artifacts.is_empty()))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inconsistent build result",
        ));
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_nested_projects_and_ignores_dependency_and_output_trees() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        fs::create_dir(root.path().join("vendor")).unwrap();
        for name in [
            "one.pwn",
            "two.PWN",
            "nested/pawn.yaml",
            "vendor/pawn.json",
            "vendor/ignore.pwn",
        ] {
            fs::write(root.path().join(name), "").unwrap();
        }
        let result = discover(&Workspace::open(root.path()).unwrap()).unwrap();
        assert_eq!(result.manifests.len(), 1);
        assert_eq!(result.entries.len(), 2);
        assert!(!result.truncated);
    }
    #[test]
    fn rejects_false_success_and_unsupported_build_schemas() {
        let report = serde_json::json!({"kind":"result","schemaVersion":2,"status":"passed","artifacts":[{"path":"output/main.amx","size":12}],"diagnostics":[],"process":{"exitCode":0}});
        assert!(parse_build(&report.to_string(), Some(0)).is_ok());
        assert!(parse_build(&report.to_string(), Some(1)).is_err());
        let mut invalid = report;
        invalid["artifacts"] = serde_json::json!([]);
        assert!(parse_build(&invalid.to_string(), Some(0)).is_err());
        invalid["schemaVersion"] = 1.into();
        assert!(parse_build(&invalid.to_string(), Some(0)).is_err());
    }
}
