/**
 * terminal-output-guard double-install restore correctness.
 *
 * Verifies that installing a second guard correctly disposes the first so that
 * the restore chain is not corrupted: without this, a second install's
 * "original" write would actually be the first guard's wrapper, and disposing
 * only the second guard would leave the first guard's patch installed forever.
 */
import { describe, expect, test } from 'bun:test';
import {
  installTerminalOutputGuard,
  type TerminalOutputIntercept,
} from '@pellux/goodvibes-terminal-shell';

function makeStream() {
  const writes: string[] = [];
  return {
    writes,
    write: (...args: unknown[]) => {
      writes.push(String(args[0] ?? ''));
      const maybeCallback = args[args.length - 1];
      if (typeof maybeCallback === 'function') {
        (maybeCallback as (err: null) => void)(null);
      }
      return true;
    },
  };
}

describe('terminal output guard — double install', () => {
  test('second install disposes first guard before patching', () => {
    const stdout = makeStream();
    const capturedFirst: TerminalOutputIntercept[] = [];
    const capturedSecond: TerminalOutputIntercept[] = [];

    const guard1 = installTerminalOutputGuard({
      stdout,
      active: true,
      onIntercept: (event) => capturedFirst.push(event),
    });

    // Installing a second guard should silently dispose guard1.
    const guard2 = installTerminalOutputGuard({
      stdout,
      active: true,
      onIntercept: (event) => capturedSecond.push(event),
    });

    try {
      // guard1 should be disposed; writes now route to guard2.
      stdout.write('after second install');
      expect(capturedFirst).toHaveLength(0);
      expect(capturedSecond).toHaveLength(1);
      expect(capturedSecond[0]?.source).toBe('stdout');
    } finally {
      guard2.dispose();
    }
  });

  test('disposing second guard restores original write (not an intermediate patch)', () => {
    const stdout = makeStream();
    const originalWrite = stdout.write;

    const guard1 = installTerminalOutputGuard({ stdout, active: true });
    const guard2 = installTerminalOutputGuard({ stdout, active: true });

    // Dispose guard2 — should fully restore stdout.write to the original.
    guard2.dispose();

    // After disposing guard2, writes should go to the underlying stream.
    stdout.write('restored');
    expect(stdout.writes).toEqual(['restored']);
    // The write method should be the original (guard1 was disposed by guard2's install).
    expect(stdout.write).toBe(originalWrite);
  });
});
