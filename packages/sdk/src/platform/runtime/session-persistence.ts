/**
 * Durable session persistence: saving a conversation to its session store file
 * and remembering which session was last active.
 *
 * The crash-snapshot half of this module now lives in session-recovery.ts, and
 * the "which directory does this call mean" layer both halves share lives in
 * session-persistence-scope.ts. This file stays the single import site every
 * consumer already uses: the full previously-public API is re-exported below,
 * name for name, so no caller changes as a result of the split.
 */

import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import type { SessionMeta } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  resolveLastSessionPointerPath,
  resolveSessionManager,
  resolveSessionsDirPath,
  resolveSessionStorePath,
  type SessionPersistenceOptions,
  type SessionSnapshot,
} from './session-persistence-scope.js';

// The scope layer's public names, re-exported unchanged. Everything else in
// session-persistence-scope.ts is internal plumbing shared with
// session-recovery.ts and deliberately stays out of the public barrel
// (runtime/operations.ts re-exports THIS file, not that one).
export {
  getLastSessionPointerPath,
  getRecoveryDir,
  getRecoveryFilePath,
  getUserSessionsDir,
  type SessionPersistenceLegacyOptions,
  type SessionPersistenceOptions,
  type SessionPersistencePaths,
  type SessionPersistenceSurfaceOptions,
  type SessionSnapshot,
} from './session-persistence-scope.js';

// The crash-recovery API, re-exported so `session-persistence.js` remains the
// one import path for it (see session-recovery.ts for the semantics).
export {
  autoRestoreRecovery,
  checkRecoveryFile,
  checkRecoveryForSession,
  consumeRecovery,
  deleteRecoveryFile,
  loadRecoveryConversation,
  removeRecoveryPoint,
  writeRecoveryFile,
  type RecoveryConsumeResult,
  type RecoveryFileInfo,
  type RecoveryReceiptSink,
  type RecoveryRemoveResult,
  type RecoveryRestoreResult,
} from './session-recovery.js';

export function generateUserSessionId(): string {
  return randomBytes(4).toString('hex');
}

export function saveSession(
  sessionId: string,
  data: SessionSnapshot,
  model: string,
  provider: string,
  title = '',
  options?: SessionPersistenceOptions,
  /**
   * Who caused this save. Defaults to `'auto'`, the honest default for every
   * existing caller (shutdownRuntime's save-on-exit, and any other call site
   * that has not been updated to state it was an explicit user action). Pass
   * `'user'` only from a call site the user directly triggered (e.g. a
   * `/save` command in a consuming surface), so the session-conversations
   * retention store (runtime/retention/append-only-registry.ts) never expires
   * a session the user explicitly asked to keep.
   */
  saveSource: 'user' | 'auto' = 'auto',
): void {
  const manager = resolveSessionManager(options);
  const meta: SessionMeta = {
    title,
    model,
    provider,
    timestamp: data.timestamp ?? Date.now(),
    titleSource: data.titleSource,
    returnContext: data.returnContext,
    saveSource,
  };
  manager.save(sessionId, data.messages as Array<Record<string, unknown>>, meta);
}

export function persistConversation(
  sessionId: string,
  data: SessionSnapshot,
  model: string,
  provider: string,
  title = '',
  options?: SessionPersistenceOptions,
  saveSource: 'user' | 'auto' = 'auto',
): void {
  saveSession(sessionId, data, model, provider, title, options, saveSource);
  writeLastSessionPointer(sessionId, options);
}

/**
 * Record which session was last active.
 *
 * Written to a pid-suffixed temp file and renamed into place: `rename()` within
 * one directory is atomic on every POSIX filesystem, so a crash mid-write can
 * only ever leave the temp file behind, never a half-written pointer where a
 * good one used to be. (The read side already treats a torn pointer as absent,
 * which is the safe direction; this makes a torn pointer impossible to produce
 * in the first place.) The pid suffix keeps two processes writing the same
 * pointer from sharing a temp name.
 */
export function writeLastSessionPointer(sessionId: string, options?: SessionPersistenceOptions): void {
  let tempPath: string | undefined;
  try {
    const pointerPath = resolveLastSessionPointerPath(options);
    mkdirSync(dirname(pointerPath), { recursive: true });
    tempPath = `${pointerPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(
      tempPath,
      JSON.stringify({ sessionId, timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );
    renameSync(tempPath, pointerPath);
    tempPath = undefined;
  } catch (error) {
    logger.warn('writeLastSessionPointer failed', { error: summarizeError(error) });
  } finally {
    // A failed write must not leave its own litter behind. ENOENT here means
    // the rename actually landed or the file was never created, either way
    // there is nothing left to clean up.
    if (tempPath !== undefined) {
      try {
        unlinkSync(tempPath);
      } catch { /* best effort */ }
    }
  }
}

/**
 * The session id last recorded by writeLastSessionPointer, or null.
 *
 * Validated BY CONTENT, not by existence: the file is parsed and the id is
 * required to be a non-empty string, so a torn pointer reads as absent.
 *
 * It deliberately does NOT check that the referenced session still exists. This
 * function answers "which id was recorded", which is a question about the
 * pointer file alone, resolving the referent needs the sessions directory and
 * the SessionManager's filename rule, and callers that only want the id (a
 * resume prompt deciding whether to offer anything, a diagnostic) would be made
 * to pay for a stat they do not need. The referent check belongs with the
 * caller that dereferences it, which is loadLastConversation below, and that
 * is where the dangling pointer is retired, so the split costs no housekeeping.
 */
export function readLastSessionPointer(options?: SessionPersistenceOptions): string | null {
  try {
    const pointerPath = resolveLastSessionPointerPath(options);
    if (!existsSync(pointerPath)) return null;
    const data = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { sessionId?: unknown };
    if (typeof data.sessionId === 'string' && data.sessionId.trim()) return data.sessionId;
  } catch (error) {
    logger.warn('readLastSessionPointer failed', { error: summarizeError(error) });
  }
  return null;
}

/**
 * Delete a pointer whose session file is gone (retention reclaimed it, the user
 * deleted the session). A one-shot record whose referent no longer exists is
 * dead weight; leaving it means every future load re-resolves the same missing
 * file. Best-effort, and ENOENT is success.
 */
/**
 * The store file the pointer refers to, or null when these options cannot
 * honestly resolve one. Two cases return null: a legacy call that injected its
 * own SessionManager (that manager owns its sessions directory, which need not
 * be the one these options resolve to, second-guessing it would retire a
 * perfectly good pointer), and a legacy call with no workingDirectory at all.
 * A null here means "no referent check", never "referent missing".
 */
function resolveLastSessionStorePathIfKnown(
  sessionId: string,
  options?: SessionPersistenceOptions,
): string | null {
  if (options?.sessionManager) return null;
  try {
    return resolveSessionStorePath(resolveSessionsDirPath(options), sessionId);
  } catch {
    return null;
  }
}

function retireDanglingPointer(sessionId: string, options?: SessionPersistenceOptions): void {
  try {
    const pointerPath = resolveLastSessionPointerPath(options);
    unlinkSync(pointerPath);
    logger.info('retired last-session pointer to a session that no longer exists', { sessionId });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn('could not retire a dangling last-session pointer', { error: summarizeError(error) });
  }
}

export function loadLastConversation(options?: SessionPersistenceOptions): SessionSnapshot | null {
  try {
    const lastId = readLastSessionPointer(options);
    const manager = resolveSessionManager(options);
    if (!lastId) return null;

    // Validate the referent before dereferencing it: a pointer at a session
    // file that no longer exists is retired here rather than being re-resolved
    // on every future load. Only a genuinely ABSENT file retires the pointer,
    // a session that exists but fails to load (unreadable, mid-write) is a
    // transient problem, and deleting the pointer over it would throw away a
    // good pointer to a recoverable session.
    const storePath = resolveLastSessionStorePathIfKnown(lastId, options);
    if (storePath !== null && !existsSync(storePath)) {
      retireDanglingPointer(lastId, options);
      return null;
    }

    const { messages } = manager.load(lastId);
    return { messages: messages as Array<Record<string, unknown>> };
  } catch (error) {
    logger.warn('loadLastConversation failed', { error: summarizeError(error) });
  }
  return null;
}
