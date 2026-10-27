use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub paths: Vec<PathBuf>,
    pub rescan: bool,
    pub error: Option<String>,
}

pub struct FileWatch {
    watcher: Option<RecommendedWatcher>,
    worker: Option<JoinHandle<()>>,
}

impl FileWatch {
    pub fn start(
        roots: &[(PathBuf, bool)],
        accept: impl Fn(&Path) -> bool + Send + 'static,
        emit: impl Fn(WatchEvent) + Send + 'static,
    ) -> notify::Result<Self> {
        let (send, receive) = mpsc::sync_channel::<notify::Result<Event>>(64);
        let overflow = Arc::new(AtomicBool::new(false));
        let dropped = Arc::clone(&overflow);
        let mut watcher = RecommendedWatcher::new(
            move |mut event: notify::Result<Event>| {
                if event.as_ref().is_ok_and(|event| event.kind.is_access()) {
                    return;
                }
                if let Ok(event) = &mut event {
                    event.paths.retain(|path| accept(path));
                    if event.paths.is_empty() && !event.need_rescan() {
                        return;
                    }
                }
                if send.try_send(event).is_err() {
                    dropped.store(true, Ordering::Relaxed);
                }
            },
            Config::default().with_follow_symlinks(false),
        )?;
        for (root, recursive) in roots {
            watcher.watch(
                root,
                if *recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                },
            )?;
        }
        let worker = thread::spawn(move || {
            while let Ok(first) = receive.recv() {
                let mut paths = HashSet::new();
                let mut error = None;
                let mut rescan = overflow.swap(false, Ordering::Relaxed);
                let deadline = Instant::now() + Duration::from_millis(200);
                let mut current = first;
                loop {
                    match current {
                        Ok(event) => {
                            rescan |= event.need_rescan();
                            for path in event.paths {
                                if paths.len() < 256 {
                                    paths.insert(path);
                                } else {
                                    rescan = true;
                                }
                            }
                        }
                        Err(failure) => {
                            error = Some(failure.to_string());
                            rescan = true;
                        }
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                    match receive.recv_timeout(Duration::from_millis(60)) {
                        Ok(event) => current = event,
                        Err(_) => break,
                    }
                }
                let mut paths: Vec<_> = paths.into_iter().collect();
                paths.sort();
                rescan |= overflow.swap(false, Ordering::Relaxed);
                emit(WatchEvent {
                    paths,
                    rescan,
                    error,
                });
            }
        });
        Ok(Self {
            watcher: Some(watcher),
            worker: Some(worker),
        })
    }
}

impl Drop for FileWatch {
    fn drop(&mut self) {
        self.watcher.take(); // Drops the event sender and wakes the coalescer.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sees_file_replacement_and_deletion_without_retaining_handles() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("main.pwn");
        std::fs::write(&path, "old").unwrap();
        let (send, receive) = mpsc::channel();
        let watch = FileWatch::start(
            &[(root.path().to_owned(), false)],
            |_| true,
            move |event| {
                let _ = send.send(event);
            },
        )
        .unwrap();
        std::fs::write(&path, "new").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("no filesystem event");
            assert!(event.error.is_none(), "{:?}", event.error);
            if event
                .paths
                .iter()
                .any(|item| item.file_name() == path.file_name())
            {
                break;
            }
        }
        std::fs::remove_file(&path).unwrap();
        drop(watch);
        root.close().unwrap();
    }
}
