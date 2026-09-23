//! Process-boundary support: Windows Job Object containment and kill escalation.

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

/// Windows process-creation flag keeping the Host console hidden.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// A Job Object that kills the Host tree when the shell dies or drops the handle.
#[cfg(windows)]
pub struct Job {
    handle: HANDLE,
}

// SAFETY: the handle is a kernel handle usable from any thread; every use goes
// through thread-agnostic FFI (create, configure, assign, close).
#[cfg(windows)]
unsafe impl Send for Job {}

#[cfg(windows)]
impl Job {
    /// Create the job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
    pub fn new() -> Result<Self, String> {
        // SAFETY: plain handle factory with no shared state.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("creating the desktop host job object failed".into());
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: freshly created handle, correctly sized information record.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            // SAFETY: the job exists but is unusable; release it instead of leaking the handle.
            unsafe { CloseHandle(handle) };
            return Err("configuring the desktop host job object failed".into());
        }
        Ok(Self { handle })
    }

    /// Add the Host process to the job; its later children join automatically.
    pub fn assign(&self, child: &std::process::Child) -> Result<(), String> {
        // SAFETY: both handles are live for the call's duration.
        let assigned = unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as HANDLE) };
        if assigned == 0 {
            return Err("assigning the desktop host to the job object failed".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // Closing the last job handle fires kill-on-close: an orphaned Host tree dies with it.
        // SAFETY: the handle is owned exclusively by this value.
        unsafe { CloseHandle(self.handle) };
    }
}

/**
 * Terminate the Host process at the platform's request level.
 *
 * Unix delivers SIGTERM; Windows uses TerminateProcess, the only termination
 * request a Windows process understands. The outcome is observed through the
 * child's exit event, not this call's result.
 */
#[cfg(windows)]
pub fn terminate(pid: u32) {
    // SAFETY: handle-scoped FFI with an immediate close; a null handle means the process is gone.
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return;
    }
    // SAFETY: the handle grants PROCESS_TERMINATE.
    unsafe { TerminateProcess(handle, 1) };
    // SAFETY: the handle is owned by this call.
    unsafe { CloseHandle(handle) };
}

/**
 * Force-kill the Host process after the request level was ignored.
 *
 * Unix delivers SIGKILL. Windows has no stronger step than TerminateProcess,
 * so both escalations use it; the job object remains the final backstop.
 */
#[cfg(windows)]
pub fn kill_force(pid: u32) {
    terminate(pid);
}

#[cfg(unix)]
pub fn terminate(pid: u32) {
    // SAFETY: signal delivery by pid; ESRCH simply means the process is gone.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
}

#[cfg(unix)]
pub fn kill_force(pid: u32) {
    // SAFETY: signal delivery by pid; ESRCH simply means the process is gone.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
}
