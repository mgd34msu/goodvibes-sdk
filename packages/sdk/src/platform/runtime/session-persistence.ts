import { randomBytes } from 'crypto';
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

import { SessionManager, type SessionMeta } from '../sessions/manager.js';
import { logger } from '../utils/logger.js';
import type { SessionReturnContextSummary } from './session-return-context.js';
import type { ConversationTitleSource } from '../core/conversation.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveScopedDirectory } from './surface-root.js';

export type SessionSnapshot = {
  messages: Array<Record<string, unknown>>;
  timestamp?: number | undefined;
  title?: string | undefined;
  titleSource?: ConversationTitleSource | undefined;
  returnContext?: SessionReturnContextSummary | undefined;
};

export type RecoveryFileInfo = {
  title: string;
  timestamp: number;
  sessionId: string;
  returnContext?: SessionReturnContextSummary | undefined;
};

export type SessionPersistenceOptions = {
  workingDirectory?: string | undefined;
  homeDirectory?: string | undefined;
  sessionManager?: SessionManager | undefined;
  surfaceRoot?: string | undefined;
};

export type SessionPersistencePaths = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

function requireWorkingDirectory(options?: Pick<SessionPersistenceOptions, 'workingDirectory'>): string {
  const workingDirectory = options?.workingDirectory;
  if (!workingDirectory) {
    throw new Error('Session persistence requires an explicit workingDirectory.');
  }
  return workingDirectory;
}

function requireHomeDirectory(options?: Pick<SessionPersistenceOptions, 'homeDirectory'>): string {
  const homeDirectory = options?.homeDirectory;
  if (!homeDirectory) {
    throw new Error('Session persistence requires an explicit homeDirectory.');
  }
  return homeDirectory;
}

function resolveSessionPersistencePaths(options: SessionPersistenceOptions): SessionPersistencePaths {
  return {
    workingDirectory: requireWorkingDirectory(options),
    homeDirectory: requireHomeDirectory(options),
  };
}

function resolveSessionManager(options?: SessionPersistenceOptions): SessionManager {
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
const RECOVERY_FILE_PREFIX = 'recovery-';
const RECOVERY_FILE_SUFFIX = '.jsonl';

/**
 * Directory holding per-session crash-recovery snapshots
 * (`<scope>/recovery/recovery-<sessionId>.jsonl`). Each concurrent session
 * owns its own file, so two sessions crashing (or snapshotting) at once never
 * clobber a single shared recovery file.
 */
export function getRecoveryDir(homeDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(homeDirectory, surfaceRoot, 'recovery');
}

/** Restrict a session id to a safe single filename segment (no path traversal). */
function sanitizeRecoverySessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error('Session persistence requires a non-empty recovery session id.');
  }
  return safe;
}

/**
 * The recovery snapshot path for a specific session:
 * `<scope>/recovery/recovery-<sessionId>.jsonl`.
 */
export function getRecoveryFilePath(homeDirectory: string, sessionId: string, surfaceRoot?: string): string {
  const safe = sanitizeRecoverySessionId(sessionId);
  return join(getRecoveryDir(homeDirectory, surfaceRoot), `${RECOVERY_FILE_PREFIX}${safe}${RECOVERY_FILE_SUFFIX}`);
}

/** All per-session recovery files currently on disk, newest-first by mtime. */
function listRecoveryFiles(homeDirectory: string, surfaceRoot?: string): Array<{ path: string; mtimeMs: number }> {
  const dir = getRecoveryDir(homeDirectory, surfaceRoot);
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
): void {
  const manager = resolveSessionManager(options);
  const meta: SessionMeta = {
    title,
    model,
    provider,
    timestamp: data.timestamp ?? Date.now(),
    titleSource: data.titleSource,
    returnContext: data.returnContext,
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
): void {
  saveSession(sessionId, data, model, provider, title, options);
  writeLastSessionPointer(sessionId, options);
}

export function writeLastSessionPointer(sessionId: string, options?: SessionPersistenceOptions): void {
  try {
    const workingDirectory = requireWorkingDirectory(options);
    const pointerPath = getLastSessionPointerPath(workingDirectory, options?.surfaceRoot);
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
    const workingDirectory = requireWorkingDirectory(options);
    const pointerPath = getLastSessionPointerPath(workingDirectory, options?.surfaceRoot);
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

export function writeRecoveryFile(
  snapshot: SessionSnapshot,
  sessionId: string,
  title = '',
  options?: SessionPersistenceOptions,
): void {
  try {
    if (!snapshot.messages.length) return;
    const homeDirectory = requireHomeDirectory(options);
    const recoveryFile = getRecoveryFilePath(homeDirectory, sessionId, options?.surfaceRoot);
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
 * session's file is removed; without one, every recovery snapshot in the scope
 * is cleared (the full-reset path). A missing file is fine.
 */
export function deleteRecoveryFile(options?: SessionPersistenceOptions, sessionId?: string): void {
  try {
    const homeDirectory = requireHomeDirectory(options);
    if (sessionId) {
      try {
        unlinkSync(getRecoveryFilePath(homeDirectory, sessionId, options?.surfaceRoot));
      } catch {
        // missing file is fine
      }
      return;
    }
    for (const entry of listRecoveryFiles(homeDirectory, options?.surfaceRoot)) {
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
 * The newest crash-recovery snapshot across all per-session files that is
 * genuinely newer than the last clean session save (older-or-equal snapshots
 * were superseded by a clean save and are not a crash). Returns null when no
 * live crash snapshot exists.
 */
export function checkRecoveryFile(options?: SessionPersistenceOptions): RecoveryFileInfo | null {
  try {
    const { workingDirectory, homeDirectory } = resolveSessionPersistencePaths({
      workingDirectory: requireWorkingDirectory(options),
      homeDirectory: requireHomeDirectory(options),
    });
    const pointerPath = getLastSessionPointerPath(workingDirectory, options?.surfaceRoot);
    const lastCleanMtime = existsSync(pointerPath) ? statSync(pointerPath).mtimeMs : 0;
    for (const entry of listRecoveryFiles(homeDirectory, options?.surfaceRoot)) {
      // listRecoveryFiles is newest-first; the first snapshot strictly newer
      // than the last clean save is the one to offer.
      if (entry.mtimeMs <= lastCleanMtime) continue;
      try {
        return readRecoveryMeta(entry.path);
      } catch {
        // Unreadable/partial snapshot — skip to the next candidate.
      }
    }
    return null;
  } catch (error) {
    logger.warn('[Recovery] Check failed', { error: summarizeError(error) });
    return null;
  }
}

/**
 * Load a recovery snapshot's conversation. With an explicit `sessionId` the
 * matching per-session file is loaded; without one, the newest crash snapshot
 * (the same one checkRecoveryFile offers) is loaded.
 */
export function loadRecoveryConversation(options?: SessionPersistenceOptions, sessionId?: string): SessionSnapshot | null {
  try {
    const homeDirectory = requireHomeDirectory(options);
    const recoveryFile = sessionId
      ? getRecoveryFilePath(homeDirectory, sessionId, options?.surfaceRoot)
      : listRecoveryFiles(homeDirectory, options?.surfaceRoot)[0]?.path;
    if (!recoveryFile) return null;
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
 * Silent crash-recovery restore. When a live crash snapshot exists (newer than
 * the last clean save), its conversation is loaded and returned WITHOUT a
 * prompt, its snapshot file is cleared, and a single one-line receipt is
 * enqueued into the receipts sink (exactly once per snapshot session) so the
 * restore surfaces as a receipt rather than an interruption. Returns null when
 * there is nothing to restore.
 *
 * This is the SDK-side replacement for the old restore-and-collide dance: with
 * per-session snapshot files there is no shared recovery file to guard, so the
 * consuming surface's collision-preservation workaround is no longer needed.
 */
export function autoRestoreRecovery(
  options?: SessionPersistenceOptions,
  receipts?: RecoveryReceiptSink,
): RecoveryRestoreResult | null {
  const info = checkRecoveryFile(options);
  if (!info) return null;
  const snapshot = loadRecoveryConversation(options, info.sessionId || undefined);
  if (!snapshot || snapshot.messages.length === 0) return null;
  const receipt = recoveryReceiptText(info, snapshot.messages.length);
  if (receipts) {
    try {
      receipts.record(`session-recovery-restored:${info.sessionId}`, receipt);
    } catch (error) {
      logger.warn('[Recovery] receipt enqueue failed', { error: summarizeError(error) });
    }
  }
  // The snapshot has served its purpose — clear it so it is not re-offered.
  deleteRecoveryFile(options, info.sessionId || undefined);
  return { snapshot, info, receipt };
}
