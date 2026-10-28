use pawn_core::{
    lsp::{LspEvent, LspSession},
    tools::{self, ToolError},
    watch::{FileWatch, WatchEvent},
    workspace::{self, Entry, FileSnapshot, Workspace},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct NativeState {
    workspace: Mutex<Option<Workspace>>,
    allowed: Mutex<HashSet<PathBuf>>,
    pub lsp: Mutex<Option<(u64, LspSession)>>,
    next: AtomicU64,
    chosen_workspace: Mutex<Option<PathBuf>>,
    pub watch: Mutex<Option<FileWatch>>,
    preferences_lock: Mutex<()>,
}

#[derive(Debug, Serialize)]
pub struct AppError {
    code: &'static str,
    detail: String,
    parameters: serde_json::Value,
}
impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        Self {
            code: match error.kind() {
                io::ErrorKind::NotFound => "notFound",
                io::ErrorKind::PermissionDenied => "permissionDenied",
                io::ErrorKind::AlreadyExists => "conflict",
                io::ErrorKind::InvalidData => "encoding",
                io::ErrorKind::FileTooLarge => "fileTooLarge",
                _ => "operationFailed",
            },
            detail: error.to_string(),
            parameters: serde_json::Value::Null,
        }
    }
}
type Result<T> = std::result::Result<T, AppError>;
fn error(code: &'static str, detail: impl Into<String>) -> AppError {
    AppError {
        code,
        detail: detail.into(),
        parameters: serde_json::Value::Null,
    }
}
fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| error("operationFailed", "state lock poisoned"))
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    #[serde(default)]
    pub recent_workspaces: Vec<PathBuf>,
    #[serde(default)]
    pub recent_files: Vec<PathBuf>,
    #[serde(default)]
    pub settings: serde_json::Value,
}
fn preferences_path(app: &AppHandle) -> Result<PathBuf> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| error("operationFailed", e.to_string()))?;
    fs::create_dir_all(&directory)?;
    Ok(directory.join("preferences.json"))
}
#[tauri::command]
pub fn load_preferences(app: AppHandle) -> Result<Preferences> {
    match fs::read(preferences_path(&app)?) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| error("settingsInvalid", e.to_string()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(e) => Err(e.into()),
    }
}
#[tauri::command]
pub fn store_preferences(
    app: AppHandle,
    state: State<'_, NativeState>,
    settings: serde_json::Value,
) -> Result<()> {
    let _guard = lock(&state.preferences_lock)?;
    let mut preferences = load_preferences(app.clone())?;
    preferences.settings = settings;
    write_preferences(&app, &preferences)
}
fn write_preferences(app: &AppHandle, preferences: &Preferences) -> Result<()> {
    let path = preferences_path(app)?;
    let expected = match workspace::read_document(&path) {
        Ok(snapshot) => Some(snapshot.revision),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let text = serde_json::to_string_pretty(preferences)
        .map_err(|e| error("operationFailed", e.to_string()))?;
    workspace::write_document(&path, &text, false, expected.as_deref())?;
    Ok(())
}
fn select_workspace(app: &AppHandle, state: &NativeState, path: &Path) -> Result<PathBuf> {
    let workspace = Workspace::open(path)?;
    let root = workspace.root().to_path_buf();
    {
        let _guard = lock(&state.preferences_lock)?;
        let mut preferences = load_preferences(app.clone())?;
        preferences.recent_workspaces.retain(|path| path != &root);
        preferences.recent_workspaces.insert(0, root.clone());
        preferences.recent_workspaces.truncate(12);
        write_preferences(app, &preferences)?;
    }
    lock(&state.lsp)?.take();
    lock(&state.watch)?.take();
    *lock(&state.workspace)? = Some(workspace);
    lock(&state.allowed)?.clear();
    Ok(root)
}
#[tauri::command]
pub async fn choose_workspace(
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<Option<PathBuf>> {
    let handle = app.clone();
    let selected =
        tauri::async_runtime::spawn_blocking(move || handle.dialog().file().blocking_pick_folder())
            .await
            .map_err(|e| error("operationFailed", e.to_string()))?;
    let path = selected
        .map(|file| {
            file.into_path()
                .map_err(|e| error("operationFailed", e.to_string()))
        })
        .transpose()?;
    *lock(&state.chosen_workspace)? = path.clone();
    Ok(path)
}

#[tauri::command]
pub fn activate_workspace(
    app: AppHandle,
    state: State<'_, NativeState>,
    path: PathBuf,
) -> Result<PathBuf> {
    if lock(&state.chosen_workspace)?.as_ref() != Some(&path) {
        return Err(error("permissionDenied", "workspace was not selected"));
    }
    let root = select_workspace(&app, &state, &path)?;
    lock(&state.chosen_workspace)?.take();
    Ok(root)
}
#[tauri::command]
pub fn recent_workspace(
    app: AppHandle,
    state: State<'_, NativeState>,
    path: PathBuf,
) -> Result<PathBuf> {
    if !load_preferences(app.clone())?
        .recent_workspaces
        .contains(&path)
    {
        return Err(error(
            "permissionDenied",
            "workspace is not in recent history",
        ));
    }
    select_workspace(&app, &state, &path)
}
#[tauri::command]
pub async fn choose_document(
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<Option<FileSnapshot>> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Pawn", &["pwn", "inc"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| error("operationFailed", e.to_string()))?;
    selected
        .map(|file| {
            let path = file
                .into_path()
                .map_err(|e| error("operationFailed", e.to_string()))?;
            let snapshot = workspace::read_document(&path)?;
            lock(&state.allowed)?.insert(snapshot.path.clone());
            Ok(snapshot)
        })
        .transpose()
}
fn permitted(state: &NativeState, path: &Path) -> Result<PathBuf> {
    let canonical = workspace::canonical(path)?;
    if lock(&state.allowed)?.contains(&canonical) {
        return Ok(canonical);
    }
    lock(&state.workspace)?
        .as_ref()
        .ok_or_else(|| error("noWorkspace", "no workspace selected"))?
        .resolve(&canonical)
        .map_err(Into::into)
}
#[tauri::command]
pub async fn remember_document(
    app: AppHandle,
    state: State<'_, NativeState>,
    path: PathBuf,
) -> Result<Vec<PathBuf>> {
    let path = permitted(&state, &path)?;
    let _guard = lock(&state.preferences_lock)?;
    let mut preferences = load_preferences(app.clone())?;
    if preferences.recent_files.first() != Some(&path) {
        preferences.recent_files.retain(|other| other != &path);
        preferences.recent_files.insert(0, path);
        preferences.recent_files.truncate(12);
        write_preferences(&app, &preferences)?;
    }
    Ok(preferences.recent_files)
}
#[tauri::command]
pub async fn recent_document(
    app: AppHandle,
    state: State<'_, NativeState>,
    path: PathBuf,
) -> Result<FileSnapshot> {
    if !load_preferences(app)?.recent_files.contains(&path) {
        return Err(error("permissionDenied", "file is not in recent history"));
    }
    let snapshot = workspace::read_document(&path)?;
    lock(&state.allowed)?.insert(snapshot.path.clone());
    Ok(snapshot)
}
#[tauri::command]
pub async fn read_document(state: State<'_, NativeState>, path: PathBuf) -> Result<FileSnapshot> {
    Ok(workspace::read_document(&permitted(&state, &path)?)?)
}
#[tauri::command]
pub async fn save_document(
    state: State<'_, NativeState>,
    path: PathBuf,
    text: String,
    bom: bool,
    revision: String,
) -> Result<FileSnapshot> {
    Ok(workspace::write_document(
        &permitted(&state, &path)?,
        &text,
        bom,
        Some(&revision),
    )?)
}
#[tauri::command]
pub async fn save_document_as(
    app: AppHandle,
    state: State<'_, NativeState>,
    text: String,
    bom: bool,
    protected_paths: Vec<PathBuf>,
) -> Result<Option<FileSnapshot>> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Pawn", &["pwn", "inc"])
            .set_file_name("untitled.pwn")
            .blocking_save_file()
    })
    .await
    .map_err(|e| error("operationFailed", e.to_string()))?;
    selected
        .map(|file| {
            let path = file
                .into_path()
                .map_err(|e| error("operationFailed", e.to_string()))?;
            // Native Save dialog supplies overwrite confirmation. Capture current disk version.
            if let Ok(canonical) = workspace::canonical(&path)
                && protected_paths
                    .iter()
                    .any(|other| workspace::canonical(other).is_ok_and(|other| other == canonical))
            {
                return Err(error(
                    "alreadyOpen",
                    "destination is open in another editor",
                ));
            }
            let expected = match workspace::read_document(&path) {
                Ok(snapshot) => Some(snapshot.revision),
                Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            };
            let snapshot = workspace::write_document(&path, &text, bom, expected.as_deref())?;
            lock(&state.allowed)?.insert(snapshot.path.clone());
            Ok(snapshot)
        })
        .transpose()
}
#[tauri::command]
pub async fn list_directory(state: State<'_, NativeState>, path: PathBuf) -> Result<Vec<Entry>> {
    Ok(lock(&state.workspace)?
        .as_ref()
        .ok_or_else(|| error("noWorkspace", "no workspace selected"))?
        .entries(&path)?)
}

fn bundled_lsp() -> Result<PathBuf> {
    let executable_name = if cfg!(windows) {
        "pawnlsp.exe"
    } else {
        "pawnlsp"
    };
    let packaged = std::env::current_exe()?
        .parent()
        .ok_or_else(|| error("missingTool", "application directory unavailable"))?
        .join(executable_name);
    if packaged.is_file() {
        return Ok(packaged);
    }
    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/pawnlsp-x86_64-pc-windows-msvc.exe");
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err(error("missingTool", "pawnlsp"))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolPin {
    name: String,
    version: String,
    executable_sha256: String,
}
#[derive(Deserialize)]
struct ToolPins {
    tools: Vec<ToolPin>,
}
#[derive(Serialize)]
pub struct ToolInfo {
    path: PathBuf,
    version: String,
    source: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageStart {
    session_id: u64,
    tool: ToolInfo,
}

fn verified_lsp(app: &AppHandle) -> Result<ToolInfo> {
    let pins: ToolPins = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../toolchain/tools.json"
    )))
    .map_err(|failure| error("operationFailed", failure.to_string()))?;
    let pin = pins
        .tools
        .into_iter()
        .find(|pin| pin.name == "pawnlsp")
        .ok_or_else(|| error("missingTool", "missing pawnlsp pin"))?;
    let preferences = load_preferences(app.clone())?;
    let configured = preferences
        .settings
        .get("languageServerPath")
        .and_then(|value| value.as_str())
        .filter(|path| !path.is_empty());
    let (path, source) = match configured {
        Some(path) => (workspace::canonical(Path::new(path))?, "external"),
        None => (bundled_lsp()?, "bundled"),
    };
    tools::verify(
        &path,
        &["--version"],
        &pin.version,
        (source == "bundled").then_some(pin.executable_sha256.as_str()),
    )
    .map_err(|failure| {
        let mut failure = match failure {
            ToolError::Io(failure) => AppError::from(failure),
            ToolError::Checksum => error("toolChecksum", "bundled pawnlsp checksum mismatch"),
            ToolError::Timeout => error("toolTimeout", "version probe timed out"),
            ToolError::OutputLimit => {
                error("toolOutputLimit", "version probe exceeded output limit")
            }
            ToolError::Failed(output) => error("toolProbe", output),
            ToolError::Version { expected, actual } => {
                let mut failure = error("toolVersion", "unsupported language-server version");
                failure.parameters = serde_json::json!({ "expected": expected, "actual": actual });
                failure
            }
        };
        if failure.parameters.is_null() {
            failure.parameters = serde_json::json!({ "path": path });
        }
        failure
    })?;
    Ok(ToolInfo {
        path,
        version: pin.version,
        source,
    })
}

#[tauri::command]
pub async fn choose_language_server(app: AppHandle) -> Result<Option<PathBuf>> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file();
        #[cfg(windows)]
        let picker = picker.add_filter("pawnlsp", &["exe"]);
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
pub async fn lsp_start(
    app: AppHandle,
    state: State<'_, NativeState>,
    document: Option<PathBuf>,
    on_event: Channel<LspEvent>,
) -> Result<LanguageStart> {
    let root = if let Some(workspace) = lock(&state.workspace)?.as_ref() {
        workspace.root().to_path_buf()
    } else {
        let document = permitted(
            &state,
            &document.ok_or_else(|| error("noWorkspace", "no document selected"))?,
        )?;
        document
            .parent()
            .ok_or_else(|| error("noWorkspace", "no document directory"))?
            .to_path_buf()
    };
    let tool = tauri::async_runtime::spawn_blocking(move || verified_lsp(&app))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))??;
    let mut owned = lock(&state.lsp)?;
    owned.take();
    let session = LspSession::start(&tool.path, &root, move |event| {
        let _ = on_event.send(event);
    })?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    *owned = Some((id, session));
    Ok(LanguageStart {
        session_id: id,
        tool,
    })
}
#[tauri::command]
pub async fn lsp_send(state: State<'_, NativeState>, session_id: u64, body: String) -> Result<()> {
    let owned = lock(&state.lsp)?;
    let (id, session) = owned
        .as_ref()
        .ok_or_else(|| error("lspStopped", "no session"))?;
    if *id != session_id {
        return Err(error("lspStopped", "stale session"));
    }
    session.send(&body)?;
    Ok(())
}
#[tauri::command]
pub async fn lsp_stop(state: State<'_, NativeState>, session_id: u64) -> Result<()> {
    let mut owned = lock(&state.lsp)?;
    if owned.as_ref().is_some_and(|(id, _)| *id == session_id) {
        owned.take();
    }
    Ok(())
}

fn ignored_watch_path(path: &Path) -> bool {
    path.components().any(|part| {
        matches!(
            part.as_os_str().to_str(),
            Some(".git" | "node_modules" | "target" | ".tools-cache")
        )
    })
}

#[tauri::command]
pub async fn watch_start(
    state: State<'_, NativeState>,
    paths: Vec<PathBuf>,
    on_event: Channel<WatchEvent>,
) -> Result<()> {
    let workspace = lock(&state.workspace)?
        .as_ref()
        .map(|workspace| workspace.root().to_path_buf());
    let allowed = lock(&state.allowed)?.clone();
    let mut roots = Vec::new();
    if let Some(root) = &workspace {
        roots.push((root.clone(), true));
        if let Some(parent) = root.parent() {
            roots.push((parent.to_owned(), false));
        }
    }
    for path in &paths {
        if !allowed.contains(path) {
            let scope = lock(&state.workspace)?;
            let scope = scope
                .as_ref()
                .ok_or_else(|| error("permissionDenied", "unselected file"))?;
            if path.exists() {
                scope.resolve(path)?;
            } else {
                let parent = path
                    .parent()
                    .ok_or_else(|| error("permissionDenied", "invalid file parent"))?;
                scope.resolve(parent)?;
            }
        }
        if !workspace
            .as_ref()
            .is_some_and(|root| path.starts_with(root))
        {
            let parent = workspace::canonical(
                path.parent()
                    .ok_or_else(|| error("permissionDenied", "invalid file parent"))?,
            )?;
            if !roots.iter().any(|(root, _)| root == &parent) {
                roots.push((parent, false));
            }
        }
    }
    let watch = FileWatch::start(
        &roots,
        move |path| {
            let relative = workspace
                .as_ref()
                .and_then(|root| path.strip_prefix(root).ok())
                .unwrap_or_else(|| path.file_name().map(Path::new).unwrap_or(path));
            !ignored_watch_path(relative)
                && (workspace
                    .as_ref()
                    .is_some_and(|root| path.starts_with(root))
                    || paths.iter().any(|allowed| allowed == path))
        },
        move |event| {
            if !event.paths.is_empty() || event.rescan || event.error.is_some() {
                let _ = on_event.send(event);
            }
        },
    )
    .map_err(|failure| error("watchFailed", failure.to_string()))?;
    *lock(&state.watch)? = Some(watch);
    Ok(())
}

#[tauri::command]
pub async fn watch_stop(state: State<'_, NativeState>) -> Result<()> {
    lock(&state.watch)?.take();
    Ok(())
}
