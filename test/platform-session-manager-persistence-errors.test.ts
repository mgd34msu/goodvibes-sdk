import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../packages/sdk/src/platform/sessions/manager.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

type WarningLog = {
  message: string;
  data?: Record<string, unknown> | undefined;
};

describe('SessionManager persistence error observability', () => {
  test('logs orphan temp cleanup failures without aborting construction', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'session-manager-'));
    const stuckTmpPath = join(sessionsDir, '.tmp-stuck');
    const logs: WarningLog[] = [];
    const originalWarn = logger.warn.bind(logger);
    const mutableLogger = logger as unknown as {
      warn(message: string, data?: Record<string, unknown>): void;
    };

    mkdirSync(stuckTmpPath);
    mutableLogger.warn = (message, data) => {
      logs.push({ message, data });
    };

    try {
      expect(() => new SessionManager('/unused', { sessionsDir })).not.toThrow();
    } finally {
      mutableLogger.warn = originalWarn;
      rmSync(sessionsDir, { recursive: true, force: true });
    }

    expect(
      logs.some((entry) =>
        entry.message === 'SessionManager: failed to remove orphan tmp file' &&
        entry.data?.file === stuckTmpPath &&
        typeof entry.data?.error === 'string',
      ),
    ).toBe(true);
  });
});
