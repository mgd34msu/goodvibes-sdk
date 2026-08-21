/**
 * watcher-recovery-window.test.ts
 *
 * `watchers.recoveryWindowMinutes`, "Recovery window for watcher restart and
 * missed-event catch-up", had a schema row, a 0…1440 range, a default of 10,
 * and no reader anywhere in the repository.
 *
 * What it now governs is the restore path in `WatcherRegistry.ensureLoaded()`.
 * A watcher that was running when the process stopped is re-armed on its
 * interval, but re-arming alone means it does nothing until the first tick, on
 * a long poller, a restart cost that much extra blindness on top of the outage.
 * `startWatcher` has always run once immediately for the same reason; the
 * restore path did not. The window decides whether the restart takes that
 * immediate catch-up run: inside it the watcher runs at once, outside it the
 * gap is too wide for the checkpoint to bracket and the watcher waits for its
 * normal tick.
 *
 * Each case below is the SAME persisted watcher restored twice, once with a
 * window that contains its outage and once with a window that does not, so the
 * only variable is the config value.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatcherRegistry } from '../packages/sdk/src/platform/watchers/registry.js';
import type { WatcherRecord } from '../packages/sdk/src/platform/runtime/store/domains/watchers.js';
import type { AutomationSourceRecord } from '../packages/sdk/src/platform/automation/sources.js';

const roots: string[] = [];
const registries: WatcherRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The watcher-framework gate, which every registry operation is behind. */
const watcherFlagsOn = { isEnabled: (id: string): boolean => id === 'watcher-framework' };

/** A long interval, so nothing but the catch-up run fires during a test. */
const LONG_INTERVAL_MS = 10 * 60_000;

/** The checkpoint a run produces: `buildRunStrategy` returns a string `metadata.run` as-is. */
const CATCH_UP_CHECKPOINT = 'ran-on-restart';

function automationSource(): AutomationSourceRecord {
  return {
    id: 'source-1',
    kind: 'watcher',
    label: 'Source 1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  } as AutomationSourceRecord;
}

/**
 * A store file holding one running watcher whose last heartbeat was `agoMs` ago,
 * and a registry pointed at it with the given window.
 */
function restoredRegistry(agoMs: number, recoveryWindowMinutes: number): WatcherRegistry {
  const root = mkdtempSync(join(tmpdir(), 'gv-watcher-recovery-'));
  roots.push(root);
  const storePath = join(root, 'watchers.json');
  mkdirSync(root, { recursive: true });
  const record: WatcherRecord = {
    id: 'poller-1',
    kind: 'polling',
    label: 'Poller 1',
    state: 'running',
    source: automationSource(),
    intervalMs: LONG_INTERVAL_MS,
    lastHeartbeatAt: Date.now() - agoMs,
    lastCheckpoint: 'checkpoint-from-before-the-restart',
    metadata: { run: CATCH_UP_CHECKPOINT, runMode: 'polling' },
  };
  writeFileSync(storePath, `${JSON.stringify({ version: 1, watchers: [record] }, null, 2)}\n`, 'utf-8');
  const registry = new WatcherRegistry({
    storePath,
    featureFlags: watcherFlagsOn,
    recoveryWindowMinutes: () => recoveryWindowMinutes,
  });
  registries.push(registry);
  return registry;
}

/** Restore, let the catch-up microtask settle, and report the watcher. */
async function restoreAndSettle(registry: WatcherRegistry): Promise<WatcherRecord> {
  registry.list();
  // The catch-up run is fire-and-forget; one turn of the loop is enough for a
  // synchronous run strategy to have written its checkpoint back.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const watchers = registry.list();
  expect(watchers).toHaveLength(1);
  return watchers[0]!;
}

describe('a restart inside the recovery window catches up immediately', () => {
  test('a two-minute outage with a ten-minute window runs at once', async () => {
    const record = await restoreAndSettle(restoredRegistry(2 * 60_000, 10));
    expect(record.lastCheckpoint).toBe(CATCH_UP_CHECKPOINT);
    expect(record.state).toBe('running');
    expect(record.sourceStatus).toBe('healthy');
  });

  test('the caught-up heartbeat is persisted, not only held in memory', async () => {
    const registry = restoredRegistry(2 * 60_000, 10);
    const record = await restoreAndSettle(registry);
    const onDisk = JSON.parse(
      readFileSync(join(roots[roots.length - 1]!, 'watchers.json'), 'utf-8'),
    ) as { watchers: WatcherRecord[] };
    expect(onDisk.watchers[0]?.lastCheckpoint).toBe(CATCH_UP_CHECKPOINT);
    expect(onDisk.watchers[0]?.lastHeartbeatAt).toBe(record.lastHeartbeatAt);
  });

  test('a wide window brings a long outage back inside it', async () => {
    // Ninety minutes down. The previous case's default window would refuse this;
    // a 24-hour window is exactly what the key's upper bound is for.
    const record = await restoreAndSettle(restoredRegistry(90 * 60_000, 1440));
    expect(record.lastCheckpoint).toBe(CATCH_UP_CHECKPOINT);
  });
});

describe('a restart outside the recovery window waits for the normal tick', () => {
  test('a ninety-minute outage with a ten-minute window does not run', async () => {
    const record = await restoreAndSettle(restoredRegistry(90 * 60_000, 10));
    expect(record.lastCheckpoint).toBe('checkpoint-from-before-the-restart');
  });

  test('a two-minute outage with a one-minute window does not run either', async () => {
    const record = await restoreAndSettle(restoredRegistry(2 * 60_000, 1));
    expect(record.lastCheckpoint).toBe('checkpoint-from-before-the-restart');
  });

  test('a window of 0 means never catch up on restart, even one second later', async () => {
    const record = await restoreAndSettle(restoredRegistry(1_000, 0));
    expect(record.lastCheckpoint).toBe('checkpoint-from-before-the-restart');
  });

  test('the watcher is still re-armed — skipping catch-up is not stopping it', async () => {
    const registry = restoredRegistry(90 * 60_000, 10);
    await restoreAndSettle(registry);
    // Re-arming is what `stopWatcher` has to undo; a watcher that was never
    // armed reports no timer to clear and comes back 'stopped' with no error.
    const stopped = registry.stopWatcher('poller-1');
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.lastError).toBeUndefined();
  });
});

describe('an unusable configured value falls back to the shipped default', () => {
  test('NaN behaves as the ten-minute default rather than as "never"', async () => {
    const record = await restoreAndSettle(restoredRegistry(2 * 60_000, Number.NaN));
    expect(record.lastCheckpoint).toBe(CATCH_UP_CHECKPOINT);
  });

  test('a negative value behaves as the default too', async () => {
    const record = await restoreAndSettle(restoredRegistry(2 * 60_000, -5));
    expect(record.lastCheckpoint).toBe(CATCH_UP_CHECKPOINT);
  });

  test('a registry given no getter uses the shipped default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-watcher-recovery-default-'));
    roots.push(root);
    const storePath = join(root, 'watchers.json');
    const record: WatcherRecord = {
      id: 'poller-1',
      kind: 'polling',
      label: 'Poller 1',
      state: 'running',
      source: automationSource(),
      intervalMs: LONG_INTERVAL_MS,
      lastHeartbeatAt: Date.now() - 2 * 60_000,
      lastCheckpoint: 'checkpoint-from-before-the-restart',
      metadata: { run: CATCH_UP_CHECKPOINT, runMode: 'polling' },
    };
    writeFileSync(storePath, `${JSON.stringify({ version: 1, watchers: [record] }, null, 2)}\n`, 'utf-8');
    const registry = new WatcherRegistry({ storePath, featureFlags: watcherFlagsOn });
    registries.push(registry);
    expect((await restoreAndSettle(registry)).lastCheckpoint).toBe(CATCH_UP_CHECKPOINT);
  });
});
