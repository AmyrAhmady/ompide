use super::*;
use pawn_core::{
    compiler::{self, BuildResult},
    process::{self, Outcome},
    project::{self, Discovery, ProjectInfo},
};
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

pub struct BuildTask {
    pub id: u64,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
pub struct BuildTools {
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

fn root(state: &NativeState, selected: Option<PathBuf>) -> Result<Workspace> {
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

fn project_error(failure: io::Error) -> AppError {
    if matches!(
        failure.kind(),
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData
    ) {
        error("projectInvalid", failure.to_string())
    } else {
        failure.into()
    }
}

fn bundled(app: &AppHandle) -> Result<PathBuf> {
    let relative = Path::new(env!("OMPIDE_COMPILER_RELATIVE"));
    let installed = app
        .path()
        .resource_dir()
        .map_err(|failure| error("missingBuildTool", failure.to_string()))?
        .join(relative);
    if installed.is_file() {
        return Ok(installed);
    }
    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err(error("missingBuildTool", "pawncc"))
}

fn verify_tools(app: &AppHandle) -> Result<BuildTools> {
    let pins: ToolPins = serde_json::from_str(include_str!(env!("OMPIDE_TOOL_MANIFEST")))
        .map_err(|failure| error("operationFailed", failure.to_string()))?;
    let pin = pins
        .tools
        .into_iter()
        .find(|pin| pin.name == "pawncc")
        .ok_or_else(|| error("missingTool", "missing compiler pin"))?;
    let settings = load_preferences(app.clone())?.settings;
    let configured = settings
        .get("compilerPath")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());
    let source = if configured.is_some() {
        "external"
    } else {
        "bundled"
    };
    let path = match configured {
        Some(path) => workspace::canonical(Path::new(path))?,
        None => bundled(app)?,
    };
    if source == "bundled" && Some(tools::sha256(&path)?).as_ref() != pin.executable_sha256.as_ref()
    {
        return Err(error("buildToolChecksum", "pawncc"));
    }
    let output = process::run(
        compiler::command(&path)?.arg("-h"),
        &AtomicBool::new(false),
        Duration::from_secs(3),
        16384,
    )?;
    let expected = format!("Pawn compiler {}", pin.version);
    if output.outcome != Outcome::Exited
        || !output
            .stdout
            .lines()
            .next()
            .is_some_and(|line| line.trim() == expected || line.starts_with(&(expected + "\t")))
    {
        let mut failure = error("buildToolVersion", "unsupported compiler");
        failure.parameters = serde_json::json!({ "tool": "pawncc", "expected": pin.version });
        return Err(failure);
    }
    Ok(BuildTools {
        compiler: ToolInfo {
            path,
            version: pin.version,
            source,
        },
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
pub async fn inspect_project(state: State<'_, NativeState>, path: PathBuf) -> Result<ProjectInfo> {
    let scope = root(&state, Some(path))?;
    tauri::async_runtime::spawn_blocking(move || project::inspect(&scope))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
        .map_err(project_error)
}

#[tauri::command]
pub async fn build_tools(app: AppHandle) -> Result<BuildTools> {
    tauri::async_runtime::spawn_blocking(move || verify_tools(&app))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
}

#[tauri::command]
pub async fn choose_build_tool(app: AppHandle) -> Result<Option<PathBuf>> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file();
        #[cfg(windows)]
        let picker = picker.add_filter("pawncc", &["exe"]);
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
    state: State<'_, NativeState>,
    entry: PathBuf,
    profile: String,
    includes: Vec<String>,
) -> Result<String> {
    let scope = root(&state, None)?;
    project::preview(&scope, &entry, &profile, &includes).map_err(project_error)
}

#[tauri::command]
pub async fn create_project(state: State<'_, NativeState>, text: String) -> Result<FileSnapshot> {
    if lock(&state.build)?.is_some() {
        return Err(error("buildBusy", "build running"));
    }
    let scope = root(&state, None)?;
    if text.len() > 256 * 1024 {
        return Err(error("projectInvalid", "manifest exceeds 256 KiB"));
    }
    for name in project::MANIFESTS {
        if scope.root().join(name).exists() {
            return Err(error("conflict", "a manifest already exists"));
        }
    }
    let configuration: serde_json::Value = serde_json::from_str(&text)
        .map_err(|failure| error("projectInvalid", failure.to_string()))?;
    project::build_configuration(&scope, &configuration, "").map_err(project_error)?;
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
        let current = project::inspect(&scope).map_err(project_error)?;
        if current.manifest.revision != selection.revision {
            return Err(error("projectChanged", "manifest changed since selection"));
        }
        let configuration =
            project::build_configuration(&scope, &current.configuration, &selection.build)
                .map_err(project_error)?;
        if scope.resolve(&selection.entry)? != configuration.entry
            || selection.profile != current.project.profile
        {
            return Err(error("projectChanged", "selected entry or profile changed"));
        }
        if cfg!(windows)
            && (!scope.root().to_string_lossy().is_ascii()
                || !tools.compiler.path.to_string_lossy().is_ascii()
                || !configuration.entry.to_string_lossy().is_ascii()
                || configuration
                    .includes
                    .iter()
                    .any(|path| !path.to_string_lossy().is_ascii()))
        {
            return Err(error(
                "compilerPathEncoding",
                "compiler requires ANSI-compatible paths",
            ));
        }
        let _ = on_event.send(BuildEvent {
            id,
            stage: "compiling",
        });
        compiler::build(&scope, &configuration, &tools.compiler.path, &cancel).map_err(|failure| {
            if failure.kind() == io::ErrorKind::InvalidInput {
                error("compilerArguments", failure.to_string())
            } else {
                failure.into()
            }
        })
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
