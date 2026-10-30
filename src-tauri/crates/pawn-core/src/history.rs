//! Reconcile remembered paths after a successful Explorer mutation, preserving recency.
use std::path::{Component, Path, PathBuf};

fn component_equal(left: Component<'_>, right: Component<'_>) -> bool {
    if cfg!(windows) {
        left.as_os_str().to_string_lossy().to_lowercase()
            == right.as_os_str().to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

fn suffix(path: &Path, parent: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    for expected in parent.components() {
        if !component_equal(parts.next()?, expected) {
            return None;
        }
    }
    Some(parts.collect())
}

/// The caller supplies the validated, canonical source and successful destination.
/// No existence checks: the former path is already gone when this function runs.
pub fn reconcile(paths: &[PathBuf], source: &Path, destination: Option<&Path>) -> Vec<PathBuf> {
    let mut result: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for path in paths {
        let next = match suffix(path, source) {
            Some(tail) => match destination {
                Some(target) if tail.as_os_str().is_empty() => target.to_path_buf(),
                Some(target) => target.join(tail),
                None => continue,
            },
            None => path.clone(),
        };
        if !result
            .iter()
            .any(|existing| suffix(existing, &next).is_some_and(|tail| tail.as_os_str().is_empty()))
        {
            result.push(next);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_history_moves_closed_descendants_without_prefix_collisions_or_duplicates() {
        let root = std::env::temp_dir().join("pawn-history-test");
        let source = root.join("scripts");
        let target = root.join("renamed");
        let paths = vec![
            source.join("closed.inc"),
            root.join("scripts-extra/keep.inc"),
            target.join("closed.inc"),
            source.join("nested/main.pwn"),
        ];
        let moved = reconcile(&paths, &source, Some(&target));
        assert_eq!(
            moved,
            vec![
                target.join("closed.inc"),
                root.join("scripts-extra/keep.inc"),
                target.join("nested/main.pwn")
            ]
        );
        assert_eq!(
            reconcile(&moved, &target, None),
            vec![root.join("scripts-extra/keep.inc")]
        );
    }

    #[test]
    fn file_rename_preserves_recency_and_case_only_destination_spelling() {
        let root = std::env::temp_dir().join("pawn-history-test");
        let source = root.join("main.pwn");
        let target = root.join("MAIN.pwn");
        let other = root.join("other.inc");
        assert_eq!(
            reconcile(&[other.clone(), source.clone()], &source, Some(&target)),
            vec![other.clone(), target]
        );
        assert_eq!(
            reconcile(&[other.clone(), source.clone()], &source, None),
            vec![other]
        );
    }
}
