/**
 *
 * Desktop-notification test-isolation guard.
 *
 * notifyCompletion() writes an in-process terminal bell byte AND shells out to
 * notify-send/osascript. Under an automated test run the real desktop shell-out
 * must never fire — otherwise every `bun test` invocation spams whoever's
 * desktop the tests happen to execute on. The terminal bell, by contrast, is a
 * single \x07 byte written to this process's own stdout with no external side
 * effect, and is asserted product behaviour by host surfaces (e.g. the TUI), so
 * it is emitted even under suppression. Verifies:
 * - Desktop shell-out suppressed by default under NODE_ENV=test (bun test's own
 *   default), while the terminal bell still writes.
 * - Desktop shell-out suppressed when GOODVIBES_SUPPRESS_NOTIFY is set,
 *   regardless of NODE_ENV, while the terminal bell still writes.
 * - The `{ force: true }` opt-in bypasses suppression and reaches the shell-out
 *   layer (for tests that exercise it directly).
 * - Normal runtime (NODE_ENV unset/production, no override) is unaffected —
 *   the real code path still fires.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { notifyCompletion, isNotifySuppressed } from '../packages/sdk/src/platform/utils/notify.ts';

/** A Bun.spawn-shaped fake that resolves immediately with no output. */
function fakeSpawnResult(): ReturnType<typeof Bun.spawn> {
  return {
    exited: Promise.resolve(0),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe('isNotifySuppressed', () => {
  let origNodeEnv: string | undefined;
  let origOverride: string | undefined;

  beforeEach(() => {
    origNodeEnv = process.env['NODE_ENV'];
    origOverride = process.env['GOODVIBES_SUPPRESS_NOTIFY'];
  });

  afterEach(() => {
    process.env['NODE_ENV'] = origNodeEnv;
    if (origOverride === undefined) {
      delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    } else {
      process.env['GOODVIBES_SUPPRESS_NOTIFY'] = origOverride;
    }
  });

  test('suppressed under NODE_ENV=test (the default bun test sets)', () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    expect(isNotifySuppressed()).toBe(true);
  });

  test('suppressed when GOODVIBES_SUPPRESS_NOTIFY is set, even outside NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['GOODVIBES_SUPPRESS_NOTIFY'] = '1';
    expect(isNotifySuppressed()).toBe(true);
  });

  test('GOODVIBES_SUPPRESS_NOTIFY=0 and GOODVIBES_SUPPRESS_NOTIFY=false do not force suppression', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['GOODVIBES_SUPPRESS_NOTIFY'] = '0';
    expect(isNotifySuppressed()).toBe(false);
    process.env['GOODVIBES_SUPPRESS_NOTIFY'] = 'false';
    expect(isNotifySuppressed()).toBe(false);
  });

  test('force:true bypasses suppression even under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['GOODVIBES_SUPPRESS_NOTIFY'] = '1';
    expect(isNotifySuppressed(true)).toBe(false);
  });

  test('normal runtime (NODE_ENV unset, no override) is not suppressed', () => {
    delete process.env['NODE_ENV'];
    delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    expect(isNotifySuppressed()).toBe(false);
  });

  test('normal runtime (NODE_ENV=production, no override) is not suppressed', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    expect(isNotifySuppressed()).toBe(false);
  });
});

describe('notifyCompletion suppression', () => {
  let origNodeEnv: string | undefined;
  let origOverride: string | undefined;
  let spawnSpy: Mock<typeof Bun.spawn>;
  let writeSpy: Mock<typeof process.stdout.write>;

  beforeEach(() => {
    origNodeEnv = process.env['NODE_ENV'];
    origOverride = process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => fakeSpawnResult()) as Mock<typeof Bun.spawn>;
    writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true) as Mock<typeof process.stdout.write>;
  });

  afterEach(() => {
    process.env['NODE_ENV'] = origNodeEnv;
    if (origOverride === undefined) {
      delete process.env['GOODVIBES_SUPPRESS_NOTIFY'];
    } else {
      process.env['GOODVIBES_SUPPRESS_NOTIFY'] = origOverride;
    }
    spawnSpy.mockRestore();
    writeSpy.mockRestore();
  });

  test('default test run: terminal bell still writes, desktop-notification shell-out suppressed', () => {
    process.env['NODE_ENV'] = 'test';
    notifyCompletion('GoodVibes', 'turn completed in 65s · session test-ses', 65_000);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('\x07');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test('GOODVIBES_SUPPRESS_NOTIFY override: terminal bell still writes, desktop shell-out suppressed', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['GOODVIBES_SUPPRESS_NOTIFY'] = '1';
    notifyCompletion('GoodVibes', 'agent agent-12 failed: boom', 65_000);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('\x07');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test('suppressed run, short duration: no bell (below the 5s threshold), no shell-out', () => {
    process.env['NODE_ENV'] = 'test';
    notifyCompletion('GoodVibes', 'quick turn', 4_000);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test('force:true opts back in under NODE_ENV=test — shell-out layer itself is reachable', () => {
    process.env['NODE_ENV'] = 'test';
    notifyCompletion('GoodVibes', 'shell-out layer test', 65_000, { force: true });
    if (process.platform === 'linux' || process.platform === 'darwin') {
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    }
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test('normal runtime (NODE_ENV unset) fires the real code path', () => {
    delete process.env['NODE_ENV'];
    notifyCompletion('GoodVibes', 'session cost $30.00 exceeded budget $1.00 · session test-ses', 65_000);
    if (process.platform === 'linux' || process.platform === 'darwin') {
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    }
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test('short duration under normal runtime: bell fires, desktop notification does not (below thresholds)', () => {
    delete process.env['NODE_ENV'];
    notifyCompletion('GoodVibes', 'WRFC chain chain-abcdef cancelled', 6_000);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
