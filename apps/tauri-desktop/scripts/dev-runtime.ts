/** Prepare the disposable runtime view the unpackaged Tauri shell launches. */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

/**
 * Resolve the profile bundles the desktop runtime initializes. Indexing the
 * template record is unguarded by design; a missing web template is a boot
 * package the shell cannot initialize and fails the run.
 * @returns The web profile's bundle names in declaration order.
 */
export function resolveWebBundles(): readonly string[] {
  if (PROFILE_TEMPLATES.web === undefined) {
    throw new Error('tauri desktop runtime: @deepseek-ai/dsh-app-boot ships no "web" profile template')
  }
  return PROFILE_TEMPLATES.web.bundles
}

const DSH_PACKAGE = '@deepseek-ai/dsh'
const DESKTOP_HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'
const RUNTIME_PACKAGE_NAME = '@deepseek-ai/dsh-tauri-desktop-runtime'

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: Readonly<Record<string, unknown>>
}

/** Locations handed to the shell and its Host child for one development run. */
export interface DevelopmentResources {
  /** Resources root exported to the shell through `DSH_TAURI_RESOURCES`. */
  readonly resources: string
  /** Development Harness home, also exported as `DSH_HOME`. */
  readonly home: string
}

/** Inputs whose locations differ between the launcher and isolated tests. */
export interface DevelopmentResourcesOptions {
  readonly repositoryRoot: string
  readonly resources: string
  readonly cliDir: string
  readonly hostDir: string
}

/**
 * Replace the disposable resources with links to the current built workspace:
 * the runtime project the Host entry resolves from, the Node executable the
 * shell spawns, the pnpm entry, the Office skill assets, and an initialized
 * development Harness home. Existing links are rebuilt; the profile is never
 * overwritten, so re-running is cheap.
 */
export function prepareDevelopmentResources(options: DevelopmentResourcesOptions): DevelopmentResources {
  const runtimeRoot = join(options.resources, 'runtime')
  prepareRuntimeProject({
    projectDir: join(options.resources, 'dsh'),
    cliDir: options.cliDir,
    hostDir: options.hostDir,
    dependencyDir: join(options.repositoryRoot, 'node_modules', '.pnpm', 'node_modules'),
  })
  prepareNode(runtimeRoot)
  linkDirectory(join(options.repositoryRoot, 'node_modules', 'pnpm'), join(runtimeRoot, 'pnpm'))
  // The desktop Office plugin rejects activation without these skill assets;
  // the full Python payload only matters when its tool runs.
  // The Host resolves the office assets beside the primary runtime, not inside it.
  linkDirectory(
    join(options.repositoryRoot, 'packages', 'skill', 'skill-office', 'assets'),
    join(runtimeRoot, 'office-skills'),
  )
  const home = join(options.resources, 'home')
  initProfile(join(home, 'profiles', 'desktop'), resolveWebBundles())
  return { resources: options.resources, home }
}

function readManifest(directory: string, subject: string): PackageManifest & { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageManifest
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`tauri desktop development: ${subject} has no name or version`)
  }
  return manifest as PackageManifest & { name: string; version: string }
}

/** Assemble the runtime project whose `node_modules` resolves the Host entry. */
function prepareRuntimeProject(options: {
  readonly projectDir: string
  readonly cliDir: string
  readonly hostDir: string
  readonly dependencyDir: string
}): void {
  const cli = readManifest(options.cliDir, 'apps/cli')
  if (cli.name !== DSH_PACKAGE) {
    throw new Error(`tauri desktop development: apps/cli must be ${DSH_PACKAGE}, found ${cli.name}`)
  }
  const host = readManifest(options.hostDir, 'apps/desktop-host')
  if (host.name !== '@deepseek-ai/dsh-desktop-host') {
    throw new Error(`tauri desktop development: apps/desktop-host must be @deepseek-ai/dsh-desktop-host, found ${host.name}`)
  }
  if (!existsSync(join(options.hostDir, 'lib', 'index.js'))) {
    throw new Error('tauri desktop development: apps/desktop-host/lib/index.js is missing; run pnpm run build')
  }

  rmSync(options.projectDir, { recursive: true, force: true })
  mkdirSync(options.projectDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(options.projectDir, 'package.json'), `${JSON.stringify({
    name: RUNTIME_PACKAGE_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: cli.version,
      [DESKTOP_HOST_PACKAGE]: host.version,
    },
    dsh: { profile: { bundles: [...resolveWebBundles()] } },
  }, undefined, 2)}\n`, { mode: 0o600 })
  writeFileSync(
    join(options.projectDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    { mode: 0o600 },
  )

  const destinationModules = join(options.projectDir, 'node_modules')
  mkdirSync(destinationModules, { recursive: true })
  // The hoisted store mirror is a pnpm-layout courtesy; every workspace package
  // also resolves through its own node_modules links, so a missing store is fine.
  if (existsSync(options.dependencyDir)) {
    mirrorDependencyLinks(options.dependencyDir, destinationModules)
  }
  mirrorWorkspaceDependencies([options.cliDir, options.hostDir], destinationModules)
  linkDirectory(options.cliDir, join(destinationModules, ...DSH_PACKAGE.split('/')))
  linkDirectory(options.hostDir, join(destinationModules, ...DESKTOP_HOST_PACKAGE.split('/')))
}

/** The shell resolves node from `runtime/bin` in both modes; development copies the launcher's own Node. */
function prepareNode(runtimeRoot: string): void {
  const bin = join(runtimeRoot, 'bin')
  mkdirSync(bin, { recursive: true })
  const destination = join(bin, process.platform === 'win32' ? 'node.exe' : 'node')
  const source = process.execPath
  // Re-copy the running interpreter only when it changed; reading a running
  // image is allowed, so no lock handling is needed.
  if (existsSync(destination)) {
    const sourceStats = statSync(source)
    const destinationStats = statSync(destination)
    if (sourceStats.size === destinationStats.size && sourceStats.mtimeMs === destinationStats.mtimeMs) return
  }
  copyFileSync(source, destination)
  if (process.platform !== 'win32') chmodSync(destination, 0o755)
}

/** Replace one owned path with a junction into the current workspace; `force` also clears dangling links. */
function linkDirectory(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Mirror the hoisted pnpm store so external requires resolve without store paths. */
function mirrorDependencyLinks(sourceRoot: string, destinationRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true })
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        linkDirectory(join(source, scoped.name), join(destinationRoot, entry.name, scoped.name))
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      linkDirectory(source, join(destinationRoot, entry.name))
    }
  }
}

/** Link every `workspace:` dependency of the roots, recursively, so runtime requires resolve. */
function mirrorWorkspaceDependencies(roots: readonly string[], destinationRoot: string): void {
  const visited = new Set<string>()
  const visit = (directory: string): void => {
    const source = realpathSync(directory)
    if (visited.has(source)) return
    visited.add(source)
    const manifest = readManifest(source, source)
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      if (typeof specifier !== 'string' || !specifier.startsWith('workspace:')) continue
      const dependency = join(source, 'node_modules', ...name.split('/'))
      if (!existsSync(dependency)) {
        throw new Error(`tauri desktop development: ${name} is missing from ${source}; run pnpm install`)
      }
      linkDirectory(dependency, join(destinationRoot, ...name.split('/')))
      visit(dependency)
    }
  }
  for (const directory of roots) visit(directory)
}
