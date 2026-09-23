/** Tauri custom Windows sign command: SafeNet eToken signing through signtool, skipped without `DSH_WINDOWS_SIGN`. */

import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'

/** Environment variable that turns the command from a no-op into real signing. */
const SIGN_ENABLED_ENV = 'DSH_WINDOWS_SIGN'
/** Environment variables carrying the release identity; all required while signing is enabled. */
const SIGNTOOL_ENV = 'DSH_WINDOWS_SIGNTOOL'
const CERTIFICATE_FILE_ENV = 'DSH_WINDOWS_CER_FILE'
const KEY_CONTAINER_ENV = 'DSH_WINDOWS_KEY_CONTAINER'
const TOKEN_PIN_ENV = 'DSH_WINDOWS_TOKEN_PIN'

/** Digest algorithm shared by the signature and the RFC 3161 timestamp reply. */
const SHA256_DIGEST = 'sha256'
/** RFC 3161 timestamp authority; a fixed release contract, not a deployment choice. */
const TIMESTAMP_URL = 'http://timestamp.digicert.com'
/** SafeNet middleware CSP that unlocks the hardware token's private key. */
const SAFENET_CSP = 'eToken Base Cryptographic Provider'
/** Environment names never inherited by a signtool child: credential-shaped or release-identity names. */
const CREDENTIAL_ENVIRONMENT = /(?:KEY|SECRET|TOKEN|PASSWORD)|^DSH_WINDOWS_/iu
const REDACTED = '<redacted>'

/**
 * Whether signing is enabled for this run.
 * @param {NodeJS.ProcessEnv} environment Parent environment.
 * @returns {boolean} True when `DSH_WINDOWS_SIGN` carries a non-empty value.
 */
export function isSigningEnabled(environment) {
  const value = environment[SIGN_ENABLED_ENV]?.trim()
  return value !== undefined && value !== ''
}

/**
 * Validate the release identity carried by the environment.
 * @param {NodeJS.ProcessEnv} environment Parent environment.
 * @returns {{ signTool: string, certificateFile: string, keyContainer: string, tokenPin: string }} Verified signing identity.
 */
export function resolveSigningIdentity(environment) {
  const signTool = environment[SIGNTOOL_ENV]?.trim()
  if (!signTool) throw new Error(`windows-sign: ${SIGNTOOL_ENV} must identify the signtool executable`)
  let signToolPath
  try {
    signToolPath = realpathSync(signTool)
    if (!statSync(signToolPath).isFile()) throw new Error('not a file')
  }
  catch {
    throw new Error(`windows-sign: ${SIGNTOOL_ENV} is missing or is not a file: ${signTool}`)
  }
  const certificateFile = environment[CERTIFICATE_FILE_ENV]?.trim()
  if (!certificateFile) throw new Error(`windows-sign: ${CERTIFICATE_FILE_ENV} must identify the public code-signing certificate file`)
  const keyContainer = environment[KEY_CONTAINER_ENV]?.trim()
  if (!keyContainer) throw new Error(`windows-sign: ${KEY_CONTAINER_ENV} must contain the SafeNet private-key container name`)
  if (/["\r\n]/u.test(keyContainer)) throw new Error(`windows-sign: ${KEY_CONTAINER_ENV} cannot contain quotes or line breaks`)
  const tokenPin = environment[TOKEN_PIN_ENV]
  if (tokenPin === undefined || tokenPin.length === 0) throw new Error(`windows-sign: ${TOKEN_PIN_ENV} must contain the SafeNet token password`)
  if (/[\]"`\r\n]/u.test(tokenPin)) throw new Error(`windows-sign: ${TOKEN_PIN_ENV} cannot contain "], backticks, quotes, or line breaks because the SafeNet key-container syntax uses them as delimiters`)
  return { signTool: signToolPath, certificateFile, keyContainer, tokenPin }
}

/**
 * Collect the files this run must sign. The Tauri bundler passes one `%1` path
 * per artifact — the shell binary, NSIS plugin DLLs, the installer, and the
 * uninstaller (through NSIS `!uninstfinalize`'s `%1` substitution) — so every
 * existing positional path is signed.
 * @param {readonly string[]} scriptArguments Positional script arguments (after the script path).
 * @returns {string[]} Existing file paths, in argument order.
 */
export function resolveSignTargets(scriptArguments) {
  const targets = []
  for (const candidate of scriptArguments) {
    if (candidate === '') continue
    try {
      if (statSync(candidate).isFile()) targets.push(realpathSync(candidate))
    }
    catch {
      // A missing path is not this command's target; the bundler always passes real files.
    }
  }
  if (targets.length === 0) {
    throw new Error('windows-sign: no existing file among the arguments; expected the Tauri %1 placeholder to carry the artifact path')
  }
  return targets
}

/**
 * Build one signtool invocation.
 * @param {{ signTool: string, certificateFile: string, keyContainer: string, tokenPin: string }} identity Verified signing identity.
 * @param {string} target Executable to sign.
 * @param {'sign' | 'timestamp'} operation Signing first, timestamp second.
 * @returns {{ command: string, args: string[] }} Invocation for signtool.
 */
export function signtoolInvocation(identity, target, operation) {
  if (operation === 'sign') {
    return {
      command: identity.signTool,
      args: [
        'sign', '/v',
        '/fd', SHA256_DIGEST,
        '/f', identity.certificateFile,
        '/csp', SAFENET_CSP,
        '/kc', `[{{${identity.tokenPin}}}]=${identity.keyContainer}`,
        target,
      ],
    }
  }
  return {
    command: identity.signTool,
    args: ['timestamp', '/v', '/tr', TIMESTAMP_URL, '/td', SHA256_DIGEST, target],
  }
}

/**
 * Replace secret values in captured tool output.
 * @param {string} text Captured output.
 * @param {readonly string[]} secrets Values that must never reach a log.
 * @returns {string} Output with every secret occurrence replaced.
 */
export function redactSigningOutput(text, secrets) {
  let redacted = text
  for (const secret of secrets) {
    if (secret !== '') redacted = redacted.replaceAll(secret, REDACTED)
  }
  return redacted
}

/**
 * Strip credential-shaped names so the signtool child inherits no release secrets.
 * @param {NodeJS.ProcessEnv} environment Parent environment.
 * @returns {NodeJS.ProcessEnv} Environment without credential-shaped names.
 */
export function scrubCredentialEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !CREDENTIAL_ENVIRONMENT.test(name)))
}

/**
 * Sign every target in place; signing failures exit non-zero so makensis and the bundler abort.
 * @param {readonly string[]} scriptArguments Positional script arguments.
 * @param {NodeJS.ProcessEnv} environment Parent environment.
 * @returns {number} Process exit code.
 */
export function run(scriptArguments, environment) {
  let targets
  try {
    targets = resolveSignTargets(scriptArguments)
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  if (!isSigningEnabled(environment)) {
    for (const target of targets) {
      process.stdout.write(`windows-sign: ${SIGN_ENABLED_ENV} is not set; leaving ${target} unsigned\n`)
    }
    return 0
  }

  let identity
  try {
    identity = resolveSigningIdentity(environment)
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const secrets = [identity.tokenPin]
  const childEnvironment = scrubCredentialEnvironment(environment)
  for (const target of targets) {
    for (const operation of ['sign', 'timestamp']) {
      const { command, args } = signtoolInvocation(identity, target, operation)
      const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnvironment })
      const stdout = redactSigningOutput(result.stdout?.toString('utf8') ?? '', secrets)
      const stderr = redactSigningOutput(result.stderr?.toString('utf8') ?? '', secrets)
      if (stdout.trim() !== '') process.stdout.write(`${stdout.trimEnd()}\n`)
      if (result.error !== undefined) {
        process.stderr.write(`windows-sign: running ${SIGNTOOL_ENV} failed for ${target}: ${String(result.error)}\n`)
        return 1
      }
      if (result.status !== 0) {
        if (stderr.trim() !== '') process.stderr.write(`${stderr.trimEnd()}\n`)
        process.stderr.write(`windows-sign: signtool ${operation} failed for ${target} with exit ${String(result.status ?? 'signal')}\n`)
        return result.status ?? 1
      }
    }
    process.stdout.write(`windows-sign: signed ${target}\n`)
  }
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  process.exitCode = run(process.argv.slice(2), process.env)
}
