//! Interactive PTYs. Output has bounded acknowledgement-based backpressure;
//! input has a bounded queue so a blocked shell never blocks a Tauri thread.
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_WINDOW: u64 = 256 * 1024;
const INPUT_LIMIT: usize = 64 * 1024;

#[derive(Clone, Serialize)]
pub struct Shell {
    pub id: String,
    pub path: PathBuf,
    pub args: Vec<String>,
}

/// Resolve only installed absolute paths; never search the opened workspace.
pub fn shells() -> Vec<Shell> {
    let mut shells = Vec::new();
    let mut add = |id: &str, path: PathBuf, args: &[&str]| {
        if path.is_absolute()
            && path.is_file()
            && !shells
                .iter()
                .any(|shell: &Shell| shell.path == path || shell.id == id)
        {
            shells.push(Shell {
                id: id.into(),
                path,
                args: args.iter().map(|s| (*s).into()).collect(),
            });
        }
    };
    #[cfg(windows)]
    {
        if let Some(paths) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&paths).filter(|p| p.is_absolute()) {
                add(
                    "pwsh",
                    directory.join("pwsh.exe"),
                    &["-NoLogo", "-NoProfile"],
                );
            }
        }
        if let Some(root) = std::env::var_os("SystemRoot") {
            let system = PathBuf::from(root).join("System32");
            add(
                "powershell",
                system.join("WindowsPowerShell/v1.0/powershell.exe"),
                &["-NoLogo", "-NoProfile"],
            );
            add("cmd", system.join("cmd.exe"), &["/D"]);
        }
    }
    #[cfg(unix)]
    {
        if let Some(shell) = std::env::var_os("SHELL") {
            let path = PathBuf::from(shell);
            let id = path.file_name().and_then(|s| s.to_str()).unwrap_or("sh");
            let args: &[&str] = match id {
                "bash" => &["--noprofile", "--norc"],
                "zsh" => &["-f"],
                _ => &[],
            };
            add(id, path.clone(), args);
        }
        add(
            "bash",
            PathBuf::from("/bin/bash"),
            &["--noprofile", "--norc"],
        );
        add("sh", PathBuf::from("/bin/sh"), &[]);
    }
    shells
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Data { data: Vec<u8>, sequence: u64 },
    Exit { code: Option<u32> },
    Error { detail: String },
}

#[derive(Default)]
struct Credit {
    sent: u64,
    acknowledged: u64,
}

#[derive(Default)]
struct Flow {
    credit: Mutex<Credit>,
    wake: Condvar,
    stopped: AtomicBool,
}

impl Flow {
    fn reserve(&self, count: usize) -> Option<u64> {
        let mut credit = self.credit.lock().ok()?;
        let mut progress = Instant::now();
        let mut last = credit.acknowledged;
        while credit.sent - credit.acknowledged >= OUTPUT_WINDOW {
            if self.stopped.load(Ordering::Acquire) {
                return None;
            }
            credit = self
                .wake
                .wait_timeout(credit, Duration::from_secs(1))
                .ok()?
                .0;
            if credit.acknowledged != last {
                last = credit.acknowledged;
                progress = Instant::now();
            }
            // A disconnected or suspended renderer cannot grow native buffers forever.
            if progress.elapsed() > Duration::from_secs(30) {
                self.stop();
                return None;
            }
        }
        if self.stopped.load(Ordering::Acquire) {
            return None;
        }
        credit.sent += count as u64;
        Some(credit.sent)
    }

    fn acknowledge(&self, sequence: u64) -> io::Result<()> {
        let mut credit = self
            .credit
            .lock()
            .map_err(|e| io::Error::other(e.to_string()))?;
        if sequence > credit.sent {
            return Err(io::Error::other("invalid terminal acknowledgement"));
        }
        credit.acknowledged = credit.acknowledged.max(sequence);
        self.wake.notify_all();
        Ok(())
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.wake.notify_all();
    }
}

type Master = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

pub struct Session {
    master: Master,
    killer: Box<dyn ChildKiller + Send + Sync>,
    input: Option<mpsc::SyncSender<Vec<u8>>>,
    flow: Arc<Flow>,
    pub running: Arc<AtomicBool>,
    pub pid: u32,
    #[cfg(windows)]
    tree: Arc<Mutex<Option<crate::process::Job>>>,
}

fn size(cols: u16, rows: u16) -> io::Result<PtySize> {
    if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid terminal dimensions",
        ));
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

impl Session {
    pub fn start(
        shell: &Shell,
        cwd: &Path,
        cols: u16,
        rows: u16,
        receive: impl Fn(Event) -> bool + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|e| io::Error::other(e.to_string()))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| io::Error::other(e.to_string()))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| io::Error::other(e.to_string()))?;
        let mut command = CommandBuilder::new(&shell.path);
        command.args(&shell.args);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // Debug WebView ports and shell startup hooks must not leak into terminal children.
        for key in ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "ENV", "BASH_ENV"] {
            command.env_remove(key);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| io::Error::other(e.to_string()))?;
        drop(pair.slave);
        let pid = child
            .process_id()
            .ok_or_else(|| io::Error::other("terminal has no process ID"))?;
        #[cfg(windows)]
        let tree = {
            let job = crate::process::Job::new().and_then(|job| {
                job.assign_handle(
                    child
                        .as_raw_handle()
                        .ok_or_else(|| io::Error::other("terminal has no process handle"))?,
                )?;
                Ok(job)
            });
            match job {
                Ok(job) => Arc::new(Mutex::new(Some(job))),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            }
        };
        let killer = child.clone_killer();
        let mut reader_killer = child.clone_killer();
        let flow = Arc::new(Flow::default());
        let running = Arc::new(AtomicBool::new(true));
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let receive = Arc::new(receive);
        let (input, input_queue) = mpsc::sync_channel::<Vec<u8>>(16);
        let writer_flow = flow.clone();
        let writer_receive = receive.clone();
        thread::spawn(move || {
            while let Ok(bytes) = input_queue.recv() {
                if writer_flow.stopped.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = writer.write_all(&bytes).and_then(|_| writer.flush()) {
                    if !writer_flow.stopped.load(Ordering::Acquire) {
                        writer_receive(Event::Error {
                            detail: error.to_string(),
                        });
                    }
                    break;
                }
            }
        });
        let wait_master = master.clone();
        let wait_running = running.clone();
        #[cfg(windows)]
        let wait_tree = tree.clone();
        let (exited, exit_status) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let status = child.wait().ok().map(|s| s.exit_code());
            wait_running.store(false, Ordering::Release);
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            if let Ok(mut tree) = wait_tree.lock() {
                tree.take();
            }
            // ClosePseudoConsole may wait for output to drain; reader remains independent.
            if let Ok(mut master) = wait_master.lock() {
                master.take();
            }
            let _ = exited.send(status);
        });
        let read_flow = flow.clone();
        thread::spawn(move || {
            let mut bytes = [0; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => {
                        if let Some(sequence) = read_flow.reserve(count) {
                            if receive(Event::Data {
                                data: bytes[..count].to_vec(),
                                sequence,
                            }) {
                                continue;
                            }
                            read_flow.stop();
                        }
                        let _ = reader_killer.kill();
                        // Drain instead of abandoning the pipe, including during ConPTY close.
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        // A disconnected PTY must not leave its waiter blocked
                        // indefinitely on an otherwise live shell.
                        read_flow.stop();
                        let _ = reader_killer.kill();
                        break;
                    }
                }
            }
            let code = exit_status.recv().ok().flatten();
            receive(Event::Exit { code });
        });
        Ok(Self {
            master,
            killer,
            input: Some(input),
            flow,
            running,
            pid,
            #[cfg(windows)]
            tree,
        })
    }

    pub fn write(&self, data: Vec<u8>) -> io::Result<()> {
        if data.is_empty() || data.len() > INPUT_LIMIT {
            return Err(io::Error::other("invalid terminal input size"));
        }
        if !self.running.load(Ordering::Acquire) {
            return Err(io::Error::other("terminal exited"));
        }
        self.input
            .as_ref()
            .ok_or_else(|| io::Error::other("terminal closed"))?
            .try_send(data)
            .map_err(|e| io::Error::other(e.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let size = size(cols, rows)?;
        let Ok(master) = self.master.try_lock() else {
            return Ok(());
        };
        if let Some(master) = master.as_ref() {
            master
                .resize(size)
                .map_err(|e| io::Error::other(e.to_string()))?;
        }
        Ok(())
    }

    pub fn acknowledge(&self, sequence: u64) -> io::Result<()> {
        self.flow.acknowledge(sequence)
    }

    pub fn stop(&mut self) {
        self.flow.stop();
        self.input.take();
        #[cfg(windows)]
        if let Ok(mut tree) = self.tree.lock() {
            tree.take();
        }
        #[cfg(unix)]
        if self.running.load(Ordering::Acquire) {
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.killer.kill();
        // The waiter owns final PTY teardown; never wait on ConPTY on the UI thread.
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_is_bounded_and_cancellation_wakes_blocked_reader() {
        let flow = Arc::new(Flow::default());
        let sequence = flow.reserve(OUTPUT_WINDOW as usize).unwrap();
        assert!(flow.acknowledge(sequence + 1).is_err());
        let blocked = flow.clone();
        let task = thread::spawn(move || blocked.reserve(1));
        flow.stop();
        assert_eq!(task.join().unwrap(), None);
        assert!(size(0, 24).is_err());
        assert!(size(80, 501).is_err());
    }

    #[test]
    fn real_pty_interactive_output_resize_and_exit() {
        let shell = shells()
            .into_iter()
            .find(|s| s.id == if cfg!(windows) { "cmd" } else { "sh" })
            .unwrap();
        let (send, receive) = mpsc::channel();
        let session = Session::start(&shell, &std::env::temp_dir(), 80, 24, move |event| {
            send.send(event).is_ok()
        })
        .unwrap();
        session.resize(101, 31).unwrap();
        // ConPTY requests the initial cursor position before accepting input.
        #[cfg(not(windows))]
        session
            .write(b"echo PAWN_PTY_VERIFIED\nexit 7\n".to_vec())
            .unwrap();
        let mut output = Vec::new();
        loop {
            match receive.recv_timeout(Duration::from_secs(15)).unwrap() {
                Event::Data { data, sequence } => {
                    #[cfg(windows)]
                    if data.windows(4).any(|part| part == b"\x1b[6n") {
                        session.write(b"\x1b[1;1R".to_vec()).unwrap();
                        session
                            .write(b"echo PAWN_PTY_VERIFIED\rexit 7\r".to_vec())
                            .unwrap();
                    }
                    output.extend(data);
                    session.acknowledge(sequence).unwrap();
                }
                Event::Exit { code } => {
                    assert_eq!(code, Some(7));
                    break;
                }
                Event::Error { detail } => panic!("{detail}"),
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("PAWN_PTY_VERIFIED"));
        assert!(!session.running.load(Ordering::Acquire));
    }
}
