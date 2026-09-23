# DeepSeek Harness Desktop Host

English | [中文](README.zh.md)

The Desktop Host is the private Node-mode child process behind the desktop shells. It boots the shared Desktop profile through `runProfile`, serves the complete Web application on the reserved port `19387`, and reports its authenticated URL, account sessions, and lifecycle to the shell over a control channel. The Electron shell spawns it in Electron Node mode and drives Node IPC; a Tauri shell appends `--stdio-control` to the same argv and drives LF-delimited NDJSON on stdin/stdout. The deleted Electron shell's `apps/desktop/src/host-process.ts` was the IPC-side counterpart of this protocol, and `src/shell-control.ts` owns the shared control layer both transports feed.

## Control channel

Frames are JSON objects. The Node IPC transport passes them through `process.send` and `process.on('message')`. The stdio transport writes one JSON object per line (LF-terminated, UTF-8, no length prefix) to stdout and reads shell commands from stdin; stdout carries control frames only, and every Host diagnostic goes to stderr. An unparseable or rejected stdio frame is logged to stderr and ignored, never crashing the Host. stdin reaching end of file — the shell died first — runs the same shutdown as an IPC `disconnect`.

Shell → Host:

| Frame | Meaning |
| --- | --- |
| `{"type":"shutdown"}` | Stop the profile tree. |
| `{"type":"update-tasks","requestId":<safe integer>,"action":"inspect"\|"lock"\|"unlock"}` | Inspect or gate active agent and job work for a desktop update. |

Host → Shell:

| Frame | Meaning |
| --- | --- |
| `{"type":"ready","url":"<authenticatedUrl>"}` | The Web application is serving; sent once after boot. The stdio frame omits `injections` because a Tauri shell loads the authenticated URL directly, while Electron receives `injections` for its packaged-asset window. |
| `{"type":"fatal","message":"...","diagnostic"?: "..."}` | Startup failure; the process then exits with code 1. |
| `{"type":"shutdown-complete"}` | The profile tree finished `shutdown.shutdown(0)`. |
| `{"type":"platform-session","session":...}` | The active account session, or `null` when credentials were removed. |
| `{"type":"update-tasks","requestId":N,"active":<boolean>,"error"?: "..."}` | Reply to the matching request; a failure reports `active: true` plus `error`. |

`ready` is sent once after boot. A `shutdown` command runs `shutdown.shutdown(0)`, then the Host sends `shutdown-complete`, releases the channel (IPC `disconnect`, stdin teardown), and exits when the event loop drains; the shell owns its own escalation timeouts. When the shell dies first, the stop runs but delivers no frame because the channel is already gone. An `update-tasks` command that arrives before boot or after shutdown began is answered with `active: true` and `desktop update: Host is unavailable`; the shell owns the request timeout budget.

## Development

`tests/stdio-control.spec.ts` covers the protocol with real stdio pipes against `tests/fixtures/stdio-host.ts` and covers the shared dispatch and both transports with injected channels.
