use super::*;
use pawn_core::{dependencies, project};

#[derive(Serialize)]
pub struct ProjectDependencyReview {
    manifest: FileSnapshot,
    #[serde(flatten)]
    review: dependencies::DependencyReview,
}

/// Inspection never invokes a project tool, acquires sources or creates files.
#[tauri::command]
pub async fn review_project_dependencies(
    state: State<'_, NativeState>,
    path: PathBuf,
) -> Result<ProjectDependencyReview> {
    let scope = builds::root(&state, Some(path))?;
    tauri::async_runtime::spawn_blocking(move || {
        let manifests: Vec<_> = project::MANIFESTS
            .iter()
            .map(|name| scope.root().join(name))
            .filter(|path| path.exists())
            .collect();
        if manifests.len() != 1 {
            return Err(error(
                "projectAmbiguous",
                "select a folder with one manifest",
            ));
        }
        let manifest = workspace::read_document(&scope.resolve(&manifests[0])?)?;
        if manifest.text.len() > 256 * 1024 {
            return Err(error("dependencyReview", "manifest exceeds 256 KiB"));
        }
        let configuration = if manifest
            .path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            serde_json::from_str::<serde_json::Value>(&manifest.text)
                .map_err(|failure| error("dependencyReview", failure.to_string()))?
        } else {
            serde_yaml_ng::from_str::<serde_json::Value>(&manifest.text)
                .map_err(|failure| error("dependencyReview", failure.to_string()))?
        };
        let review = dependencies::review(&scope, &configuration).map_err(|failure| {
            if failure.kind() == io::ErrorKind::InvalidData
                || failure.kind() == io::ErrorKind::InvalidInput
            {
                error("dependencyReview", failure.to_string())
            } else {
                failure.into()
            }
        })?;
        Ok(ProjectDependencyReview { manifest, review })
    })
    .await
    .map_err(|failure| error("operationFailed", failure.to_string()))?
}
