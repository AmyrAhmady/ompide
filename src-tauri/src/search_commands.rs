use super::*;
use pawn_core::search::{self, Options, Overlay, SearchResult};
use std::sync::{Arc, atomic::AtomicBool};

#[tauri::command]
pub async fn search_workspace(
    state: State<'_, NativeState>,
    id: u64,
    options: Options,
    overlays: Vec<Overlay>,
    replacement: Option<String>,
) -> Result<SearchResult> {
    let scope = Workspace::open(
        lock(&state.workspace)?
            .as_ref()
            .ok_or_else(|| error("noWorkspace", "select a workspace folder"))?
            .root(),
    )?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut current = lock(&state.search)?;
        if let Some((_, previous)) = current.take() {
            previous.store(true, Ordering::Release);
        }
        *current = Some((id, cancel.clone()));
    }
    let task_cancel = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        search::search(
            &scope,
            &options,
            overlays,
            replacement.as_deref(),
            &task_cancel,
        )
    })
    .await
    .map_err(|failure| error("operationFailed", failure.to_string()));
    {
        let mut current = lock(&state.search)?;
        if current
            .as_ref()
            .is_some_and(|(current_id, signal)| *current_id == id && Arc::ptr_eq(signal, &cancel))
        {
            current.take();
        }
    }
    result?.map_err(|failure| {
        if failure.kind() == io::ErrorKind::FileTooLarge {
            error("searchBuffersLarge", failure.to_string())
        } else if failure.kind() == io::ErrorKind::InvalidInput {
            error("searchInvalid", failure.to_string())
        } else {
            failure.into()
        }
    })
}
#[tauri::command]
pub async fn cancel_search(state: State<'_, NativeState>, id: u64) -> Result<()> {
    if let Some((_, cancel)) = lock(&state.search)?
        .as_ref()
        .filter(|(current, _)| *current == id)
    {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}
