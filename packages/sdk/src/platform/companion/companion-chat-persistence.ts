/**
 * companion-chat-persistence.ts
 *
 * Disk-backed session store for CompanionChatManager.
 *
 * Design:
 * - Sessions and their messages are stored as individual JSON files under
 *   `<sessionsDir>/<sessionId>.json` using atomic tmp-file + rename writes.
 * - The store is loaded eagerly at construction time (async init()) and
 *   thereafter kept in sync with every createSession / updateSession /
 *   appendMessage / closeSession mutation.
 * - Default storage root: ~/.goodvibes/companion-chat/sessions/
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CompanionChatMessage, CompanionChatSession } from './companion-chat-types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// On-disk shape
// ---------------------------------------------------------------------------

export interface PersistedChatSession {
  readonly meta: CompanionChatSession;
  readonly messages: CompanionChatMessage[];
}

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

export function defaultSessionsDir(): string {
  return join(homedir(), '.goodvibes', 'companion-chat', 'sessions');
}

// ---------------------------------------------------------------------------
// CompanionChatPersistence
// ---------------------------------------------------------------------------

export class CompanionChatPersistence {
  private readonly sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? defaultSessionsDir();
  }

  /** Ensure the sessions directory exists. */
  private ensureDir(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  /** Load all persisted sessions from disk. Returns an empty array on directory failure. */
  async loadAll(): Promise<PersistedChatSession[]> {
    const results: PersistedChatSession[] = [];
    let entries: string[];

    try {
      this.ensureDir();
      entries = readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      logger.warn('CompanionChatPersistence: failed to read sessions directory', {
        dir: this.sessionsDir,
        error: summarizeError(err),
      });
      return results;
    }

    await Promise.all(
      entries.map(async (filename) => {
        const filePath = join(this.sessionsDir, filename);
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(raw) as unknown;
          if (isPersistedChatSession(parsed)) {
            results.push(parsed);
          }
        } catch (err) {
          logger.warn('CompanionChatPersistence: failed to load session', {
            file: filePath,
            error: summarizeError(err),
          });
        }
      }),
    );

    return results;
  }

  /** Atomically persist a single session to disk. Rejects when the write fails. */
  async save(session: PersistedChatSession): Promise<void> {
    const filePath = this.filePath(session.meta.id);
    const tmpPath = `${filePath}.tmp`;

    try {
      this.ensureDir();
      mkdirSync(dirname(filePath), { recursive: true });
      const content = JSON.stringify(session, null, 2) + '\n';
      await fs.writeFile(tmpPath, content, 'utf-8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      if (existsSync(tmpPath)) {
        try {
          await fs.unlink(tmpPath);
        } catch (cleanupErr) {
          logger.warn('CompanionChatPersistence: failed to remove save tmp file', {
            sessionId: session.meta.id,
            tmpPath,
            error: summarizeError(cleanupErr),
          });
        }
      }
      throw new Error(`Companion chat session save failed for ${session.meta.id}: ${summarizeError(err)}`);
    }
  }

  /** Delete a session file from disk (called when a closed session is GC'd). Rejects on unlink failure. */
  async delete(sessionId: string): Promise<void> {
    const filePath = this.filePath(sessionId);

    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (isNodeErrorCode(err, 'ENOENT')) return;
      throw new Error(`Companion chat session delete failed for ${sessionId}: ${summarizeError(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isPersistedChatSession(value: unknown): value is PersistedChatSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['meta'] === 'object' &&
    v['meta'] !== null &&
    typeof (v['meta'] as Record<string, unknown>)['id'] === 'string' &&
    Array.isArray(v['messages'])
  );
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === code
  );
}
