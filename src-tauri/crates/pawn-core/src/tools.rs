use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum ToolError {
    Io(io::Error),
    Checksum,
    Timeout,
    OutputLimit,
    Failed(String),
    Version { expected: String, actual: String },
}
impl From<io::Error> for ToolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn sha256(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Redirect short version probes to owned temporary files, so a held pipe cannot hang cleanup.
/// Bound their duration and output; no shell or workspace-defined command is involved.
pub fn probe(command: &mut Command, timeout: Duration) -> Result<String, ToolError> {
    const LIMIT: u64 = 16 * 1024;
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(ToolError::Io(error)),
            Ok(None) => {}
        }
        let size = match stdout
            .metadata()
            .and_then(|out| stderr.metadata().map(|err| out.len() + err.len()))
        {
            Ok(size) => size,
            Err(error) => break Err(ToolError::Io(error)),
        };
        if size > LIMIT {
            break Err(ToolError::OutputLimit);
        }
        if Instant::now() >= deadline {
            break Err(ToolError::Timeout);
        }
        thread::sleep(Duration::from_millis(10));
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let status = result?;
    if stdout.metadata()?.len() + stderr.metadata()?.len() > LIMIT {
        return Err(ToolError::OutputLimit);
    }
    stdout.seek(SeekFrom::Start(0))?;
    stderr.seek(SeekFrom::Start(0))?;
    let mut output = String::new();
    let mut errors = String::new();
    stdout.read_to_string(&mut output)?;
    stderr.read_to_string(&mut errors)?;
    if !status.success() {
        return Err(ToolError::Failed(errors));
    }
    Ok(output.trim().to_owned())
}

pub fn verify(
    path: &Path,
    arguments: &[&str],
    expected: &str,
    checksum: Option<&str>,
) -> Result<(), ToolError> {
    if let Some(checksum) = checksum
        && sha256(path)? != checksum
    {
        return Err(ToolError::Checksum);
    }
    let actual = probe(Command::new(path).args(arguments), Duration::from_secs(3))?;
    if actual != expected {
        return Err(ToolError::Version {
            expected: expected.to_owned(),
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn checksum_mismatch_never_executes_the_file() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"not an executable").unwrap();
        assert_eq!(sha256(file.path()).unwrap().len(), 64);
        assert!(matches!(
            verify(file.path(), &["--version"], "1", Some("wrong")),
            Err(ToolError::Checksum)
        ));
    }
    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "tools::tests::probe_child_fixture",
            "--nocapture",
        ]);
        command.env("PAWN_IDE_TEST_PROBE", mode);
        command
    }
    #[test]
    fn bounds_probe_duration_and_output_and_waits_for_termination() {
        assert!(matches!(
            probe(&mut fixture("sleep"), Duration::from_millis(80)),
            Err(ToolError::Timeout)
        ));
        assert!(matches!(
            probe(&mut fixture("large"), Duration::from_secs(3)),
            Err(ToolError::OutputLimit)
        ));
        assert!(
            probe(&mut fixture("version"), Duration::from_secs(3))
                .unwrap()
                .contains("fixture version")
        );
    }
    // Invoked as a child by the probe test; its ordinary test-suite invocation is a no-op.
    #[test]
    fn probe_child_fixture() {
        match std::env::var("PAWN_IDE_TEST_PROBE").as_deref() {
            Ok("sleep") => thread::sleep(Duration::from_secs(10)),
            Ok("large") => print!("{}", "x".repeat(32 * 1024)),
            Ok("version") => println!("fixture version"),
            _ => {}
        }
    }
}
