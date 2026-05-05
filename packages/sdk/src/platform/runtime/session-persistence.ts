import { randomBytes } from 'crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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

export function getRecoveryFilePath(homeDirectory: string, surfaceRoot?: string): string {
  return resolveScopedDirectory(homeDirectory, surfaceRoot, 'recovery.jsonl');
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
    const recoveryFile = getRecoveryFilePath(homeDirectory, options?.surfaceRoot);
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

export function deleteRecoveryFile(options?: SessionPersistenceOptions): void {
  try {
    const homeDirectory = requireHomeDirectory(options);
    unlinkSync(getRecoveryFilePath(homeDirectory, options?.surfaceRoot));
  } catch {
    // missing file is fine
  }
}

export function checkRecoveryFile(options?: SessionPersistenceOptions): RecoveryFileInfo | null {
  try {
    const { workingDirectory, homeDirectory } = resolveSessionPersistencePaths({
      workingDirectory: requireWorkingDirectory(options),
      homeDirectory: requireHomeDirectory(options),
    });
    const recoveryFile = getRecoveryFilePath(homeDirectory, options?.surfaceRoot);
    if (!existsSync(recoveryFile)) return null;
    const recoveryMtime = statSync(recoveryFile).mtimeMs;
    const pointerPath = getLastSessionPointerPath(workingDirectory, options?.surfaceRoot);
    if (existsSync(pointerPath)) {
      const lastCleanMtime = statSync(pointerPath).mtimeMs;
      if (recoveryMtime <= lastCleanMtime) return null;
    }
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
  } catch (error) {
    logger.warn('[Recovery] Check failed', { error: summarizeError(error) });
    return null;
  }
}

export function loadRecoveryConversation(options?: SessionPersistenceOptions): SessionSnapshot | null {
  try {
    const homeDirectory = requireHomeDirectory(options);
    const recoveryFile = getRecoveryFilePath(homeDirectory, options?.surfaceRoot);
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
