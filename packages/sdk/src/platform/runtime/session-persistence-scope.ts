/**
 * Shared types and scope resolution for session persistence.
 *
 * "Scope" is the question every persistence call answers before it touches a
 * file: WHICH directory does this call mean? There are two answers, the
 * legacy per-call `workingDirectory` / `homeDirectory` / `surfaceRoot` triple,
 * and a declare-once `SessionSurface`, and both the durable-store half
 * (session-persistence.ts) and the crash-snapshot half (session-recovery.ts)
 * route every path through the resolvers here, so the two sibling modules can
 * never disagree about where a file lives.
 *
 * This module is NOT re-exported wholesale. session-persistence.ts re-exports
 * exactly the names that were already public before the split; everything else
 * below is internal plumbing shared between the two siblings.
 */

import { join } from 'path';

import { SessionManager, sanitizeSessionName } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import type { SessionReturnContextSummary } from './session-return-context.js';
import type { ConversationTitleSource } from '../core/conversation.js';
import { resolveScopedDirectory, resolveSharedDirectory, sanitizeSessionIdSegment } from './surface-root.js';
import type { SessionSurface } from './session-surface.js';

export type SessionSnapshot = {
  messages: Array<Record<string, unknown>>;
  timestamp?: number | undefined;
  title?: string | undefined;
  titleSource?: ConversationTitleSource | undefined;
  returnContext?: SessionReturnContextSummary | undefined;
};

/**
 * Legacy per-call scope: `workingDirectory` / `homeDirectory` / `surfaceRoot`
 * resolved independently on every call. Kept working byte-for-byte unchanged
 * (an omitted `surfaceRoot` still silently falls back to the shared, unscoped
 * `.goodvibes/` directory), this is the compat path. Every call through this
 * shape emits a one-time-per-process deprecation warning recommending a
 * `SessionSurface` instead. `surface` is declared here only so it can be typed
 * as `undefined`, making this shape and `SessionPersistenceSurfaceOptions`
 * mutually exclusive at the type level (mixing the two is a compile error).
 */
export type SessionPersistenceLegacyOptions = {
  workingDirectory?: string | undefined;
  homeDirectory?: string | undefined;
  sessionManager?: SessionManager | undefined;
  surfaceRoot?: string | undefined;
  readonly surface?: undefined;
};

/**
 * Surface-based scope: every path is read directly off a declare-once
 * `SessionSurface` (see session-surface.ts), no per-call scope argument is
 * accepted alongside it, so there is no unscoped fallback to silently resolve
 * to and no way for a writer and a reader to disagree about a path as long as
 * they share the same surface.
 */
export type SessionPersistenceSurfaceOptions = {
  readonly surface: SessionSurface;
  readonly workingDirectory?: undefined;
  readonly homeDirectory?: undefined;
  readonly sessionManager?: undefined;
  readonly surfaceRoot?: undefined;
};

export type SessionPersistenceOptions = SessionPersistenceLegacyOptions | SessionPersistenceSurfaceOptions;

export type SessionPersistencePaths = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

/** True once the legacy-options deprecation warning has fired for this process. */
let legacyOptionsWarned = false;

/**
 * Emit the legacy-options deprecation warning exactly once per process,
 * regardless of how many legacy-shaped calls occur (including internal calls
 * chaining through, e.g. persistConversation -> saveSession -> writeLastSessionPointer).
 */
export function warnLegacyOptionsOnce(): void {
  if (legacyOptionsWarned) return;
  legacyOptionsWarned = true;
  logger.warn(
    'Session persistence called with legacy workingDirectory/homeDirectory/surfaceRoot options, pass a SessionSurface instead (see platform/runtime/session-surface.ts, createSessionSurface).',
  );
}

/** True when `options` uses the surface-based call form. */
export function isSurfaceOptions(
  options: SessionPersistenceOptions | undefined,
): options is SessionPersistenceOptions & { readonly surface: SessionSurface } {
  return !!options && (options as { surface?: SessionSurface }).surface !== undefined;
}

/**
 * Read the `SessionSurface` off surface-form options, throwing synchronously
 * with a clear message if it is missing a required path. This is what makes
 * the arity-bug class (a mis-called function silently resolving an unscoped
 * path because an options argument came through undefined) impossible in the
 * surface form: there is no fallback branch here to silently resolve to.
 */
export function requireSurface(options: SessionPersistenceOptions): SessionSurface {
  const surface = (options as { surface?: SessionSurface }).surface;
  if (
    !surface
    || !surface.workingDirectory
    || !surface.sessionsDir
    || !surface.recoveryDir
    || !surface.lastSessionPointer
    // recoveryFile is a method, not a path: a hand-rolled partial object that
    // supplies every string but omits it would otherwise pass this check and
    // fail later with an opaque "surface.recoveryFile is not a function".
    || typeof surface.recoveryFile !== 'function'
  ) {
    throw new Error(
      'Session persistence surface form requires a fully-resolved SessionSurface (build one with createSessionSurface).',
    );
  }
  return surface;
}

/** Resolve the last-session pointer path for either call form. */
export function resolveLastSessionPointerPath(options?: SessionPersistenceOptions): string {
  if (isSurfaceOptions(options)) {
    return requireSurface(options).lastSessionPointer;
  }
  warnLegacyOptionsOnce();
  return getLastSessionPointerPath(requireWorkingDirectory(options), options?.surfaceRoot);
}

/** Resolve the recovery directory for either call form. */
export function resolveRecoveryDirPath(options?: SessionPersistenceOptions): string {
  if (isSurfaceOptions(options)) {
    return requireSurface(options).recoveryDir;
  }
  warnLegacyOptionsOnce();
  return getRecoveryDir(requireHomeDirectory(options), options?.surfaceRoot);
}

/** Resolve a specific session's recovery file path for either call form. */
export function resolveRecoveryFilePath(options: SessionPersistenceOptions | undefined, sessionId: string): string {
  if (isSurfaceOptions(options)) {
    return requireSurface(options).recoveryFile(sessionId);
  }
  warnLegacyOptionsOnce();
  return getRecoveryFilePath(requireHomeDirectory(options), sessionId, options?.surfaceRoot);
}

/**
 * Resolve the DURABLE session-store directory (the one holding
 * `<sessionId>.jsonl` files SessionManager writes) for either call form. This
 * is the directory the recovery layer compares a snapshot against to decide
 * whether that snapshot's own session already saved something newer, see
 * `sessionStoreMtimeMs` in session-recovery.ts.
 */
export function resolveSessionsDirPath(options?: SessionPersistenceOptions): string {
  if (isSurfaceOptions(options)) {
    return requireSurface(options).sessionsDir;
  }
  warnLegacyOptionsOnce();
  return getUserSessionsDir(requireWorkingDirectory(options), options?.surfaceRoot);
}

/**
 * The durable store file for one session inside an already-resolved sessions
 * directory. The filename stem comes from the SAME rule SessionManager.save
 * writes with (`sanitizeSessionName`), so this path is the file that session's
 * clean saves actually land in, not a lookalike derived from a second rule.
 */
export function resolveSessionStorePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sanitizeSessionName(sessionId)}.jsonl`);
}

export function requireWorkingDirectory(options?: Pick<SessionPersistenceOptions, 'workingDirectory'>): string {
  const workingDirectory = options?.workingDirectory;
  if (!workingDirectory) {
    throw new Error('Session persistence requires an explicit workingDirectory.');
  }
  return workingDirectory;
}

export function requireHomeDirectory(options?: Pick<SessionPersistenceOptions, 'homeDirectory'>): string {
  const homeDirectory = options?.homeDirectory;
  if (!homeDirectory) {
    throw new Error('Session persistence requires an explicit homeDirectory.');
  }
  return homeDirectory;
}

export function resolveSessionManager(options?: SessionPersistenceOptions): SessionManager {
  if (isSurfaceOptions(options)) {
    const surface = requireSurface(options);
    return new SessionManager(surface.workingDirectory, { surface });
  }
  warnLegacyOptionsOnce();
  if (options?.sessionManager) {
    return options.sessionManager;
  }
  return new SessionManager(requireWorkingDirectory(options), { surfaceRoot: options?.surfaceRoot });
}

export function getUserSessionsDir(workingDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
}

export function getLastSessionPointerPath(workingDirectory: string, surfaceRoot?: string): string {
  return join(getUserSessionsDir(workingDirectory, surfaceRoot), 'last-session.json');
}

/** Filename prefix for per-session crash-recovery snapshots. */
export const RECOVERY_FILE_PREFIX = 'recovery-';
export const RECOVERY_FILE_SUFFIX = '.jsonl';

/**
 * Directory holding per-session crash-recovery snapshots
 * (`<scope>/recovery/recovery-<sessionId>.jsonl`). Each concurrent session
 * owns its own file, so two sessions crashing (or snapshotting) at once never
 * clobber a single shared recovery file.
 */
export function getRecoveryDir(homeDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(homeDirectory, surfaceRoot, 'recovery');
}

/**
 * Restrict a session id to a safe single filename segment (no path traversal).
 * Delegates to the shared helper in surface-root.ts so the legacy path here
 * and `SessionSurface.recoveryFile` (session-surface.ts) always produce
 * byte-identical filenames for the same session id.
 */
function sanitizeRecoverySessionId(sessionId: string): string {
  return sanitizeSessionIdSegment(sessionId);
}

/**
 * The legacy, home-anchored, fully UNSCOPED shared recovery directory
 * (`~/.goodvibes/recovery/`, no surfaceRoot segment at all), the oldest
 * layout, predating even the surfaceRoot-scoped `getRecoveryDir` above. It
 * cannot be mapped to a project deterministically (any project that ever ran
 * with this surfaceRoot before per-project scoping could have written here),
 * so it is never migrated (see session-migration.ts's header), only
 * dual-read, one time, by the surface form of checkRecoveryFile /
 * loadRecoveryConversation / deleteRecoveryFile in session-recovery.ts.
 */
export function legacySharedRecoveryDir(surface: SessionSurface): string {
  return resolveSharedDirectory(surface.homeDirectory, 'recovery');
}

/** The legacy shared per-session recovery file path for `sessionId` (see legacySharedRecoveryDir). */
export function legacySharedRecoveryFile(surface: SessionSurface, sessionId: string): string {
  const safe = sanitizeRecoverySessionId(sessionId);
  return join(legacySharedRecoveryDir(surface), `${RECOVERY_FILE_PREFIX}${safe}${RECOVERY_FILE_SUFFIX}`);
}

/**
 * The recovery snapshot path for a specific session:
 * `<scope>/recovery/recovery-<sessionId>.jsonl`.
 */
export function getRecoveryFilePath(homeDirectory: string, sessionId: string, surfaceRoot?: string): string {
  const safe = sanitizeRecoverySessionId(sessionId);
  return join(getRecoveryDir(homeDirectory, surfaceRoot), `${RECOVERY_FILE_PREFIX}${safe}${RECOVERY_FILE_SUFFIX}`);
}
