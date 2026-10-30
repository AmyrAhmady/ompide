use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMutation {
    source: PathBuf,
    path: Option<PathBuf>,
    recent_files: Option<Vec<PathBuf>>,
    warning: Option<AppError>,
}

fn reconcile_history(
    app: &AppHandle,
    state: &NativeState,
    source: PathBuf,
    path: Option<PathBuf>,
) -> EntryMutation {
    let update = || -> Result<Vec<PathBuf>> {
        let _guard = lock(&state.preferences_lock)?;
        let mut preferences = load_preferences(app.clone())?;
        let next =
            pawn_core::history::reconcile(&preferences.recent_files, &source, path.as_deref());
        if next != preferences.recent_files {
            preferences.recent_files = next;
            write_preferences(app, &preferences)?;
        }
        Ok(preferences.recent_files)
    };
    let (recent_files, warning) = match update() {
        Ok(files) => (Some(files), None),
        // The file operation already succeeded. Report it accurately even if preferences fail.
        Err(failure) => (None, Some(error("historyUpdateFailed", failure.detail))),
    };
    EntryMutation {
        source,
        path,
        recent_files,
        warning,
    }
}

fn scope(state: &NativeState) -> Result<Workspace> {
    Workspace::open(
        lock(&state.workspace)?
            .as_ref()
            .ok_or_else(|| error("noWorkspace", "select a workspace folder"))?
            .root(),
    )
    .map_err(Into::into)
}

fn mutation_error(failure: io::Error) -> AppError {
    match failure.kind() {
        io::ErrorKind::AlreadyExists => error("nameExists", failure.to_string()),
        io::ErrorKind::InvalidInput => error("invalidName", failure.to_string()),
        io::ErrorKind::Unsupported => error("trashUnavailable", failure.to_string()),
        _ => failure.into(),
    }
}

#[tauri::command]
pub async fn create_entry(
    state: State<'_, NativeState>,
    parent: PathBuf,
    name: String,
    directory: bool,
) -> Result<PathBuf> {
    let scope = scope(&state)?;
    tauri::async_runtime::spawn_blocking(move || scope.create(&parent, &name, directory))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
        .map_err(mutation_error)
}

#[tauri::command]
pub async fn rename_entry(
    app: AppHandle,
    state: State<'_, NativeState>,
    path: PathBuf,
    name: String,
) -> Result<EntryMutation> {
    if lock(&state.build)?.is_some() {
        return Err(error("buildBusy", "cancel the build before renaming files"));
    }
    let scope = scope(&state)?;
    let source = scope.mutable_entry(&path)?;
    let path = tauri::async_runtime::spawn_blocking(move || scope.rename(&path, &name))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
        .map_err(mutation_error)?;
    Ok(reconcile_history(&app, &state, source, Some(path)))
}

#[tauri::command]
pub async fn trash_entry(
    app: AppHandle,
    state: State<'_, NativeState>,
    path: PathBuf,
) -> Result<EntryMutation> {
    if lock(&state.build)?.is_some() {
        return Err(error(
            "buildBusy",
            "cancel the build before moving files to the Recycle Bin",
        ));
    }
    let scope = scope(&state)?;
    let source = scope.mutable_entry(&path)?;
    tauri::async_runtime::spawn_blocking(move || scope.trash(&path))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
        .map_err(mutation_error)?;
    Ok(reconcile_history(&app, &state, source, None))
}
