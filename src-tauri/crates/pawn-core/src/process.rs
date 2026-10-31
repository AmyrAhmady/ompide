//! Bounded, cancellable process ownership. No shell and no inherited stdin.
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Exited,
    Cancelled,
    Timeout,
    OutputLimit,
}
#[derive(Debug)]
pub struct Output {
    pub outcome: Outcome,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub struct BytesOutput {
    pub outcome: Outcome,
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[cfg(windows)]
pub(crate) struct Job(windows_sys::Win32::Foundation::HANDLE);
// This owned kernel handle has no thread affinity and is never borrowed after close.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
impl Job {
    pub(crate) fn new() -> io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        // The handle is owned here, never inherited or exposed to the child.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
    fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        self.assign_handle(child.as_raw_handle())
    }
    pub(crate) fn assign_handle(&self, handle: std::os::windows::io::RawHandle) -> io::Result<()> {
        if unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0, handle)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

struct OwnedChild {
    child: Child,
    #[cfg(windows)]
    job: Option<Job>,
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        #[cfg(windows)]
        self.job.take(); // Kills the CLI and its compiler descendants together.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn run(
    command: &mut Command,
    cancel: &AtomicBool,
    timeout: Duration,
    limit: u64,
) -> io::Result<Output> {
    let result = run_bytes(command, cancel, timeout, limit)?;
    Ok(Output {
        outcome: result.outcome,
        exit_code: result.exit_code,
        stdout: String::from_utf8_lossy(&result.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&result.stderr).into_owned(),
    })
}

/// Keep blob bytes intact until the caller chooses a disk text encoding.
pub fn run_bytes(
    command: &mut Command,
    cancel: &AtomicBool,
    timeout: Duration,
    limit: u64,
) -> io::Result<BytesOutput> {
    if cancel.load(Ordering::Acquire) {
        return Ok(BytesOutput {
            outcome: Outcome::Cancelled,
            exit_code: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
        });
    }
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?);
    #[cfg(windows)]
    let job = {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        Job::new()?
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut owned = OwnedChild {
        child: command.spawn()?,
        #[cfg(windows)]
        job: Some(job),
    };
    #[cfg(windows)]
    owned.job.as_ref().unwrap().assign(&owned.child)?;
    let deadline = Instant::now() + timeout;
    let (outcome, code) = loop {
        if cancel.load(Ordering::Acquire) {
            break (Outcome::Cancelled, None);
        }
        if stdout.metadata()?.len() + stderr.metadata()?.len() > limit {
            break (Outcome::OutputLimit, None);
        }
        if let Some(status) = owned.child.try_wait()? {
            break (Outcome::Exited, status.code());
        }
        if Instant::now() >= deadline {
            break (Outcome::Timeout, None);
        }
        thread::sleep(Duration::from_millis(20));
    };
    drop(owned); // Terminate/wait before reading; cloned file handles can share offsets.
    let outcome = if stdout.metadata()?.len() + stderr.metadata()?.len() > limit {
        Outcome::OutputLimit
    } else {
        outcome
    };
    fn read(file: &mut File, limit: u64) -> io::Result<Vec<u8>> {
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.take(limit).read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    Ok(BytesOutput {
        outcome,
        exit_code: code,
        stdout: read(&mut stdout, limit)?,
        stderr: read(&mut stderr, limit)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "process::tests::child_fixture", "--nocapture"])
            .env("OMPIDE_PROCESS_FIXTURE", mode);
        command
    }
    #[test]
    fn bounds_output_and_time_and_supports_cancellation() {
        assert_eq!(
            run(
                &mut fixture("large"),
                &AtomicBool::new(false),
                Duration::from_secs(5),
                1024
            )
            .unwrap()
            .outcome,
            Outcome::OutputLimit
        );
        assert_eq!(
            run(
                &mut fixture("sleep"),
                &AtomicBool::new(false),
                Duration::from_millis(100),
                4096
            )
            .unwrap()
            .outcome,
            Outcome::Timeout
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Release);
        });
        assert_eq!(
            run(&mut fixture("sleep"), &cancel, Duration::from_secs(5), 4096)
                .unwrap()
                .outcome,
            Outcome::Cancelled
        );
        setter.join().unwrap();
        let output = run(
            &mut fixture("output"),
            &AtomicBool::new(false),
            Duration::from_secs(5),
            4096,
        )
        .unwrap();
        assert_eq!(output.exit_code, Some(0));
        assert!(output.stdout.contains("🦀 stdout"));
        assert!(output.stderr.contains("stderr"));
    }
    #[test]
    #[cfg(windows)]
    fn cancellation_terminates_descendants() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("child.pid");
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let ready = marker.clone();
        let setter = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !ready.exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            signal.store(true, Ordering::Release);
        });
        let output = run(
            fixture("tree").env("OMPIDE_CHILD_MARKER", &marker),
            &cancel,
            Duration::from_secs(10),
            4096,
        )
        .unwrap();
        setter.join().unwrap();
        assert_eq!(output.outcome, Outcome::Cancelled);
        let pid: u32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if !handle.is_null() {
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut status = 259;
            loop {
                assert_ne!(unsafe { GetExitCodeProcess(handle, &mut status) }, 0);
                if status != 259 || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            unsafe {
                CloseHandle(handle);
            }
            assert_ne!(status, 259, "descendant survived cancellation");
        }
    }
    #[test]
    fn child_fixture() {
        match std::env::var("OMPIDE_PROCESS_FIXTURE").as_deref() {
            Ok("sleep") => thread::sleep(Duration::from_secs(20)),
            Ok("large") => print!("{}", "x".repeat(32 * 1024)),
            Ok("tree") => {
                let mut child = fixture("sleep").spawn().unwrap();
                std::fs::write(
                    std::env::var("OMPIDE_CHILD_MARKER").unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
                thread::sleep(Duration::from_secs(20));
                let _ = child.wait();
            }
            Ok("output") => {
                println!("🦀 stdout");
                eprintln!("stderr");
            }
            _ => {}
        }
    }
}
