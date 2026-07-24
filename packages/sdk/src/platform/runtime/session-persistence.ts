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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import type { SessionMeta } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  resolveLastSessionPointerPath,
  resolveSessionManager,
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
   * Who caused this save. Defaults to `'auto'` — the honest default for every
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

export function writeLastSessionPointer(sessionId: string, options?: SessionPersistenceOptions): void {
  try {
    const pointerPath = resolveLastSessionPointerPath(options);
    mkdirSync(dirname(pointerPath), { recursive: true });
    writeFileSync(
      pointerPath,
      JSON.stringify({ sessionId, timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );
  } catch (error) {
    logger.warn('writeLastSessionPointer failed', { error: summarizeError(error) });
  }
}

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

export function loadLastConversation(options?: SessionPersistenceOptions): SessionSnapshot | null {
  try {
    const lastId = readLastSessionPointer(options);
    const manager = resolveSessionManager(options);
    if (!lastId) return null;

    const { messages } = manager.load(lastId);
    return { messages: messages as Array<Record<string, unknown>> };
  } catch (error) {
    logger.warn('loadLastConversation failed', { error: summarizeError(error) });
  }
  return null;
}
