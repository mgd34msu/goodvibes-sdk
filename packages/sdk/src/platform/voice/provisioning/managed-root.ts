/**
 * managed-root.ts — where the managed voice tree lives, resolvable without a
 * runtime.
 *
 * WHY THIS IS NOT JUST `join(home, '.goodvibes', 'voice')` AT EACH CALL SITE
 *
 * A running surface asks its path service
 * (`ShellPathService.resolveUserPath('voice')`). An INSTALLER cannot: it runs
 * before there is any runtime to ask, and it is the thing that decides where the
 * downloaded model lands. Two hand-written derivations that drift by one path
 * segment produce the worst possible outcome — an install that reports success
 * and a daemon that reports not-provisioned, with the bytes sitting in a
 * directory nothing reads. So the derivation is one function, and a test asserts
 * it equals what the path service returns.
 *
 * NOT SURFACE-SCOPED, DELIBERATELY. Surface-scoped storage exists so two
 * products do not fight over each other's state; a checksum-pinned engine binary
 * and a wake-word classifier are neither product's state, they are megabytes of
 * identical bytes every surface on the machine loads. One copy, at the user root.
 */
import { isAbsolute, join, resolve } from 'node:path';

/** The `voice` segment under the user's goodvibes root. */
export const MANAGED_VOICE_DIRECTORY_NAME = 'voice';

/**
 * The managed voice root for a home directory: engines, models and the `wake`
 * subtree the wake-word artifacts live in.
 *
 * Throws on a relative or empty home directory rather than quietly resolving
 * against the process's working directory, which for an installer would scatter
 * a 200 MB tree wherever it happened to be run from.
 */
export function resolveManagedVoiceRoot(homeDirectory: string): string {
  const trimmed = homeDirectory.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new Error(`the managed voice root needs an absolute home directory (got "${homeDirectory}")`);
  }
  return join(resolve(trimmed), '.goodvibes', MANAGED_VOICE_DIRECTORY_NAME);
}
