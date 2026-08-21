import { describe, expect, test } from 'bun:test';
import { installFullScreenTerminalOutputGuard } from '@pellux/goodvibes-terminal-shell';

/**
 * The `notify` contract: a formatted, human-readable notice naming how many
 * direct writes were captured since the last notice (not the session
 * cumulative total, that is what `onCapture` is for) and the most recent
 * write's preview.
 */
describe('terminal-output guard formatted notice (notify)', () => {
  test('a captured write produces one formatted notice naming the count and a preview', () => {
    const fakeStdout = { write: () => true };
    const notices: string[] = [];

    const guard = installFullScreenTerminalOutputGuard({
      stdout: fakeStdout as never,
      active: true,
      notify: (message) => { notices.push(message); },
    });
    try {
      (fakeStdout.write as (s: string) => boolean)('rogue direct stdout line');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('Captured 1 direct stdout write');
      expect(notices[0]).toContain('rogue direct stdout line');
      expect(notices[0]).not.toContain('writes'); // singular for count 1
    } finally {
      guard.dispose();
    }
  });

  test('a second capture within the 5s rate-limit window does not fire notify again', () => {
    const fakeStdout = { write: () => true };
    const notices: string[] = [];

    const guard = installFullScreenTerminalOutputGuard({
      stdout: fakeStdout as never,
      active: true,
      notify: (message) => { notices.push(message); },
    });
    try {
      (fakeStdout.write as (s: string) => boolean)('first');
      (fakeStdout.write as (s: string) => boolean)('second, same instant');
      // Both writes land inside one rate-limit window, so only one notice
      // fires, but the write itself is suppressed from the real stream
      // regardless of whether a notice fires.
      expect(notices).toHaveLength(1);
    } finally {
      guard.dispose();
    }
  });

  test('onCapture and notify are independent: a caller may use either, or neither', () => {
    const fakeStdout = { write: () => true };
    const captures: number[] = [];

    // Only onCapture wired, notify absent entirely, so it must never be an
    // error for it to be missing, and no notice-shaped side effect occurs.
    const guard = installFullScreenTerminalOutputGuard({
      stdout: fakeStdout as never,
      active: true,
      onCapture: (total) => { captures.push(total); },
    });
    try {
      (fakeStdout.write as (s: string) => boolean)('captured');
      expect(captures).toEqual([1]);
    } finally {
      guard.dispose();
    }
  });
});
