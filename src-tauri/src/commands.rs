use pawn_core::{
    lsp::{LspEvent, LspSession},
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
}

#[derive(Debug, Serialize)]
pub struct AppError {
    code: &'static str,
    detail: String,
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
        }
    }
}
type Result<T> = std::result::Result<T, AppError>;
fn error(code: &'static str, detail: impl Into<String>) -> AppError {
    AppError {
        code,
        detail: detail.into(),
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
pub fn store_preferences(app: AppHandle, settings: serde_json::Value) -> Result<()> {
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
    let mut preferences = load_preferences(app.clone())?;
    preferences.recent_workspaces.retain(|path| path != &root);
    preferences.recent_workspaces.insert(0, root.clone());
    preferences.recent_workspaces.truncate(12);
    write_preferences(app, &preferences)?;
    lock(&state.lsp)?.take();
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
pub fn read_document(state: State<'_, NativeState>, path: PathBuf) -> Result<FileSnapshot> {
    Ok(workspace::read_document(&permitted(&state, &path)?)?)
}
#[tauri::command]
pub fn save_document(
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
pub fn list_directory(state: State<'_, NativeState>, path: PathBuf) -> Result<Vec<Entry>> {
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
#[tauri::command]
pub async fn lsp_start(
    state: State<'_, NativeState>,
    document: Option<PathBuf>,
    on_event: Channel<LspEvent>,
) -> Result<u64> {
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
    let mut owned = lock(&state.lsp)?;
    owned.take();
    let session = LspSession::start(&bundled_lsp()?, &root, move |event| {
        let _ = on_event.send(event);
    })?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    *owned = Some((id, session));
    Ok(id)
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
