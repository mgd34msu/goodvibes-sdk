/**
 * session-surface.test.ts, the declare-once `SessionSurface` handle.
 *
 * Defect class this replaces: session persistence took an optional per-call
 * `surfaceRoot` whose omission silently fell back to a shared, unscoped
 * directory (surface-root.ts `resolveScopedDirectory`), so a writer and a
 * reader that disagreed about `surfaceRoot` (or a caller that forgot it)
 * silently looked in different places instead of erroring. `createSessionSurface`
 * makes `surfaceRoot` mandatory and validated exactly once, and every path a
 * consumer needs is pre-resolved from that single declaration.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createSessionSurface,
  type SessionSurface,
  type SurfaceIdentity,
} from '../packages/sdk/src/platform/runtime/session-surface.ts';

function identity(overrides: Partial<SurfaceIdentity> = {}): SurfaceIdentity {
  return {
    surfaceRoot: 'tui',
    workingDirectory: '/project/work',
    homeDirectory: '/home/user',
    ...overrides,
  };
}

describe('createSessionSurface', () => {
  test('every path derives from one declaration', () => {
    const surface = createSessionSurface(identity());

    expect(surface.surfaceRoot).toBe('tui');
    expect(surface.workingDirectory).toBe('/project/work');
    expect(surface.homeDirectory).toBe('/home/user');
    expect(surface.sessionsDir).toBe(join('/project/work', '.goodvibes', 'tui', 'sessions'));
    expect(surface.agentJournalsDir).toBe(join(surface.sessionsDir, 'agents'));
    expect(surface.lastSessionPointer).toBe(join(surface.sessionsDir, 'last-session.json'));
    expect(surface.recoveryDir).toBe(join('/project/work', '.goodvibes', 'tui', 'recovery'));
    expect(surface.stateDir).toBe(join('/project/work', '.goodvibes', 'tui', 'state'));
    expect(surface.checkpointsDir).toBe(join('/project/work', '.goodvibes', 'tui', 'checkpoints'));
    expect(surface.recoveryFile('abc123')).toBe(join(surface.recoveryDir, 'recovery-abc123.jsonl'));
  });

  test('recoveryDir is anchored to workingDirectory, not homeDirectory', () => {
    const surface = createSessionSurface(
      identity({ workingDirectory: '/project/a', homeDirectory: '/home/shared' }),
    );
    expect(surface.recoveryDir.startsWith('/project/a')).toBe(true);
    expect(surface.recoveryDir.includes('/home/shared')).toBe(false);
  });

  test('two different working directories produce disjoint recovery/session paths for the same surfaceRoot', () => {
    const a = createSessionSurface(identity({ workingDirectory: '/project/a' }));
    const b = createSessionSurface(identity({ workingDirectory: '/project/b' }));
    expect(a.recoveryDir).not.toBe(b.recoveryDir);
    expect(a.sessionsDir).not.toBe(b.sessionsDir);
  });

  test('recoveryFile sanitizes the session id into a safe filename segment', () => {
    const surface = createSessionSurface(identity());
    const path = surface.recoveryFile('has/slash');
    expect(path.startsWith(join(surface.recoveryDir, 'recovery-has_slash-'))).toBe(true);
    expect(path.endsWith('.jsonl')).toBe(true);
    // No separator survives into the filename, that is the whole point.
    expect(path.slice(surface.recoveryDir.length + 1).includes('/')).toBe(false);
  });

  test('machine-minted session ids pass through sanitization byte-for-byte (no filename moves)', () => {
    const surface = createSessionSurface(identity());
    // generateUserSessionId(): randomBytes(4).toString('hex'), 8 lowercase hex.
    expect(surface.recoveryFile('a1b2c3d4')).toBe(join(surface.recoveryDir, 'recovery-a1b2c3d4.jsonl'));
    // Agent ids: `agent-<8 hex>`.
    expect(surface.recoveryFile('agent-deadbeef')).toBe(join(surface.recoveryDir, 'recovery-agent-deadbeef.jsonl'));
    // Anything already a safe segment is untouched, dots and all.
    expect(surface.recoveryFile('sess.1_v2-x')).toBe(join(surface.recoveryDir, 'recovery-sess.1_v2-x.jsonl'));
  });

  test('two ids that flatten to the same characters still get different files', () => {
    const surface = createSessionSurface(identity());
    // `a/b` and `a_b` both replace to `a_b`: without a discriminator these two
    // sessions would share one snapshot file and silently overwrite each other.
    const fromSlash = surface.recoveryFile('a/b');
    const fromUnderscore = surface.recoveryFile('a_b');
    expect(fromSlash).not.toBe(fromUnderscore);
    // ...and each id is stable across calls (the discriminator is a digest of
    // the raw id, not a random value).
    expect(surface.recoveryFile('a/b')).toBe(fromSlash);
  });

  test('omitted surfaceRoot throws', () => {
    expect(() => createSessionSurface({ ...identity(), surfaceRoot: undefined as unknown as string })).toThrow();
  });

  test('empty surfaceRoot throws', () => {
    expect(() => createSessionSurface(identity({ surfaceRoot: '   ' }))).toThrow();
  });

  test('multi-segment surfaceRoot throws', () => {
    expect(() => createSessionSurface(identity({ surfaceRoot: 'tui/nested' }))).toThrow();
    expect(() => createSessionSurface(identity({ surfaceRoot: 'tui\\nested' }))).toThrow();
  });

  test('"." and ".." surfaceRoot throw', () => {
    expect(() => createSessionSurface(identity({ surfaceRoot: '.' }))).toThrow();
    expect(() => createSessionSurface(identity({ surfaceRoot: '..' }))).toThrow();
  });

  test('empty workingDirectory throws', () => {
    expect(() => createSessionSurface(identity({ workingDirectory: '' }))).toThrow();
    expect(() => createSessionSurface(identity({ workingDirectory: '   ' }))).toThrow();
  });

  test('empty homeDirectory throws', () => {
    expect(() => createSessionSurface(identity({ homeDirectory: '' }))).toThrow();
  });

  test('the returned handle is a plain value usable across the module boundary', () => {
    const surface: SessionSurface = createSessionSurface(identity());
    // Every field is a string (or a callable), never undefined, no optional
    // scope argument was left to silently resolve later.
    expect(typeof surface.sessionsDir).toBe('string');
    expect(typeof surface.recoveryDir).toBe('string');
    expect(typeof surface.recoveryFile).toBe('function');
  });
});
