/** Launch the Desktop profile through the Web application and report its URL to the desktop shell:
 * Electron over Node IPC, or `--stdio-control` NDJSON frames. */

import { delimiter, join } from 'node:path'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'
import { installShellControl, ipcShellTransport, stdioShellTransport, type ShellControl } from './shell-control.ts'
import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOfficeEngineResolution } from './office-engine.ts'

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  const stdioMode = process.argv.includes('--stdio-control')
  // Boot failures surface as this promise's rejection, so the control channel exists to report them.
  const application = (async () => {
    installOfficeEngineResolution(runtimeDir)
    const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
    return runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: 'desktop',
      resolvedProfile: { profile, installAnchor },
      patchFiles: [],
      args: ['--no-open', '--no-print-url', '--port', '19387'],
      ...(process.argv[5] === undefined ? {} : {
        packageManager: {
          command: process.execPath,
          args: ['--expose-internals', process.argv[5]],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
            PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
          },
        },
      }),
    })
  })()
  const control = installShellControl(
    stdioMode ? stdioShellTransport() : ipcShellTransport(),
    application,
    // stdio frames share the shell's protocol stream; IPC frames come from the trusted Electron parent.
    stdioMode ? { reportInvalidFrame: reportInvalidControlFrame } : {},
  )
  try {
    const { ctx } = await application
    control.installUpdateTasks(installDesktopUpdateTaskControl(ctx))
    await ctx.plugin(desktopOffice, {
      source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
      root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
    })
    installPlatformSessionPublisher(ctx, (session) => { control.publishPlatformSession(session) })
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
    await control.reportReady(url, stdioMode ? undefined : ctx.webServer.collectIndexInjections())
  } catch (error) {
    reportFatalShutdown(control, error)
  }
}

/**
 * Report a startup failure to the shell and let the process exit with a failure code.
 *
 * The shell receives the complete inspected error here, not through stderr: stderr bytes
 * and this control frame race, and the shell reports the first failure it sees.
 */
function reportFatalShutdown(control: ShellControl, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
  void control.reportFatal(message, diagnostic)
  console.error(error)
  process.exitCode = 1
  control.transport.close()
}

/** Log a rejected stdio control frame; the protocol stream on stdout stays clean. */
function reportInvalidControlFrame(message: unknown): void {
  console.error('desktop-host: ignoring an invalid control frame', message)
}

/** Upper bound of the startup diagnostic carried over the control channel; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  void main()
}
