/**
 * session-storage-services.ts, the declare-once storage handle and the
 * session store built on it.
 *
 * Every path a product uses for session state (the sessions directory, the
 * last-session pointer, crash-recovery snapshots, the checkpoint store, the
 * transcript journal, the multi-instance liveness markers) derives from ONE
 * `SessionSurface`, built here, once, at composition time.
 *
 * The reason it is one object rather than a scope argument repeated at each
 * call site: when each site derived its own scope, they drifted. A resume
 * wrote the last-session pointer with no scope at all, into the shared,
 * unscoped `.goodvibes/` directory, while `--continue` and the boot notice
 * read a scoped path under `.goodvibes/<surfaceRoot>/`. Nothing errored; the pointer
 * simply never existed where anyone looked. `createSessionSurface` also
 * throws synchronously on a bad scope instead of silently resolving to the
 * unscoped fallback on first use, so a mistake here fails at boot rather than
 * six months later as missing state.
 */
import { SessionManager } from '../sessions/index.js';
import { createSessionSurface, type SessionSurface } from './session-surface.js';

export interface SessionStorageServices {
  readonly surface: SessionSurface;
  readonly sessionManager: SessionManager;
}

export function createSessionStorageServices(input: {
  /** The owning product's storage scope, the `<surfaceRoot>` path segment. */
  readonly surfaceRoot: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}): SessionStorageServices {
  // Also performs the one-time migration of pre-surface state (pointer
  // copy-forward, journal moves) into the scoped location.
  const surface = createSessionSurface({
    surfaceRoot: input.surfaceRoot,
    workingDirectory: input.workingDirectory,
    homeDirectory: input.homeDirectory,
  });
  return { surface, sessionManager: new SessionManager(input.workingDirectory, { surface }) };
}
