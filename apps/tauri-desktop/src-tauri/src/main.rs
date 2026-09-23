//! Tauri desktop shell.
//!
//! Owns the private Desktop Host process over an NDJSON stdio control channel
//! and loads the Host's authenticated Web application once it reports readiness.
//! The window is created only after the `ready` frame; Host and shell logs go
//! to stderr so stdout carries nothing but the control protocol.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod frames;
mod host;
mod platform;
mod stderr;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, State, WebviewUrl, WebviewWindowBuilder};

use frames::Frame;
use host::{Event, HostConfig, HostProcess, PendingTask};

/// Environment override pointing the shell at the dev script's prepared resources
/// instead of packaged resources next to the executable.
const RESOURCES_ENV: &str = "DSH_TAURI_RESOURCES";
/// Development override selecting the built pnpm entry (mirrors the Electron development launch).
const PNPM_ENTRY_ENV: &str = "DSH_TAURI_PNPM_ENTRY";
/// Shared with the Electron shell: optional Host inspector port, development only.
const INSPECT_PORT_ENV: &str = "DSH_DESKTOP_HOST_INSPECT_PORT";

/// Slack over the control loop's own 10 s deadline for the command-side reply wait.
const UPDATE_TASKS_REPLY_SLACK: Duration = Duration::from_secs(11);

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let config = match resolve_host_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("dsh tauri desktop: {error}");
            return 1;
        }
    };
    let (events, receiver) = channel::<Event>();
    let mut host = match host::spawn(&config, events.clone()) {
        Ok(host) => host,
        Err(error) => {
            eprintln!("dsh tauri desktop: {error}");
            return 1;
        }
    };

    let app = match tauri::Builder::default()
        .manage(ShellState { events: Mutex::new(events.clone()) })
        .invoke_handler(tauri::generate_handler![desktop_update_tasks])
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            eprintln!("dsh tauri desktop: building the shell failed: {error}");
            let _ = host.stop(&receiver);
            return 1;
        }
    };

    let handle = app.handle().clone();
    let control = std::thread::Builder::new()
        .name("host-control".into())
        .spawn(move || control_loop(host, receiver, handle));
    let control = match control {
        Ok(control) => control,
        Err(error) => {
            eprintln!("dsh tauri desktop: starting the control loop failed: {error}");
            return 1;
        }
    };

    app.run(|_handle, _event| {});
    let _ = events.send(Event::Stop);
    control.join().unwrap_or(1)
}

/// Shared sender letting Tauri commands reach the control loop.
struct ShellState {
    events: Mutex<Sender<Event>>,
}

/**
 * Ask the Host about live work or update-task admission.
 *
 * @param action - `inspect`, `lock`, or `unlock`, as the update handoff expects.
 * @returns Whether live tasks would be affected; lock failures carry the Host's error.
 */
#[tauri::command]
async fn desktop_update_tasks(state: State<'_, ShellState>, action: String) -> Result<bool, String> {
    if !matches!(action.as_str(), "inspect" | "lock" | "unlock") {
        return Err(format!("desktop update: unknown action {action:?}; expected inspect, lock, or unlock"));
    }
    let (reply, reply_receiver) = channel();
    let sender = state
        .events
        .lock()
        .expect("shell event sender lock")
        .clone();
    sender
        .send(Event::UpdateTasks { action, reply })
        .map_err(|_| "desktop update: the shell control loop is gone".to_owned())?;
    let received = tauri::async_runtime::spawn_blocking(move || {
        reply_receiver.recv_timeout(UPDATE_TASKS_REPLY_SLACK)
    })
    .await
    .map_err(|error| format!("desktop update: reply task failed: {error}"))?
    .map_err(|_| "desktop update: the Host reply did not arrive".to_owned())?;
    received
}

/**
 * Pump Host events for the shell's lifetime: create the window on readiness,
 * report failures, correlate `update-tasks` replies, and own teardown.
 *
 * @returns The shell exit code.
 */
fn control_loop(mut host: HostProcess, events: Receiver<Event>, handle: AppHandle) -> i32 {
    let mut pending: HashMap<i64, PendingTask> = HashMap::new();
    let mut window_open = false;
    let mut host_gone = false;
    loop {
        let event = match host::earliest_deadline(&pending) {
            Some(deadline) => match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => {
                    host::fail_expired(&mut pending, Instant::now());
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    host::fail_pending(&mut pending, "desktop update: the shell is shutting down");
                    return 0;
                }
            },
            None => match events.recv() {
                Ok(event) => event,
                Err(_) => return 0,
            },
        };
        match event {
            Event::Frame(Frame::Ready { url }) => {
                if window_open {
                    continue;
                }
                window_open = true;
                if let Err(error) = open_main_window(&handle, &url) {
                    return fatal_stop(&handle, &mut host, host_gone, &events, &error);
                }
            }
            Event::Frame(Frame::Fatal { message, diagnostic }) => {
                let mut reason = format!("the desktop host reported a fatal failure: {message}");
                if let Some(diagnostic) = diagnostic {
                    reason.push_str(&format!("\n{diagnostic}"));
                }
                reason.push_str(&stderr_note(&host));
                return fatal_stop(&handle, &mut host, host_gone, &events, &reason);
            }
            Event::Frame(Frame::ShutdownComplete) => {
                let reason = "the desktop host acknowledged an unrequested shutdown".to_owned();
                return fatal_stop(&handle, &mut host, host_gone, &events, &reason);
            }
            Event::Frame(Frame::PlatformSession { .. }) => {
                // No Platform views in this shell yet; the frames carry credential state
                // only the Platform document consumes.
            }
            Event::Frame(Frame::UpdateTasks { request_id, active, error }) => {
                if let Some(task) = pending.remove(&request_id) {
                    let _ = task.reply.send(match error {
                        Some(error) => Err(error),
                        None => Ok(active),
                    });
                }
            }
            Event::InvalidStream(reason) => {
                let reason = format!("the desktop host violated the control protocol: {reason}");
                return fatal_stop(&handle, &mut host, host_gone, &events, &reason);
            }
            Event::Exited(exit) => {
                host_gone = true;
                let reason = match exit {
                    Ok(status) => format!(
                        "the desktop host exited unexpectedly ({}{})",
                        status.code().map_or_else(|| "signal".to_owned(), |code| code.to_string()),
                        stderr_note(&host),
                    ),
                    Err(error) => format!("waiting for the desktop host failed: {error}"),
                };
                return fatal_stop(&handle, &mut host, host_gone, &events, &reason);
            }
            Event::UpdateTasks { action, reply } => match host.send_update_tasks(&action) {
                Ok(request_id) => {
                    pending.insert(
                        request_id,
                        PendingTask { reply, deadline: Instant::now() + host::UPDATE_TASKS_TIMEOUT },
                    );
                }
                Err(error) => {
                    let _ = reply.send(Err(error));
                }
            },
            Event::Stop => {
                host::fail_pending(&mut pending, "desktop update: the shell is shutting down");
                if host_gone {
                    return 0;
                }
                let report = host.stop(&events);
                eprintln!("dsh tauri desktop: host stopped ({})", describe_stop(&report));
                return if report.is_clean() { 0 } else { 1 };
            }
        }
    }
}

/**
 * Create the main window on the main thread and load the Host's authenticated URL.
 *
 * Creation is queued; a failure inside the queued closure exits the application
 * because the shell has nothing to show without the Host document.
 */
fn open_main_window(handle: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("the ready url is invalid: {error}"))?;
    let queued = handle.clone();
    handle
        .run_on_main_thread(move || {
            let window = WebviewWindowBuilder::new(&queued, "main", WebviewUrl::External(parsed))
                .title("DeepSeek Harness")
                .inner_size(1280.0, 820.0)
                .min_inner_size(520.0, 600.0);
            if let Err(error) = window.build() {
                eprintln!("dsh tauri desktop: creating the main window failed: {error}");
                queued.exit(1);
            }
        })
        .map_err(|error| format!("queueing the main window creation failed: {error}"))
}

/// Report a fatal failure, stop the Host through the escalation chain, and exit.
fn fatal_stop(
    handle: &AppHandle,
    host: &mut HostProcess,
    host_gone: bool,
    events: &Receiver<Event>,
    reason: &str,
) -> i32 {
    eprintln!("dsh tauri desktop: fatal: {reason}");
    if !host_gone {
        let report = host.stop(events);
        eprintln!("dsh tauri desktop: host stopped after failure ({})", describe_stop(&report));
    }
    handle.exit(1);
    1
}

/// The retained Host stderr tail, when any output arrived.
fn stderr_note(host: &HostProcess) -> String {
    let tail = host.stderr_tail().lock().expect("stderr tail lock").text();
    if tail.is_empty() {
        String::new()
    } else {
        format!("\nhost stderr tail:\n{tail}")
    }
}

fn describe_stop(report: &host::StopReport) -> String {
    let exit = match &report.exit {
        Some(Ok(status)) => format!(
            "exit {}",
            status.code().map_or_else(|| "signal".to_owned(), |code| code.to_string()),
        ),
        Some(Err(error)) => format!("exit status unavailable: {error}"),
        None => "did not exit; the job object is the remaining backstop".to_owned(),
    };
    format!("{exit}, shutdown acknowledged {}, forced {}", report.shutdown_completed, report.forced)
}

/// Resolve the Host launch inputs from packaged resources or the dev script's overrides.
fn resolve_host_config() -> Result<HostConfig, String> {
    let dev_resources = std::env::var(RESOURCES_ENV).ok().filter(|value| !value.trim().is_empty());
    let development = dev_resources.is_some();
    let resources = match dev_resources {
        Some(directory) => PathBuf::from(directory),
        None => {
            let executable =
                std::env::current_exe().map_err(|error| format!("locating the executable failed: {error}"))?;
            let directory = executable
                .parent()
                .ok_or_else(|| "the executable has no parent directory".to_owned())?;
            directory.join("resources")
        }
    };

    let runtime_dir = resources.join("dsh");
    let runtime_root = resources.join("runtime");
    let node = runtime_root.join("bin").join(if cfg!(windows) { "node.exe" } else { "node" });
    let project_dir = if development {
        resources.join("home").join("profiles").join("desktop")
    } else {
        dsh_home()?.join("profiles").join("desktop")
    };
    let env_overrides = if development {
        vec![(
            "DSH_HOME".to_owned(),
            resources.join("home").to_string_lossy().into_owned(),
        )]
    } else {
        Vec::new()
    };

    let pnpm = match std::env::var(PNPM_ENTRY_ENV).ok().filter(|value| !value.trim().is_empty()) {
        Some(entry) => Some(PathBuf::from(entry)),
        None => {
            let packaged = runtime_root.join("pnpm").join("bin").join("pnpm.mjs");
            packaged.is_file().then_some(packaged)
        }
    };
    let node_bin = {
        let directory = runtime_root.join("bin");
        directory.is_dir().then_some(directory)
    };
    let inspect_port = if cfg!(debug_assertions) { inspect_port()? } else { None };

    Ok(HostConfig {
        node,
        runtime_dir,
        project_dir,
        primary_runtime: runtime_root.join("primary-runtime"),
        pnpm,
        node_bin,
        inspect_port,
        env_overrides,
    })
}

/// Mirrors `@deepseek-ai/dsh-home-paths`: `$DSH_HOME` when set, else `~/.dsh`.
fn dsh_home() -> Result<PathBuf, String> {
    match std::env::var("DSH_HOME").ok().filter(|value| !value.trim().is_empty()) {
        Some(home) => Ok(PathBuf::from(home)),
        None => {
            let home = std::env::home_dir()
                .ok_or_else(|| "the user home directory is unknown".to_owned())?;
            Ok(home.join(".dsh"))
        }
    }
}

fn inspect_port() -> Result<Option<u16>, String> {
    match std::env::var(INSPECT_PORT_ENV).ok().filter(|value| !value.trim().is_empty()) {
        None => Ok(None),
        Some(value) => {
            let invalid = || format!("{INSPECT_PORT_ENV} must be an integer from 1 through 65535");
            let port: u16 = value.parse().map_err(|_| invalid())?;
            if port == 0 {
                return Err(invalid());
            }
            Ok(Some(port))
        }
    }
}
