import { writeLastSessionPointer } from './session-persistence.js';
import type { SessionSurface } from './session-surface.js';

/**
 * Binds the two-argument `writeLastSessionPointer(sessionId, options?)` to one
 * `SessionSurface`, returning a plain `(sessionId: string) => void`.
 *
 * Never pass the raw function reference into a `(sessionId: string) => void`
 * slot. A function with an extra optional parameter is structurally assignable
 * there, so it type-checks, but a caller in that slot invokes it with exactly
 * one argument: `options` arrives as `undefined`, the unscoped compat path's
 * `requireWorkingDirectory(undefined)` throws, and `writeLastSessionPointer`'s
 * own try/catch swallows that into a logged warning. The pointer file then
 * silently never gets written after a resume, and the next launch's
 * `--continue` / boot notice sees nothing. Bind through here instead, and the
 * surface travels with the call.
 */
export function bindWriteLastSessionPointerToSurface(surface: SessionSurface): (sessionId: string) => void {
  return (sessionId: string): void => writeLastSessionPointer(sessionId, { surface });
}
