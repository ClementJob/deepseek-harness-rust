/**
 * Control layer between the Desktop Host and its desktop shell: shell command validation,
 * the shutdown sequence, and Host frames.
 *
 * Two transports carry the same frames: Node IPC for the Electron shell, and LF-delimited
 * NDJSON on stdin/stdout for `--stdio-control` shells, where stdout carries control frames
 * only and Host diagnostics go to stderr.
 */

import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { Readable, Writable } from 'node:stream'

/** Task-control actions the shell may request; `installDesktopUpdateTaskControl` answers them. */
export type UpdateTaskAction = 'inspect' | 'lock' | 'unlock'

/** Task inspector installed on the booted profile context. */
export type UpdateTaskInspector = (action: UpdateTaskAction) => Promise<boolean>

/** A shell command the control layer accepts; every other frame is ignored. */
export type ShellCommand =
  | { readonly type: 'shutdown' }
  | { readonly type: 'update-tasks'; readonly requestId: number; readonly action: UpdateTaskAction }

/** The running profile tree the control layer stops; the structural subset of the `runProfile` result it needs. */
export interface StoppableApplication {
  shutdown: { shutdown(exitCode: number): Promise<void> }
}

/**
 * Byte transport for one shell connection.
 *
 * Implementations deliver frames as-is; the control layer owns validation. A send on a
 * shell that is already gone resolves without delivering, mirroring a disconnected IPC
 * channel. Where the two transports differ is a live-channel delivery failure: Node IPC
 * rejects, the stdio transport logs to stderr and resolves.
 */
export interface ShellTransport {
  /** Whether the shell can still receive frames. */
  readonly connected: boolean
  /**
   * Deliver one control frame to the shell.
   * @param message - Frame payload; serialized by the transport (IPC passthrough, stdio JSON plus LF).
   * @returns Resolves once the channel accepts the frame, or immediately when the shell is gone.
   */
  send(message: object): Promise<void>
  /** Release the channel after the final frame; later sends resolve without delivering and reading ends. */
  close(): void
  /**
   * Register the receiver for shell frames.
   * @param handler - Receives each frame verbatim; the control layer validates it.
   */
  onMessage(handler: (message: unknown) => void): void
  /**
   * Register the receiver for shell loss (IPC `disconnect`, stdin end or read error).
   * @param handler - Invoked at most once.
   */
  onShellGone(handler: () => void): void
}

/** Installation options for the control layer. */
export interface ShellControlOptions {
  /**
   * Diagnostic hook for parsed frames the control layer rejects; stdio shells log them, Electron IPC stays silent.
   * @param message - The rejected frame.
   */
  reportInvalidFrame?: (message: unknown) => void
}

/** Host-side handle the booted profile context wires into the installed control layer. */
export interface ShellControl {
  /** The transport driving this control layer; the fatal path closes it. */
  readonly transport: ShellTransport
  /**
   * Install the task inspector once the profile context is booted.
   * @param inspector - Inspector from `installDesktopUpdateTaskControl`; earlier
   *   `update-tasks` commands answer `desktop update: Host is unavailable`.
   */
  installUpdateTasks(inspector: UpdateTaskInspector): void
  /**
   * Report the authenticated Web application URL.
   * @param url - Authenticated URL from the booted context.
   * @param injections - Boot injections for the Electron packaged-asset window; a stdio shell loads the served URL and receives none.
   * @returns Resolves once the channel accepts the frame; delivery failures are logged.
   */
  reportReady(url: string, injections?: readonly unknown[]): Promise<void>
  /**
   * Publish the active account session for each provider lifetime.
   * @param session - Platform session snapshot, or null when credentials were removed; skipped when the shell is gone.
   */
  publishPlatformSession(session: PlatformSession | null): void
  /**
   * Report a startup failure.
   * @param message - Failure headline.
   * @param diagnostic - Complete inspected error; the head holds the message and stack.
   * @returns Resolves once the channel accepts the frame; delivery failures are logged.
   */
  reportFatal(message: string, diagnostic: string | undefined): Promise<void>
}

/**
 * Install the shared shell-control dispatch on a transport: validated commands drive the
 * shutdown sequence and the update-task inspector, and shell loss runs the same shutdown.
 * @param transport - Shell transport selected by the launcher.
 * @param application - Running profile tree from the profile boot; a rejected boot skips the tree shutdown.
 * @param options - Installation options.
 * @returns The handle the booted profile context wires into.
 */
export function installShellControl(
  transport: ShellTransport,
  application: Promise<StoppableApplication>,
  options: ShellControlOptions = {},
): ShellControl {
  let updateTasks: UpdateTaskInspector | undefined
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported through reportFatal; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await transport.send({ type: 'shutdown-complete' })
    transport.close()
  })()
  transport.onMessage((message) => {
    const command = parseShellCommand(message, options.reportInvalidFrame)
    if (command === undefined) return
    if (command.type === 'shutdown') { void stop(); return }
    void (async () => {
      try {
        if (stopping !== undefined || updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await updateTasks(command.action)
        await transport.send({ type: 'update-tasks', requestId: command.requestId, active })
      } catch (error) {
        await transport.send({ type: 'update-tasks', requestId: command.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  transport.onShellGone(() => { void stop() })
  return {
    transport,
    installUpdateTasks: (inspector) => { updateTasks = inspector },
    reportReady: (url, injections) => {
      const frame: { type: 'ready'; url: string; injections?: readonly unknown[] } = { type: 'ready', url }
      if (injections !== undefined) frame.injections = injections
      return transport.send(frame).catch((error: unknown) => { console.error(error) })
    },
    publishPlatformSession: (session) => {
      if (!transport.connected) return
      void transport.send({ type: 'platform-session', session }).catch((error: unknown) => { console.error(error) })
    },
    reportFatal: (message, diagnostic) => {
      const frame: { type: 'fatal'; message: string; diagnostic?: string } = { type: 'fatal', message }
      if (diagnostic !== undefined) frame.diagnostic = diagnostic
      return transport.send(frame).catch((error: unknown) => { console.error(error) })
    },
  }
}

/**
 * Validate one shell frame against the commands the control layer accepts.
 * @param message - Frame as received.
 * @param reportInvalid - Optional diagnostic hook for rejected frames.
 * @returns The command, or undefined for a frame to ignore.
 */
function parseShellCommand(message: unknown, reportInvalid?: (message: unknown) => void): ShellCommand | undefined {
  if (typeof message !== 'object' || message === null || !('type' in message)) { reportInvalid?.(message); return undefined }
  if (message.type === 'shutdown') return { type: 'shutdown' }
  if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
    || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) {
    reportInvalid?.(message)
    return undefined
  }
  return { type: 'update-tasks', requestId: message.requestId as number, action: message.action as UpdateTaskAction }
}

/** The subset of the Node IPC channel the Electron transport drives. */
interface IpcChannel {
  connected: boolean | undefined
  send?(message: object, callback?: (error: Error | null) => void): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'disconnect', listener: () => void): unknown
  disconnect(): void
}

/**
 * Node IPC transport for the Electron shell, wrapping the process message channel exactly
 * as the historical host wiring did.
 * @param channel - IPC-capable process; defaults to the running process.
 * @returns The transport for `installShellControl`.
 */
export function ipcShellTransport(channel: IpcChannel = process): ShellTransport {
  return {
    get connected() { return channel.connected === true },
    send: (message) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      if (!channel.connected || channel.send === undefined) { resolve(); return promise }
      channel.send(message, (error) => { if (error === null) resolve(); else reject(error) })
      return promise
    },
    close: () => { if (channel.connected) channel.disconnect() },
    onMessage: (handler) => { channel.on('message', handler) },
    onShellGone: (handler) => { channel.once('disconnect', handler) },
  }
}

/** Streams the stdio transport reads shell commands from and writes frames to. */
export interface StdioStreams {
  /** Shell command source; ended or errored stdin means the shell is gone. */
  stdin: Readable
  /** Control-frame sink; must carry control frames only. */
  stdout: Writable
}

/**
 * LF-delimited NDJSON transport over stdin/stdout for `--stdio-control` shells: each frame
 * is one JSON object followed by LF, unparseable lines are logged to stderr and ignored,
 * and stdin reaching end or error means the shell is gone the way an IPC disconnect is.
 * @param streams - Streams to attach to; defaults to the process stdio.
 * @returns The transport for `installShellControl`.
 */
export function stdioShellTransport(streams: StdioStreams = process): ShellTransport {
  let open = true
  let messageHandler: ((message: unknown) => void) | undefined
  let shellGoneHandler: (() => void) | undefined
  let buffered = ''
  const emitShellGone = (): void => {
    if (!open) return
    open = false
    shellGoneHandler?.()
  }
  streams.stdin.setEncoding('utf8')
  streams.stdin.on('data', (chunk: string) => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline === -1) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (messageHandler === undefined) continue
      const frame = line.endsWith('\r') ? line.slice(0, -1) : line
      if (frame.length === 0) continue
      let message: unknown
      try {
        message = JSON.parse(frame)
      } catch (error) {
        console.error('desktop-host: ignoring an unparseable control frame', error)
        continue
      }
      messageHandler(message)
    }
  })
  streams.stdin.once('end', () => { emitShellGone() })
  streams.stdin.once('error', (error: Error) => { console.error(error); emitShellGone() })
  streams.stdout.on('error', (error: Error) => { console.error(error) })
  return {
    get connected() { return open },
    send: (message) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      if (!open) { resolve(); return promise }
      // Write failures are logged by the stdout error listener; the frame is dropped either way.
      streams.stdout.write(`${JSON.stringify(message)}\n`, () => { resolve() })
      return promise
    },
    close: () => {
      open = false
      streams.stdin.destroy()
    },
    onMessage: (handler) => { messageHandler = handler },
    onShellGone: (handler) => { shellGoneHandler = handler },
  }
}
