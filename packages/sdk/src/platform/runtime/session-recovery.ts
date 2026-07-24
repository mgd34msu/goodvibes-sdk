/**
 * Crash-recovery snapshots: write, offer, load, retire.
 *
 * A recovery snapshot (`<scope>/recovery/recovery-<sessionId>.jsonl`) is a
 * periodic autosave of a live conversation. It exists so that a process that
 * dies between clean saves does not take the conversation with it. Split out
 * of session-persistence.ts, which keeps the durable-store half (save / load /
 * last-session pointer); both halves resolve every path through the shared
 * scope layer in session-persistence-scope.ts.
 *
 * SUPERSESSION — when is a snapshot still live crash data?
 * A snapshot is offered when it is strictly newer than ITS OWN session's
 * durable store file (`<scope>/sessions/<sessionId>.jsonl`), or when that
 * session has no store file at all. It is NOT judged against the last-session
 * pointer, which advances on every turn-completion persist of ANY session:
 * under that older rule, one message typed in an unrelated session (or in a
 * `--continue`d resume of this one) silently buried a snapshot that still held
 * unsaved messages, with no UI path left to reach it. Judging a snapshot
 * against its own session's store keeps that impossible — an unrelated
 * session's activity cannot bury it, and a clean shutdown of the snapshot's
 * own session both writes the store AND deletes the snapshot, so the surviving
 * snapshot of a session whose store is older is a crash by definition.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

import { logger } from '../utils/logger.js';
import type { SessionReturnContextSummary } from './session-return-context.js';
import type { ConversationTitleSource } from '../core/conversation.js';
import { summarizeError } from '../utils/error-display.js';
import type { SessionSurface } from './session-surface.js';
import {
  isSurfaceOptions,
  legacySharedRecoveryDir,
  legacySharedRecoveryFile,
  requireSurface,
  resolveRecoveryDirPath,
  resolveRecoveryFilePath,
  resolveSessionStorePath,
  resolveSessionsDirPath,
  RECOVERY_FILE_PREFIX,
  RECOVERY_FILE_SUFFIX,
  type SessionPersistenceOptions,
  type SessionSnapshot,
} from './session-persistence-scope.js';

export type RecoveryFileInfo = {
  title: string;
  timestamp: number;
  sessionId: string;
  returnContext?: SessionReturnContextSummary | undefined;
};

/**
 * All per-session recovery files currently on disk under `dir`, newest-first
 * by mtime. Takes an already-resolved recovery directory so both the legacy
 * (`getRecoveryDir(homeDirectory, surfaceRoot)`) and surface
 * (`surface.recoveryDir`) call forms share one implementation.
 */
function listRecoveryFiles(dir: string): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter(
      (name) => name.startsWith(RECOVERY_FILE_PREFIX) && name.endsWith(RECOVERY_FILE_SUFFIX),
    );
  } catch {
    return [];
  }
  const entries: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      entries.push({ path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // File vanished between readdir and stat — skip.
    }
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Every recovery snapshot visible to `options`, newest-first by mtime: the
 * scoped recovery directory, plus — for the surface form only — the legacy
 * shared directory (see legacySharedRecoveryDir). One list, used by every
 * "which snapshot is THE snapshot" decision (check / load / consume / remove),
 * so the file that is offered is always exactly the file that is retired.
 */
function listRecoveryCandidates(options?: SessionPersistenceOptions): Array<{ path: string; mtimeMs: number }> {
  const scoped = listRecoveryFiles(resolveRecoveryDirPath(options));
  if (!isSurfaceOptions(options)) return scoped;
  const legacy = listRecoveryFiles(legacySharedRecoveryDir(requireSurface(options)));
  if (legacy.length === 0) return scoped;
  return [...scoped, ...legacy].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The ONE snapshot file a recovery operation acts on, or undefined when there
 * is none. With a `sessionId`, that session's file wherever it actually lives
 * (canonical first, then the legacy shared dir); without one, the newest
 * snapshot across every visible location — the same file `checkRecoveryFile`
 * offers.
 *
 * In the corner case where the same session id has a snapshot in BOTH
 * locations, this resolves to the canonical one; the legacy duplicate stays
 * until it is itself the newest candidate. Retiring exactly one identified
 * file is the invariant — no operation here ever clears a directory.
 */
function pickRecoverySnapshotPath(
  options: SessionPersistenceOptions | undefined,
  sessionId?: string,
): string | undefined {
  if (!sessionId) return listRecoveryCandidates(options)[0]?.path;
  const canonical = resolveRecoveryFilePath(options, sessionId);
  if (existsSync(canonical)) return canonical;
  if (isSurfaceOptions(options)) {
    const legacyFile = legacySharedRecoveryFile(requireSurface(options), sessionId);
    if (existsSync(legacyFile)) return legacyFile;
  }
  return undefined;
}

/** Delete one specific snapshot file. A missing file is fine; nothing else is touched. */
function deleteRecoverySnapshotAt(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // missing file is fine
  }
}

export function writeRecoveryFile(
  snapshot: SessionSnapshot,
  sessionId: string,
  title = '',
  options?: SessionPersistenceOptions,
): void {
  try {
    if (!snapshot.messages.length) return;
    const recoveryFile = resolveRecoveryFilePath(options, sessionId);
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'meta', sessionId, title, timestamp: Date.now() }));
    if (snapshot.titleSource || snapshot.returnContext) {
      lines[0]! = JSON.stringify({
        type: 'meta',
        sessionId,
        title,
        timestamp: Date.now(),
        titleSource: snapshot.titleSource,
        returnContext: snapshot.returnContext,
      });
    }
    for (const message of snapshot.messages) {
      lines.push(JSON.stringify({ type: 'message', ...message }));
    }
    const tmpPath = recoveryFile + '.tmp';
    mkdirSync(dirname(recoveryFile), { recursive: true });
    writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
    renameSync(tmpPath, recoveryFile);
  } catch (error) {
    logger.warn('[Recovery] Write failed', { error: summarizeError(error) });
  }
}

/**
 * Delete a per-session recovery snapshot (after a clean save, or once its
 * conversation has been restored). With an explicit `sessionId` only that
 * session's file is removed — for the surface form, this also tries the
 * legacy shared per-session file (see legacySharedRecoveryFile), so a
 * snapshot restored via the dual-read fallback is retired from wherever it
 * actually lived. Without a `sessionId`, every recovery snapshot in the
 * scoped directory is cleared: this is the explicit FULL-RESET path, for a
 * caller that genuinely means "discard all crash state for this surface". It
 * is deliberately NOT what the prompted/silent recovery flows use —
 * `consumeRecovery`, `removeRecoveryPoint` and `autoRestoreRecovery` retire
 * exactly the one snapshot file they offered or loaded, so accepting one
 * session's snapshot can never destroy another session's. The full reset also
 * does NOT touch the legacy shared directory, which is shared across every
 * project that ever used this surfaceRoot before per-project scoping
 * existed; a bulk clear there could delete an unrelated project's crash
 * snapshot. Only a session-id-keyed operation (ids are unique) reaches into
 * it. A missing file is fine either way.
 */
export function deleteRecoveryFile(options?: SessionPersistenceOptions, sessionId?: string): void {
  try {
    if (sessionId) {
      try {
        unlinkSync(resolveRecoveryFilePath(options, sessionId));
      } catch {
        // missing file is fine
      }
      if (isSurfaceOptions(options)) {
        try {
          unlinkSync(legacySharedRecoveryFile(requireSurface(options), sessionId));
        } catch {
          // missing file is fine — most of the time nothing lives here
        }
      }
      return;
    }
    const dir = resolveRecoveryDirPath(options);
    for (const entry of listRecoveryFiles(dir)) {
      try {
        unlinkSync(entry.path);
      } catch {
        // missing file is fine
      }
    }
  } catch {
    // missing directory / unresolved home is fine
  }
}

/** Read the first-line meta of a recovery file into a RecoveryFileInfo. */
function readRecoveryMeta(recoveryFile: string): RecoveryFileInfo | null {
  const fd = openSync(recoveryFile, 'r');
  const buf = Buffer.alloc(4096);
  const bytesRead = readSync(fd, buf, 0, 4096, 0);
  closeSync(fd);
  const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
  const meta = JSON.parse(firstLine!) as {
    title?: string | undefined;
    timestamp?: number | undefined;
    sessionId?: string | undefined;
    returnContext?: SessionReturnContextSummary | undefined;
  };
  return {
    title: meta.title ?? '',
    timestamp: meta.timestamp ?? 0,
    sessionId: meta.sessionId ?? '',
    returnContext: meta.returnContext,
  };
}

/**
 * The mtime of `sessionId`'s durable store file, or null when that session has
 * no store file (never cleanly saved, or its file was deleted) — and also null
 * for a snapshot that carries no session id at all, which nothing in the store
 * can correspond to.
 */
function sessionStoreMtimeMs(sessionsDir: string, sessionId: string): number | null {
  if (!sessionId.trim()) return null;
  try {
    return statSync(resolveSessionStorePath(sessionsDir, sessionId)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * True when this snapshot was already superseded by a clean save of its OWN
 * session — the only thing that can make a snapshot stale.
 *
 * No store file for that session (including a snapshot with no session id, and
 * a legacy shared-directory snapshot whose session was never saved under the
 * current surface scope) means nothing has superseded it: offer it.
 *
 * Equal mtimes count as superseded, deliberately. Filesystem mtime resolution
 * and clock skew make "same timestamp" indistinguishable from "the store was
 * written last", and a snapshot whose content the store already holds is worth
 * nothing — so the tie goes to not re-offering data the user already has.
 */
function isSupersededByOwnStore(sessionsDir: string, sessionId: string, snapshotMtimeMs: number): boolean {
  const storeMtimeMs = sessionStoreMtimeMs(sessionsDir, sessionId);
  if (storeMtimeMs === null) return false;
  return snapshotMtimeMs <= storeMtimeMs;
}

/**
 * The newest crash-recovery snapshot that has not been superseded by a clean
 * save of its own session (see the SUPERSESSION note at the top of this file).
 * Returns null when no live crash snapshot exists.
 *
 * The surface form ALSO consults the legacy, home-anchored, fully unscoped
 * shared recovery directory (see legacySharedRecoveryDir) as a standing
 * one-time offer for a pre-upgrade snapshot that predates per-project
 * scoping entirely. That directory cannot be mapped to a project
 * deterministically — a snapshot found there might belong to a different
 * project that happened to share this surfaceRoot before scoping existed.
 * This is a deliberate, accepted tradeoff: offering a possibly-unrelated
 * snapshot once is judged better than silently losing a genuinely-relevant
 * one forever.
 *
 * A session that is CURRENTLY RUNNING keeps refreshing its own snapshot, so
 * its snapshot is legitimately newer than its store and will be reported here.
 * That is the honest answer to the question this function asks, and it does
 * not self-offer after a clean exit: shutdown saves the store and deletes the
 * snapshot, leaving nothing to find. Suppressing a still-live process's own
 * snapshot needs process liveness, which this module has no view of — that
 * check belongs to the consuming surface, at the point where it decides to
 * show the offer.
 */
export function checkRecoveryFile(options?: SessionPersistenceOptions): RecoveryFileInfo | null {
  return findLiveRecoveryCandidate(options)?.info ?? null;
}

/**
 * Whether ONE specific session has a live crash snapshot — a snapshot strictly
 * newer than that session's own durable store file, under exactly the rule
 * `checkRecoveryFile` uses. Returns its meta, or null when that session has no
 * snapshot or its snapshot was already superseded.
 *
 * This is the probe for a consumer's resume-a-named-session flow (`--continue`
 * and friends): loading the store copy directly would silently drop the tail of
 * messages that only the snapshot holds, so the consumer asks here first and
 * routes a non-null answer through its recovery prompt instead of resuming the
 * shorter copy. Like the keyed forms of `consumeRecovery` /
 * `removeRecoveryPoint`, it finds the snapshot in whichever directory it
 * actually lives (canonical first, then the legacy shared dir).
 */
export function checkRecoveryForSession(surface: SessionSurface, sessionId: string): RecoveryFileInfo | null {
  const options: SessionPersistenceOptions = { surface };
  try {
    const path = pickRecoverySnapshotPath(options, sessionId);
    if (!path) return null;
    const snapshotMtimeMs = statSync(path).mtimeMs;
    if (isSupersededByOwnStore(resolveSessionsDirPath(options), sessionId, snapshotMtimeMs)) return null;
    return readRecoveryMeta(path);
  } catch (error) {
    logger.warn('[Recovery] Per-session check failed', { error: summarizeError(error) });
    return null;
  }
}

/**
 * The live crash snapshot to offer, as BOTH its meta and the exact path it was
 * read from — so a caller that acts on the offer (autoRestoreRecovery) retires
 * precisely the file it restored, rather than re-deriving a path from the
 * meta's session id and hoping the two agree.
 *
 * Note the ordering: each candidate's meta is read BEFORE the supersession
 * test, because the session id that names the store file to compare against
 * lives in that meta. An unreadable or partial snapshot is skipped, exactly as
 * before.
 */
function findLiveRecoveryCandidate(
  options?: SessionPersistenceOptions,
): { path: string; info: RecoveryFileInfo } | null {
  try {
    const sessionsDir = resolveSessionsDirPath(options);
    for (const entry of listRecoveryCandidates(options)) {
      // Newest-first; the first snapshot its own session has not already
      // superseded with a clean save is the one to offer.
      let info: RecoveryFileInfo | null;
      try {
        info = readRecoveryMeta(entry.path);
      } catch {
        // Unreadable/partial snapshot — skip to the next candidate.
        continue;
      }
      if (!info) continue;
      if (isSupersededByOwnStore(sessionsDir, info.sessionId, entry.mtimeMs)) continue;
      return { path: entry.path, info };
    }
    return null;
  } catch (error) {
    logger.warn('[Recovery] Check failed', { error: summarizeError(error) });
    return null;
  }
}

/** Parse a recovery snapshot file's contents into a SessionSnapshot. Throws on any read/parse failure — callers wrap this in their own try/catch. */
function parseRecoveryFile(recoveryFile: string): SessionSnapshot {
  const raw = readFileSync(recoveryFile, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < 2) return { messages: [] };
  return {
    title: (() => {
      try {
        const metaLine = JSON.parse(lines[0]!) as {
          title?: string | undefined;
          titleSource?: ConversationTitleSource | undefined;
          returnContext?: SessionReturnContextSummary | undefined;
        };
        return metaLine.title;
      } catch {
        return undefined;
      }
    })(),
    titleSource: (() => {
      try {
        const metaLine = JSON.parse(lines[0]!) as { titleSource?: ConversationTitleSource };
        return metaLine.titleSource;
      } catch {
        return undefined;
      }
    })(),
    returnContext: (() => {
      try {
        const metaLine = JSON.parse(lines[0]!) as { returnContext?: SessionReturnContextSummary };
        return metaLine.returnContext;
      } catch {
        return undefined;
      }
    })(),
    messages: lines.slice(1).map((line) => {
      const { type: _type, ...rest } = JSON.parse(line) as { type: string } & Record<string, unknown>;
      return rest;
    }),
  };
}

/**
 * Load a recovery snapshot's conversation. With an explicit `sessionId` the
 * matching per-session file is loaded; without one, the newest crash snapshot
 * (the same one checkRecoveryFile offers) is loaded.
 *
 * The surface form ALSO dual-reads the legacy shared recovery directory when
 * the canonical (scoped) location has nothing — see checkRecoveryFile's doc
 * comment for the cross-project caveat this accepts, and
 * legacySharedRecoveryDir for why it can never be migrated instead.
 */
export function loadRecoveryConversation(options?: SessionPersistenceOptions, sessionId?: string): SessionSnapshot | null {
  let recoveryFile: string | undefined;
  try {
    recoveryFile = pickRecoverySnapshotPath(options, sessionId);
  } catch (error) {
    logger.warn('[Recovery] Load failed', { error: summarizeError(error) });
    return null;
  }
  if (!recoveryFile) return null;
  return loadRecoveryConversationAt(recoveryFile);
}

/** Parse one specific snapshot file, converting any read/parse failure into null (never throws). */
function loadRecoveryConversationAt(recoveryFile: string): SessionSnapshot | null {
  try {
    return parseRecoveryFile(recoveryFile);
  } catch (error) {
    logger.warn('[Recovery] Load failed', { error: summarizeError(error) });
    return null;
  }
}

/**
 * A one-line receipt sink — the structural shape of FeatureAnnouncementStore's
 * announce-once queue (`record(id, text)`), so auto-restore can enqueue its
 * receipt into the same attach-time queue surfaces drain, without this module
 * depending on the config layer.
 */
export interface RecoveryReceiptSink {
  record(id: string, text?: string): boolean;
}

/** The outcome of a silent auto-restore. */
export interface RecoveryRestoreResult {
  readonly snapshot: SessionSnapshot;
  readonly info: RecoveryFileInfo;
  /** The one-line receipt describing the restore. */
  readonly receipt: string;
}

/** Build the one-line restore receipt, verbatim. */
function recoveryReceiptText(info: RecoveryFileInfo, messageCount: number): string {
  const label = info.title.trim().length > 0 ? ` "${info.title.trim()}"` : '';
  const plural = messageCount === 1 ? 'message' : 'messages';
  return `Restored an interrupted session${label}: ${messageCount} ${plural} recovered from a crash snapshot.`;
}

/**
 * Silent crash-recovery restore. When a live crash snapshot exists (one its own
 * session has not superseded with a clean save), its conversation is loaded and
 * returned WITHOUT a prompt, its snapshot file is cleared, and a single one-line
 * receipt is enqueued into the receipts sink (exactly once per snapshot session)
 * so the restore surfaces as a receipt rather than an interruption. Returns null
 * when there is nothing to restore.
 *
 * This is the SDK-side replacement for the old restore-and-collide dance: with
 * per-session snapshot files there is no shared recovery file to guard, so the
 * consuming surface's collision-preservation workaround is no longer needed.
 */
export function autoRestoreRecovery(
  options?: SessionPersistenceOptions,
  receipts?: RecoveryReceiptSink,
): RecoveryRestoreResult | null {
  const candidate = findLiveRecoveryCandidate(options);
  if (!candidate) return null;
  const { path, info } = candidate;
  const snapshot = loadRecoveryConversationAt(path);
  if (!snapshot || snapshot.messages.length === 0) return null;
  const receipt = recoveryReceiptText(info, snapshot.messages.length);
  if (receipts) {
    try {
      receipts.record(`session-recovery-restored:${info.sessionId}`, receipt);
    } catch (error) {
      logger.warn('[Recovery] receipt enqueue failed', { error: summarizeError(error) });
    }
  }
  // The snapshot has served its purpose — retire exactly the file that was
  // restored (never a directory sweep, and never a path re-derived from the
  // meta's session id, which a snapshot with an empty/foreign id would not
  // resolve back to).
  deleteRecoverySnapshotAt(path);
  return { snapshot, info, receipt };
}

/** The outcome of the prompted "yes, resume it" recovery flow (`consumeRecovery`). */
export interface RecoveryConsumeResult {
  /** The loaded conversation, or null when there was nothing to consume. */
  readonly snapshot: SessionSnapshot | null;
  /** True once a recovery snapshot was found, loaded, and deleted. */
  readonly consumed: boolean;
}

/**
 * The "yes, resume it" primitive for a consumer's PROMPTED recovery flow (as
 * opposed to `autoRestoreRecovery`'s silent path): loads a session's recovery
 * snapshot and deletes its file in one operation — load-then-delete. If the
 * load finds nothing (or fails; `loadRecoveryConversation` converts a read
 * failure into `null` rather than throwing), the snapshot file is left
 * untouched — retirement only follows a successful load, so a bad read can
 * never destroy data that was never actually recovered.
 *
 * Contract: the SDK never applies the loaded snapshot to any conversation on
 * its own here. The caller decides what happens to the messages it gets
 * back — this keeps the prompted path honest, so retirement can't be
 * forgotten (unlike a hand-rolled load-then-maybe-delete sequence, where a
 * consumer can forget the delete half entirely).
 *
 * Exactly ONE snapshot is retired: the file that was loaded, in whichever
 * directory it actually lives (canonical or the legacy shared dir). Omitting
 * `sessionId` selects the newest snapshot — the same one `checkRecoveryFile`
 * offers — and still retires only that one file. Another session's
 * never-loaded snapshot is never collateral damage.
 */
export function consumeRecovery(surface: SessionSurface, sessionId?: string): RecoveryConsumeResult {
  const options: SessionPersistenceOptions = { surface };
  let path: string | undefined;
  try {
    path = pickRecoverySnapshotPath(options, sessionId);
  } catch (error) {
    logger.warn('[Recovery] Consume failed to resolve a snapshot', { error: summarizeError(error) });
    return { snapshot: null, consumed: false };
  }
  if (!path) return { snapshot: null, consumed: false };
  const snapshot = loadRecoveryConversationAt(path);
  if (!snapshot) {
    return { snapshot: null, consumed: false };
  }
  deleteRecoverySnapshotAt(path);
  return { snapshot, consumed: true };
}

/** The outcome of the prompted "no, and remove it" recovery flow (`removeRecoveryPoint`). */
export interface RecoveryRemoveResult {
  /** True when a recovery snapshot existed on disk and was deleted; false when there was nothing to remove. */
  readonly removed: boolean;
}

/**
 * The "no, and remove it" primitive for a consumer's prompted recovery flow:
 * deletes a session's recovery snapshot WITHOUT loading it, and reports
 * honestly whether there was anything there to delete. Like `consumeRecovery`,
 * this never touches any conversation object — it only clears the on-disk
 * snapshot.
 *
 * Symmetrically with `consumeRecovery`, exactly ONE snapshot is retired: the
 * identified one, in whichever directory it actually lives. Omitting
 * `sessionId` declines the snapshot currently being offered (the newest) and
 * removes only that file — every other session's snapshot survives untouched.
 */
export function removeRecoveryPoint(surface: SessionSurface, sessionId?: string): RecoveryRemoveResult {
  const options: SessionPersistenceOptions = { surface };
  const path = pickRecoverySnapshotPath(options, sessionId);
  if (!path) return { removed: false };
  deleteRecoverySnapshotAt(path);
  return { removed: true };
}
