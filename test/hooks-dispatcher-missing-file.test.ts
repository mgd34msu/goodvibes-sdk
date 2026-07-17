import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { HookDispatcher } from '../packages/sdk/src/platform/hooks/dispatcher.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

/**
 * Missing hooks.json is the normal state for most installs — loadFromFile
 * must skip quietly instead of emitting a WARN (permission probe) + ERROR
 * (read failure) pair on every startup.
 */
describe('HookDispatcher.loadFromFile with no hooks file', () => {
  const originalWarn = logger.warn.bind(logger);
  const originalError = logger.error.bind(logger);

  afterEach(() => {
    logger.warn = originalWarn;
    logger.error = originalError;
  });

  test('absent file: no warn/error logged, nothing registered', () => {
    const calls: string[] = [];
    logger.warn = ((message: string) => { calls.push(`warn:${message}`); }) as typeof logger.warn;
    logger.error = ((message: string) => { calls.push(`error:${message}`); }) as typeof logger.error;

    const dispatcher = new HookDispatcher();
    dispatcher.loadFromFile(join(tmpdir(), 'goodvibes-test-does-not-exist', 'hooks.json'));

    expect(calls).toEqual([]);
  });

  test('present file still loads hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodvibes-hooks-'));
    try {
      const path = join(dir, 'hooks.json');
      writeFileSync(path, JSON.stringify({
        hooks: { 'tool.pre': [{ type: 'command', match: '*', command: 'echo ok' }] },
      }));
      const errors: string[] = [];
      logger.error = ((message: string) => { errors.push(message); }) as typeof logger.error;

      const dispatcher = new HookDispatcher();
      dispatcher.loadFromFile(path);

      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
