/** Assemble the packaged resources and produce the Windows NSIS release. */

import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveWebBundles } from './dev-runtime.ts'
import { isSigningEnabled } from './windows-sign.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const BUILD_ROOT = join(APP_ROOT, '.tauri-build')
const PACKAGING_ROOT = join(BUILD_ROOT, 'packaging')
const RESOURCES_ROOT = join(PACKAGING_ROOT, 'resources')
const RUNTIME_ROOT = join(RESOURCES_ROOT, 'runtime')
const RUNTIME_PROJECT_ROOT = join(RESOURCES_ROOT, 'dsh')
const RUNTIME_MODULES_ROOT = join(RUNTIME_PROJECT_ROOT, 'node_modules')
const NSIS_BUNDLE_ROOT = join(APP_ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis')

const CLI_PACKAGE = '@deepseek-ai/dsh'
const HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'
const RUNTIME_PACKAGE_NAME = '@deepseek-ai/dsh-tauri-desktop-runtime'
const CLI_DIR = join(REPOSITORY_ROOT, 'apps', 'cli')
const HOST_DIR = join(REPOSITORY_ROOT, 'apps', 'desktop-host')
const PNPM_PACKAGE_DIR = join(REPOSITORY_ROOT, 'node_modules', 'pnpm')
const OFFICE_SKILLS_DIR = join(REPOSITORY_ROOT, 'packages', 'skill', 'skill-office', 'assets')
const TAURI_CONFIG_PATH = join(APP_ROOT, 'src-tauri', 'tauri.conf.json')

/** Built workspace artifacts the packaged Host entry resolution depends on. */
const REQUIRED_ARTIFACTS = [
  join(CLI_DIR, 'lib'),
  join(HOST_DIR, 'lib', 'index.js'),
  // The Host activates profile plugins from these faces; a partial build:lib
  // otherwise surfaces as dozens of plugin import failures at first launch.
  join(REPOSITORY_ROOT, 'packages', 'typert', 'registry', 'lib', 'index.js'),
  join(REPOSITORY_ROOT, 'packages', 'client', 'ui-theme', 'lib', 'index.js'),
]

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: Readonly<Record<string, unknown>>
  readonly optionalDependencies?: Readonly<Record<string, unknown>>
  readonly peerDependencies?: Readonly<Record<string, unknown>>
}

/**
 * Run one command to completion with inherited stdio.
 * @param command - Executable name or path.
 * @param args - Command arguments.
 * @param cwd - Working directory for the child.
 * @returns Resolves when the child exits 0; rejects with its otherwise exit status.
 */
function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve()
    else reject(new Error(`tauri desktop build: ${command} exited with ${String(code ?? signal)}`))
  })
  return promise
}

/**
 * Run one pnpm CLI invocation through the invoking pnpm, keeping the corepack-managed version.
 * @param args - pnpm CLI arguments after the program name (`run build`, `exec tauri build`).
 * @param cwd - Working directory for the invocation.
 * @returns Resolves when the invocation exits 0.
 */
async function runPackageManager(args: readonly string[], cwd: string): Promise<void> {
  const packageManager = process.env.npm_execpath
  if (packageManager === undefined || packageManager === '') {
    throw new Error('tauri desktop build: invoke this build through pnpm run build')
  }
  await run(process.execPath, [packageManager, ...args], cwd)
}

function readManifest(directory: string, subject: string): PackageManifest & { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageManifest
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`tauri desktop build: ${subject} has no name or version`)
  }
  return manifest as PackageManifest & { name: string; version: string }
}

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`tauri desktop build: ${subject} has no version`)
  return manifest.version
}

/**
 * Verify the shell release version is identical across the package manifests, the Cargo crate, and the Tauri config.
 * @returns The shared version string.
 */
function resolveSharedVersion(): string {
  const observed: Record<string, string | undefined> = {
    'root package.json': manifestVersion(join(REPOSITORY_ROOT, 'package.json'), 'root package.json'),
    'apps/tauri-desktop/package.json': manifestVersion(join(APP_ROOT, 'package.json'), 'apps/tauri-desktop/package.json'),
    // The crate's `[package]` version; the regex read avoids a TOML dependency.
    'src-tauri/Cargo.toml': /^version = "([^"]+)"$/mu.exec(readFileSync(join(APP_ROOT, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1],
    'src-tauri/tauri.conf.json': manifestVersion(TAURI_CONFIG_PATH, 'src-tauri/tauri.conf.json'),
  }
  const version = Object.values(observed)[0]
  if (version === undefined || Object.values(observed).some(candidate => candidate !== version)) {
    throw new Error(`tauri desktop build: release versions diverge: ${Object.entries(observed).map(([subject, candidate]) => `${subject}=${String(candidate)}`).join(', ')}; sync them before packaging`)
  }
  return version
}

/**
 * Deep-copy one directory, resolving every symlink and junction to real files.
 * Links are never re-created in the staging tree, so the installer ships no
 * reparse point that resolves on the build host only. A link whose target is an
 * ancestor of the current copy is skipped: Node resolves the skipped name
 * against the already-materialized ancestor, which is exactly the layout's
 * own resolution rule.
 * @param sourceRealDir - Real (link-resolved) directory to copy.
 * @param destinationDir - Destination directory; created when missing.
 * @param ancestorRealDirs - Real directories on the path from the copy root, cycle guards for junction loops.
 * @param excludedDirNames - Directory names never entered (dependency `node_modules` of a package copy).
 */
function copyResolvedTree(
  sourceRealDir: string,
  destinationDir: string,
  ancestorRealDirs: ReadonlySet<string>,
  excludedDirNames: ReadonlySet<string> = new Set(),
): void {
  mkdirSync(destinationDir, { recursive: true })
  for (const entry of readdirSync(sourceRealDir, { withFileTypes: true })) {
    // pnpm materializes some dependency `node_modules` directories as junctions,
    // which report as symlinks, so the exclusion must run before the link branch.
    if (excludedDirNames.has(entry.name)) continue
    const sourceEntry = join(sourceRealDir, entry.name)
    const destinationEntry = join(destinationDir, entry.name)
    const nextAncestors = new Set(ancestorRealDirs)
    nextAncestors.add(realpathSync(sourceRealDir))
    if (entry.isSymbolicLink()) {
      // A dangling link cannot be part of a working runtime layout; skip it the
      // way the development junction view leaves it unresolvable.
      const entryRealDir = (() => {
        try {
          return realpathSync(sourceEntry)
        }
        catch {
          return undefined
        }
      })()
      if (entryRealDir === undefined) continue
      if (ancestorRealDirs.has(entryRealDir)) continue
      if (statSync(entryRealDir).isDirectory()) {
        copyResolvedTree(entryRealDir, destinationEntry, nextAncestors, excludedDirNames)
      }
      else {
        copyFileSync(sourceEntry, destinationEntry)
      }
      continue
    }
    if (entry.isDirectory()) {
      copyResolvedTree(sourceEntry, destinationEntry, nextAncestors, excludedDirNames)
      continue
    }
    copyFileSync(sourceEntry, destinationEntry)
  }
}

const NODE_MODULES_DIR = 'node_modules'

/**
 * Deep-copy one runtime package: files resolve to real content, but dependency
 * `node_modules` directories are excluded because every placement below resolves
 * them against the shared runtime `node_modules` root.
 * @param sourceRealDir - Real (link-resolved) package directory.
 * @param destinationDir - Destination package directory, replaced when present.
 */
function copyPackage(sourceRealDir: string, destinationDir: string): void {
  rmSync(destinationDir, { recursive: true, force: true })
  if (existsSync(destinationDir)) throw new Error(`tauri desktop build: could not replace the previous copy at ${destinationDir}`)
  copyResolvedTree(sourceRealDir, destinationDir, new Set(), new Set([NODE_MODULES_DIR]))
}

/**
 * Place one runtime package under the shared root and resolve its declared
 * runtime dependencies from the pnpm layout that installed it. Store packages
 * resolve siblings beside themselves (`.pnpm/<pkg>@<v>/node_modules`); workspace
 * packages resolve through their own `node_modules` links. Every package is
 * materialized exactly once: repeats resolve against the shared root, which is
 * the same deduplication pnpm's hoisted layer performs.
 * @param sourceRealDir - Real (link-resolved) package directory to place.
 * @param destinationDir - Destination package directory under the runtime root.
 * @param placedRealDirs - Real directories already materialized in this assembly.
 */
function placePackage(sourceRealDir: string, destinationDir: string, placedRealDirs: Set<string>): void {
  if (placedRealDirs.has(sourceRealDir)) return
  placedRealDirs.add(sourceRealDir)
  copyPackage(sourceRealDir, destinationDir)
  const manifest = readManifest(sourceRealDir, sourceRealDir)
  // Store packages resolve dependencies among their pnpm siblings: the nearest
  // `node_modules` ancestor (scoped names nest one level deeper). Workspace
  // packages have no `node_modules` ancestor and resolve through their own links.
  let candidateSiblings = dirname(sourceRealDir)
  while (basename(candidateSiblings) !== 'node_modules' && candidateSiblings !== dirname(candidateSiblings)) {
    candidateSiblings = dirname(candidateSiblings)
  }
  const siblingsDir = basename(candidateSiblings) === 'node_modules' ? candidateSiblings : join(sourceRealDir, 'node_modules')
  const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}))
  const peerNames = new Set(Object.keys(manifest.peerDependencies ?? {}))
  // Optional edges carry the native addon platform bindings; a package present
  // in the installing layout must ship, a platform-gated absence stays legal.
  for (const [name] of [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}),
    ...Object.entries(manifest.optionalDependencies ?? {}),
  ]) {
    const candidate = join(siblingsDir, ...name.split('/'))
    if (!existsSync(candidate)) {
      // Optional and peer dependencies may legitimately be absent (platform-gated
      // packages); a missing required dependency would break the source layout itself.
      if (optionalNames.has(name) || peerNames.has(name)) continue
      throw new Error(`tauri desktop build: required dependency ${name} of ${manifest.name} is missing from ${siblingsDir}`)
    }
    placePackage(realpathSync(candidate), join(RUNTIME_MODULES_ROOT, ...name.split('/')), placedRealDirs)
  }
}

/**
 * Assemble the runtime project whose `node_modules` resolves the Host entry:
 * the built CLI (`@deepseek-ai/dsh`), the Desktop Host, and everything their
 * runtime requires, as real copies that resolve without the build host's store.
 */
function prepareRuntimeProject(): void {
  rmSync(RUNTIME_PROJECT_ROOT, { recursive: true, force: true })
  mkdirSync(RUNTIME_PROJECT_ROOT, { recursive: true, mode: 0o700 })
  const cli = readManifest(CLI_DIR, 'apps/cli')
  if (cli.name !== CLI_PACKAGE) throw new Error(`tauri desktop build: apps/cli must be ${CLI_PACKAGE}, found ${cli.name}`)
  const host = readManifest(HOST_DIR, 'apps/desktop-host')
  if (host.name !== HOST_PACKAGE) throw new Error(`tauri desktop build: apps/desktop-host must be ${HOST_PACKAGE}, found ${host.name}`)

  writeFileSync(join(RUNTIME_PROJECT_ROOT, 'package.json'), `${JSON.stringify({
    name: RUNTIME_PACKAGE_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [CLI_PACKAGE]: cli.version,
      [HOST_PACKAGE]: host.version,
    },
    dsh: { profile: { bundles: [...resolveWebBundles()] } },
  }, undefined, 2)}\n`, { mode: 0o600 })
  // Same linker contract the development runtime declares; the packaged tree
  // resolves through the placements below instead of an install.
  writeFileSync(join(RUNTIME_PROJECT_ROOT, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 })

  mkdirSync(RUNTIME_MODULES_ROOT, { recursive: true })
  const placedRealDirs = new Set<string>()
  placePackage(realpathSync(CLI_DIR), join(RUNTIME_MODULES_ROOT, ...CLI_PACKAGE.split('/')), placedRealDirs)
  placePackage(realpathSync(HOST_DIR), join(RUNTIME_MODULES_ROOT, ...HOST_PACKAGE.split('/')), placedRealDirs)
}

/**
 * Stage the packaged resources tree the Tauri bundler ships next to the shell:
 * the runtime project, the runtime Node executable and package manager, and the
 * Office skill assets the desktop Office plugin requires.
 */
function prepareResources(): void {
  rmSync(RESOURCES_ROOT, { recursive: true, force: true })
  if (existsSync(RESOURCES_ROOT)) {
    // force swallows removal errors; a leftover staging tree would mix old and
    // new copies, so never assemble over one.
    throw new Error(`tauri desktop build: could not remove the previous staging tree ${RESOURCES_ROOT}; delete it manually and retry`)
  }
  prepareRuntimeProject()

  const nodeBin = join(RUNTIME_ROOT, 'bin')
  mkdirSync(nodeBin, { recursive: true })
  const nodeExecutable = join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node')
  copyFileSync(process.execPath, nodeExecutable)
  if (process.platform !== 'win32') chmodSync(nodeExecutable, 0o755)

  copyResolvedTree(realpathSync(PNPM_PACKAGE_DIR), join(RUNTIME_ROOT, 'pnpm'), new Set())
  copyResolvedTree(realpathSync(OFFICE_SKILLS_DIR), join(RUNTIME_ROOT, 'office-skills'), new Set())
}

/**
 * Bundle the shell and report the produced NSIS artifact.
 * @returns Resolves after the installer exists; the artifact is logged with its size.
 */
async function bundleShell(): Promise<void> {
  await runPackageManager(['exec', 'tauri', 'build'], APP_ROOT)

  const artifacts = readdirSync(NSIS_BUNDLE_ROOT).filter(name => name.endsWith('-setup.exe'))
  if (artifacts.length === 0) throw new Error(`tauri desktop build: tauri build produced no NSIS installer under ${NSIS_BUNDLE_ROOT}`)
  for (const artifact of artifacts) {
    const path = join(NSIS_BUNDLE_ROOT, artifact)
    const megabytes = (statSync(path).size / (1024 * 1024)).toFixed(1)
    console.log(`tauri desktop build: installer ${path} (${megabytes} MB)`)
  }
  if (!isSigningEnabled(process.env)) {
    console.log('tauri desktop build: DSH_WINDOWS_SIGN is not set; the shell, installer, and uninstaller are UNSIGNED. Configure the release certificate environment to sign.')
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'skip-workspace-build': { type: 'boolean', default: false } } })
  const version = resolveSharedVersion()
  console.log(`tauri desktop build: packaging version ${version}`)
  if (!values['skip-workspace-build']) {
    await runPackageManager(['run', 'build'], REPOSITORY_ROOT)
  }
  for (const path of REQUIRED_ARTIFACTS) {
    if (!existsSync(path)) throw new Error(`tauri desktop build: missing built artifact ${path}; run pnpm run build`)
  }
  prepareResources()
  await bundleShell()
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
