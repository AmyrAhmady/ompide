use super::*;
use pawn_core::git::{Action, Repository};
use std::sync::{Arc, atomic::AtomicBool};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GitRequest {
    Status,
    Diff { path: String, staged: bool },
    Execute { revision: String, action: Action },
}

/// One Git operation at a time; workspace switching is blocked until ownership ends.
#[tauri::command]
pub async fn git_request(
    state: State<'_, NativeState>,
    root: PathBuf,
    id: u64,
    request: GitRequest,
) -> Result<serde_json::Value> {
    let cancel = Arc::new(AtomicBool::new(false));
    let scope = {
        let mut task = lock(&state.git)?;
        if task.is_some() {
            return Err(error("gitBusy", "another Git operation is running"));
        }
        if matches!(request, GitRequest::Execute { .. }) && lock(&state.build)?.is_some() {
            return Err(error(
                "buildBusy",
                "wait for the build before changing the repository",
            ));
        }
        let scope = Workspace::open(
            lock(&state.workspace)?
                .as_ref()
                .ok_or_else(|| error("noWorkspace", "select a workspace"))?
                .root(),
        )?;
        if workspace::canonical(&root)? != scope.root() {
            return Err(error("gitScope", "workspace changed"));
        }
        *task = Some((id, cancel.clone()));
        scope
    };
    let signal = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value> {
        let run = || -> std::result::Result<serde_json::Value, pawn_core::git::Error> {
            let repo = Repository::open(scope, &signal)?;
            let value = match request {
                GitRequest::Status => serde_json::to_value(repo.status(&signal)?),
                GitRequest::Diff { path, staged } => {
                    serde_json::to_value(repo.diff(&path, staged, &signal)?)
                }
                GitRequest::Execute { revision, action } => {
                    serde_json::to_value(repo.execute(&revision, action, &signal)?)
                }
            };
            value.map_err(io::Error::other).map_err(Into::into)
        };
        run().map_err(|failure| error(failure.code, failure.detail))
    })
    .await
    .map_err(|failure| error("gitFailed", failure.to_string()));
    let mut task = lock(&state.git)?;
    if task
        .as_ref()
        .is_some_and(|(current, signal)| *current == id && Arc::ptr_eq(signal, &cancel))
    {
        task.take();
    }
    result?
}

#[tauri::command]
pub fn cancel_git(state: State<'_, NativeState>, id: u64) -> Result<()> {
    if let Some((_, signal)) = lock(&state.git)?
        .as_ref()
        .filter(|(current, _)| *current == id)
    {
        signal.store(true, Ordering::Release);
    }
    Ok(())
}
