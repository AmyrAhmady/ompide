use super::*;
use pawn_core::{
    process::{self, Outcome},
    project::{self, BuildReport, Discovery, ProjectReport},
};
use std::{
    process::Command,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

pub struct BuildTask {
    pub id: u64,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    project: ProjectReport,
    manifest: FileSnapshot,
    configuration: serde_json::Value,
}
#[derive(Serialize)]
pub struct BuildTools {
    pawn: ToolInfo,
    compiler: ToolInfo,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildEvent {
    id: u64,
    stage: &'static str,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSelection {
    root: PathBuf,
    entry: PathBuf,
    revision: String,
    build: String,
    profile: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    outcome: &'static str,
    report: Option<BuildReport>,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

pub(super) fn root(state: &NativeState, selected: Option<PathBuf>) -> Result<Workspace> {
    let guard = lock(&state.workspace)?;
    let workspace = guard
        .as_ref()
        .ok_or_else(|| error("noWorkspace", "select a workspace folder"))?;
    let root = match selected {
        Some(path) => workspace.resolve(&path)?,
        None => workspace.root().to_owned(),
    };
    Ok(Workspace::open(&root)?)
}
fn pin(name: &str) -> Result<ToolPin> {
    let pins: ToolPins = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../toolchain/tools.json"
    )))
    .map_err(|failure| error("operationFailed", failure.to_string()))?;
    pins.tools
        .into_iter()
        .find(|pin| pin.name == name)
        .ok_or_else(|| error("missingTool", name))
}
fn bundled(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let relative = if name == "pawn" {
        PathBuf::from(if cfg!(windows) { "pawn.exe" } else { "pawn" })
    } else {
        PathBuf::from("binaries/compiler/pawnc-3.10.11-windows/bin/pawncc.exe")
    };
    let installed = if name == "pawn" {
        std::env::current_exe()?
            .parent()
            .ok_or_else(|| error("missingTool", name))?
            .join(&relative)
    } else {
        app.path()
            .resource_dir()
            .map_err(|failure| error("missingTool", failure.to_string()))?
            .join(&relative)
    };
    if installed.is_file() {
        return Ok(installed);
    }
    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join(if name == "pawn" {
            "binaries/pawn-x86_64-pc-windows-msvc.exe"
        } else {
            "binaries/compiler/pawnc-3.10.11-windows/bin/pawncc.exe"
        });
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err(error("missingBuildTool", name))
}
fn verify_tools(app: &AppHandle) -> Result<BuildTools> {
    let settings = load_preferences(app.clone())?.settings;
    let tool = |name: &str, setting: &str| -> Result<ToolInfo> {
        let pin = pin(name)?;
        let configured = settings
            .get(setting)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty());
        let source = if configured.is_some() {
            "external"
        } else {
            "bundled"
        };
        let path = match configured {
            Some(path) => workspace::canonical(Path::new(path))?,
            None => bundled(app, name)?,
        };
        if source == "bundled" && tools::sha256(&path)? != pin.executable_sha256 {
            return Err(error("buildToolChecksum", name));
        }
        let mut command = Command::new(&path);
        if name == "pawn" {
            command.arg("--version");
        } else {
            command.arg("-h");
        }
        let output = process::run(
            &mut command,
            &AtomicBool::new(false),
            Duration::from_secs(3),
            16384,
        )?;
        let expected = if name == "pawn" {
            format!("pawn {}", pin.version)
        } else {
            format!("Pawn compiler {}", pin.version)
        };
        if output.outcome != Outcome::Exited
            || !output.stdout.lines().next().is_some_and(|line| {
                if name == "pawn" {
                    line.trim() == expected
                } else {
                    line.starts_with(&(expected.clone() + "\t")) || line.trim() == expected
                }
            })
        {
            let mut failure = error("buildToolVersion", name);
            failure.parameters = serde_json::json!({ "tool": name, "expected": pin.version });
            return Err(failure);
        }
        Ok(ToolInfo {
            path,
            version: pin.version,
            source,
        })
    };
    Ok(BuildTools {
        pawn: tool("pawn", "pawnPath")?,
        compiler: tool("pawncc", "compilerPath")?,
    })
}
fn call(pawn: &Path, directory: &Path, args: &[String]) -> Result<String> {
    let result = process::run(
        Command::new(pawn).current_dir(directory).args(args),
        &AtomicBool::new(false),
        Duration::from_secs(15),
        2 * 1024 * 1024,
    )?;
    if result.outcome != Outcome::Exited || result.exit_code != Some(0) {
        let mut failure = error("projectInvalid", result.stderr.clone());
        failure.parameters = serde_json::json!({ "reason": result.stderr.trim() });
        return Err(failure);
    }
    Ok(result.stdout)
}
fn inspect(pawn: &Path, scope: &Workspace) -> Result<ProjectInfo> {
    if project::MANIFESTS
        .iter()
        .filter(|name| scope.root().join(name).is_file())
        .count()
        > 1
    {
        return Err(error(
            "projectAmbiguous",
            "multiple manifests in the selected project folder",
        ));
    }
    let text = call(
        pawn,
        scope.root(),
        &[
            "project".into(),
            "--project".into(),
            scope.root().to_string_lossy().into(),
            "--output".into(),
            "json".into(),
        ],
    )?;
    let project = project::parse_project(&text, scope)
        .map_err(|failure| error("projectInvalid", failure.to_string()))?;
    let manifest = workspace::read_document(&scope.resolve(&project.manifest)?)?;
    if manifest.text.len() > 256 * 1024 {
        return Err(error("projectInvalid", "manifest exceeds 256 KiB"));
    }
    let configuration = if manifest
        .path
        .extension()
        .is_some_and(|extension| extension == "json")
    {
        serde_json::from_str(&manifest.text)
            .map_err(|failure| error("projectInvalid", failure.to_string()))?
    } else {
        serde_yaml_ng::from_str(&manifest.text)
            .map_err(|failure| error("projectInvalid", failure.to_string()))?
    };
    Ok(ProjectInfo {
        project,
        manifest,
        configuration,
    })
}

#[tauri::command]
pub async fn discover_projects(state: State<'_, NativeState>) -> Result<Discovery> {
    let workspace = root(&state, None)?;
    tauri::async_runtime::spawn_blocking(move || project::discover(&workspace))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
        .map_err(Into::into)
}
#[tauri::command]
pub async fn inspect_project(
    app: AppHandle,
    state: State<'_, NativeState>,
    path: PathBuf,
) -> Result<ProjectInfo> {
    let scope = root(&state, Some(path))?;
    tauri::async_runtime::spawn_blocking(move || {
        let tools = verify_tools(&app)?;
        inspect(&tools.pawn.path, &scope)
    })
    .await
    .map_err(|failure| error("operationFailed", failure.to_string()))?
}
#[tauri::command]
pub async fn build_tools(app: AppHandle) -> Result<BuildTools> {
    tauri::async_runtime::spawn_blocking(move || verify_tools(&app))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
}
#[tauri::command]
pub async fn choose_build_tool(app: AppHandle, compiler: bool) -> Result<Option<PathBuf>> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file();
        #[cfg(windows)]
        let picker = picker.add_filter(if compiler { "pawncc" } else { "pawn" }, &["exe"]);
        picker.blocking_pick_file()
    })
    .await
    .map_err(|failure| error("operationFailed", failure.to_string()))?;
    selected
        .map(|file| {
            file.into_path()
                .map_err(|failure| error("operationFailed", failure.to_string()))
        })
        .transpose()
}

#[tauri::command]
pub async fn preview_project(
    app: AppHandle,
    state: State<'_, NativeState>,
    entry: PathBuf,
    profile: String,
    includes: Vec<String>,
) -> Result<String> {
    let scope = root(&state, None)?;
    let entry = scope.resolve(&entry)?;
    if !matches!(profile.as_str(), "openmp" | "samp")
        || !entry
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pwn"))
        || includes.len() > 64
    {
        return Err(error("projectInvalid", "invalid project setup"));
    }
    let mut args = vec![
        "init".into(),
        "--dry-run".into(),
        "--project".into(),
        scope.root().to_string_lossy().into(),
        "--entry".into(),
        entry.to_string_lossy().into(),
        "--target".into(),
        profile,
    ];
    for include in includes {
        args.push("--include".into());
        args.push(scope.resolve(Path::new(&include))?.to_string_lossy().into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tools = verify_tools(&app)?;
        call(&tools.pawn.path, scope.root(), &args)
    })
    .await
    .map_err(|failure| error("operationFailed", failure.to_string()))?
}
#[tauri::command]
pub async fn create_project(state: State<'_, NativeState>, text: String) -> Result<FileSnapshot> {
    if lock(&state.build)?.is_some() {
        return Err(error("buildBusy", "build running"));
    }
    let scope = root(&state, None)?;
    for name in project::MANIFESTS {
        if scope.root().join(name).exists() {
            return Err(error("conflict", "a manifest already exists"));
        }
    }
    // Only accept a PawnKit init preview with relative existing paths, never a new schema.
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .map_err(|failure| error("projectInvalid", failure.to_string()))?;
    let entry = manifest
        .get("entry")
        .and_then(|value| value.as_str())
        .ok_or_else(|| error("projectInvalid", "missing entry"))?;
    scope.resolve(Path::new(entry))?;
    Ok(workspace::write_document(
        &scope.root().join("pawn.json"),
        &text,
        false,
        None,
    )?)
}

#[tauri::command]
pub async fn build_project(
    app: AppHandle,
    state: State<'_, NativeState>,
    selection: BuildSelection,
    on_event: Channel<BuildEvent>,
) -> Result<BuildResult> {
    let scope = root(&state, Some(selection.root.clone()))?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = lock(&state.build)?;
        if slot.is_some() {
            return Err(error("buildBusy", "build running"));
        }
        *slot = Some(BuildTask {
            id,
            cancel: cancel.clone(),
        });
    }
    let _ = on_event.send(BuildEvent {
        id,
        stage: "preparing",
    });
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<BuildResult> {
        let tools = verify_tools(&app)?;
        let current = inspect(&tools.pawn.path, &scope)?;
        if current.manifest.revision != selection.revision {
            return Err(error("projectChanged", "manifest changed since selection"));
        }
        if current.manifest.path.extension().is_none_or(|extension| extension != "json")
            && current.configuration.get("pawnkit").and_then(|value| value.get("schemaVersion")).is_some() {
            return Err(error("yamlSchema", "pinned PawnKit rejects integer schemaVersion in YAML; use JSON for PawnKit extension settings"));
        }
        let mut entry = current.project.entry.clone();
        let manifest = &current.configuration;
        let defaults = manifest.get("build");
        let named = manifest.get("builds").and_then(|value| value.as_array());
        let selected = if selection.build.is_empty() {
            defaults.or_else(|| named.and_then(|builds| builds.first()))
        } else {
            Some(
                named
                    .and_then(|builds| {
                        builds.iter().find(|build| {
                            build.get("name").and_then(|value| value.as_str())
                                == Some(&selection.build)
                        })
                    })
                    .ok_or_else(|| error("projectInvalid", "unknown build selection"))?,
            )
        };
        if let Some(input) = selected
            .and_then(|build| build.get("input"))
            .and_then(|value| value.as_str())
            .filter(|input| !input.is_empty())
            .or_else(|| {
                defaults
                    .and_then(|build| build.get("input"))
                    .and_then(|value| value.as_str())
                    .filter(|input| !input.is_empty())
            })
        {
            entry = scope.resolve(Path::new(input))?;
        }
        if scope.resolve(&selection.entry)? != scope.resolve(&entry)?
            || selection.profile != current.project.profile
        {
            return Err(error("projectChanged", "selected entry or profile changed"));
        }
        if !scope.root().to_string_lossy().is_ascii()
            || !tools.compiler.path.to_string_lossy().is_ascii()
        {
            return Err(error(
                "compilerPathEncoding",
                "compiler requires ANSI-compatible paths; use an ASCII path",
            ));
        }
        let output_directory = scope.root().join("output");
        match fs::create_dir(&output_directory) {
            Ok(()) => {}
            Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => {}
            Err(failure) => return Err(failure.into()),
        }
        let directory = scope.resolve(&output_directory)?;
        let name = entry
            .file_stem()
            .ok_or_else(|| error("projectInvalid", "missing entry name"))?
            .to_string_lossy();
        let artifact = directory.join(format!("{name}.amx"));
        if fs::symlink_metadata(&artifact)
            .is_ok_and(|metadata| metadata.is_symlink() || !metadata.is_file())
        {
            return Err(error("permissionDenied", "unsafe artifact target"));
        }
        match fs::remove_file(&artifact) { Ok(()) => {}, Err(failure) if failure.kind() == io::ErrorKind::NotFound => {}, Err(failure) => return Err(failure.into()) }
        let mut command = Command::new(&tools.pawn.path);
        command
            .current_dir(scope.root())
            .args(["build", "--project"])
            .arg(scope.root())
            .args(["--format", "json", "--compiler"])
            .arg(&tools.compiler.path)
            .arg("--artifact")
            .arg(&artifact);
        if !selection.build.is_empty() {
            command.args(["--build", &selection.build]);
        }
        command.args(["--profile", &selection.profile]);
        let _ = on_event.send(BuildEvent {
            id,
            stage: "compiling",
        });
        let output = process::run(
            &mut command,
            &cancel,
            Duration::from_secs(15 * 60),
            8 * 1024 * 1024,
        )?;
        if output.outcome != Outcome::Exited {
            // A cancelled/limited build must never leave an apparently successful artifact.
            let _ = fs::remove_file(&artifact);
            return Ok(BuildResult {
                outcome: match output.outcome {
                    Outcome::Cancelled => "cancelled",
                    Outcome::Timeout => "timeout",
                    _ => "outputLimit",
                },
                report: None,
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code,
            });
        }
        match project::parse_build(&output.stdout, output.exit_code) {
            Ok(report) => {
                if report.status == "passed" {
                    for item in &report.artifacts {
                        if scope.resolve(&item.path)? != artifact
                            || fs::metadata(&item.path)?.len() != item.size
                            || item.size == 0
                        {
                            return Err(error("buildReport", "artifact verification failed"));
                        }
                    }
                }
                Ok(BuildResult {
                    outcome: "completed",
                    report: Some(report),
                    stdout: String::new(),
                    stderr: output.stderr,
                    exit_code: output.exit_code,
                })
            }
            Err(_) => Ok(BuildResult {
                outcome: "invalidReport",
                report: None,
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code,
            }),
        }
    })
    .await
    .map_err(|failure| error("operationFailed", failure.to_string()));
    {
        let mut slot = lock(&state.build)?;
        if slot.as_ref().is_some_and(|task| task.id == id) {
            slot.take();
        }
    }
    result?
}
#[tauri::command]
pub async fn cancel_build(state: State<'_, NativeState>, id: u64) -> Result<()> {
    if let Some(task) = lock(&state.build)?.as_ref().filter(|task| task.id == id) {
        task.cancel.store(true, Ordering::Release);
    }
    Ok(())
}
