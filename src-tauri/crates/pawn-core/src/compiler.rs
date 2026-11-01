//! Direct open.mp compiler execution and presentation of its documented diagnostics.
use crate::{
    process::{self, Outcome},
    project::BuildConfiguration,
    workspace::{self, Workspace},
};
use regex::Regex;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};

/// Read the selected executable's own banner rather than substituting a tool pin.
pub fn reported_version(output: &str) -> Option<&str> {
    let banner = output.lines().next()?.trim();
    let version = banner
        .strip_prefix("Pawn compiler ")?
        .split_whitespace()
        .next()?;
    Regex::new(r"^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$")
        .unwrap()
        .is_match(version)
        .then_some(version)
}

/// Configure only the selected compiler process's bundled shared-library path.
/// The upstream Linux distribution has an absolute build-machine RUNPATH.
pub fn command(executable: &Path) -> io::Result<Command> {
    #[cfg(not(target_os = "linux"))]
    {
        Ok(Command::new(executable))
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new(executable);
        if let Some(parent) = executable.parent().and_then(Path::parent) {
            let library = parent.join("lib");
            if library.join("libpawnc.so").is_file() {
                let mut paths = vec![library];
                if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") {
                    paths.extend(std::env::split_paths(&existing));
                }
                let value = std::env::join_paths(paths)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
                command.env("LD_LIBRARY_PATH", value);
            }
        }
        Ok(command)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub outcome: &'static str,
    pub report: Option<BuildReport>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct BuildReport {
    pub status: &'static str,
    pub artifacts: Vec<Artifact>,
    pub diagnostics: Vec<Diagnostic>,
    pub process: BuildProcess,
}

#[derive(Debug, Serialize)]
pub struct Artifact {
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: &'static str,
    pub message: String,
    pub primary: Location,
}

#[derive(Debug, Serialize)]
pub struct Location {
    pub uri: String,
    pub range: Range,
}

#[derive(Debug, Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Serialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildProcess {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

fn invalid(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, reason.into())
}

fn define(value: &str) -> bool {
    let Some((name, value)) = value.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.len() <= 63
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic() || byte == b'_' || index > 0 && byte.is_ascii_digit()
        })
        && !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

/// The IDE owns source selection, working directory and output. Response files
/// and options that redirect writes or select non-AMX output are not accepted.
pub fn arguments(
    scope: &Workspace,
    configuration: &BuildConfiguration,
    artifact: &Path,
) -> io::Result<Vec<String>> {
    let safe = Regex::new(r"^-(?:A\d+|C[+-]?|c[A-Za-z0-9_-]+|d[0-3]|O[0-2]|R[+-]?|S\d+|s\d+|t\d+|v[0-2]|w\d+|X(?:D)?\d+|Z[+-]?|E[+-]?|[;\(][+-]?|[\\^])$").unwrap();
    let mut result = vec![configuration.entry.to_string_lossy().into_owned()];
    for argument in &configuration.arguments {
        if let Some(include) = argument
            .strip_prefix("-i")
            .filter(|value| !value.is_empty())
        {
            let include = scope.resolve(Path::new(include))?;
            if !include.is_dir() {
                return Err(invalid("compiler include path is not a directory"));
            }
            result.push(format!("-i{}", include.display()));
        } else if safe.is_match(argument) || define(argument) {
            result.push(argument.clone());
        } else {
            return Err(invalid(format!("unsupported compiler option: {argument}")));
        }
    }
    result.push(format!("-D{}", scope.root().display()));
    for include in &configuration.includes {
        result.push(format!("-i{}", include.display()));
    }
    for (name, value) in &configuration.defines {
        let argument = format!("{name}={value}");
        if !define(&argument) {
            return Err(invalid("invalid compiler constant"));
        }
        result.push(argument);
    }
    result.push(format!("-o{}", artifact.display()));
    Ok(result)
}

pub fn diagnostics(scope: &Workspace, stdout: &str, stderr: &str) -> Vec<Diagnostic> {
    let pattern = Regex::new(r"^(.+)\(([0-9]+)(?:\s*--\s*[0-9]+)?\)\s*:\s*(fatal error|error|warning)\s+([0-9]+):\s*(.+)$").unwrap();
    let mut result = vec![];
    let mut seen = HashSet::new();
    for line in stdout.lines().chain(stderr.lines()) {
        let Some(parts) = pattern.captures(line.trim()) else {
            continue;
        };
        let Ok(number) = parts[2].parse::<u32>() else {
            continue;
        };
        let Ok(path) = scope.resolve(Path::new(&parts[1])) else {
            continue;
        };
        let Ok(uri) = workspace::file_uri(&path) else {
            continue;
        };
        let code = format!("pawncc-{}", &parts[4]);
        let message = parts[5].to_owned();
        if !seen.insert((uri.clone(), number, code.clone(), message.clone())) {
            continue;
        }
        result.push(Diagnostic {
            code,
            severity: if &parts[3] == "warning" {
                "warning"
            } else {
                "error"
            },
            message,
            primary: Location {
                uri,
                range: Range {
                    start: Position {
                        line: number.saturating_sub(1),
                        character: 0,
                    },
                    end: Position {
                        line: number.saturating_sub(1),
                        character: 1,
                    },
                },
            },
        });
    }
    result
}

fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(failure) => Err(failure),
    }
}

pub fn build(
    scope: &Workspace,
    configuration: &BuildConfiguration,
    compiler: &Path,
    cancel: &AtomicBool,
) -> io::Result<BuildResult> {
    let name = configuration
        .entry
        .file_stem()
        .ok_or_else(|| invalid("missing entry file name"))?
        .to_string_lossy();
    let output = scope.new_child(scope.root(), "output")?;
    if fs::symlink_metadata(&output).is_ok_and(|metadata| metadata.is_symlink()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "output directory is a symbolic link",
        ));
    }
    let artifact = output.join(format!("{name}.amx"));
    let arguments = arguments(scope, configuration, &artifact)?;
    match fs::create_dir(&output) {
        Ok(()) => {}
        Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => {}
        Err(failure) => return Err(failure),
    }
    let output = scope.resolve(&output)?;
    let artifact = scope.new_child(&output, &format!("{name}.amx"))?;
    if fs::symlink_metadata(&artifact)
        .is_ok_and(|metadata| metadata.is_symlink() || !metadata.is_file())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsafe compiler artifact",
        ));
    }
    remove(&artifact)?;
    let result = match process::run(
        command(compiler)?.current_dir(scope.root()).args(arguments),
        cancel,
        Duration::from_secs(15 * 60),
        8 * 1024 * 1024,
    ) {
        Ok(result) => result,
        Err(failure) => {
            remove(&artifact)?;
            return Err(failure);
        }
    };
    if result.outcome != Outcome::Exited {
        remove(&artifact)?;
        return Ok(BuildResult {
            outcome: match result.outcome {
                Outcome::Cancelled => "cancelled",
                Outcome::Timeout => "timeout",
                _ => "outputLimit",
            },
            report: None,
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exit_code,
        });
    }
    let diagnostics = diagnostics(scope, &result.stdout, &result.stderr);
    let passed =
        result.exit_code == Some(0) && !diagnostics.iter().any(|item| item.severity == "error");
    let mut artifacts = vec![];
    let mut outcome = "completed";
    if passed {
        let valid = (|| -> io::Result<u64> {
            if fs::symlink_metadata(&artifact)?.is_symlink() {
                return Err(invalid("symbolic artifact"));
            }
            let mut file = fs::File::open(&artifact)?;
            let size = file.metadata()?.len();
            let mut header = [0u8; 6];
            file.read_exact(&mut header)?;
            if size < 56 || u16::from_le_bytes([header[4], header[5]]) != 0xf1e0 {
                return Err(invalid("invalid 32-bit Pawn AMX header"));
            }
            Ok(size)
        })();
        if let Ok(size) = valid {
            artifacts.push(Artifact {
                path: artifact.clone(),
                size,
            });
        } else {
            outcome = "invalidArtifact";
        }
    }
    if !passed || outcome != "completed" {
        remove(&artifact)?;
    }
    Ok(BuildResult {
        outcome,
        stdout: String::new(),
        stderr: String::new(),
        exit_code: result.exit_code,
        report: Some(BuildReport {
            status: if passed && outcome == "completed" {
                "passed"
            } else {
                "failed"
            },
            artifacts,
            diagnostics,
            process: BuildProcess {
                exit_code: result.exit_code,
                stdout: result.stdout,
                stderr: result.stderr,
                truncated: false,
            },
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project;
    use serde_json::json;

    #[test]
    fn detects_selected_compiler_versions_without_requiring_the_bundled_version() {
        for version in [
            "3.10.11",
            "3.10.10",
            "3.2.3664",
            "3.10.11.1",
            "3.11.0-beta.1",
        ] {
            let banner =
                format!("Pawn compiler {version}\tCopyright (c) contributors\r\nUsage: pawncc\r\n");
            assert_eq!(reported_version(&banner), Some(version));
        }
        for banner in [
            "",
            "unrelated tool 3.10.11",
            "Pawn compiler unknown",
            "Pawn compiler 3",
            "error\nPawn compiler 3.10.11",
        ] {
            assert_eq!(reported_version(banner), None);
        }
    }

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("main.pwn"), "main() {}\n").unwrap();
        root
    }

    #[test]
    fn parses_real_compiler_locations_ranges_unicode_and_duplicate_output() {
        let root = fixture();
        fs::write(root.path().join("🦀 header.inc"), "// fixture").unwrap();
        let scope = Workspace::open(root.path()).unwrap();
        let text = "main.pwn(2) : error 017: undefined symbol \"MissingFunction\"\n🦀 header.inc(7 -- 9) : warning 213: tag mismatch\n../../outside.pwn(1) : error 001: outside\n";
        let items = diagnostics(&scope, text, text);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].code, "pawncc-017");
        assert_eq!(items[0].severity, "error");
        assert_eq!(items[0].primary.range.start.line, 1);
        assert_eq!(items[1].primary.range.start.line, 6);
        assert_eq!(items[1].severity, "warning");
        assert!(items[1].primary.uri.contains("%F0%9F%A6%80"));
    }

    #[test]
    fn builds_argument_arrays_with_inherited_flags_constants_and_owned_output() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        let configuration = project::build_configuration(&scope, &json!({"entry":"main.pwn", "build":{"args":["-d3", "-O2", "-E+", "-;"], "constants":{"FEATURE":true}}}), "").unwrap();
        let artifact = scope.root().join("output/main.amx");
        let args = arguments(&scope, &configuration, &artifact).unwrap();
        assert_eq!(args[0], scope.root().join("main.pwn").to_string_lossy());
        assert!(args.contains(&"FEATURE=1".to_owned()));
        assert!(args.contains(&"-d3".to_owned()));
        assert_eq!(args.last().unwrap(), &format!("-o{}", artifact.display()));
    }

    #[test]
    fn rejects_write_redirection_response_files_and_extra_sources_before_execution() {
        let root = fixture();
        let scope = Workspace::open(root.path()).unwrap();
        for option in [
            "-o../outside",
            "-eerrors.log",
            "-D..",
            "-rreport",
            "-a",
            "-l",
            "@options.txt",
            "other.pwn",
            "/ooutside",
        ] {
            let configuration = project::build_configuration(
                &scope,
                &json!({"entry":"main.pwn", "build":{"args":[option]}}),
                "",
            )
            .unwrap();
            assert!(
                build(
                    &scope,
                    &configuration,
                    Path::new("must-not-run"),
                    &AtomicBool::new(false)
                )
                .is_err(),
                "{option}"
            );
            assert!(!scope.root().join("output").exists());
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn bundled_library_lookup_is_scoped_to_the_compiler_child() {
        let root = tempfile::tempdir().unwrap();
        let library = root.path().join("lib");
        fs::create_dir(&library).unwrap();
        fs::write(library.join("libpawnc.so"), b"fixture").unwrap();
        let executable = root.path().join("bin/pawncc");
        let before = std::env::var_os("LD_LIBRARY_PATH");
        let child = command(&executable).unwrap();
        let (_, value) = child
            .get_envs()
            .find(|(key, _)| *key == "LD_LIBRARY_PATH")
            .unwrap();
        assert_eq!(std::env::split_paths(value.unwrap()).next(), Some(library));
        assert_eq!(std::env::var_os("LD_LIBRARY_PATH"), before);
        assert_eq!(
            command(Path::new("/external/bin/pawncc"))
                .unwrap()
                .get_envs()
                .count(),
            0
        );
    }
}
