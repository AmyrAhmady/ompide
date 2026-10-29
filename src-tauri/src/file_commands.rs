use super::*;

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
    state: State<'_, NativeState>,
    path: PathBuf,
    name: String,
) -> Result<PathBuf> {
    if lock(&state.build)?.is_some() {
        return Err(error("buildBusy", "cancel the build before renaming files"));
    }
    let scope = scope(&state)?;
    tauri::async_runtime::spawn_blocking(move || scope.rename(&path, &name))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
        .map_err(mutation_error)
}

#[tauri::command]
pub async fn trash_entry(state: State<'_, NativeState>, path: PathBuf) -> Result<()> {
    if lock(&state.build)?.is_some() {
        return Err(error(
            "buildBusy",
            "cancel the build before moving files to the Recycle Bin",
        ));
    }
    let scope = scope(&state)?;
    tauri::async_runtime::spawn_blocking(move || scope.trash(&path))
        .await
        .map_err(|failure| error("operationFailed", failure.to_string()))?
        .map_err(mutation_error)
}
