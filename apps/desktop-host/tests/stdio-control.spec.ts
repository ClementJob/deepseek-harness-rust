/** Desktop Host shell-control behavior: real stdio pipes against the protocol fixture,
 * plus the shared dispatch and both transports over injected channels. */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installShellControl, ipcShellTransport, stdioShellTransport, type ShellTransport, type StoppableApplication } from '../src/shell-control.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/stdio-host.ts', import.meta.url))

/** Bound on a single fixture frame wait; a failure carries stderr so a dead child explains itself. */
const LINE_TIMEOUT_MS = 4_000

/** A spawned fixture child with bounded frame reads and quiescent teardown. */
interface Fixture {
  child: ChildProcess
  send(line: string): void
  nextLine(): Promise<string>
  lineCount(): number
  stderrText(): string
  /** Resolves with the exit code once stderr has drained. */
  settled(): Promise<number | null>
}

function spawnFixture(env: Record<string, string> = {}): Fixture {
  const child = spawn(process.execPath, [fixturePath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  const pending: Array<(line: string | null) => void> = []
  const queued: (string | null)[] = []
  let lines = 0
  let stderr = ''
  const reader = createInterface({ input: child.stdout })
  reader.on('line', (line: string) => {
    lines += 1
    const waiter = pending.shift()
    if (waiter !== undefined) waiter(line)
    else queued.push(line)
  })
  reader.once('close', () => {
    const waiter = pending.shift()
    if (waiter !== undefined) waiter(null)
    else queued.push(null)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const { promise: exit, resolve: exitResolve } = Promise.withResolvers<number | null>()
  child.once('exit', (code) => { exitResolve(code) })
  const stderrDrained = finished(child.stderr, { cleanup: true })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exit
    await stderrDrained
  })
  return {
    child,
    send: (line) => { child.stdin.write(line) },
    nextLine: () => {
      const queuedLine = queued.shift()
      if (queuedLine !== null && queuedLine !== undefined) return Promise.resolve(queuedLine)
      if (queuedLine !== undefined) return Promise.reject(new Error(`fixture stdout ended before a frame; stderr: ${stderr}`))
      const { promise, resolve, reject } = Promise.withResolvers<string>()
      const timer = setTimeout(() => { reject(new Error(`fixture frame timeout; stderr: ${stderr}`)) }, LINE_TIMEOUT_MS)
      pending.push((line) => {
        clearTimeout(timer)
        if (line === null) reject(new Error(`fixture stdout ended before a frame; stderr: ${stderr}`))
        else resolve(line)
      })
      return promise
    },
    lineCount: () => lines,
    stderrText: () => stderr,
    settled: async () => {
      const code = await exit
      await stderrDrained
      return code
    },
  }
}

async function awaitReady(fixture: Fixture): Promise<void> {
  expect(JSON.parse(await fixture.nextLine())).toEqual({ type: 'ready', url: 'http://127.0.0.1:19387/' })
}

/** Deterministic drain for the dispatch's microtask chains. */
async function settleDispatch(): Promise<void> {
  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers()
  setImmediate(resolve)
  await promise
}

function fakeApplication(onShutdown: () => void = () => {}): Promise<StoppableApplication> {
  return Promise.resolve({ shutdown: { shutdown: async () => { onShutdown() } } })
}

/** In-memory transport recording every frame and close for dispatch assertions. */
function controlSpy(): ShellTransport & {
  emit(message: unknown): void
  loseShell(): void
  frames(): object[]
  closeCount(): number
} {
  const sent: object[] = []
  let messageHandler: ((message: unknown) => void) | undefined
  let shellGoneHandler: (() => void) | undefined
  let closes = 0
  return {
    get connected() { return closes === 0 },
    send: (message) => {
      if (closes > 0) return Promise.resolve()
      sent.push(message)
      return Promise.resolve()
    },
    close: () => { closes += 1 },
    onMessage: (handler) => { messageHandler = handler },
    onShellGone: (handler) => { shellGoneHandler = handler },
    emit: (message) => { messageHandler?.(message) },
    loseShell: () => { shellGoneHandler?.() },
    frames: () => sent,
    closeCount: () => closes,
  }
}

it('reports ready with the authenticated URL once boot completes', async () => {
  await awaitReady(spawnFixture())
})

it('answers shutdown with shutdown-complete, stops the profile tree once, and exits cleanly', async () => {
  const fixture = spawnFixture()
  await awaitReady(fixture)
  fixture.send('{"type":"shutdown"}\n')
  expect(JSON.parse(await fixture.nextLine())).toEqual({ type: 'shutdown-complete' })
  const exitCode = await fixture.settled()
  expect(fixture.child.signalCode).toBeNull()
  expect(exitCode).toBe(0)
  expect(fixture.stderrText()).toContain('desktop-host fixture: shutdown(0)')
  expect(fixture.stderrText().split('desktop-host fixture: shutdown(')).toHaveLength(2)
  expect(fixture.lineCount()).toBe(2)
})

it('answers update-tasks with the installed inspector result', async () => {
  const fixture = spawnFixture()
  await awaitReady(fixture)
  fixture.send('{"type":"update-tasks","requestId":11,"action":"inspect"}\n')
  expect(JSON.parse(await fixture.nextLine())).toEqual({ type: 'update-tasks', requestId: 11, active: false })
  fixture.send('{"type":"shutdown"}\n')
  expect(JSON.parse(await fixture.nextLine())).toEqual({ type: 'shutdown-complete' })
})

it('reports update-tasks failures as active with the error message', async () => {
  const fixture = spawnFixture({ DSH_FIXTURE_UPDATE_TASKS: 'fail' })
  await awaitReady(fixture)
  fixture.send('{"type":"update-tasks","requestId":12,"action":"lock"}\n')
  expect(JSON.parse(await fixture.nextLine()))
    .toEqual({ type: 'update-tasks', requestId: 12, active: true, error: 'fixture task failure' })
})

it('ignores invalid frames, keeps the channel working, and keeps stdout to control frames', async () => {
  const fixture = spawnFixture()
  await awaitReady(fixture)
  fixture.send('not-json\n')
  fixture.send('{"type":"unknown"}\n')
  fixture.send('[1]\n')
  fixture.send('"str"\n')
  fixture.send('{"type":"shutdown"}\n')
  expect(JSON.parse(await fixture.nextLine())).toEqual({ type: 'shutdown-complete' })
  const exitCode = await fixture.settled()
  expect(exitCode).toBe(0)
  expect(fixture.stderrText()).toContain('ignoring an unparseable control frame')
  expect(fixture.stderrText()).toContain('ignoring an invalid control frame')
  // Invalid frames produced no stdout: only ready and shutdown-complete ever arrived.
  expect(fixture.lineCount()).toBe(2)
})

it('stops the profile tree when the shell closes stdin first, without a shutdown-complete frame', async () => {
  const fixture = spawnFixture()
  await awaitReady(fixture)
  fixture.child.stdin!.end()
  const exitCode = await fixture.settled()
  expect(fixture.child.signalCode).toBeNull()
  expect(exitCode).toBe(0)
  expect(fixture.stderrText()).toContain('desktop-host fixture: shutdown(0)')
  // The shell is already gone, so the stop itself stays silent, exactly like the IPC disconnect path.
  expect(fixture.lineCount()).toBe(1)
})

it('answers update-tasks before boot with the unavailable error', async () => {
  const spy = controlSpy()
  installShellControl(spy, Promise.withResolvers<StoppableApplication>().promise)
  spy.emit({ type: 'update-tasks', requestId: 1, action: 'inspect' })
  await settleDispatch()
  expect(spy.frames())
    .toEqual([{ type: 'update-tasks', requestId: 1, active: true, error: 'desktop update: Host is unavailable' }])
})

it('runs the shutdown sequence once across repeated commands and shell loss', async () => {
  const spy = controlSpy()
  let shutdowns = 0
  installShellControl(spy, fakeApplication(() => { shutdowns += 1 }))
  spy.emit({ type: 'shutdown' })
  spy.emit({ type: 'shutdown' })
  spy.loseShell()
  await settleDispatch()
  expect(shutdowns).toBe(1)
  expect(spy.frames()).toEqual([{ type: 'shutdown-complete' }])
  expect(spy.closeCount()).toBe(1)
})

it('answers update-tasks with the installed inspector result over the shared dispatch', async () => {
  const spy = controlSpy()
  const control = installShellControl(spy, fakeApplication())
  const inspected: string[] = []
  control.installUpdateTasks(async (action) => { inspected.push(action); return action !== 'lock' })
  spy.emit({ type: 'update-tasks', requestId: 7, action: 'inspect' })
  spy.emit({ type: 'update-tasks', requestId: 8, action: 'lock' })
  await settleDispatch()
  expect(inspected).toEqual(['inspect', 'lock'])
  expect(spy.frames()).toEqual([
    { type: 'update-tasks', requestId: 7, active: true },
    { type: 'update-tasks', requestId: 8, active: false },
  ])
})

it('reports invalid frames through the diagnostic hook and keeps dispatching', async () => {
  const spy = controlSpy()
  const rejected: unknown[] = []
  installShellControl(spy, fakeApplication(), { reportInvalidFrame: (message) => { rejected.push(message) } })
  for (const frame of [{ type: 'unknown' }, [1], 'frame', null]) spy.emit(frame)
  spy.emit({ type: 'shutdown' })
  await settleDispatch()
  expect(rejected).toEqual([{ type: 'unknown' }, [1], 'frame', null])
  expect(spy.frames()).toEqual([{ type: 'shutdown-complete' }])
})

it('sends ready, platform-session, and fatal frames with the shell payloads', async () => {
  const spy = controlSpy()
  const control = installShellControl(spy, fakeApplication())
  await control.reportReady('http://127.0.0.1:19387/', ['<script>boot</script>'])
  control.publishPlatformSession({ origin: 'https://platform.example', token: 't' })
  control.publishPlatformSession(null)
  await control.reportFatal('boot failed', 'Error: boot failed\n    at main')
  expect(spy.frames()).toEqual([
    { type: 'ready', url: 'http://127.0.0.1:19387/', injections: ['<script>boot</script>'] },
    { type: 'platform-session', session: { origin: 'https://platform.example', token: 't' } },
    { type: 'platform-session', session: null },
    { type: 'fatal', message: 'boot failed', diagnostic: 'Error: boot failed\n    at main' },
  ])
})

it('drops Host frames after the transport closed', async () => {
  const spy = controlSpy()
  const control = installShellControl(spy, fakeApplication())
  control.transport.close()
  await control.reportReady('http://127.0.0.1:19387/')
  control.publishPlatformSession(null)
  await expect(control.reportFatal('late', undefined)).resolves.toBeUndefined()
  expect(spy.frames()).toEqual([])
})

it('drives the Node IPC channel through the same dispatch', async () => {
  const sends: object[] = []
  let messageListener: ((message: unknown) => void) | undefined
  let disconnectListener: (() => void) | undefined
  let disconnected = false
  const channel = {
    connected: true,
    send: (message: object, callback?: (error: Error | null) => void) => { sends.push(message); callback?.(null) },
    on: (event: 'message', listener: (message: unknown) => void) => {
      if (event === 'message') messageListener = listener
      return channel
    },
    once: (event: 'disconnect', listener: () => void) => {
      if (event === 'disconnect') disconnectListener = listener
      return channel
    },
    disconnect: () => { disconnected = true },
  }
  let shutdowns = 0
  installShellControl(ipcShellTransport(channel), fakeApplication(() => { shutdowns += 1 }))
  messageListener?.({ type: 'shutdown' })
  await settleDispatch()
  expect(shutdowns).toBe(1)
  expect(sends).toEqual([{ type: 'shutdown-complete' }])
  expect(disconnected).toBe(true)
  expect(disconnectListener).toBeDefined()
})

it('reassembles frames split across stdin chunks and skips blank lines', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const received: unknown[] = []
  const transport = stdioShellTransport({ stdin, stdout })
  transport.onMessage((message) => { received.push(message) })
  stdin.write('{"type":"shut')
  stdin.write('down"}\r\n')
  stdin.write('\n')
  stdin.write(`${JSON.stringify({ type: 'update-tasks', requestId: 3, action: 'inspect' })}\n`)
  await settleDispatch()
  expect(received).toEqual([
    { type: 'shutdown' },
    { type: 'update-tasks', requestId: 3, action: 'inspect' },
  ])
})

it('writes one LF-delimited JSON object per frame on stdout', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const transport = stdioShellTransport({ stdin, stdout })
  let stdoutText = ''
  stdout.setEncoding('utf8')
  stdout.on('data', (chunk: string) => { stdoutText += chunk })
  await transport.send({ type: 'ready', url: 'http://127.0.0.1:19387/' })
  await settleDispatch()
  expect(stdoutText).toBe('{"type":"ready","url":"http://127.0.0.1:19387/"}\n')
})

it('logs a failed stdout write and keeps resolving', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const transport = stdioShellTransport({ stdin, stdout })
  const errors: unknown[][] = []
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
  try {
    stdout.on('error', () => { /* the transport reports the failure through its own error listener */ })
    stdout.destroy(new Error('stdout broken'))
    await expect(transport.send({ type: 'ready', url: 'http://127.0.0.1:19387/' })).resolves.toBeUndefined()
    expect(errors.length).toBeGreaterThan(0)
    expect(transport.connected).toBe(true)
  } finally {
    errorSpy.mockRestore()
  }
})

it('treats stdin end and stdin error as shell loss', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const fail of [false, true]) {
      const stdin = new PassThrough()
      const transport = stdioShellTransport({ stdin, stdout: new PassThrough() })
      const { promise: gone, resolve: goneResolve }: PromiseWithResolvers<void> = Promise.withResolvers()
      transport.onShellGone(() => { goneResolve() })
      if (fail) stdin.destroy(new Error('stdin broken'))
      else stdin.end()
      await gone
      expect(transport.connected).toBe(false)
      await expect(transport.send({ type: 'shutdown-complete' })).resolves.toBeUndefined()
    }
  } finally {
    errorSpy.mockRestore()
  }
})
