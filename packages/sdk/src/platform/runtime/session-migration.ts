/**
 * session-migration.ts — one-time migration from the pre-SessionSurface,
 * pre-agents-subdirectory on-disk layout into the surface-scoped layout,
 * invoked once per surface from createSessionSurface (session-surface.ts).
 *
 * Idempotent: guarded by a marker file at
 * `<workingDirectory>/.goodvibes/<surfaceRoot>/.migrated-v1`. A surface whose
 * marker VALIDATES returns immediately — the migration steps below never run
 * twice. Validation is by CONTENT, never by existence: the marker holds a
 * schema version, a completion flag, a timestamp and a per-step summary of what
 * was moved and how many, and is re-read and parsed on every boot. A marker
 * that is zero-byte, truncated, non-JSON, missing `completed: true`, or written
 * by an older schema reads as "not migrated" and the whole (idempotent) pass
 * runs again. A crash between `open` and the last byte of the write used to
 * leave a file that `existsSync` happily accepted, stranding the user's legacy
 * session data forever; the marker is now also written to a temp file and
 * renamed into place, so an interrupted write leaves the previous state rather
 * than a torn marker. Every step is copy-forward or move, never delete-only: a step
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * The marker's schema version. A marker written by an OLDER schema reads as
 * "not migrated" and the pass re-runs — every step is existsSync/rename-guarded
 * and safe to repeat, so re-running costs a directory listing, never data. A
 * marker written by a NEWER schema is accepted: a later build already did at
 * least this much work, and downgrading must not re-migrate on every boot.
 */
const MARKER_SCHEMA_VERSION = 1;

/** What the migration actually did, recorded in the marker and disclosed in the log. */
interface MigrationSummary {
  /** Journals relocated from flat sessions/ into sessions/agents/. */
  agentJournalsMoved: number;
  /** Journals left where they were because a real file already held the destination name. */
  agentJournalsLeftInPlace: number;
  /** Zero-byte or unparseable destination files replaced by the legacy source. */
  tornDestinationsReplaced: number;
  /** The legacy unscoped last-session pointer was copied forward. */
  lastSessionPointerAdopted: boolean;
  /** The shared legacy checkpoint store was moved into this surface. */
  checkpointsAdopted: boolean;
}

function emptySummary(): MigrationSummary {
  return {
    agentJournalsMoved: 0,
    agentJournalsLeftInPlace: 0,
    tornDestinationsReplaced: 0,
    lastSessionPointerAdopted: false,
    checkpointsAdopted: false,
  };
}

function markerPath(surface: SessionSurface): string {
  return join(surface.workingDirectory, '.goodvibes', surface.surfaceRoot, '.migrated-v1');
}

/**
 * Has this surface already been migrated? Answered by PARSING the marker, never
 * by its existence.
 *
 * A crash mid-write leaves a file that exists and says nothing: zero bytes, a
 * truncated object, a page of NULs restored by a filesystem that recovered the
 * inode but not the data. `existsSync` returns true for every one of those, and
 * the migration would then be skipped forever with the user's legacy sessions,
 * journals and checkpoints stranded in the old layout. So the marker must
 * positively assert its own completion: a JSON object with a known schema
 * version and `completed: true`. Anything else — unreadable, unparseable, an
 * array, a bare `true`, a missing flag, an older schema — is treated as "not
 * migrated" and the idempotent pass runs again.
 */
function readCompletedMarker(surface: SessionSurface): { schemaVersion: number } | null {
  const path = markerPath(surface);
  let raw: string;
  try {
    if (!existsSync(path)) return null;
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    logger.warn('session-migration: marker unreadable — treating this surface as unmigrated', {
      marker: path,
      error: summarizeError(error),
    });
    return null;
  }
  if (raw.trim().length === 0) {
    logger.warn('session-migration: marker is empty (interrupted write) — re-running the migration', { marker: path });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('session-migration: marker is not parseable JSON (torn write) — re-running the migration', {
      marker: path,
      bytes: raw.length,
    });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('session-migration: marker is not an object — re-running the migration', { marker: path });
    return null;
  }
  const record = parsed as { schemaVersion?: unknown; completed?: unknown };
  if (record.completed !== true) {
    logger.warn('session-migration: marker does not assert completion — re-running the migration', { marker: path });
    return null;
  }
  if (typeof record.schemaVersion !== 'number' || !Number.isFinite(record.schemaVersion)) {
    logger.warn('session-migration: marker has no usable schema version — re-running the migration', { marker: path });
    return null;
  }
  if (record.schemaVersion < MARKER_SCHEMA_VERSION) {
    logger.info('session-migration: marker was written by an older schema — re-running the migration', {
      marker: path,
      markerSchemaVersion: record.schemaVersion,
      currentSchemaVersion: MARKER_SCHEMA_VERSION,
    });
    return null;
  }
  return { schemaVersion: record.schemaVersion };
}

/**
 * Write the completion marker with the content that makes it verifiable:
 * schema version, timestamp, surface, and exactly what was moved and how many.
 *
 * Written to a sibling temp file and renamed into place, so an interruption
 * leaves either no marker at all (the pass retries) or the complete previous
 * one — never a half-written file that a later boot would trust. The temp name
 * carries the pid so two processes racing to migrate the same surface cannot
 * scribble over each other's partial file; `rename` onto the final path is
 * atomic, and both processes write the same "completed" assertion, so whichever
 * lands last is equally correct.
 */
function writeCompletedMarker(surface: SessionSurface, summary: MigrationSummary): void {
  const path = markerPath(surface);
  const temp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify(
    {
      schemaVersion: MARKER_SCHEMA_VERSION,
      completed: true,
      migratedAt: new Date().toISOString(),
      surfaceRoot: surface.surfaceRoot,
      workingDirectory: surface.workingDirectory,
      moved: {
        agentJournals: summary.agentJournalsMoved,
        agentJournalsLeftInPlace: summary.agentJournalsLeftInPlace,
        tornDestinationsReplaced: summary.tornDestinationsReplaced,
        lastSessionPointerAdopted: summary.lastSessionPointerAdopted,
        checkpointsAdopted: summary.checkpointsAdopted,
      },
    },
    null,
    2,
  ) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, body, 'utf-8');
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file is inert; failing to clean it up is not worth a second error.
    }
    throw error;
  }
}

/** Copy `from` forward to `to`, creating `to`'s parent directory if needed. Throws on failure — callers wrap this. */
function copyForward(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/**
 * Is the file at `path` genuinely absent of content — zero bytes, or bytes that
 * do not begin a parseable JSON record?
 *
 * Used to tell "a real file already holds this name" from "a crash left a
 * carcass here". A destination in either of those states holds nothing that can
 * be read back, and the legacy source about to be moved onto it is by
 * definition at least as complete, so replacing it loses no recoverable data.
 * A file that DOES parse is real and is never overwritten.
 */
function isTornOrEmptyFile(path: string): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    // Unreadable stat: treat as real and leave it alone (when in doubt, keep).
    return false;
  }
  if (size === 0) return true;
  try {
    const firstLine = readFileSync(path, 'utf-8').split('\n', 1)[0] ?? '';
    if (firstLine.trim().length === 0) return true;
    const parsed: unknown = JSON.parse(firstLine);
    return typeof parsed !== 'object' || parsed === null;
  } catch {
    // Present, non-empty, and not a parseable opening record: a truncated
    // half-write, not a file anything can read back.
    return true;
  }
}

function migrateLastSessionPointer(surface: SessionSurface, summary: MigrationSummary): StepOutcome {
  const canonicalPath = surface.lastSessionPointer;
  const legacyUnscopedPath = join(resolveSharedDirectory(surface.workingDirectory, 'sessions'), 'last-session.json');
  if (!existsSync(legacyUnscopedPath)) return 'nothing';

  // Validate the destination by content, not existence: a canonical pointer
  // left zero-byte or half-written by a crash names no session at all, so the
  // legacy pointer is strictly better and wins regardless of mtime.
  if (!existsSync(canonicalPath) || isTornOrEmptyFile(canonicalPath)) {
    copyForward(legacyUnscopedPath, canonicalPath);
    summary.lastSessionPointerAdopted = true;
    return 'done';
  }
  // Both exist and both are readable: newest mtime wins, copied into the
  // canonical path. The legacy unscoped file is left in place either way.
  const canonicalMtime = statSync(canonicalPath).mtimeMs;
  const legacyMtime = statSync(legacyUnscopedPath).mtimeMs;
  if (legacyMtime > canonicalMtime) {
    copyForward(legacyUnscopedPath, canonicalPath);
    summary.lastSessionPointerAdopted = true;
    return 'done';
  }
  return 'nothing';
}

function migrateAgentJournals(surface: SessionSurface, summary: MigrationSummary): StepOutcome {
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
  let leftInPlace = 0;
  let replacedTorn = 0;
  for (const name of toMove) {
    const from = join(sessionsDir, name);
    const to = join(surface.agentJournalsDir, name);
    try {
      // Never clobber a REAL existing agents/ file with the same name — leave
      // the legacy copy in place rather than guess which one is authoritative.
      // But "the destination exists" is not the same claim as "the destination
      // holds data": a crash mid-copy leaves a zero-byte or truncated file that
      // existsSync accepts and nothing can read back, and skipping on that
      // strands the legacy journal permanently. Decide on content.
      if (existsSync(to)) {
        if (!isTornOrEmptyFile(to)) {
          leftInPlace++;
          logger.info('session-migration: agent journal left in place — a readable file already holds that name', {
            file: name,
            destination: to,
          });
          continue;
        }
        logger.warn('session-migration: replacing an empty/truncated destination journal with the legacy source', {
          file: name,
          destination: to,
        });
        replacedTorn++;
      }
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
  summary.agentJournalsMoved += moved;
  summary.agentJournalsLeftInPlace += leftInPlace;
  summary.tornDestinationsReplaced += replacedTorn;
  if (failures > 0) return 'failed';
  return moved > 0 ? 'done' : 'nothing';
}

/** `<workingDirectory>/.goodvibes/checkpoints-moved.json` — the trace left at the old shared location. */
function checkpointsMovedMarkerPath(surface: SessionSurface): string {
  return join(surface.workingDirectory, '.goodvibes', 'checkpoints-moved.json');
}

function migrateCheckpointsDir(surface: SessionSurface, summary: MigrationSummary): StepOutcome {
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
  summary.checkpointsAdopted = true;
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
  if (readCompletedMarker(surface) !== null) return;

  const summary = emptySummary();
  const outcomes: StepOutcome[] = [
    runStep('last-session pointer migration', () => migrateLastSessionPointer(surface, summary)),
    runStep('agent journal migration', () => migrateAgentJournals(surface, summary)),
    runStep('checkpoints migration', () => migrateCheckpointsDir(surface, summary)),
  ];

  if (outcomes.includes('failed')) {
    logger.warn('session-migration: a step failed — leaving the migration marker unwritten so the next start retries', {
      surfaceRoot: surface.surfaceRoot,
      workingDirectory: surface.workingDirectory,
    });
    return;
  }

  // Disclosure: a migration that actually moved something says what it moved
  // and how many, rather than relocating a user's data in silence. A pass that
  // found nothing to do stays quiet — it is the common case on every boot after
  // the first, and logging it would drown the lines that matter.
  const movedAnything = summary.agentJournalsMoved > 0
    || summary.lastSessionPointerAdopted
    || summary.checkpointsAdopted
    || summary.agentJournalsLeftInPlace > 0
    || summary.tornDestinationsReplaced > 0;
  if (movedAnything) {
    logger.info('session-migration: migrated legacy session data into the surface-scoped layout', {
      surfaceRoot: surface.surfaceRoot,
      workingDirectory: surface.workingDirectory,
      agentJournalsMoved: summary.agentJournalsMoved,
      agentJournalsLeftInPlace: summary.agentJournalsLeftInPlace,
      tornDestinationsReplaced: summary.tornDestinationsReplaced,
      lastSessionPointerAdopted: summary.lastSessionPointerAdopted,
      checkpointsAdopted: summary.checkpointsAdopted,
    });
  }

  try {
    writeCompletedMarker(surface, summary);
  } catch (error) {
    // If the marker itself cannot be written, the next createSessionSurface
    // call will simply retry the (idempotent — existsSync/rename-guarded)
    // steps above; nothing is lost by trying again.
    logger.warn('session-migration: marker write failed — migration will retry next time', { error: summarizeError(error) });
  }
}
