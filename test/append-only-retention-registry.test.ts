/**
 * append-only-retention-registry.test.ts — every append-only store the platform
 * writes has a registered retention owner, and a start-time janitor sweeps them.
 *
 * Defect class: an append-only file that no one prunes grows without bound (the
 * observed 22.8 MB activity.md). Now every append-only store registers here with
 * an owner + policy, a start-time sweep owns every registered path, and a
 * membership check fails LOUDLY on an unregistered id — the same fail-closed
 * discipline as the feature-gate-id and model-source checks.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  APPEND_ONLY_STORES,
  assertAppendOnlyStoreRegistered,
  isAppendOnlyStoreRegistered,
  runAppendOnlyRetentionSweep,
  runStartupAppendOnlySweep,
  type AppendOnlyStoreId,
} from '../packages/sdk/src/platform/runtime/retention/append-only-registry.ts';
import { resolveScopedDirectory } from '../packages/sdk/src/platform/runtime/surface-root.ts';

// The append-only stores the platform writes. A new append-only writer must be
// added here AND registered in APPEND_ONLY_STORES — this list is the honest
// enumeration the membership check is measured against.
const KNOWN_APPEND_ONLY_STORES: readonly AppendOnlyStoreId[] = [
  'session-journals',
  'activity-log',
  'telemetry-local-ledger',
  'session-recovery-snapshots',
];

const dirs: string[] = [];
function tempDir(): string {
  const dir = join(tmpdir(), `gv-aoretention-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('append-only store registry membership (fails loudly)', () => {
  test('RED: an unregistered append-only store id fails the membership check', () => {
    expect(() => assertAppendOnlyStoreRegistered('seeded-unknown-store', 'test composition'))
      .toThrow(/unknown append-only store id "seeded-unknown-store".*APPEND_ONLY_STORES/s);
    expect(isAppendOnlyStoreRegistered('seeded-unknown-store')).toBe(false);
  });

  test('every known append-only store is registered with an owner and a policy', () => {
    for (const id of KNOWN_APPEND_ONLY_STORES) {
      expect(() => assertAppendOnlyStoreRegistered(id, 'test')).not.toThrow();
      const descriptor = APPEND_ONLY_STORES.find((store) => store.id === id);
      expect(descriptor, `store "${id}" has no descriptor`).toBeDefined();
      expect(descriptor!.owner.length).toBeGreaterThan(0);
      expect(descriptor!.policy.retention.maxTotalBytes).toBeGreaterThan(0);
    }
  });

  test('the registry contains exactly the known stores (no unregistered, no phantom)', () => {
    const registeredIds = APPEND_ONLY_STORES.map((store) => store.id).sort();
    expect(registeredIds).toEqual([...KNOWN_APPEND_ONLY_STORES].sort());
  });
});

describe('start-time retention sweep', () => {
  test('reclaims an over-budget append-only journal file', () => {
    const workingDirectory = tempDir();
    const surfaceRoot = 'tui';
    const sessionsDir = resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    // Seed two agent journals well past a tiny total-size budget.
    const older = join(sessionsDir, 'agent-old.jsonl');
    const newer = join(sessionsDir, 'agent-new.jsonl');
    writeFileSync(older, 'x'.repeat(200_000), 'utf-8');
    writeFileSync(newer, 'y'.repeat(200_000), 'utf-8');
    // Make the older file genuinely older so it is reclaimed first.
    const past = Date.now() / 1000 - 3600;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.utimesSync(older, past, past);

    const outcome = runAppendOnlyRetentionSweep(
      { workingDirectory, surfaceRoot },
      { policyOverride: { redact: true, retention: { maxAgeMs: 365 * 24 * 3600 * 1000, maxTotalBytes: 250_000 } } },
    );

    expect(outcome.sweptStores).toContain('session-journals');
    expect(outcome.deletedFiles).toBeGreaterThanOrEqual(1);
    // The older journal is gone; total now fits the budget.
    expect(() => statSync(older)).toThrow();
    expect(statSync(newer).size).toBe(200_000);
  });

  test('the full production roots sweep every registered store — none silently skipped', () => {
    const workingDirectory = tempDir();
    const homeDirectory = tempDir();
    const surfaceRoot = 'tui';
    // Materialize each store's target so the sweep genuinely visits it.
    mkdirSync(resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions'), { recursive: true });
    const logDir = join(homeDirectory, 'logs');
    const telemetryDir = join(homeDirectory, 'telemetry');
    const recoveryDir = resolveScopedDirectory(homeDirectory, surfaceRoot, 'recovery');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(telemetryDir, { recursive: true });
    mkdirSync(recoveryDir, { recursive: true });
    writeFileSync(join(logDir, 'activity.md'), 'log line\n', 'utf-8');
    writeFileSync(join(telemetryDir, 'spans.jsonl'), '{}\n', 'utf-8');
    writeFileSync(join(recoveryDir, 'recovery-s1.jsonl'), '{}\n', 'utf-8');

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot, homeDirectory, logDir, telemetryDir });
    // Every registered store swept; the roots omission class (a registered
    // entry that never runs in production) is what this pins down.
    expect([...outcome.sweptStores].sort()).toEqual([...KNOWN_APPEND_ONLY_STORES].sort());
    expect(outcome.skippedStores).toEqual([]);
  });

  test('a stale never-restored recovery snapshot is reclaimed by the sweep', () => {
    const homeDirectory = tempDir();
    const surfaceRoot = 'tui';
    const recoveryDir = resolveScopedDirectory(homeDirectory, surfaceRoot, 'recovery');
    mkdirSync(recoveryDir, { recursive: true });
    const stale = join(recoveryDir, 'recovery-dead-session.jsonl');
    writeFileSync(stale, 'x'.repeat(1000), 'utf-8');
    const past = Date.now() / 1000 - 90 * 24 * 3600;
    (require('node:fs') as typeof import('node:fs')).utimesSync(stale, past, past);

    const outcome = runAppendOnlyRetentionSweep(
      { homeDirectory, surfaceRoot },
      { policyOverride: { redact: true, retention: { maxAgeMs: 30 * 24 * 3600 * 1000, maxTotalBytes: 10_000_000 } } },
    );
    expect(outcome.sweptStores).toContain('session-recovery-snapshots');
    expect(() => statSync(stale)).toThrow();
  });

  test('stores whose roots are absent are skipped, not errors', () => {
    const outcome = runAppendOnlyRetentionSweep({ workingDirectory: undefined });
    // With no roots at all, every store is skipped and nothing throws.
    expect(outcome.skippedStores.length).toBe(APPEND_ONLY_STORES.length);
    expect(outcome.sweptStores.length).toBe(0);
  });

  test('runStartupAppendOnlySweep never throws and returns an outcome', () => {
    const workingDirectory = tempDir();
    const result = runStartupAppendOnlySweep({ workingDirectory, surfaceRoot: 'tui' }, () => undefined);
    expect(result).not.toBeNull();
    expect(result!.sweptStores).toContain('session-journals');
  });
});
