/** The NSIS installer hooks compile with the real makensis toolset and define the PREINSTALL migration hook. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const HOOKS_PATH = resolve(import.meta.dirname, '..', 'src-tauri', 'installer', 'hooks.nsh')
const MAKENSIS_CANDIDATES = process.platform === 'win32'
  ? [join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS', 'makensis.exe')]
  : ['makensis']

/** First runnable makensis, preferring the toolset the Tauri bundler downloads. */
function findMakensis(): string | undefined {
  for (const candidate of MAKENSIS_CANDIDATES) {
    const result = spawnSync(candidate, ['-VERSION'], { encoding: 'utf8' })
    if (result.error === undefined && result.status === 0) return candidate
  }
  return undefined
}

const makensis = findMakensis()
const compileTest = makensis === undefined ? it.skip : it

if (makensis === undefined) {
  console.warn('installer-hooks: makensis is unavailable; skipping. Run pnpm run build:desktop once so the Tauri bundler downloads the NSIS toolset.')
}

/** The NSIS harness: registers the hooks the bundler wires and fails compilation when PREINSTALL is missing. */
function harnessSource(hooksPath: string, outFile: string): string {
  return [
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    `!include "${hooksPath}"`,
    '!ifmacrodef NSIS_HOOK_PREINSTALL',
    '!else',
    '  !error "NSIS_HOOK_PREINSTALL must be defined by the installer hooks"',
    '!endif',
    `OutFile "${outFile}"`,
    'Section "-install"',
    '  !insertmacro NSIS_HOOK_PREINSTALL',
    'SectionEnd',
    '',
  ].join('\n')
}

compileTest('compiles the installer hooks, including the PREINSTALL migration hook, with makensis', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-installer-hooks-'))
  try {
    const outFile = join(scratch, 'harness-installer.exe')
    const harnessPath = join(scratch, 'harness.nsi')
    writeFileSync(harnessPath, harnessSource(HOOKS_PATH, outFile))
    // Unreachable: compileTest skips without makensis; the guard narrows for spawnSync.
    if (makensis === undefined) return
    const result = spawnSync(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', harnessPath], { encoding: 'utf8', timeout: 120_000 })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    // The old Electron installation directory convention the migration hook targets;
    // the legacy name is fixed by the Electron release history, not PRODUCTNAME.
    const hooks = readFileSync(HOOKS_PATH, 'utf8')
    expect(hooks).toContain('!define DshLegacyProductName "DeepSeek Harness"')
    expect(hooks).toContain('"$LOCALAPPDATA\\Programs\\${DshLegacyProductName}"')
  }
  finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
