/**
 * watcher-persist-containment.test.ts — a watcher-store write that fails must
 * not be able to kill the process that attempted it.
 *
 * The live crash: `WatcherRegistry.list()` refreshes every record and persists
 * the refreshed snapshot, and the fleet registry's coalesced tick calls that
 * list on a `setInterval`. When the snapshot write threw — a concurrent writer
 * had swept its temp file, so `chmod` came back ENOENT — the exception left a
 * timer callback with no caller above it to catch anything, reached the top as
 * an uncaught exception, and the agent process died.
 *
 * The store the write was for rebuilds from live registrations on the next
 * load, so nothing was even being protected by the crash. These tests hold the
 * containment: the failure is logged at error level with the store path and the
 * errno, `list()` still answers from memory, and it can be called again — which
 * is exactly what the next tick does.
 */
import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { WatcherRegistry } from '../packages/sdk/src/platform/watchers/registry.ts';
import { logger } from '../packages/sdk/src/platform/utils/logger.ts';
import type { AutomationSourceRecord } from '../packages/sdk/src/platform/automation/sources.ts';

/** The watcher-framework gate every registry operation sits behind. */
const watcherFlagsOn = { isEnabled: (id: string): boolean => id === 'watcher-framework' };

const registries: WatcherRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function track(registry: WatcherRegistry): WatcherRegistry {
  registries.push(registry);
  return registry;
}

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
 * A store path with a regular file partway down it, so creating the store's
 * parent directory has to traverse through a file and every write fails with
 * ENOTDIR — the same class of unwritable store as the ENOENT that crashed the
 * agent, and deterministic rather than timing-dependent.
 */
function unwritableStorePath(): string {
  const dir = makeProjectTempDir('gv-watcher-persist');
  mkdirSync(dir, { recursive: true });
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'a file where the store directory should be', 'utf-8');
  return join(blocker, 'nested', 'watchers.json');
}

describe('watcher snapshot persistence failures are contained', () => {
  test('registering a watcher against an unwritable store does not throw and keeps the record in memory', () => {
    const registry = track(new WatcherRegistry({ storePath: unwritableStorePath(), featureFlags: watcherFlagsOn }));

    const record = registry.registerWatcher({
      id: 'poller-1',
      label: 'Poller 1',
      kind: 'polling',
      source: automationSource(),
      intervalMs: 600_000,
    });

    expect(record.id).toBe('poller-1');
    expect(registry.getWatcher('poller-1')?.id).toBe('poller-1');
  });

  test('a failed persist inside the refresh the fleet tick drives is logged with path and errno, and the tick survives to run again', () => {
    const storePath = unwritableStorePath();
    const registry = track(new WatcherRegistry({ storePath, featureFlags: watcherFlagsOn }));
    registry.registerWatcher({
      id: 'poller-1',
      label: 'Poller 1',
      kind: 'polling',
      source: automationSource(),
      intervalMs: 600_000,
    });

    const errorSpy = spyOn(logger, 'error') as Mock<typeof logger.error>;
    try {
      // list() is what the fleet registry's assemble() calls on every tick, and
      // it persists the refreshed snapshot every time. Two calls: the crash
      // took the process out on the first one, so surviving to a second is the
      // whole point.
      const firstTick = registry.list();
      const secondTick = registry.list();

      expect(firstTick.map((watcher) => watcher.id)).toEqual(['poller-1']);
      expect(secondTick.map((watcher) => watcher.id)).toEqual(['poller-1']);

      const reports = errorSpy.mock.calls.filter(([message]) => String(message).includes('[watchers/store]'));
      expect(reports.length).toBeGreaterThanOrEqual(2);
      const [, data] = reports[0] as [string, Record<string, unknown>];
      expect(data.filePath).toBe(storePath);
      expect(data.code).toBe('ENOTDIR');
      expect(typeof data.error).toBe('string');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('the same refresh against a writable store still persists the snapshot', () => {
    const storePath = join(makeProjectTempDir('gv-watcher-persist'), 'watchers.json');
    const registry = track(new WatcherRegistry({ storePath, featureFlags: watcherFlagsOn }));
    registry.registerWatcher({
      id: 'poller-1',
      label: 'Poller 1',
      kind: 'polling',
      source: automationSource(),
      intervalMs: 600_000,
    });

    expect(registry.list().map((watcher) => watcher.id)).toEqual(['poller-1']);
    expect(existsSync(storePath)).toBe(true);
  });
});
