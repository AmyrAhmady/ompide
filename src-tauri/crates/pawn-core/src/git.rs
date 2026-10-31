//! Installed Git with explicit scope, bounded output, and cancellable child ownership.
use crate::{
    process,
    workspace::{self, Workspace},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};

const LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub detail: String,
}

impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        fail("gitFailed", value.to_string())
    }
}

type Result<T> = std::result::Result<T, Error>;

fn fail(code: &'static str, detail: impl Into<String>) -> Error {
    Error {
        code,
        detail: detail.into(),
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Change {
    pub path: String,
    pub original: Option<String>,
    pub index: char,
    pub working: char,
    pub conflict: bool,
    pub submodule: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct Snapshot {
    pub head: String,
    pub revision: String,
    pub branch: String,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<Change>,
    pub branches: Vec<String>,
    pub tags: Vec<String>,
    pub stashes: Vec<String>,
    pub remotes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Diff {
    pub before: String,
    pub after: String,
    pub unsupported: bool,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Stage { paths: Vec<String> },
    Unstage { paths: Vec<String> },
    Commit { message: String, amend: bool },
    Undo,
    Switch { name: String },
    CreateBranch { name: String },
    RenameBranch { name: String, new_name: String },
    DeleteBranch { name: String },
    CreateTag { name: String },
    DeleteTag { name: String },
    Push { remote: String },
    Pull { remote: String },
    PushTag { remote: String, name: String },
    Stash { message: String },
    ApplyStash { name: String },
    PopStash { name: String },
    DropStash { name: String },
}

pub struct Repository {
    git: PathBuf,
    scope: Workspace,
}

/// Resolve an absolute executable before entering an untrusted workspace.
fn installed_git() -> Result<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    for folder in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if folder.is_absolute() {
            let candidate = folder.join(name);
            if candidate.is_file() {
                return Ok(workspace::canonical(&candidate)?);
            }
        }
    }
    Err(fail("gitMissing", "Git is not installed on PATH"))
}

impl Repository {
    pub fn open(scope: Workspace, cancel: &AtomicBool) -> Result<Self> {
        let repo = Self {
            git: installed_git()?,
            scope,
        };
        let output = repo.raw(&["rev-parse", "--show-toplevel"], cancel)?;
        if output.exit_code != Some(0) {
            return Err(fail("gitRepository", output.stderr));
        }
        let root = workspace::canonical(Path::new(output.stdout.trim_end_matches(['\r', '\n'])))?;
        if root != repo.scope.root() {
            return Err(fail(
                "gitScope",
                "open the repository root as the workspace",
            ));
        }
        Ok(repo)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.git);
        for (name, _) in std::env::vars_os() {
            if name
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(name);
            }
        }
        command
            .current_dir(self.scope.root())
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "false")
            .env("GIT_SEQUENCE_EDITOR", "false")
            .env("GCM_TRACE", "0")
            .env("GCM_TRACE_SECRETS", "0")
            .args([
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "color.ui=false",
                "-c",
                "submodule.recurse=false",
                "-c",
                "merge.autoStash=false",
                "-c",
                "rebase.autoStash=false",
                "-c",
                "credential.trace=false",
                "-c",
                "credential.traceSecrets=false",
            ]);
        command
    }

    fn raw(&self, args: &[&str], cancel: &AtomicBool) -> Result<process::Output> {
        let output = process::run(
            self.command().args(args),
            cancel,
            Duration::from_secs(300),
            LIMIT,
        )?;
        let code = match output.outcome {
            process::Outcome::Exited => return Ok(output),
            process::Outcome::Cancelled => "gitCancelled",
            process::Outcome::Timeout => "gitTimeout",
            process::Outcome::OutputLimit => "gitOutputLimit",
        };
        Err(fail(code, output.stderr))
    }

    fn run(&self, args: &[&str], cancel: &AtomicBool) -> Result<String> {
        let output = self.raw(args, cancel)?;
        if output.exit_code != Some(0) {
            return Err(fail(
                "gitFailed",
                format!("{}{}", output.stdout, output.stderr),
            ));
        }
        Ok(output.stdout)
    }

    pub fn status(&self, cancel: &AtomicBool) -> Result<Snapshot> {
        let text = self.run(
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
            cancel,
        )?;
        let mut result = parse_status(&text)?;
        result.branches = self
            .run(
                &["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"],
                cancel,
            )?
            .lines()
            .map(str::to_owned)
            .collect();
        result.tags = self
            .run(
                &["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"],
                cancel,
            )?
            .lines()
            .map(str::to_owned)
            .collect();
        result.stashes = self
            .run(&["stash", "list", "--format=%gd: %gs"], cancel)?
            .lines()
            .map(str::to_owned)
            .collect();
        result.remotes = self
            .run(&["remote"], cancel)?
            .lines()
            .map(str::to_owned)
            .collect();
        result.revision = format!(
            "{:x}",
            Sha256::digest(
                [
                    text.as_bytes(),
                    serde_json::to_vec(&result)
                        .map_err(io::Error::other)?
                        .as_slice(),
                    self.run(&["stash", "list", "--format=%H"], cancel)?
                        .as_bytes()
                ]
                .concat()
            )
        );
        Ok(result)
    }

    /// Deleted files still need their existing ancestors checked. Never follow links.
    fn path(&self, relative: &str) -> Result<PathBuf> {
        if relative.is_empty()
            || relative.contains(['\\', '\0', '\u{fffd}'])
            || relative.split('/').any(|part| {
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || part.eq_ignore_ascii_case(".git")
                    || part.contains(':')
            })
        {
            return Err(fail("gitPath", "invalid repository-relative path"));
        }
        let mut path = self.scope.root().to_path_buf();
        for part in relative.split('/') {
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink()
                        || !workspace::canonical(&path)?.starts_with(self.scope.root())
                    {
                        return Err(fail(
                            "gitPath",
                            "links and paths outside the workspace are unsupported",
                        ));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(path)
    }

    fn blob(&self, reference: &str, path: &str, cancel: &AtomicBool) -> Result<Option<String>> {
        let output = process::run_bytes(
            self.command().args([
                "show",
                "--no-ext-diff",
                "--no-textconv",
                &format!("{reference}:{path}"),
            ]),
            cancel,
            Duration::from_secs(300),
            LIMIT,
        )?;
        let code = match output.outcome {
            process::Outcome::Exited if output.exit_code == Some(0) => None,
            process::Outcome::Exited => Some("gitFailed"),
            process::Outcome::Cancelled => Some("gitCancelled"),
            process::Outcome::Timeout => Some("gitTimeout"),
            process::Outcome::OutputLimit => Some("gitOutputLimit"),
        };
        if let Some(code) = code {
            return Err(fail(code, String::from_utf8_lossy(&output.stderr)));
        }
        Ok(crate::text::decode(&output.stdout, None)
            .ok()
            .map(|decoded| decoded.text))
    }

    pub fn diff(&self, path: &str, staged: bool, cancel: &AtomicBool) -> Result<Diff> {
        let snapshot = self.status(cancel)?;
        let change = snapshot
            .changes
            .iter()
            .find(|change| change.path == path)
            .ok_or_else(|| fail("gitChanged", "change no longer exists"))?;
        if change.conflict || change.submodule {
            return Ok(Diff {
                before: String::new(),
                after: String::new(),
                unsupported: true,
            });
        }
        let target = self.path(path)?;
        let original = change.original.as_deref().unwrap_or(path);
        self.path(original)?;
        let (before, after) = if staged {
            let before = if change.index == 'A' {
                Some(String::new())
            } else {
                self.blob("HEAD", original, cancel)?
            };
            let after = if change.index == 'D' {
                Some(String::new())
            } else {
                self.blob("", path, cancel)?
            };
            (before, after)
        } else {
            let before = if change.index == '?' {
                Some(String::new())
            } else {
                self.blob("", path, cancel)?
            };
            let after = if change.working == 'D' {
                Some(String::new())
            } else {
                if fs::metadata(&target)?.len() > LIMIT {
                    return Err(fail("gitOutputLimit", "file too large"));
                }
                crate::text::decode(&fs::read(target)?, None)
                    .ok()
                    .map(|decoded| decoded.text)
            };
            (before, after)
        };
        let unsupported = before.is_none() || after.is_none();
        Ok(Diff {
            before: if unsupported {
                String::new()
            } else {
                before.unwrap()
            },
            after: if unsupported {
                String::new()
            } else {
                after.unwrap()
            },
            unsupported,
        })
    }

    fn reference(&self, name: &str, prefix: &str, cancel: &AtomicBool) -> Result<()> {
        if name.starts_with('-') || name.is_empty() || name.len() > 1024 {
            return Err(fail("gitReference", "invalid reference"));
        }
        self.run(
            &["check-ref-format", &format!("refs/{prefix}/{name}")],
            cancel,
        )?;
        Ok(())
    }

    fn remote_branch(
        &self,
        status: &Snapshot,
        remote: &str,
        cancel: &AtomicBool,
    ) -> Result<String> {
        let configured_remote = self.raw(
            &[
                "config",
                "--get",
                &format!("branch.{}.remote", status.branch),
            ],
            cancel,
        )?;
        if configured_remote.exit_code == Some(0) && configured_remote.stdout.trim() == remote {
            let merge = self.run(
                &[
                    "config",
                    "--get",
                    &format!("branch.{}.merge", status.branch),
                ],
                cancel,
            )?;
            let name = merge
                .trim()
                .strip_prefix("refs/heads/")
                .ok_or_else(|| fail("gitReference", "upstream must be a branch"))?;
            self.reference(name, "heads", cancel)?;
            return Ok(name.to_owned());
        }
        Ok(status.branch.clone())
    }

    pub fn execute(
        &self,
        expected_revision: &str,
        action: Action,
        cancel: &AtomicBool,
    ) -> Result<String> {
        let status = self.status(cancel)?;
        if status.revision != expected_revision {
            return Err(fail(
                "gitChanged",
                "repository changed; refresh before retrying",
            ));
        }
        let remote = |name: &str| -> Result<()> {
            if name.starts_with('-') || !status.remotes.iter().any(|item| item == name) {
                return Err(fail("gitReference", "select an existing remote"));
            }
            Ok(())
        };
        let stash = |name: &str| -> Result<()> {
            if !status
                .stashes
                .iter()
                .any(|item| item.split_once(": ").is_some_and(|(id, _)| id == name))
            {
                return Err(fail("gitChanged", "stash no longer exists"));
            }
            Ok(())
        };
        match action {
            Action::Stage { paths } | Action::Unstage { paths } if paths.is_empty() => {
                Err(fail("gitPath", "select files"))
            }
            Action::Stage { paths } => {
                let mut args = vec!["add", "--"];
                for path in &paths {
                    self.path(path)?;
                }
                args.extend(paths.iter().map(String::as_str));
                self.run(&args, cancel)
            }
            Action::Unstage { paths } => {
                let mut args = if status.head == "(initial)" {
                    vec!["rm", "--cached", "--"]
                } else {
                    vec!["reset", "-q", "HEAD", "--"]
                };
                for path in &paths {
                    self.path(path)?;
                }
                args.extend(paths.iter().map(String::as_str));
                self.run(&args, cancel)
            }
            Action::Commit { message, amend } => {
                if message.trim().is_empty() || message.len() > 65536 || message.contains('\0') {
                    return Err(fail("gitMessage", "provide a commit message"));
                }
                let mut args = vec!["commit", "-m", &message];
                if amend {
                    args.push("--amend");
                }
                self.run(&args, cancel)
            }
            Action::Undo => self.run(&["reset", "--soft", "HEAD^"], cancel),
            Action::Switch { name } => {
                self.reference(&name, "heads", cancel)?;
                if !status.branches.contains(&name) {
                    return Err(fail("gitReference", "select a local branch"));
                }
                self.run(&["switch", "--no-guess", &name], cancel)
            }
            Action::CreateBranch { name } => {
                self.reference(&name, "heads", cancel)?;
                self.run(&["switch", "-c", &name], cancel)
            }
            Action::RenameBranch { name, new_name } => {
                self.reference(&name, "heads", cancel)?;
                self.reference(&new_name, "heads", cancel)?;
                self.run(&["branch", "-m", &name, &new_name], cancel)
            }
            Action::DeleteBranch { name } => {
                self.reference(&name, "heads", cancel)?;
                self.run(&["branch", "-d", &name], cancel)
            }
            Action::CreateTag { name } => {
                self.reference(&name, "tags", cancel)?;
                self.run(&["tag", &name], cancel)
            }
            Action::DeleteTag { name } => {
                self.reference(&name, "tags", cancel)?;
                self.run(&["tag", "-d", &name], cancel)
            }
            Action::Push { remote: name } => {
                remote(&name)?;
                self.reference(&status.branch, "heads", cancel)?;
                self.run(
                    &[
                        "push",
                        "--porcelain",
                        "--set-upstream",
                        &name,
                        &format!(
                            "HEAD:refs/heads/{}",
                            self.remote_branch(&status, &name, cancel)?
                        ),
                    ],
                    cancel,
                )
            }
            Action::Pull { remote: name } => {
                remote(&name)?;
                self.reference(&status.branch, "heads", cancel)?;
                self.run(
                    &[
                        "pull",
                        "--ff-only",
                        "--no-rebase",
                        "--no-edit",
                        &name,
                        &self.remote_branch(&status, &name, cancel)?,
                    ],
                    cancel,
                )
            }
            Action::PushTag {
                remote: name,
                name: tag,
            } => {
                remote(&name)?;
                self.reference(&tag, "tags", cancel)?;
                self.run(
                    &[
                        "push",
                        "--porcelain",
                        &name,
                        &format!("refs/tags/{tag}:refs/tags/{tag}"),
                    ],
                    cancel,
                )
            }
            Action::Stash { message } => {
                if message.len() > 65536 || message.contains('\0') {
                    return Err(fail("gitMessage", "invalid stash message"));
                }
                self.run(
                    &["stash", "push", "--include-untracked", "-m", &message],
                    cancel,
                )
            }
            Action::ApplyStash { name } => {
                stash(&name)?;
                self.run(&["stash", "apply", "--index", &name], cancel)
            }
            Action::PopStash { name } => {
                stash(&name)?;
                self.run(&["stash", "pop", "--index", &name], cancel)
            }
            Action::DropStash { name } => {
                stash(&name)?;
                self.run(&["stash", "drop", &name], cancel)
            }
        }
    }
}

fn parse_status(text: &str) -> Result<Snapshot> {
    let mut result = Snapshot::default();
    let mut records = text.split('\0').filter(|part| !part.is_empty());
    while let Some(record) = records.next() {
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            result.head = value.into();
        } else if let Some(value) = record.strip_prefix("# branch.head ") {
            result.branch = value.into();
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            result.upstream = value.into();
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut counts = value.split(' ');
            result.ahead = counts
                .next()
                .and_then(|n| n.strip_prefix('+'))
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            result.behind = counts
                .next()
                .and_then(|n| n.strip_prefix('-'))
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        } else if let Some(path) = record.strip_prefix("? ") {
            result.changes.push(Change {
                path: path.into(),
                original: None,
                index: '?',
                working: '?',
                conflict: false,
                submodule: false,
            });
        } else if record.starts_with(['1', '2', 'u']) {
            let fields: Vec<_> = record
                .splitn(
                    if record.starts_with('1') {
                        9
                    } else if record.starts_with('u') {
                        11
                    } else {
                        10
                    },
                    ' ',
                )
                .collect();
            if fields.len() < 9 || fields[1].len() != 2 {
                return Err(fail("gitFailed", "malformed status"));
            }
            let original = if record.starts_with('2') {
                Some(
                    records
                        .next()
                        .ok_or_else(|| fail("gitFailed", "missing rename path"))?
                        .into(),
                )
            } else {
                None
            };
            result.changes.push(Change {
                path: fields.last().unwrap().to_string(),
                original,
                index: fields[1].as_bytes()[0] as char,
                working: fields[1].as_bytes()[1] as char,
                conflict: record.starts_with('u'),
                submodule: fields[2] != "N...",
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    struct Fixture {
        directory: tempfile::TempDir,
        repo: Repository,
        cancel: AtomicBool,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let cancel = AtomicBool::new(false);
            let git = installed_git().expect("Git required for source control tests");
            let init = Command::new(&git)
                .current_dir(directory.path())
                .args(["init", "-b", "main"])
                .output()
                .unwrap();
            assert!(init.status.success());
            let repo =
                Repository::open(Workspace::open(directory.path()).unwrap(), &cancel).unwrap();
            repo.run(&["config", "user.name", "Pawn IDE tests"], &cancel)
                .unwrap();
            repo.run(
                &["config", "user.email", "fixture@example.invalid"],
                &cancel,
            )
            .unwrap();
            repo.run(&["config", "commit.gpgsign", "false"], &cancel)
                .unwrap();
            Self {
                directory,
                repo,
                cancel,
            }
        }

        fn write(&self, name: &str, text: &str) {
            fs::write(self.directory.path().join(name), text).unwrap();
        }

        fn status(&self) -> Snapshot {
            self.repo.status(&self.cancel).unwrap()
        }

        fn action(&self, action: Action) -> String {
            self.repo
                .execute(&self.status().revision, action, &self.cancel)
                .unwrap()
        }

        fn commit(&self, message: &str) {
            self.action(Action::Commit {
                message: message.into(),
                amend: false,
            });
        }
    }

    #[test]
    fn real_index_diffs_rename_unborn_commit_amend_undo_and_stashes() {
        let f = Fixture::new();
        let path = "source 🦀 [1].pwn";
        f.write(path, "main() { return 1; }\r\n");
        let untracked = f.status();
        assert_eq!(untracked.head, "(initial)");
        assert_eq!(untracked.changes[0].index, '?');
        assert!(
            f.repo
                .diff(path, false, &f.cancel)
                .unwrap()
                .before
                .is_empty()
        );
        f.action(Action::Stage {
            paths: vec![path.into()],
        });
        assert!(
            f.repo
                .diff(path, true, &f.cancel)
                .unwrap()
                .before
                .is_empty()
        );
        f.action(Action::Unstage {
            paths: vec![path.into()],
        });
        assert_eq!(f.status().changes[0].index, '?');
        f.action(Action::Stage {
            paths: vec![path.into()],
        });
        f.commit("Initial source");
        let initial = f.status().head;
        f.write(path, "main() { return 2; }\n");
        assert!(
            f.repo
                .diff(path, false, &f.cancel)
                .unwrap()
                .after
                .contains("return 2")
        );
        f.action(Action::Stage {
            paths: vec![path.into()],
        });
        f.write(path, "main() { return 3; }\n");
        let staged = f.repo.diff(path, true, &f.cancel).unwrap();
        let working = f.repo.diff(path, false, &f.cancel).unwrap();
        assert!(staged.before.contains("return 1") && staged.after.contains("return 2"));
        assert!(working.before.contains("return 2") && working.after.contains("return 3"));
        f.commit("Second source");
        f.action(Action::Commit {
            message: "Amended source".into(),
            amend: true,
        });
        assert!(
            f.repo
                .run(&["log", "-1", "--format=%s"], &f.cancel)
                .unwrap()
                .contains("Amended source")
        );
        f.action(Action::Undo);
        assert_eq!(f.status().head, initial);
        assert_eq!(f.status().changes[0].index, 'M');
        assert!(
            fs::read_to_string(f.directory.path().join(path))
                .unwrap()
                .contains("return 3")
        );
        f.action(Action::Stash {
            message: "Work in progress".into(),
        });
        assert!(f.status().changes.is_empty());
        f.action(Action::ApplyStash {
            name: "stash@{0}".into(),
        });
        assert!(!f.status().changes.is_empty());
        f.action(Action::Stash {
            message: "Again".into(),
        });
        f.action(Action::PopStash {
            name: "stash@{0}".into(),
        });
        f.action(Action::DropStash {
            name: "stash@{0}".into(),
        });
        assert!(f.status().stashes.is_empty());
        f.action(Action::Stage {
            paths: vec![path.into()],
        });
        f.commit("Keep staged edits");
        fs::rename(
            f.directory.path().join(path),
            f.directory.path().join("renamed.pwn"),
        )
        .unwrap();
        f.action(Action::Stage {
            paths: vec![path.into(), "renamed.pwn".into()],
        });
        let changed = f.status();
        assert_eq!(changed.changes[0].original.as_deref(), Some(path));
        assert!(f.repo.diff("renamed.pwn", true, &f.cancel).is_ok());
        f.action(Action::Unstage {
            paths: vec![path.into(), "renamed.pwn".into()],
        });
        assert!(f.status().changes.iter().any(|c| c.working == 'D'));
    }

    #[test]
    fn working_and_index_diffs_decode_unicode_files_before_comparing() {
        let f = Fixture::new();
        let name = "unicode.pwn";
        let before = "// λ😀\r\nmain() { return 1; }\r\n";
        fs::write(
            f.directory.path().join(name),
            crate::text::encode(before, "utf-16le", true).unwrap(),
        )
        .unwrap();
        f.repo.run(&["add", "--", name], &f.cancel).unwrap();
        f.repo
            .run(&["commit", "-m", "Initial Unicode source"], &f.cancel)
            .unwrap();
        let after = before.replace("return 1", "return 2");
        fs::write(
            f.directory.path().join(name),
            crate::text::encode(&after, "utf-16le", true).unwrap(),
        )
        .unwrap();
        let working = f.repo.diff(name, false, &f.cancel).unwrap();
        assert!(!working.unsupported);
        assert_eq!(working.before, before);
        assert_eq!(working.after, after);
        f.repo.run(&["add", "--", name], &f.cancel).unwrap();
        let staged = f.repo.diff(name, true, &f.cancel).unwrap();
        assert!(!staged.unsupported);
        assert_eq!(staged.before, before);
        assert_eq!(staged.after, after);
    }

    #[test]
    fn local_remote_branches_tags_push_pull_and_rejections() {
        let f = Fixture::new();
        f.write("main.pwn", "main() {}\n");
        f.action(Action::Stage {
            paths: vec!["main.pwn".into()],
        });
        f.commit("First");
        let remote = tempfile::tempdir().unwrap();
        assert!(
            Command::new(&f.repo.git)
                .args(["init", "--bare"])
                .arg(remote.path())
                .output()
                .unwrap()
                .status
                .success()
        );
        f.repo
            .run(
                &["remote", "add", "origin", remote.path().to_str().unwrap()],
                &f.cancel,
            )
            .unwrap();
        f.action(Action::Push {
            remote: "origin".into(),
        });
        assert_eq!(f.status().upstream, "origin/main");
        f.action(Action::CreateBranch {
            name: "feature".into(),
        });
        assert_eq!(f.status().branch, "feature");
        f.action(Action::RenameBranch {
            name: "feature".into(),
            new_name: "renamed".into(),
        });
        f.action(Action::Switch {
            name: "main".into(),
        });
        f.action(Action::DeleteBranch {
            name: "renamed".into(),
        });
        f.action(Action::CreateTag { name: "v1".into() });
        f.action(Action::PushTag {
            remote: "origin".into(),
            name: "v1".into(),
        });
        assert!(
            Command::new(&f.repo.git)
                .arg("--git-dir")
                .arg(remote.path())
                .args(["show-ref", "--verify", "refs/tags/v1"])
                .output()
                .unwrap()
                .status
                .success()
        );
        f.action(Action::DeleteTag { name: "v1".into() });
        // Advance another clone, then fast-forward through the product API.
        let clone = tempfile::tempdir().unwrap();
        assert!(
            Command::new(&f.repo.git)
                .args(["clone", "-b", "main"])
                .arg(remote.path())
                .arg(clone.path())
                .output()
                .unwrap()
                .status
                .success()
        );
        let other = Repository::open(Workspace::open(clone.path()).unwrap(), &f.cancel).unwrap();
        other
            .run(&["config", "user.name", "Test"], &f.cancel)
            .unwrap();
        other
            .run(
                &["config", "user.email", "fixture@example.invalid"],
                &f.cancel,
            )
            .unwrap();
        fs::write(clone.path().join("remote.inc"), "// pulled\n").unwrap();
        other.run(&["add", "--", "remote.inc"], &f.cancel).unwrap();
        other
            .run(
                &["commit", "--no-gpg-sign", "-m", "Remote update"],
                &f.cancel,
            )
            .unwrap();
        other.run(&["push", "origin", "main"], &f.cancel).unwrap();
        f.action(Action::Pull {
            remote: "origin".into(),
        });
        assert!(f.directory.path().join("remote.inc").exists());
        let revision = f.status().revision;
        f.write("new.inc", "// untracked");
        assert_eq!(
            f.repo
                .execute(&revision, Action::Undo, &f.cancel)
                .unwrap_err()
                .code,
            "gitChanged"
        );
        for name in ["--orphan", "../bad", "a:b", "a..b"] {
            assert!(
                f.repo
                    .execute(
                        &f.status().revision,
                        Action::CreateBranch { name: name.into() },
                        &f.cancel
                    )
                    .is_err()
            );
        }
        for path in [
            "../outside",
            ".git/config",
            "C:/outside",
            "folder/../../bad",
        ] {
            assert_eq!(
                f.repo
                    .execute(
                        &f.status().revision,
                        Action::Stage {
                            paths: vec![path.into()]
                        },
                        &f.cancel
                    )
                    .unwrap_err()
                    .code,
                "gitPath"
            );
        }
        let nested = f.directory.path().join("nested");
        fs::create_dir(&nested).unwrap();
        assert_eq!(
            Repository::open(Workspace::open(&nested).unwrap(), &f.cancel)
                .err()
                .unwrap()
                .code,
            "gitScope"
        );
        f.cancel.store(true, Ordering::Release);
        assert_eq!(f.repo.status(&f.cancel).unwrap_err().code, "gitCancelled");
    }

    #[test]
    fn read_only_status_never_calls_fsmonitor_and_binary_diff_is_explicit() {
        let f = Fixture::new();
        f.repo
            .run(
                &["config", "core.fsmonitor", "this-command-must-never-run"],
                &f.cancel,
            )
            .unwrap();
        assert!(f.status().changes.is_empty());
        fs::write(f.directory.path().join("binary.pwn"), [1, 0, 255]).unwrap();
        assert!(
            f.repo
                .diff("binary.pwn", false, &f.cancel)
                .unwrap()
                .unsupported
        );
        let parsed = parse_status(
            "u UU N... 100644 100644 100644 100644 a b c conflict.pwn\0? new\nline.inc\0",
        )
        .unwrap();
        assert!(parsed.changes[0].conflict);
        assert_eq!(parsed.changes[0].path, "conflict.pwn");
        assert_eq!(parsed.changes[1].path, "new\nline.inc");
    }
}

#[cfg(test)]
mod conflict_tests {
    use super::*;

    #[test]
    fn real_conflict_paths_and_dirty_switch_are_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let git = installed_git().unwrap();
        assert!(
            Command::new(git)
                .current_dir(directory.path())
                .args(["init", "-b", "main"])
                .output()
                .unwrap()
                .status
                .success()
        );
        let cancel = AtomicBool::new(false);
        let repo = Repository::open(Workspace::open(directory.path()).unwrap(), &cancel).unwrap();
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "fixture@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            repo.run(&["config", key, value], &cancel).unwrap();
        }
        let file = directory.path().join("conflict file.inc");
        fs::write(&file, "original\n").unwrap();
        repo.run(&["add", "--", "conflict file.inc"], &cancel)
            .unwrap();
        repo.run(&["commit", "-m", "Initial"], &cancel).unwrap();
        repo.run(&["switch", "-c", "other"], &cancel).unwrap();
        fs::write(&file, "other branch\n").unwrap();
        repo.run(&["commit", "-am", "Other"], &cancel).unwrap();
        repo.run(&["switch", "main"], &cancel).unwrap();
        fs::write(&file, "main branch\n").unwrap();
        repo.run(&["commit", "-am", "Main"], &cancel).unwrap();
        fs::write(&file, "local dirty file\n").unwrap();
        let status = repo.status(&cancel).unwrap();
        assert!(
            repo.execute(
                &status.revision,
                Action::Switch {
                    name: "other".into()
                },
                &cancel
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "local dirty file\n");
        fs::write(&file, "main branch\n").unwrap();
        assert!(repo.run(&["merge", "--no-edit", "other"], &cancel).is_err());
        let conflict = repo.status(&cancel).unwrap();
        assert_eq!(conflict.changes[0].path, "conflict file.inc");
        assert!(conflict.changes[0].conflict);
        assert!(
            repo.diff("conflict file.inc", false, &cancel)
                .unwrap()
                .unsupported
        );
        fs::write(&file, "resolved\n").unwrap();
        repo.execute(
            &conflict.revision,
            Action::Stage {
                paths: vec!["conflict file.inc".into()],
            },
            &cancel,
        )
        .unwrap();
        assert!(!repo.status(&cancel).unwrap().changes[0].conflict);
    }
}
