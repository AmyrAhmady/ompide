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
    stdin: Mutex<Option<ChildStdin>>,
    readers: Vec<JoinHandle<()>>,
}

impl LspSession {
    pub fn start(
        executable: &Path,
        workspace: &Path,
        emit: impl Fn(LspEvent) + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let mut command = Command::new(executable);
        command
            .current_dir(workspace)
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
            stdin: Mutex::new(Some(stdin)),
            readers: vec![output, errors],
        })
    }

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

    pub fn stop(&mut self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        // The client sends shutdown/exit first; kill also handles crashed or unresponsive servers.
        let _ = self.child.kill();
        let _ = self.child.wait();
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
