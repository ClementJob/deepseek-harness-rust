/** Type contract for the Tauri custom sign command script (`windows-sign.mjs`). */

/** Verified release identity carried by the `DSH_WINDOWS_*` environment. */
export interface SigningIdentity {
  signTool: string
  certificateFile: string
  keyContainer: string
  tokenPin: string
}

/**
 * Whether signing is enabled for this run.
 * @param environment - Parent environment.
 * @returns True when `DSH_WINDOWS_SIGN` carries a non-empty value.
 */
export declare function isSigningEnabled(environment: NodeJS.ProcessEnv): boolean

/**
 * Validate the release identity carried by the environment.
 * @param environment - Parent environment.
 * @returns Verified signing identity.
 */
export declare function resolveSigningIdentity(environment: NodeJS.ProcessEnv): SigningIdentity

/**
 * Collect the existing positional `.exe` paths this run must sign.
 * @param scriptArguments - Positional script arguments (after the script path).
 * @returns Existing file paths, in argument order.
 */
export declare function resolveSignTargets(scriptArguments: readonly string[]): string[]

/**
 * Build one signtool invocation.
 * @param identity - Verified signing identity.
 * @param target - Executable to sign.
 * @param operation - Signing first, timestamp second.
 * @returns Invocation for signtool.
 */
export declare function signtoolInvocation(identity: SigningIdentity, target: string, operation: 'sign' | 'timestamp'): { command: string; args: string[] }

/**
 * Replace secret values in captured tool output.
 * @param text - Captured output.
 * @param secrets - Values that must never reach a log.
 * @returns Output with every secret occurrence replaced.
 */
export declare function redactSigningOutput(text: string, secrets: readonly string[]): string

/**
 * Strip credential-shaped names so the signtool child inherits no release secrets.
 * @param environment - Parent environment.
 * @returns Environment without credential-shaped names.
 */
export declare function scrubCredentialEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv

/**
 * Sign every target in place; signing failures exit non-zero so makensis and the bundler abort.
 * @param scriptArguments - Positional script arguments.
 * @param environment - Parent environment.
 * @returns Process exit code.
 */
export declare function run(scriptArguments: readonly string[], environment: NodeJS.ProcessEnv): number
