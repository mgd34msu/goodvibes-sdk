/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { join } from 'node:path';
import { requireSurfaceRoot, resolveSurfaceDirectory, sanitizeSessionIdSegment } from './surface-root.js';
import { runSessionSurfaceMigration } from './session-migration.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * The raw identity a product declares once at startup: which surface it is
 * (`'tui'`, `'agent'`, a future third-party name...) plus the two directories
 * every storage path derives from. `createSessionSurface` turns this into a
 * fully-resolved `SessionSurface`, the declare-once handle every reader and
 * writer in that product threads through instead of re-deriving paths per call.
 */
export interface SurfaceIdentity {
  /** Single path segment identifying the product, e.g. 'tui' | 'agent'. Validated by requireSurfaceRoot: throws if omitted, empty, or not a single segment. */
  readonly surfaceRoot: string;
  /** Project root all per-project state (sessions, recovery, checkpoints) is anchored to. */
  readonly workingDirectory: string;
  /** User home directory. Carried on the surface for identity purposes; none of the paths below are derived from it. */
  readonly homeDirectory: string;
}

/**
 * A product's declare-once storage handle. Every path a session-persistence
 * or session-manager call needs is pre-resolved here, at construction, from a
 * single `SurfaceIdentity`, so a writer and a reader that both hold the same
 * `SessionSurface` can never disagree about where a file lives. This replaces
 * the old pattern of passing `surfaceRoot` / `workingDirectory` / `homeDirectory`
 * independently to each call, where an omitted `surfaceRoot` silently fell back
 * to the shared, unscoped `.goodvibes/` directory instead of erroring.
 */
export interface SessionSurface {
  readonly surfaceRoot: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** `<workingDirectory>/.goodvibes/<surfaceRoot>/sessions` */
  readonly sessionsDir: string;
  /** `<workingDirectory>/.goodvibes/<surfaceRoot>/sessions/agents` */
  readonly agentJournalsDir: string;
  /** `sessionsDir/last-session.json` */
  readonly lastSessionPointer: string;
  /**
   * `<workingDirectory>/.goodvibes/<surfaceRoot>/recovery`, anchored to
   * `workingDirectory`, NOT `homeDirectory`. A crash-recovery snapshot lives
   * with the project it happened in, so a crash in one project never nags
   * the boot of an unrelated project, the defect the legacy, home-anchored
   * `getRecoveryDir` (session-persistence-scope.ts) has, and keeps having for
   * callers that stay on the legacy option form.
   */
  readonly recoveryDir: string;
  /** `<workingDirectory>/.goodvibes/<surfaceRoot>/state` */
  readonly stateDir: string;
  /** `<workingDirectory>/.goodvibes/<surfaceRoot>/checkpoints` */
  readonly checkpointsDir: string;
  /** `recoveryDir/recovery-<sanitized sessionId>.jsonl`, the per-session crash-recovery snapshot path. */
  recoveryFile(sessionId: string): string;
}

function requireNonEmptyDirectory(value: string, source: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${source} must be a non-empty directory path.`);
  }
  return normalized;
}

/**
 * Build a `SessionSurface` from a `SurfaceIdentity`. Throws synchronously,
 * at construction, not on first use, when `surfaceRoot` is omitted, empty, or
 * not a single path segment (delegated to `requireSurfaceRoot`), or when
 * `workingDirectory` / `homeDirectory` is empty. A product calls this exactly
 * once at startup and threads the resulting handle through every reader and
 * writer, so there is no later call site where the scope can be re-guessed,
 * mismatched, or silently resolved to an unscoped path.
 */
export function createSessionSurface(identity: SurfaceIdentity): SessionSurface {
  const surfaceRoot = requireSurfaceRoot(identity.surfaceRoot, 'SurfaceIdentity.surfaceRoot');
  const workingDirectory = requireNonEmptyDirectory(identity.workingDirectory, 'SurfaceIdentity.workingDirectory');
  const homeDirectory = requireNonEmptyDirectory(identity.homeDirectory, 'SurfaceIdentity.homeDirectory');

  const sessionsDir = resolveSurfaceDirectory(workingDirectory, surfaceRoot, 'sessions');
  const recoveryDir = resolveSurfaceDirectory(workingDirectory, surfaceRoot, 'recovery');

  const surface: SessionSurface = {
    surfaceRoot,
    workingDirectory,
    homeDirectory,
    sessionsDir,
    agentJournalsDir: join(sessionsDir, 'agents'),
    lastSessionPointer: join(sessionsDir, 'last-session.json'),
    recoveryDir,
    stateDir: resolveSurfaceDirectory(workingDirectory, surfaceRoot, 'state'),
    checkpointsDir: resolveSurfaceDirectory(workingDirectory, surfaceRoot, 'checkpoints'),
    recoveryFile(sessionId: string): string {
      return join(recoveryDir, `recovery-${sanitizeSessionIdSegment(sessionId)}.jsonl`);
    },
  };

  // One-time, idempotent, marker-guarded migration from the pre-surface
  // on-disk layout (see session-migration.ts). Never throws: a migration
  // problem must never break surface construction or startup.
  try {
    runSessionSurfaceMigration(surface);
  } catch (error) {
    logger.warn('createSessionSurface: migration pass failed', { error: summarizeError(error) });
  }

  return surface;
}
