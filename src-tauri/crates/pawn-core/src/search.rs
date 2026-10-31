//! Literal workspace search and read-only replacement previews. Source is never executed.
use crate::workspace::{self, Workspace};
use ignore::WalkBuilder;
use regex::{NoExpand, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const MAX_MATCHES: usize = 2_000;
const MAX_FILES: usize = 500;
const MAX_SCAN_BYTES: usize = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 16 * 1024 * 1024;
// Workspace scans have their own bound; opening a larger file does not expand it.
const MAX_SEARCH_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub query: String,
    #[serde(default)]
    pub file_query: String,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub files_only: bool,
}
#[derive(Deserialize)]
pub struct Overlay {
    pub path: PathBuf,
    pub text: String,
    pub version: u32,
    #[serde(default)]
    pub excluded: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub preview: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub path: PathBuf,
    pub uri: String,
    pub relative: String,
    pub revision: String,
    pub buffer_version: Option<u32>,
    pub hits: Vec<Hit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<FileResult>,
    pub scanned: usize,
    pub skipped: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

/// A preview is safe to apply only when complete and each open model still equals `before`.
/// The frontend owns the undoable edits and explicit save; this module never writes files.
pub fn search(
    scope: &Workspace,
    options: &Options,
    overlays: Vec<Overlay>,
    replacement: Option<&str>,
    cancel: &AtomicBool,
) -> io::Result<SearchResult> {
    if options.query.len() > 1024
        || options.file_query.len() > 1024
        || options.query.contains(['\r', '\n'])
        || (replacement.is_some() && (options.query.is_empty() || options.files_only))
        || replacement.is_some_and(|text| text.len() > 64 * 1024)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid search or replacement",
        ));
    }
    let mut buffers = HashMap::new();
    let mut overlay_bytes = 0;
    for overlay in overlays {
        overlay_bytes += overlay.text.len();
        if overlay_bytes > MAX_PREVIEW_BYTES || overlay.text.len() as u64 > MAX_SEARCH_FILE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "unsaved search buffers exceed limit",
            ));
        }
        let path = scope.resolve(&overlay.path)?;
        if buffers.insert(path, overlay).is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "duplicate search buffer",
            ));
        }
    }
    let regex = RegexBuilder::new(&regex::escape(&options.query))
        .case_insensitive(!options.match_case)
        .build()
        .map_err(io::Error::other)?;
    let mut result = SearchResult {
        files: vec![],
        scanned: 0,
        skipped: 0,
        truncated: false,
        cancelled: false,
    };
    if options.query.is_empty() && !options.files_only {
        return Ok(result);
    }
    let mut builder = WalkBuilder::new(scope.root());
    builder
        .follow_links(false)
        .hidden(false)
        .parents(false)
        .git_global(false)
        .require_git(false)
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|kind| kind.is_dir())
                || !matches!(
                    entry.file_name().to_str(),
                    Some(
                        ".git"
                            | "node_modules"
                            | "target"
                            | ".tools-cache"
                            | "output"
                            | "dist"
                            | ".vendor"
                            | "dependencies"
                    )
                )
        })
        .sort_by_file_path(|a, b| a.cmp(b));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut matches = 0;
    let mut bytes = 0;
    let mut preview_bytes: usize = 0;
    let mut visited = 0;
    for entry in builder.build() {
        if cancel.load(Ordering::Acquire) {
            result.cancelled = true;
            break;
        }
        visited += 1;
        if visited > 50_000 || Instant::now() >= deadline {
            result.truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = match scope.resolve(entry.path()) {
            Ok(path) => path,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        // Re-check the entry itself: even an in-scope symlink must not become a replace target.
        if std::fs::symlink_metadata(entry.path()).is_ok_and(|metadata| metadata.is_symlink()) {
            result.skipped += 1;
            continue;
        }
        let relative = path
            .strip_prefix(scope.root())
            .map_err(io::Error::other)?
            .to_string_lossy()
            .replace('\\', "/");
        if !relative
            .to_lowercase()
            .contains(&options.file_query.replace('\\', "/").to_lowercase())
        {
            continue;
        }
        if options.files_only {
            if !relative
                .to_lowercase()
                .contains(&options.query.replace('\\', "/").to_lowercase())
            {
                continue;
            }
            if result.files.len() >= MAX_FILES {
                result.truncated = true;
                break;
            }
            result.files.push(FileResult {
                uri: workspace::file_uri(&path)?,
                path,
                relative,
                revision: String::new(),
                buffer_version: None,
                hits: vec![],
                before: None,
                after: None,
            });
            continue;
        }
        if buffers.get(&path).is_some_and(|overlay| overlay.excluded)
            || entry
                .metadata()
                .is_ok_and(|metadata| metadata.len() > MAX_SEARCH_FILE_BYTES)
        {
            result.skipped += 1;
            result.truncated |= replacement.is_some();
            continue;
        }
        let snapshot = match workspace::read_document(&path) {
            Ok(snapshot) => snapshot,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if snapshot.text.len() as u64 > MAX_SEARCH_FILE_BYTES {
            result.skipped += 1;
            result.truncated |= replacement.is_some();
            continue;
        }
        let overlay = buffers.get(&path);
        let text = overlay
            .map(|overlay| overlay.text.as_str())
            .unwrap_or(&snapshot.text);
        bytes += text.len();
        result.scanned += 1;
        if bytes > MAX_SCAN_BYTES {
            result.truncated = true;
            break;
        }
        let mut hits = vec![];
        for (line_index, line) in text.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            for found in regex.find_iter(line) {
                if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                    result.truncated = true;
                    break;
                }
                if matches >= MAX_MATCHES {
                    result.truncated = true;
                    break;
                }
                let preview_start = line[..found.start()]
                    .char_indices()
                    .rev()
                    .nth(60)
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                let preview = line[preview_start..].chars().take(240).collect();
                hits.push(Hit {
                    line: line_index as u32 + 1,
                    column: line[..found.start()].encode_utf16().count() as u32 + 1,
                    end_column: line[..found.end()].encode_utf16().count() as u32 + 1,
                    preview,
                });
                matches += 1;
            }
            if result.truncated || cancel.load(Ordering::Acquire) {
                break;
            }
        }
        if hits.is_empty() {
            continue;
        }
        if result.files.len() >= MAX_FILES {
            result.truncated = true;
            break;
        }
        let (before, after) = if let Some(replacement) = replacement {
            if result.truncated
                || preview_bytes
                    .saturating_add(text.len().saturating_mul(2))
                    .saturating_add(hits.len().saturating_mul(replacement.len()))
                    > MAX_PREVIEW_BYTES
            {
                result.truncated = true;
                break;
            }
            let after = regex.replace_all(text, NoExpand(replacement)).into_owned();
            preview_bytes += text.len() + after.len();
            if preview_bytes > MAX_PREVIEW_BYTES {
                result.truncated = true;
                break;
            }
            (Some(text.to_owned()), Some(after))
        } else {
            (None, None)
        };
        result.files.push(FileResult {
            uri: snapshot.uri,
            path,
            relative,
            revision: snapshot.revision,
            buffer_version: overlay.map(|overlay| overlay.version),
            hits,
            before,
            after,
        });
        if result.truncated {
            break;
        }
    }
    result.cancelled |= cancel.load(Ordering::Acquire);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn options(query: &str) -> Options {
        Options {
            query: query.into(),
            file_query: String::new(),
            match_case: false,
            files_only: false,
        }
    }
    #[test]
    fn unicode_crlf_bom_and_literal_replacements_preserve_source_and_disk() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        let path = scope.root().join("main.pwn");
        fs::write(&path, "\u{feff}// 🦀 Foo[1]\r\nFoo[1]\r\n").unwrap();
        let result = search(
            &scope,
            &options("foo[1]"),
            vec![],
            Some("$literal"),
            &AtomicBool::new(false),
        )
        .unwrap();
        let file = &result.files[0];
        assert_eq!(file.hits.len(), 2);
        assert_eq!(file.hits[0].column, 7);
        assert_eq!(file.hits[1].line, 2);
        assert_eq!(
            file.after.as_deref(),
            Some("// 🦀 $literal\r\n$literal\r\n")
        );
        assert!(fs::read_to_string(path).unwrap().starts_with('\u{feff}'));
    }
    #[test]
    fn honors_ignore_files_and_unsaved_overlays_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        fs::write(scope.root().join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(scope.root().join("ignored")).unwrap();
        fs::write(scope.root().join("ignored/hidden.pwn"), "Needle").unwrap();
        let path = scope.root().join("main.pwn");
        fs::write(&path, "disk text").unwrap();
        let overlay = Overlay {
            path: path.clone(),
            text: "unsaved NEEDLE".into(),
            version: 5,
            excluded: false,
        };
        let result = search(
            &scope,
            &options("needle"),
            vec![overlay],
            Some("replacement"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].buffer_version, Some(5));
        assert_eq!(
            result.files[0].after.as_deref(),
            Some("unsaved replacement")
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "disk text");
    }
    #[test]
    fn bounds_results_and_cancellation_and_rejects_outside_overlays() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        fs::write(scope.root().join("many.pwn"), "x ".repeat(MAX_MATCHES + 1)).unwrap();
        let result = search(&scope, &options("x"), vec![], None, &AtomicBool::new(false)).unwrap();
        assert!(result.truncated);
        assert_eq!(result.files[0].hits.len(), MAX_MATCHES);
        let preview = search(
            &scope,
            &options("x"),
            vec![],
            Some(&"y".repeat(64 * 1024)),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(preview.truncated);
        assert!(preview.files.is_empty());
        assert!(
            search(&scope, &options("x"), vec![], None, &AtomicBool::new(true))
                .unwrap()
                .cancelled
        );
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(
            search(
                &scope,
                &options("x"),
                vec![Overlay {
                    path: outside.path().to_owned(),
                    text: "x".into(),
                    version: 1,
                    excluded: false,
                }],
                None,
                &AtomicBool::new(false)
            )
            .is_err()
        );
    }
    #[test]
    fn finds_files_by_relative_path_without_reading_binary_contents() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        fs::write(scope.root().join("Game.inc"), [0, 255, 1]).unwrap();
        let mut query = options("game.inc");
        query.files_only = true;
        let result = search(&scope, &query, vec![], None, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].hits.is_empty());
    }

    #[test]
    fn large_files_are_findable_and_skipped_content_cannot_apply_partial_replacements() {
        let directory = tempfile::tempdir().unwrap();
        let scope = Workspace::open(directory.path()).unwrap();
        let path = scope.root().join("large.pwn");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_SEARCH_FILE_BYTES + 1)
            .unwrap();
        fs::write(scope.root().join("small.pwn"), "needle").unwrap();
        let cancel = AtomicBool::new(false);
        let result = search(&scope, &options("needle"), vec![], Some("changed"), &cancel).unwrap();
        assert!(result.truncated);
        assert_eq!(result.skipped, 1);
        assert!(
            result.files.is_empty(),
            "a skipped large file prevents a partial replacement preview"
        );
        let mut query = options("large");
        query.files_only = true;
        assert_eq!(
            search(&scope, &query, vec![], None, &cancel)
                .unwrap()
                .files
                .len(),
            1
        );
        fs::write(&path, "needle on disk").unwrap();
        let result = search(
            &scope,
            &options("needle"),
            vec![Overlay {
                path,
                text: String::new(),
                version: 2,
                excluded: true,
            }],
            None,
            &cancel,
        )
        .unwrap();
        assert_eq!(result.skipped, 1);
        assert_eq!(
            result.files.len(),
            1,
            "never search stale disk text behind an excluded dirty buffer"
        );
    }
}
