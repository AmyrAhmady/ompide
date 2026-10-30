use crate::framing::{read_frame, write_frame};
use serde::Serialize;
use std::{
    io::{self, BufReader, Read},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", content = "body", rename_all = "camelCase")]
pub enum LspEvent {
    Message(String),
    Stderr(String),
    Error(String),
    Closed,
}

/// Owns the process and a single ordered protocol writer. No network listener is involved.
pub struct LspSession {
    child: Child,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    readers: Vec<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct LspWriter {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl LspSession {
    pub fn start(
        executable: &Path,
        workspace: &Path,
        emit: impl Fn(LspEvent) + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let mut command = Command::new(executable);
        command.current_dir(workspace);
        Self::spawn(command, emit)
    }

    fn spawn(
        mut command: Command,
        emit: impl Fn(LspEvent) + Send + Sync + 'static,
    ) -> io::Result<Self> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let emit = Arc::new(emit);
        let messages = Arc::clone(&emit);
        let output = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_frame(&mut reader) {
                    Ok(Some(body)) => messages(LspEvent::Message(body)),
                    Ok(None) => break,
                    Err(error) => {
                        messages(LspEvent::Error(error.to_string()));
                        break;
                    }
                }
            }
            messages(LspEvent::Closed);
        });
        let errors = thread::spawn(move || {
            let mut buffer = [0; 4096];
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => emit(LspEvent::Stderr(
                        String::from_utf8_lossy(&buffer[..count]).into_owned(),
                    )),
                }
            }
        });
        Ok(Self {
            child,
            stdin: Arc::new(Mutex::new(Some(stdin))),
            readers: vec![output, errors],
        })
    }

    pub fn send(&self, message: &str) -> io::Result<()> {
        self.writer().send(message)
    }

    pub fn writer(&self) -> LspWriter {
        LspWriter {
            stdin: Arc::clone(&self.stdin),
        }
    }

    pub fn stop(&mut self) {
        // Kill before taking the pipe lock: a busy server may not be reading stdin.
        // Termination releases blocked writers, allowing their acknowledgements to fail.
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        self.stop();
    }
}

impl LspWriter {
    pub fn send(&self, message: &str) -> io::Result<()> {
        let value: serde_json::Value = serde_json::from_str(message)?;
        if !value.is_object() || value.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected JSON-RPC 2.0 object",
            ));
        }
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| io::Error::other("LSP writer lock poisoned"))?;
        write_frame(
            stdin
                .as_mut()
                .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "LSP stopped"))?,
            message,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };

    #[test]
    fn stop_interrupts_a_blocked_protocol_write() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "lsp::tests::blocked_reader_fixture",
                "--nocapture",
            ])
            .env("PAWN_IDE_LSP_BLOCKED_FIXTURE", "1");
        let mut session = LspSession::spawn(command, |_| {}).unwrap();
        let writer = session.writer();
        let (done, completed) = mpsc::channel();
        let send = thread::spawn(move || {
            let message = serde_json::json!({"jsonrpc":"2.0", "method":"test/large", "params": {"text":"x".repeat(2 * 1024 * 1024)}}).to_string();
            done.send(writer.send(&message)).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while session.stdin.try_lock().is_ok() {
            assert!(
                Instant::now() < deadline,
                "writer did not enter the pipe write"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert!(completed.try_recv().is_err());
        let start = Instant::now();
        session.stop();
        let elapsed = start.elapsed();
        assert!(
            completed
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .is_err()
        );
        send.join().unwrap();
        assert!(
            elapsed < Duration::from_secs(2),
            "stop waited on the blocked writer for {elapsed:?}"
        );
        assert!(
            session
                .writer()
                .send(r#"{"jsonrpc":"2.0","method":"test/late"}"#)
                .is_err()
        );
    }

    #[test]
    fn blocked_reader_fixture() {
        if std::env::var_os("PAWN_IDE_LSP_BLOCKED_FIXTURE").is_some() {
            thread::sleep(Duration::from_secs(5));
        }
    }
}
