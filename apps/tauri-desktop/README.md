# DeepSeek Harness Tauri Desktop

English | [中文](README.zh.md)

The Tauri desktop application is a Rust shell around the complete dsh Web application. It spawns the shared [Desktop Host](../desktop-host/README.md) under the bundled runtime Node and loads the Host's authenticated Web application once the Host reports readiness. It replaces the deleted Electron shell; the wayfinder map (issue #4) records the migration decisions.

## Architecture

```
┌────────────────────────── Tauri shell (Rust) ──────────────────────────┐
│  control loop               main window (created on ready frame)       │
│      │  stdin NDJSON              │ WebviewUrl::External(ready.url)    │
│      ▼  ◄── stdout NDJSON ──      ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Desktop Host (Node, spawned from runtime/bin)                   │  │  │
│  │  dsh profile + Web application, authenticated HTTP on 19387      │  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Window.** No window exists at startup. The first `ready` frame carries the authenticated URL and the shell creates the main window loading it directly (`WebviewUrl::External`); the Host serves every asset and boot injection, so no custom protocol or proxy exists. Token authentication lands in the WebView2 cookie jar the same way a browser session does.
- **Process containment.** On Windows the Host child joins a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so an orphaned Host tree dies with the shell; spawn uses `CREATE_NO_WINDOW`. On Unix the shell delivers termination signals directly.
- **Stderr.** A dedicated reader thread keeps the last 64 KiB of Host stderr in a bounded tail for failure diagnostics, mirroring the Electron shell; nothing is forwarded to the Web document.
- **Console.** Release builds set `windows_subsystem = "windows"`; debug builds keep the console and support the shared `DSH_DESKTOP_HOST_INSPECT_PORT` inspector override.

## Control protocol

stdin and stdout carry one JSON object per line (LF-terminated UTF-8, no length prefix). Host logs go to stderr only, so stdout carries nothing but this protocol. The Electron shell expresses the same events over Node IPC (`apps/desktop/src/host-process.ts`); the message shapes are shared.

Shell → Host:

| Frame | Meaning |
|---|---|
| `{"type":"shutdown"}` | Begin teardown; the Host finishes `shutdown.shutdown(0)`, then exits. |
| `{"type":"update-tasks","requestId":N,"action":"inspect"\|"lock"\|"unlock"}` | Read live work or gate update handoff; the Host replies by `requestId`. |

Host → shell:

| Frame | Meaning |
|---|---|
| `{"type":"ready","url":"…"}` | The authenticated Web application is serving; sent once. |
| `{"type":"fatal","message":"…","diagnostic"?}` | A Host-chosen failure report; `diagnostic` is the complete inspected error when supplied. |
| `{"type":"shutdown-complete"}` | The Host acknowledged a `shutdown` request and completed teardown. |
| `{"type":"platform-session","session":…}` | Embedded-Platform credential state; this shell has no Platform views and ignores it. |
| `{"type":"update-tasks","requestId":N,"active":bool,"error"?}` | Reply to the matching request. |

Any other stdout byte sequence — invalid JSON, an unknown frame, or a line without a terminator — is a protocol violation and becomes a shell fatal error. The shell enforces a 1 MiB per-frame bound.

### Shutdown escalation

Requesting stop sends `shutdown`, then waits 10 s for exit. Without an exit it terminates the process (SIGTERM on Unix, TerminateProcess on Windows — a Windows process has no stronger request level), waits 5 s, then force-kills and waits a further 5 s. A `shutdown-complete` frame received before exit confirms a graceful stop; clean means chose-to-show confirmation plus exit code 0 with no forced step. The Job Object remains the last-resort backstop for a Host that survives every step on Windows.

### Update-task queries

`desktop_update_tasks` Tauri commands send the action and wait for the correlated reply with a 10 s deadline; timed-out and unanswered requests fail with the update-handoff error, and only `inspect`/`lock`/`unlock` names are accepted. The shell never authorizes installation itself; it only records whether live tasks would be affected, matching the Electron shell's update-coordinator contract.

## Development

```sh
pnpm --dir apps/tauri-desktop run dev
pnpm --dir apps/tauri-desktop run start        # skip the workspace build
```

`scripts/dev.ts` builds the workspace, then `scripts/dev-runtime.ts` prepares the disposable resources under `.tauri-build/development/`:

- `dsh/` — the runtime project whose `node_modules` links the built CLI (`@deepseek-ai/dsh`), the Desktop Host, and their `workspace:` dependencies, with a hoisted-linker pnpm workspace file, so the Host entry at `node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` resolves.
- `runtime/bin/node` — the launcher's own Node executable, the process the shell spawns (production copies the packaged runtime here through the packaging flow).
- `runtime/pnpm` + `runtime/primary-runtime/office-skills` — the package-manager entry and the Office skill assets the desktop Office plugin requires.
- `home/` — a development Harness home; its `profiles/desktop` profile is initialized with the shared Web bundle template and never overwritten afterwards.

The launcher then builds the shell (`cargo build`) and start it with `DSH_TAURI_RESOURCES` and `DSH_HOME` pointing at the prepared tree. Debug builds (`cfg(debug_assertions)`) read those overrides; packaged builds resolve `resources/` next to the executable, honor the user's real `DSH_HOME`, and derive node, pnpm and primary-runtime paths the same way the Electron shell derived them from `process.resourcesPath`.

Host logs reach the console (stderr); application troubleshooting follows the same practices as the Web application.

## Layout

```
package.json        workspace package, scripts for dev and cargo checks
scripts/
  dev.ts            development launcher: build, prepare, launch
  dev-runtime.ts    development resources and profile preparation
src-tauri/
  Cargo.toml        shell crate (tauri 2, serde_json, windows-sys/libc)
  build.rs          tauri-build context
  tauri.conf.json   identifier/productName/version; no window or updater config
  icons/icon.ico    placeholder Windows resource icon
  src/
    main.rs         entry, configuration resolution, control loop, window
    host.rs         Host spawn, argv shape, NDJSON channel, escalation
    frames.rs       NDJSON frame parsing (unit-tested)
    stderr.rs       bounded stderr tail (unit-tested)
    platform.rs     Job Object containment and kill escalation
shell-dist/         static placeholder the window configuration requires
```

`tauri.conf.json` carries no updater or signing configuration; packaging and signing follow the separate packaging-and-signing ticket (#6) and reuse the dsh release identity.
