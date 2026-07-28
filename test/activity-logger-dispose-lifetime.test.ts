/**
 * ActivityLogger.dispose() must actually end the logger's life.
 *
 * Found by counting temp directories, not by reading the code. A tui test
 * process deletes its temp tree at teardown and the tree came back, holding
 * `workspace/.goodvibes/logs/activity.md` — written AFTER the delete. The
 * mechanism is in this file's own doc comment: a flush whose destination has
 * vanished RECREATES it and retries. That behaviour is correct for a live
 * logger whose directory was moved underneath it, and it is what made a
 * disposed one resurrect a directory its owner had just removed.
 *
 * Two distinct holes, both driven below:
 *   - `dispose()` flushed through the recreating path, so disposal itself
 *     could rebuild the destination;
 *   - `dispose()` cleared the timer but left the logger armed — the next
 *     `info()` re-buffered, re-scheduled a flush, and wrote again.
 *
 * The live-recreate behaviour is deliberate and is asserted here too, so a fix
 * that simply stopped recreating would fail this file rather than pass it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActivityLogger } from '../packages/sdk/src/platform/utils/logger.js';

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `activity-dispose-${label}-`));
}

describe('dispose() is final', () => {
  test('disposing a logger whose directory was removed does NOT recreate it', () => {
    const root = scratch('teardown');
    const logDir = join(root, 'logs');
    const logger = new ActivityLogger();
    try {
      logger.configure(logDir);
      logger.info('written while the directory existed');
      logger.flushSync();
      expect(existsSync(join(logDir, 'activity.md'))).toBe(true);

      // What a test teardown does: remove the tree while the logger is alive
      // and holding buffered entries.
      logger.info('buffered, destination now going away');
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(logDir)).toBe(false);

      logger.dispose();

      // The whole point. Before the fix, dispose()'s own flushSync went through
      // the ENOENT-recreate path and rebuilt logDir plus activity.md.
      expect(existsSync(logDir)).toBe(false);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a disposed logger ignores later entries and never rebuilds its destination', () => {
    const root = scratch('after');
    const logDir = join(root, 'logs');
    const logger = new ActivityLogger();
    try {
      logger.configure(logDir);
      logger.flushSync();
      logger.dispose();
      rmSync(root, { recursive: true, force: true });

      // A component that outlives its logger — the case that produced the
      // observed leak.
      logger.info('after dispose');
      logger.warn('after dispose');
      logger.flushSync();

      expect(existsSync(root)).toBe(false);
      expect(logger.isDisposed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dispose() still lands entries buffered while the destination is intact', () => {
    // Disposal must not become a way to LOSE the final lines; that is the
    // failure mode a naive "stop writing on dispose" fix would introduce.
    const root = scratch('flush');
    const logDir = join(root, 'logs');
    const logger = new ActivityLogger();
    try {
      logger.configure(logDir);
      logger.info('final line');
      logger.dispose();
      expect(readFileSync(join(logDir, 'activity.md'), 'utf-8')).toContain('final line');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a LIVE logger keeps the documented recreate behaviour', () => {
  test('a destination removed under a running logger is rebuilt and the write retried', () => {
    // This is the case the recreate path exists for: the directory went away
    // under a process that is still running and still owns it. A fix that
    // removed recreation altogether would fail here.
    const root = scratch('live');
    const logDir = join(root, 'logs');
    const logger = new ActivityLogger();
    try {
      logger.configure(logDir);
      logger.info('first');
      logger.flushSync();
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(logDir)).toBe(false);

      logger.info('after the directory vanished');
      logger.flushSync();

      expect(existsSync(join(logDir, 'activity.md'))).toBe(true);
      expect(readFileSync(join(logDir, 'activity.md'), 'utf-8')).toContain('after the directory vanished');
      expect(logger.isDisposed).toBe(false);
    } finally {
      logger.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
