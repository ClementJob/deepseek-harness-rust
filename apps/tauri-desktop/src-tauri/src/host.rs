//! The private Desktop Host child: spawn, NDJSON control channel, and teardown escalation.
//!
//! Lifecycle semantics mirror the Electron shell (`apps/desktop/src/host-process.ts`):
//! spawn arguments, the 10 s/5 s/5 s shutdown escalation, the 64 KiB stderr tail,
//! and treating any protocol violation as a fatal failure.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::frames::{Frame, FrameStream};
use crate::stderr::BoundedTail;

/// Byte bound of the retained Host stderr tail (64 KiB, matching the Electron shell).
pub const STDERR_TAIL_BYTES: usize = 64 * 1024;

/// How long a `update-tasks` reply may take before the request fails.
pub const UPDATE_TASKS_TIMEOUT: Duration = Duration::from_secs(10);

const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const TERMINATE_GRACE: Duration = Duration::from_secs(5);
const KILL_GRACE: Duration = Duration::from_secs(5);

/// Resolved launch inputs for one Host process.
pub struct HostConfig {
    pub node: PathBuf,
    pub runtime_dir: PathBuf,
    pub project_dir: PathBuf,
    pub primary_runtime: PathBuf,
    pub pnpm: Option<PathBuf>,
    pub node_bin: Option<PathBuf>,
    pub inspect_port: Option<u16>,
    /// Additional child environment entries; development isolation sets `DSH_HOME`.
    pub env_overrides: Vec<(String, String)>,
}

/// Events bubbling from the Host's reader threads and shell requests into the control loop.
pub enum Event {
    Frame(Frame),
    /// The stdout stream violated the control protocol; the Host must not be trusted further.
    InvalidStream(String),
    Exited(std::io::Result<ExitStatus>),
    UpdateTasks { action: String, reply: Sender<Result<bool, String>> },
    /// The shell is exiting and the Host must be stopped through the escalation chain.
    Stop,
}

/// Correlated reply slot for one in-flight `update-tasks` request.
pub struct PendingTask {
    pub reply: Sender<Result<bool, String>>,
    pub deadline: Instant,
}

/** One Web backend running under the runtime Node executable. */
pub struct HostProcess {
    pid: u32,
    stdin: ChildStdin,
    stderr_tail: Arc<Mutex<BoundedTail>>,
    next_request_id: i64,
    #[cfg(windows)]
    _job: crate::platform::Job,
}

/**
 * Spawn the Host in stdio control mode and wire its event plumbing.
 *
 * Returns the process handle for the control loop; events from the stdout
 * reader, the stderr reader, and the exit waiter arrive on the same channel.
 */
pub fn spawn(config: &HostConfig, events: Sender<Event>) -> Result<HostProcess, String> {
    let entry = config
        .runtime_dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh-desktop-host")
        .join("lib")
        .join("index.js");
    if !entry.is_file() {
        return Err(format!("desktop host entry is missing: {}; build the dsh runtime first", entry.display()));
    }
    if !config.node.is_file() {
        return Err(format!("host node executable is missing: {}", config.node.display()));
    }
    if !config.project_dir.is_dir() {
        return Err(format!("host project directory is missing: {}", config.project_dir.display()));
    }

    let mut args: Vec<OsString> = vec!["--expose-internals".into()];
    if let Some(port) = config.inspect_port {
        args.push(format!("--inspect=127.0.0.1:{port}").into());
    }
    args.push(entry.into_os_string());
    args.push(config.runtime_dir.clone().into_os_string());
    args.push(config.project_dir.clone().into_os_string());
    args.push(config.primary_runtime.clone().into_os_string());
    if let (Some(pnpm), Some(node_bin)) = (&config.pnpm, &config.node_bin) {
        args.push(pnpm.clone().into_os_string());
        args.push(node_bin.clone().into_os_string());
    }
    args.push("--stdio-control".into());

    let mut command = Command::new(&config.node);
    command
        .args(args)
        .current_dir(&config.project_dir)
        .envs(config.env_overrides.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(crate::platform::CREATE_NO_WINDOW);

    let mut child =
        command.spawn().map_err(|error| format!("failed to spawn the desktop host: {error}"))?;
    let pid = child.id();

    #[cfg(windows)]
    let job = {
        let job = crate::platform::Job::new()?;
        job.assign(&child)?;
        job
    };

    let stdin = child.stdin.take().expect("host stdin is piped");
    let stdout = child.stdout.take().expect("host stdout is piped");
    let stderr = child.stderr.take().expect("host stderr is piped");
    let stderr_tail = Arc::new(Mutex::new(BoundedTail::new(STDERR_TAIL_BYTES)));

    spawn_thread("host-stdout", {
        let events = events.clone();
        move || read_stdout(stdout, events)
    })?;
    spawn_thread("host-stderr", {
        let stderr_tail = Arc::clone(&stderr_tail);
        move || read_stderr(stderr, stderr_tail)
    })?;
    spawn_thread("host-exit", {
        let events = events.clone();
        move || {
            let _ = events.send(Event::Exited(child.wait()));
        }
    })?;

    Ok(HostProcess {
        pid,
        stdin,
        stderr_tail,
        next_request_id: 1,
        #[cfg(windows)]
        _job: job,
    })
}

fn spawn_thread(name: &str, run: impl FnOnce() + Send + 'static) -> Result<(), String> {
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(run)
        .map(|_| ())
        .map_err(|error| format!("starting the {name} reader failed: {error}"))
}

fn read_stdout(stdout: impl Read, events: Sender<Event>) {
    let mut stream = FrameStream::new();
    let mut reader = stdout;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => match stream.push(&chunk[..count]) {
                Ok(frames) => {
                    for frame in frames {
                        if events.send(Event::Frame(frame)).is_err() {
                            return;
                        }
                    }
                }
                Err(reason) => {
                    let _ = events.send(Event::InvalidStream(reason));
                    return;
                }
            },
            Err(error) => {
                let _ = events.send(Event::InvalidStream(format!("reading host stdout failed: {error}")));
                return;
            }
        }
    }
    if let Err(reason) = stream.finish() {
        let _ = events.send(Event::InvalidStream(reason));
    }
}

fn read_stderr(stderr: impl Read, tail: Arc<Mutex<BoundedTail>>) {
    let mut reader = stderr;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return,
            Ok(count) => {
                if let Ok(mut tail) = tail.lock() {
                    tail.extend(&chunk[..count]);
                }
            }
            Err(_) => return,
        }
    }
}

impl HostProcess {
    /// The retained stderr tail, for failure diagnostics.
    pub fn stderr_tail(&self) -> Arc<Mutex<BoundedTail>> {
        Arc::clone(&self.stderr_tail)
    }

    /// Send one `update-tasks` request; the control loop correlates the reply by id.
    pub fn send_update_tasks(&mut self, action: &str) -> Result<i64, String> {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let frame = serde_json::json!({ "type": "update-tasks", "requestId": request_id, "action": action });
        self.send_line(&format!("{frame}\n"))?;
        Ok(request_id)
    }

    /// Best-effort `shutdown`; the escalation chain in `stop` owns the outcome.
    pub fn request_shutdown(&mut self) {
        let frame = serde_json::json!({ "type": "shutdown" });
        if let Err(error) = self.send_line(&format!("{frame}\n")) {
            eprintln!("dsh tauri desktop: {error}");
        }
    }

    /**
     * Teardown escalation: `shutdown`, 10 s, terminate, 5 s, force-kill, 5 s.
     *
     * Drains events while waiting; `shutdown-complete` confirms a graceful stop.
     */
    pub fn stop(&mut self, events: &Receiver<Event>) -> StopReport {
        self.request_shutdown();
        let mut shutdown_completed = false;
        let mut exit = await_exit(events, SHUTDOWN_GRACE, &mut shutdown_completed);
        let mut forced = false;
        if exit.is_none() {
            crate::platform::terminate(self.pid);
            forced = true;
            exit = await_exit(events, TERMINATE_GRACE, &mut shutdown_completed);
            if exit.is_none() {
                crate::platform::kill_force(self.pid);
                exit = await_exit(events, KILL_GRACE, &mut shutdown_completed);
            }
        }
        StopReport { exit, shutdown_completed, forced }
    }

    fn send_line(&mut self, line: &str) -> Result<(), String> {
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|()| self.stdin.flush())
            .map_err(|error| format!("the host control pipe is closed: {error}"))
    }
}

/// Outcome of the teardown escalation.
pub struct StopReport {
    /// The child's exit status, or none if it survived every escalation step.
    pub exit: Option<std::io::Result<ExitStatus>>,
    pub shutdown_completed: bool,
    pub forced: bool,
}

impl StopReport {
    /** A clean stop: the child exited with code 0 after acknowledging `shutdown`. */
    pub fn is_clean(&self) -> bool {
        matches!(&self.exit, Some(Ok(status)) if status.code() == Some(0))
            && self.shutdown_completed
            && !self.forced
    }
}

fn await_exit(
    events: &Receiver<Event>,
    timeout: Duration,
    shutdown_completed: &mut bool,
) -> Option<std::io::Result<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match events.recv_timeout(remaining) {
            Ok(Event::Exited(exit)) => return Some(exit),
            Ok(Event::Frame(Frame::ShutdownComplete)) => *shutdown_completed = true,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

/// Reply every in-flight `update-tasks` request; used when the shell stops waiting.
pub fn fail_pending(pending: &mut HashMap<i64, PendingTask>, error: &str) {
    for (_, task) in pending.drain() {
        let _ = task.reply.send(Err(error.to_owned()));
    }
}

/// Reply `update-tasks` requests whose deadline elapsed.
pub fn fail_expired(pending: &mut HashMap<i64, PendingTask>, now: Instant) {
    let expired: Vec<i64> = pending
        .iter()
        .filter(|(_, task)| task.deadline <= now)
        .map(|(id, _)| *id)
        .collect();
    for id in expired {
        if let Some(task) = pending.remove(&id) {
            let _ = task.reply.send(Err("desktop update: task inspection timed out".into()));
        }
    }
}

/// Earliest pending deadline, for the control loop's bounded wait.
pub fn earliest_deadline(pending: &HashMap<i64, PendingTask>) -> Option<Instant> {
    pending.values().map(|task| task.deadline).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn pending_task(deadline: Instant) -> PendingTask {
        let (reply, _) = channel();
        PendingTask { reply, deadline }
    }

    #[test]
    fn fails_only_expired_requests() {
        let now = Instant::now();
        let mut pending = HashMap::new();
        pending.insert(1, pending_task(now - Duration::from_secs(1)));
        pending.insert(2, pending_task(now + Duration::from_secs(30)));
        fail_expired(&mut pending, now);
        assert_eq!(pending.len(), 1);
        assert!(pending.contains_key(&2));
    }

    #[test]
    fn reports_the_earliest_deadline() {
        let now = Instant::now();
        let mut pending = HashMap::new();
        pending.insert(1, pending_task(now + Duration::from_secs(30)));
        pending.insert(2, pending_task(now + Duration::from_secs(5)));
        assert_eq!(earliest_deadline(&pending), Some(now + Duration::from_secs(5)));
    }
}
