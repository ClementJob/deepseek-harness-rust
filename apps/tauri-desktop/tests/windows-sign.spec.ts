/** The Tauri custom sign command: argv contract against a fixture signtool, unsigned skip, and failure propagation. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { redactSigningOutput, signtoolInvocation } from '../scripts/windows-sign.mjs'

const SCRIPT_PATH = resolve(import.meta.dirname, '..', 'scripts', 'windows-sign.mjs')
const FIXTURE_ROOT = resolve(import.meta.dirname, 'fixtures', 'fake-signtool')
const FIXTURE_BINARY = join(FIXTURE_ROOT, 'target', 'debug', process.platform === 'win32' ? 'fake-signtool.exe' : 'fake-signtool')
const ARGUMENT_SEPARATOR = '\u{1f}'

/** Environment handed to the sign script; release identity arrives through the documented variables. */
function signEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_WINDOWS_SIGN: '',
    DSH_WINDOWS_SIGNTOOL: '',
    DSH_WINDOWS_CER_FILE: '',
    DSH_WINDOWS_KEY_CONTAINER: '',
    DSH_WINDOWS_TOKEN_PIN: '',
    ...overrides,
  }
}

/** One scratch tree holding the argv log and a stand-in executable to sign. */
function scratchTree(): { root: string; target: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-windows-sign-'))
  const target = join(root, 'artifact.exe')
  writeFileSync(target, 'placeholder bytes')
  return { root, target, log: join(root, 'signtool-argv.log') }
}

/** Recorded argv lines of the fixture signtool. */
function recordedInvocations(log: string): string[][] {
  return readFileSync(log, 'utf8').trimEnd().split('\n').map(line => line.split(ARGUMENT_SEPARATOR))
}

beforeAll(() => {
  const result = spawnSync('cargo', ['build', '--quiet'], { cwd: FIXTURE_ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`building the fake-signtool fixture failed: ${result.stderr}`)
  expect(statSync(FIXTURE_BINARY).isFile()).toBe(true)
})

it('builds the SafeNet sign invocation followed by the RFC 3161 timestamp', () => {
  const identity = { signTool: 'signtool.exe', certificateFile: 'release.cer', keyContainer: 'dsh-release', tokenPin: 'pin-value' }
  expect(signtoolInvocation(identity, 'C:/dist/app.exe', 'sign')).toEqual({
    command: 'signtool.exe',
    args: ['sign', '/v', '/fd', 'sha256', '/f', 'release.cer', '/csp', 'eToken Base Cryptographic Provider', '/kc', '[{{pin-value}}]=dsh-release', 'C:/dist/app.exe'],
  })
  expect(signtoolInvocation(identity, 'C:/dist/app.exe', 'timestamp')).toEqual({
    command: 'signtool.exe',
    args: ['timestamp', '/v', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', 'C:/dist/app.exe'],
  })
})

it('redacts secret values from tool output', () => {
  expect(redactSigningOutput('SignTool Sign: pin-value in [{{pin-value}}]=dsh', ['pin-value'])).not.toContain('pin-value')
})

it('leaves artifacts unsigned with a clear log when DSH_WINDOWS_SIGN is not set', () => {
  const scratch = scratchTree()
  const result = spawnSync(process.execPath, [SCRIPT_PATH, scratch.target], {
    encoding: 'utf8',
    env: signEnvironment({ DSH_WINDOWS_SIGNTOOL: FIXTURE_BINARY, FAKE_SIGNTOOL_LOG: scratch.log }),
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('DSH_WINDOWS_SIGN is not set')
  expect(result.stdout).toContain(scratch.target)
  expect(() => statSync(scratch.log)).toThrow()
  rmSync(scratch.root, { recursive: true, force: true })
})

it('signs and timestamps the requested artifact through the configured signtool without leaking the token pin', () => {
  const scratch = scratchTree()
  const result = spawnSync(process.execPath, [SCRIPT_PATH, scratch.target], {
    encoding: 'utf8',
    env: signEnvironment({
      DSH_WINDOWS_SIGN: '1',
      DSH_WINDOWS_SIGNTOOL: FIXTURE_BINARY,
      DSH_WINDOWS_CER_FILE: 'release.cer',
      DSH_WINDOWS_KEY_CONTAINER: 'dsh-release',
      DSH_WINDOWS_TOKEN_PIN: 'token-pin-secret',
      FAKE_SIGNTOOL_LOG: scratch.log,
    }),
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain(`windows-sign: signed ${realpathSync(scratch.target)}`)
  expect(result.stdout + result.stderr).not.toContain('token-pin-secret')
  const invocations = recordedInvocations(scratch.log)
  const target = realpathSync(scratch.target)
  expect(invocations[0]).toEqual([
    'sign', '/v', '/fd', 'sha256', '/f', 'release.cer', '/csp', 'eToken Base Cryptographic Provider', '/kc', '[{{token-pin-secret}}]=dsh-release', target,
  ])
  expect(invocations[1]).toEqual(['timestamp', '/v', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', target])
  rmSync(scratch.root, { recursive: true, force: true })
})

it('propagates a signtool failure as a non-zero exit', () => {
  const scratch = scratchTree()
  const result = spawnSync(process.execPath, [SCRIPT_PATH, scratch.target], {
    encoding: 'utf8',
    env: signEnvironment({
      DSH_WINDOWS_SIGN: '1',
      DSH_WINDOWS_SIGNTOOL: FIXTURE_BINARY,
      DSH_WINDOWS_CER_FILE: 'release.cer',
      DSH_WINDOWS_KEY_CONTAINER: 'dsh-release',
      DSH_WINDOWS_TOKEN_PIN: 'token-pin-secret',
      FAKE_SIGNTOOL_LOG: scratch.log,
      FAKE_SIGNTOOL_EXIT: '3',
    }),
  })
  expect(result.status).toBe(3)
  expect(result.stderr).toContain('signtool sign failed')
  rmSync(scratch.root, { recursive: true, force: true })
})
