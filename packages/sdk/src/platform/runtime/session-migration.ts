/**
 * session-migration.ts — one-time migration from the pre-SessionSurface,
 * pre-agents-subdirectory on-disk layout into the surface-scoped layout,
 * invoked once per surface from createSessionSurface (session-surface.ts).
 *
 * Idempotent: guarded by a marker file at
 * `<workingDirectory>/.goodvibes/<surfaceRoot>/.migrated-v1`. A surface whose
 * marker already exists returns immediately — the migration steps below never
 * run twice. Every step is copy-forward or move, never delete-only: a step
 * that cannot complete safely leaves the legacy data exactly where it was,
 * and a failure in one step never aborts the others (each is independently
 * try/caught) or this module's caller (createSessionSurface never throws
 * because a migration step failed).
 *
 * Steps:
 *  1. Last-session pointer: the canonical path
 *     (`surface.lastSessionPointer`) IS the same path the legacy `surfaceRoot`-
 *     scoped call form already wrote to — no migration needed between those
 *     two. The real gap is the legacy fully-UNSCOPED pointer
 *     (`<workingDirectory>/.goodvibes/sessions/last-session.json`, written by
 *     a caller that never passed a surfaceRoot at all). When only the
 *     unscoped file exists, it is copied forward. When both exist, the newer
 *     one (by mtime) wins and is copied into the canonical path. The legacy
 *     file is always left in place (one-release grace).
 *  2. Agent journals: `*_workmap.jsonl` and agent-id-shaped `*.jsonl` sitting
 *     flat in sessions/ whose FIRST LINE is genuinely that journal's opening
 *     record (see legacy-agent-journal-patterns.ts for the exact, shared
 *     name-plus-content classification) are MOVED (not copied) into
 *     sessions/agents/ — these are relocated files, not a legacy/canonical
 *     pair to reconcile by recency. A user conversation whose saved name
 *     merely collides with a journal filename shape is never moved: moving it
 *     would make it vanish from the user's session list. A name that already
 *     exists at the destination is left alone rather than overwritten.
 *  3. Checkpoints: if the surface-scoped checkpoints directory does not exist
 *     yet but a legacy `<workingDirectory>/.goodvibes/checkpoints` does, the
 *     whole directory (side GIT_DIR + manifest) is renamed into place in one
 *     atomic filesystem operation. `rename()` on a single directory entry is
 *     atomic on the same filesystem, so this can never half-move: it either
 *     fully succeeds or throws with the legacy directory completely
 *     untouched (caught and logged, never re-attempted destructively).
 *     Because that legacy store is SHARED — two products working in the same
 *     directory both see it, and whichever constructs its surface first
 *     adopts the history — the move leaves a `checkpoints-moved.json` marker
 *     at the old location naming where the store went, and logs the adoption.
 *     The second product's user finds a trace instead of a silent coin flip.
 *     When the scoped store already exists, the legacy directory is stranded
 *     (nothing reclaims it): that is disclosed by name in one log line and
 *     never auto-deleted — it is a git store that may hold real history.
 *
 * The marker is written only when every step either succeeded or found
 * nothing to do. A step that failed transiently (an unreadable directory, a
 * cross-device rename) leaves the marker absent so the next boot retries the
 * whole (idempotent) pass rather than declaring a partial migration finished.
 *
 * NOT handled here (by design):
 *  - Shared crash-recovery snapshots (`~/.goodvibes/recovery/*.jsonl`, home-
 *    anchored and unscoped) cannot be mapped to a project deterministically —
 *    there is nothing to move. Instead session-recovery.ts's
 *    checkRecoveryFile/loadRecoveryConversation/deleteRecoveryFile dual-read
 *    that legacy shared directory directly, session-id-keyed, as a
 *    standing one-time-offer (see that module's header for the cross-project
 *    caveat this accepts).
 *  - KVState (tools/index.ts's session_*.json store) dual-reads the legacy
 *    unscoped state dir directly (see state/kv-state.ts's `legacyStateDir`)
 *    and copies forward lazily, per session, on first read — no bulk move is
 *    performed here.
 *  - The dead `.goodvibes/state/events.jsonl` + `event-archives/` store is
 *    reclaimed by the append-only retention sweep (legacy-event-store), not
 *    by migration — it has no live reader to migrate FOR.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveSharedDirectory } from './surface-root.js';
import { isLegacyAgentJournalFile } from './retention/legacy-agent-journal-patterns.js';
import type { SessionSurface } from './session-surface.js';

/**
 * The outcome of one migration step. `failed` is the only value that holds
 * back the migration marker — `nothing` (no legacy data to migrate) is a
 * completed step, not a deferred one.
 */
type StepOutcome = 'done' | 'nothing' | 'failed';

function markerPath(surface: SessionSurface): string {
  return join(surface.workingDirectory, '.goodvibes', surface.surfaceRoot, '.migrated-v1');
}

/** Copy `from` forward to `to`, creating `to`'s parent directory if needed. Throws on failure — callers wrap this. */
function copyForward(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function migrateLastSessionPointer(surface: SessionSurface): StepOutcome {
  const canonicalPath = surface.lastSessionPointer;
  const legacyUnscopedPath = join(resolveSharedDirectory(surface.workingDirectory, 'sessions'), 'last-session.json');
  if (!existsSync(legacyUnscopedPath)) return 'nothing';

  if (!existsSync(canonicalPath)) {
    copyForward(legacyUnscopedPath, canonicalPath);
    return 'done';
  }
  // Both exist: newest mtime wins, copied into the canonical path. The
  // legacy unscoped file is left in place either way.
  const canonicalMtime = statSync(canonicalPath).mtimeMs;
  const legacyMtime = statSync(legacyUnscopedPath).mtimeMs;
  if (legacyMtime > canonicalMtime) {
    copyForward(legacyUnscopedPath, canonicalPath);
    return 'done';
  }
  return 'nothing';
}

function migrateAgentJournals(surface: SessionSurface): StepOutcome {
  const sessionsDir = surface.sessionsDir;
  if (!existsSync(sessionsDir)) return 'nothing';
  let names: string[];
  try {
    names = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    logger.warn('session-migration: could not list sessions dir for agent-journal move', { error: summarizeError(error) });
    return 'failed';
  }
  // Name AND first-line content: a saved user conversation whose name happens
  // to collide with a journal filename shape stays exactly where the user's
  // session list expects to find it (see legacy-agent-journal-patterns.ts).
  const toMove = names.filter((name) => isLegacyAgentJournalFile(join(sessionsDir, name), name));
  if (toMove.length === 0) return 'nothing';
  mkdirSync(surface.agentJournalsDir, { recursive: true });
  let moved = 0;
  let failures = 0;
  for (const name of toMove) {
    const from = join(sessionsDir, name);
    const to = join(surface.agentJournalsDir, name);
    try {
      // Never clobber an existing agents/ file with the same name — leave
      // the legacy copy in place rather than guess which one is authoritative.
      if (existsSync(to)) continue;
      renameSync(from, to);
      moved++;
    } catch (error) {
      failures++;
      logger.warn('session-migration: agent journal move failed, left in place', {
        file: name,
        error: summarizeError(error),
      });
    }
  }
  if (failures > 0) return 'failed';
  return moved > 0 ? 'done' : 'nothing';
}

/** `<workingDirectory>/.goodvibes/checkpoints-moved.json` — the trace left at the old shared location. */
function checkpointsMovedMarkerPath(surface: SessionSurface): string {
  return join(surface.workingDirectory, '.goodvibes', 'checkpoints-moved.json');
}

function migrateCheckpointsDir(surface: SessionSurface): StepOutcome {
  const legacyDir = join(surface.workingDirectory, '.goodvibes', 'checkpoints');
  if (!existsSync(legacyDir)) return 'nothing'; // nothing legacy to move
  if (existsSync(surface.checkpointsDir)) {
    // The scoped store already exists, so the legacy store cannot be adopted
    // here — and nothing else reclaims it. Disclose it by name rather than
    // leaving it silently orphaned; never auto-delete a git store that may
    // hold real checkpoint history.
    logger.info('session-migration: legacy checkpoint store left in place — the surface-scoped store already exists', {
      strandedLegacyCheckpoints: legacyDir,
      scopedCheckpoints: surface.checkpointsDir,
      surfaceRoot: surface.surfaceRoot,
    });
    return 'nothing';
  }
  try {
    mkdirSync(dirname(surface.checkpointsDir), { recursive: true });
    // A single rename() of the whole directory is atomic on the same
    // filesystem: it either fully succeeds (side GIT_DIR + index.json move
    // together) or throws with the legacy directory completely untouched —
    // there is no intermediate, half-moved state to reach.
    renameSync(legacyDir, surface.checkpointsDir);
  } catch (error) {
    logger.warn('session-migration: checkpoints dir move failed — leaving legacy checkpoints in place', {
      error: summarizeError(error),
    });
    return 'failed';
  }

  // The shared legacy store has been adopted by THIS surface. In a working
  // directory used by two products, the first mover claims the history —
  // so leave a findable trace at the old location for the second one's user,
  // and say so in the log.
  logger.info('session-migration: adopted the shared legacy checkpoint store into this surface', {
    movedFrom: legacyDir,
    movedTo: surface.checkpointsDir,
    surfaceRoot: surface.surfaceRoot,
  });
  try {
    writeFileSync(
      checkpointsMovedMarkerPath(surface),
      JSON.stringify(
        {
          movedTo: surface.checkpointsDir,
          surfaceRoot: surface.surfaceRoot,
          date: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
  } catch (error) {
    // The store itself moved successfully; only the breadcrumb failed. That
    // is worth a warning but is not a reason to redo (or undo) the move.
    logger.warn('session-migration: checkpoint adoption marker could not be written', {
      marker: checkpointsMovedMarkerPath(surface),
      error: summarizeError(error),
    });
  }
  return 'done';
}

/** Run one migration step, converting a thrown error into a `failed` outcome. Never throws. */
function runStep(name: string, step: () => StepOutcome): StepOutcome {
  try {
    return step();
  } catch (error) {
    logger.warn(`session-migration: ${name} failed`, { error: summarizeError(error) });
    return 'failed';
  }
}

/**
 * Run the one-time migration for `surface`, guarded by its marker file.
 * Never throws — every step and the marker write itself are independently
 * best-effort; a failure anywhere is logged and otherwise ignored so a
 * migration problem can never break `createSessionSurface` or startup.
 *
 * The marker is written only when NO step failed. A transient failure (an
 * unreadable directory, a cross-device rename) leaves the marker absent, so
 * the next `createSessionSurface` retries the whole pass; every step is
 * existsSync/rename-guarded and therefore safe to repeat.
 */
export function runSessionSurfaceMigration(surface: SessionSurface): void {
  const marker = markerPath(surface);
  try {
    if (existsSync(marker)) return;
  } catch (error) {
    logger.warn('session-migration: marker check failed, skipping this pass', { error: summarizeError(error) });
    return;
  }

  const outcomes: StepOutcome[] = [
    runStep('last-session pointer migration', () => migrateLastSessionPointer(surface)),
    runStep('agent journal migration', () => migrateAgentJournals(surface)),
    runStep('checkpoints migration', () => migrateCheckpointsDir(surface)),
  ];

  if (outcomes.includes('failed')) {
    logger.warn('session-migration: a step failed — leaving the migration marker unwritten so the next start retries', {
      surfaceRoot: surface.surfaceRoot,
      workingDirectory: surface.workingDirectory,
    });
    return;
  }

  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ migratedAt: new Date().toISOString() }) + '\n', 'utf-8');
  } catch (error) {
    // If the marker itself cannot be written, the next createSessionSurface
    // call will simply retry the (idempotent — existsSync/rename-guarded)
    // steps above; nothing is lost by trying again.
    logger.warn('session-migration: marker write failed — migration will retry next time', { error: summarizeError(error) });
  }
}
