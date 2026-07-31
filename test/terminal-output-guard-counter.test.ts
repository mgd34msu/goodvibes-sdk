import { describe, expect, test } from 'bun:test';
import { installTuiTerminalOutputGuard } from '@pellux/goodvibes-terminal-shell';

// direct terminal writes that would corrupt a full-screen renderer are
// captured and counted (surfaced by e.g. /debug), NOT pushed as repeated
// transcript lines.
describe('terminal-output guard cumulative counter (onCapture)', () => {
  test('captured writes increment a cumulative counter and are suppressed from the stream', () => {
    const written: string[] = [];
    const fakeStdout = { write: (s: string | Uint8Array) => { written.push(String(s)); return true; } };
    const captures: number[] = [];

    const guard = installTuiTerminalOutputGuard({
      stdout: fakeStdout as never,
      stderr: fakeStdout as never,
      active: true,
      onCapture: (total) => { captures.push(total); },
    });
    try {
      // After install, fakeStdout.write is the guard wrapper: a direct write is
      // intercepted (never reaches the real stream) and bumps the counter.
      (fakeStdout.write as (s: string) => boolean)('rogue direct stdout line\n');
      expect(captures).toEqual([1]);       // counter surfaced via onCapture
      expect(written).toEqual([]);         // suppressed — not written through
    } finally {
      guard.dispose();
    }
  });

  test('a second capture within the 5s rate-limit window does not fire onCapture again', () => {
    const fakeStdout = { write: () => true };
    const captures: number[] = [];

    const guard = installTuiTerminalOutputGuard({
      stdout: fakeStdout as never,
      active: true,
      onCapture: (total) => { captures.push(total); },
    });
    try {
      (fakeStdout.write as (s: string) => boolean)('first\n');
      (fakeStdout.write as (s: string) => boolean)('second, same instant\n');
      // Only the first capture is inside a fresh rate-limit window; both calls
      // happen well within 5s of each other in a synchronous test, so the
      // second capture is suppressed from onCapture — but it is still
      // suppressed from the real stream either way.
      expect(captures).toEqual([1]);
    } finally {
      guard.dispose();
    }
  });
});
