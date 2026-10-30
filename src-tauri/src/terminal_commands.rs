use super::*;
use pawn_core::terminal::{Event, Session, Shell};

#[derive(Serialize)]
pub struct TerminalInfo {
    id: u64,
    pid: u32,
    cwd: PathBuf,
}

#[tauri::command]
pub fn terminal_shells() -> Vec<Shell> {
    pawn_core::terminal::shells()
}

#[tauri::command]
pub async fn terminal_start(
    app: AppHandle,
    shell: String,
    root: Option<PathBuf>,
    cols: u16,
    rows: u16,
    on_event: Channel<Event>,
) -> Result<TerminalInfo> {
    let generation = app
        .state::<NativeState>()
        .terminal_generation
        .load(Ordering::Acquire);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NativeState>();
        let workspace = lock(&state.workspace)?;
        // No frontend workspace means an explicit home-directory terminal, also
        // after a renderer reload. Supplied workspace roots must still match.
        if root.is_some() && workspace.as_ref().map(|w| w.root()) != root.as_deref() {
            return Err(error(
                "terminalWorkspaceChanged",
                "workspace changed before terminal start",
            ));
        }
        let cwd = root.unwrap_or(
            app.path()
                .home_dir()
                .map_err(|e| error("terminalFailed", e.to_string()))?,
        );
        let selected = pawn_core::terminal::shells()
            .into_iter()
            .find(|candidate| candidate.id == shell)
            .ok_or_else(|| error("terminalShellMissing", "selected shell is not installed"))?;
        let mut sessions = lock(&state.terminals)?;
        if state.terminal_generation.load(Ordering::Acquire) != generation {
            return Err(error(
                "terminalClosed",
                "renderer retired before terminal start",
            ));
        }
        if sessions.len() >= 8 {
            return Err(error(
                "terminalLimit",
                "close a terminal before creating another",
            ));
        }
        let session = Session::start(&selected, &cwd, cols, rows, move |event| {
            on_event.send(event).is_ok()
        })
        .map_err(|e| error("terminalFailed", e.to_string()))?;
        if state.terminal_generation.load(Ordering::Acquire) != generation {
            return Err(error(
                "terminalClosed",
                "renderer retired during terminal start",
            ));
        }
        let id = state.next.fetch_add(1, Ordering::Relaxed);
        let info = TerminalInfo {
            id,
            pid: session.pid,
            cwd,
        };
        sessions.insert(id, session);
        Ok(info)
    })
    .await
    .map_err(|e| error("terminalFailed", e.to_string()))?
}

#[tauri::command]
pub fn terminal_write(state: State<'_, NativeState>, id: u64, data: Vec<u8>) -> Result<()> {
    lock(&state.terminals)?
        .get(&id)
        .ok_or_else(|| error("terminalClosed", "terminal closed"))?
        .write(data)
        .map_err(|e| error("terminalInput", e.to_string()))
}

#[tauri::command]
pub async fn terminal_resize(app: AppHandle, id: u64, cols: u16, rows: u16) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        lock(&app.state::<NativeState>().terminals)?
            .get(&id)
            .ok_or_else(|| error("terminalClosed", "terminal closed"))?
            .resize(cols, rows)
            .map_err(|e| error("terminalFailed", e.to_string()))
    })
    .await
    .map_err(|e| error("terminalFailed", e.to_string()))?
}

#[tauri::command]
pub fn terminal_acknowledge(state: State<'_, NativeState>, id: u64, sequence: u64) -> Result<()> {
    if let Some(session) = lock(&state.terminals)?.get(&id) {
        session
            .acknowledge(sequence)
            .map_err(|e| error("terminalFailed", e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_close(state: State<'_, NativeState>, id: u64) -> Result<()> {
    lock(&state.terminals)?.remove(&id);
    Ok(())
}

#[tauri::command]
pub fn terminal_close_all(state: State<'_, NativeState>) -> Result<()> {
    lock(&state.terminals)?.clear();
    Ok(())
}
