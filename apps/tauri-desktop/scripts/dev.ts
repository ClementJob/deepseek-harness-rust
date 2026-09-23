/** Build and launch the unpackaged Tauri shell against the current workspace. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { prepareDevelopmentResources } from './dev-runtime.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const BUILD_ROOT = join(APP_ROOT, '.tauri-build')
const RESOURCES_ROOT = join(BUILD_ROOT, 'development')

/** Commands whose absence fails the run before the shell launches. */
const REQUIRED_ARTIFACTS = [
  join(REPOSITORY_ROOT, 'apps', 'cli', 'lib'),
  join(REPOSITORY_ROOT, 'apps', 'desktop-host', 'lib', 'index.js'),
]

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...environment },
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`tauri desktop development: ${command} exited with ${String(code ?? signal)}`))
    })
  })
}

async function runPackageScript(script: string, cwd: string): Promise<void> {
  const packageManager = process.env.npm_execpath
  if (packageManager === undefined || packageManager === '') {
    throw new Error('tauri desktop development: invoke this launcher through pnpm run dev or start')
  }
  await run(process.execPath, [packageManager, 'run', script], cwd)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false } } })
  if (!values['skip-build']) {
    await runPackageScript('build', REPOSITORY_ROOT)
  }
  for (const path of REQUIRED_ARTIFACTS) {
    if (!existsSync(path)) throw new Error(`tauri desktop development: missing built artifact ${path}`)
  }
  const resources = prepareDevelopmentResources({
    repositoryRoot: REPOSITORY_ROOT,
    resources: RESOURCES_ROOT,
    cliDir: join(REPOSITORY_ROOT, 'apps', 'cli'),
    hostDir: join(REPOSITORY_ROOT, 'apps', 'desktop-host'),
  })
  console.log(`tauri desktop development: DSH_HOME=${resources.home}`)

  // A debug-build shell reads the prepared resources through DSH_TAURI_RESOURCES
  // and isolates product data under the development home; production resolves
  // resources next to the executable and honors the user's real DSH_HOME.
  await run('cargo', ['build', '--manifest-path', join(APP_ROOT, 'src-tauri', 'Cargo.toml')], APP_ROOT)
  const executable = join(
    APP_ROOT,
    'src-tauri',
    'target',
    'debug',
    process.platform === 'win32' ? 'dsh-tauri-desktop.exe' : 'dsh-tauri-desktop',
  )
  await run(executable, [], APP_ROOT, {
    DSH_TAURI_RESOURCES: resources.resources,
    DSH_HOME: resources.home,
  })
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
