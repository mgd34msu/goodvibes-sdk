/**
 * session-persistence-surface.test.ts — the dual API on session-persistence.ts:
 * every function keeps working with the legacy `{ workingDirectory, homeDirectory,
 * surfaceRoot }` options (byte-compatible, but deprecated with a one-time warning),
 * and now also accepts `{ surface: SessionSurface }`, which resolves every path
 * from one declare-once handle instead of re-deriving it per call.
 *
 * Also covers the two new prompted-recovery primitives, `consumeRecovery` and
 * `removeRecoveryPoint` (session-persistence.ts), which are surface-only (no
 * legacy option form — they are new, there is nothing to stay compatible with).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  checkRecoveryFile,
  consumeRecovery,
  readLastSessionPointer,
  removeRecoveryPoint,
  writeLastSessionPointer,
  writeRecoveryFile,
  type SessionPersistenceOptions,
  type SessionSnapshot,
} from '../packages/sdk/src/platform/runtime/session-persistence.ts';
import { createSessionSurface, type SessionSurface } from '../packages/sdk/src/platform/runtime/session-surface.ts';
import { resolveSharedDirectory } from '../packages/sdk/src/platform/runtime/surface-root.ts';
import { logger } from '../packages/sdk/src/platform/utils/logger.ts';

const roots: string[] = [];

function tempSurface(surfaceRoot = 'tui'): { surface: SessionSurface; workingDirectory: string; homeDirectory: string } {
  const base = join(tmpdir(), `gv-surface-persistence-${randomUUID()}`);
  const workingDirectory = join(base, 'work');
  const homeDirectory = join(base, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  roots.push(base);
  return { surface: createSessionSurface({ surfaceRoot, workingDirectory, homeDirectory }), workingDirectory, homeDirectory };
}

function snapshotOf(text: string): SessionSnapshot {
  return { messages: [{ role: 'user', content: text }], timestamp: Date.now() };
}

function withCapturedWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = logger.warn.bind(logger);
  const mutableLogger = logger as unknown as { warn(message: string, data?: Record<string, unknown>): void };
  mutableLogger.warn = (message: string) => {
    warnings.push(message);
  };
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    mutableLogger.warn = original;
  }
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('session-persistence: surface-form pointer round trip', () => {
  test('writeLastSessionPointer and readLastSessionPointer through a surface hit the SAME path', () => {
    const { surface } = tempSurface();
    writeLastSessionPointer('session-abc', { surface });
    expect(existsSync(surface.lastSessionPointer)).toBe(true);
    expect(readLastSessionPointer({ surface })).toBe('session-abc');
  });
});

describe('session-persistence: legacy form stays byte-compatible and warns once', () => {
  test('legacy options form still resolves and round-trips', () => {
    const { workingDirectory, homeDirectory } = tempSurface();
    const options: SessionPersistenceOptions = { workingDirectory, homeDirectory };
    writeLastSessionPointer('legacy-session', options);
    expect(readLastSessionPointer(options)).toBe('legacy-session');
  });

  test('repeated legacy calls emit the migration warning at most once, and never more on repeat calls', () => {
    // Session-persistence.ts's deprecation flag is process-global (module state
    // shared across every test file bun runs in this process), so we cannot
    // assert this is the very FIRST warning the process has ever seen — an
    // earlier-sorted test file may have already tripped it. What we CAN assert,
    // order-independently, is the "once" guarantee itself: firing the legacy
    // path repeatedly never adds more than one occurrence of the migration
    // message, and a second call never adds a second occurrence on top of a
    // first that already happened within this test.
    const { workingDirectory, homeDirectory } = tempSurface();
    const options: SessionPersistenceOptions = { workingDirectory, homeDirectory };
    const isMigrationWarning = (w: string) => w.includes('SessionSurface');

    const first = withCapturedWarnings(() => writeLastSessionPointer('warn-once-a', options));
    const firstCount = first.warnings.filter(isMigrationWarning).length;
    expect(firstCount).toBeLessThanOrEqual(1);

    const second = withCapturedWarnings(() => writeLastSessionPointer('warn-once-b', options));
    const secondCount = second.warnings.filter(isMigrationWarning).length;
    // Once the flag has been tripped (by `first` at the latest), a further
    // legacy call must not emit the migration warning again.
    expect(secondCount).toBe(0);
  });
});

describe('session-persistence: surface and legacy options cannot be mixed (compile-time)', () => {
  test('mixing surface with a legacy scope field is rejected by the type checker', () => {
    const { surface, workingDirectory } = tempSurface();
    // NOTE: bun test does not type-check test files (packages/sdk/tsconfig.json
    // excludes **/*.test.ts, and this repo's `pretest` tsc build only compiles
    // src/**/*.ts — see package.json). So this assertion documents the intended
    // compile-time contract (as the sibling type-tests under test/types/ do for
    // other exported types) but is not currently enforced by any `bun test` or
    // `bun run test` gate; it would only be caught by running `tsc` directly
    // against this file, which the repo does not do today.
    // @ts-expect-error — surface and workingDirectory are mutually exclusive; SessionPersistenceOptions is a discriminated union, not two independently-optional bags.
    const mixed: SessionPersistenceOptions = { surface, workingDirectory };
    // Reference `mixed` so the (deliberately not-typechecked-at-runtime) line
    // above isn't reported as an unused variable if a stricter lint ever runs.
    expect(typeof mixed).toBe('object');
  });
});

describe('session-persistence: consumeRecovery', () => {
  test('deletes the snapshot only after a successful load', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('resume me'), 'sess-consume', 'My Task', { surface });
    expect(existsSync(surface.recoveryFile('sess-consume'))).toBe(true);

    const result = consumeRecovery(surface, 'sess-consume');
    expect(result.consumed).toBe(true);
    expect(result.snapshot?.messages[0]?.content).toBe('resume me');
    // Retired: the snapshot file is gone after a successful consume.
    expect(existsSync(surface.recoveryFile('sess-consume'))).toBe(false);
  });

  test('does not delete anything when there is nothing to load', () => {
    const { surface } = tempSurface();
    const result = consumeRecovery(surface, 'never-existed');
    expect(result.consumed).toBe(false);
    expect(result.snapshot).toBeNull();
  });

  test('does not apply the snapshot to any conversation on its own — it only returns data', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('untouched'), 'sess-passive', '', { surface });
    const result = consumeRecovery(surface, 'sess-passive');
    // The contract: consumeRecovery hands back raw data. There is no side
    // channel, applied conversation, or mutation beyond the snapshot file's
    // own deletion — verified by there being nothing else to observe here
    // besides the returned snapshot and the deleted file (already asserted above).
    expect(Array.isArray(result.snapshot?.messages)).toBe(true);
  });
});

describe('session-persistence: removeRecoveryPoint', () => {
  test('reports removed:true and deletes when a snapshot exists', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('discard me'), 'sess-remove', '', { surface });
    expect(existsSync(surface.recoveryFile('sess-remove'))).toBe(true);

    const result = removeRecoveryPoint(surface, 'sess-remove');
    expect(result.removed).toBe(true);
    expect(existsSync(surface.recoveryFile('sess-remove'))).toBe(false);
  });

  test('is honest when nothing existed to remove', () => {
    const { surface } = tempSurface();
    const result = removeRecoveryPoint(surface, 'never-existed-either');
    expect(result.removed).toBe(false);
  });

  test('without a sessionId, reports honestly whether ANY snapshot existed', () => {
    const { surface } = tempSurface();
    const emptyResult = removeRecoveryPoint(surface);
    expect(emptyResult.removed).toBe(false);

    writeRecoveryFile(snapshotOf('a'), 'sess-a', '', { surface });
    const clearedResult = removeRecoveryPoint(surface);
    expect(clearedResult.removed).toBe(true);
    expect(existsSync(surface.recoveryFile('sess-a'))).toBe(false);
  });

  test('without a sessionId, retires ONLY the offered (newest) snapshot — never every other session\'s', () => {
    // The keyless "no, remove it" answers the ONE snapshot the user was
    // offered. Clearing the whole directory would silently destroy other
    // sessions' crash snapshots that were never shown to anyone.
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('older'), 'sess-old', 'Old', { surface });
    const olderPath = surface.recoveryFile('sess-old');
    const past = new Date(Date.now() - 120_000);
    utimesSync(olderPath, past, past);
    writeRecoveryFile(snapshotOf('newer'), 'sess-new', 'New', { surface });

    const result = removeRecoveryPoint(surface);
    expect(result.removed).toBe(true);
    // The offered (newest) snapshot is gone...
    expect(existsSync(surface.recoveryFile('sess-new'))).toBe(false);
    // ...and the never-offered one survives untouched.
    expect(existsSync(olderPath)).toBe(true);
  });
});

describe('session-persistence: one snapshot in, one snapshot out (never a bulk clear)', () => {
  test('R2: keyless consumeRecovery loads the newest snapshot and deletes ONLY that file', () => {
    // Reproduction: consumeRecovery(surface) with no sessionId loaded the
    // newest snapshot and then called the keyless FULL-RESET delete, wiping
    // every other session's never-loaded snapshot along with it.
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('older'), 'sess-old', 'Old', { surface });
    const olderPath = surface.recoveryFile('sess-old');
    const past = new Date(Date.now() - 120_000);
    utimesSync(olderPath, past, past);
    writeRecoveryFile(snapshotOf('newer'), 'sess-new', 'New', { surface });

    const result = consumeRecovery(surface);
    expect(result.consumed).toBe(true);
    expect(result.snapshot?.messages[0]?.content).toBe('newer');
    // The loaded snapshot is retired...
    expect(existsSync(surface.recoveryFile('sess-new'))).toBe(false);
    // ...and the untouched, never-loaded one is still exactly where it was.
    expect(existsSync(olderPath)).toBe(true);
  });

  test('R1: keyless consumeRecovery of a legacy-shared-only snapshot actually retires it', () => {
    // Reproduction: a snapshot that lives ONLY in the legacy shared dir was
    // loaded and reported consumed:true, but the keyless delete never looked
    // in that directory — so the file survived and was re-offered forever.
    const { surface } = tempSurface();
    const legacyDir = resolveSharedDirectory(surface.homeDirectory, 'recovery');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'recovery-legacy-only.jsonl');
    writeFileSync(
      legacyPath,
      [
        JSON.stringify({ type: 'meta', sessionId: 'legacy-only', title: 'T', timestamp: Date.now() }),
        JSON.stringify({ type: 'message', role: 'user', content: 'legacy body' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const result = consumeRecovery(surface);
    expect(result.consumed).toBe(true);
    expect(result.snapshot?.messages[0]?.content).toBe('legacy body');
    // consumed:true now means what it says — the file is gone, in whichever
    // directory it actually lived.
    expect(existsSync(legacyPath)).toBe(false);
    // A second keyless consume has nothing left to offer.
    expect(consumeRecovery(surface).consumed).toBe(false);
  });

  test('keyless removeRecoveryPoint retires a legacy-shared-only snapshot instead of leaving it forever', () => {
    const { surface } = tempSurface();
    const legacyDir = resolveSharedDirectory(surface.homeDirectory, 'recovery');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'recovery-legacy-decline.jsonl');
    writeFileSync(
      legacyPath,
      [
        JSON.stringify({ type: 'meta', sessionId: 'legacy-decline', title: '', timestamp: Date.now() }),
        JSON.stringify({ type: 'message', role: 'user', content: 'x' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const result = removeRecoveryPoint(surface);
    expect(result.removed).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
  });
});

describe('session-persistence: requireSurface rejects a partial hand-rolled surface', () => {
  test('a surface object missing its recoveryFile method fails with the clear construction message', () => {
    const { surface } = tempSurface();
    // Every string field present, the method missing — the exact shape a
    // hand-rolled "surface-like" object takes. Before the check covered
    // recoveryFile, this passed validation and died later with an opaque
    // "surface.recoveryFile is not a function".
    const partial = { ...surface, recoveryFile: undefined } as unknown as SessionSurface;
    expect(() => removeRecoveryPoint(partial, 'sess-partial')).toThrow(/fully-resolved SessionSurface/);
  });
});

describe('session-persistence: cross-project isolation via surface', () => {
  test('a snapshot written for project A is invisible to a surface for project B', () => {
    const { surface: surfaceA } = tempSurface();
    const { surface: surfaceB } = tempSurface();

    writeRecoveryFile(snapshotOf('project A only'), 'shared-session-id', 'A', { surface: surfaceA });

    expect(existsSync(surfaceA.recoveryFile('shared-session-id'))).toBe(true);
    expect(existsSync(surfaceB.recoveryFile('shared-session-id'))).toBe(false);

    const loadedFromB = consumeRecovery(surfaceB, 'shared-session-id');
    expect(loadedFromB.snapshot).toBeNull();
    expect(loadedFromB.consumed).toBe(false);

    // Untouched in A.
    expect(existsSync(surfaceA.recoveryFile('shared-session-id'))).toBe(true);
  });
});

describe('session-persistence: legacy shared recovery dual-read (one-time offer)', () => {
  function writeLegacySharedRecovery(surface: SessionSurface, sessionId: string, text: string, title: string): string {
    const dir = resolveSharedDirectory(surface.homeDirectory, 'recovery');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `recovery-${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'meta', sessionId, title, timestamp: Date.now() }),
      JSON.stringify({ type: 'message', role: 'user', content: text }),
    ];
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
    return path;
  }

  test('checkRecoveryFile finds a pre-upgrade snapshot that only exists in the legacy shared dir', () => {
    const { surface } = tempSurface();
    writeLegacySharedRecovery(surface, 'pre-upgrade-1', 'from before scoping', 'Old Session');

    const info = checkRecoveryFile({ surface });
    expect(info?.sessionId).toBe('pre-upgrade-1');
    expect(info?.title).toBe('Old Session');
  });

  test('the scoped (canonical) location is preferred when both exist and is newer', () => {
    const { surface } = tempSurface();
    const legacyPath = writeLegacySharedRecovery(surface, 'both-exist', 'legacy content', 'Legacy');
    const past = new Date(Date.now() - 60_000);
    utimesSync(legacyPath, past, past);
    writeRecoveryFile(snapshotOf('canonical content'), 'both-exist', 'Canonical', { surface });

    const info = checkRecoveryFile({ surface });
    expect(info?.sessionId).toBe('both-exist');
    expect(info?.title).toBe('Canonical');
  });

  test('consumeRecovery loads and deletes from the legacy shared dir when that is where the snapshot actually lives', () => {
    const { surface } = tempSurface();
    const legacyPath = writeLegacySharedRecovery(surface, 'legacy-only', 'legacy body', 'Legacy Only');
    expect(existsSync(surface.recoveryFile('legacy-only'))).toBe(false);

    const result = consumeRecovery(surface, 'legacy-only');
    expect(result.consumed).toBe(true);
    expect(result.snapshot?.messages[0]?.content).toBe('legacy body');
    // Retired from the legacy shared location — the one-time offer is spent.
    expect(existsSync(legacyPath)).toBe(false);
  });

  test('removeRecoveryPoint reports removed:true and deletes a legacy-shared-only snapshot', () => {
    const { surface } = tempSurface();
    const legacyPath = writeLegacySharedRecovery(surface, 'legacy-remove', 'body', 'Title');

    const result = removeRecoveryPoint(surface, 'legacy-remove');
    expect(result.removed).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
  });

  test('a bulk (no-sessionId) removeRecoveryPoint never touches the legacy shared dir', () => {
    const { surface } = tempSurface();
    const legacyPath = writeLegacySharedRecovery(surface, 'unrelated-project-session', 'someone else entirely', 'Unrelated');
    writeRecoveryFile(snapshotOf('this project'), 'this-project-session', 'Mine', { surface });

    const result = removeRecoveryPoint(surface);
    expect(result.removed).toBe(true);
    // The scoped snapshot is gone...
    expect(existsSync(surface.recoveryFile('this-project-session'))).toBe(false);
    // ...but the legacy shared file (which could belong to a different
    // project entirely) is left completely alone.
    expect(existsSync(legacyPath)).toBe(true);
  });
});
