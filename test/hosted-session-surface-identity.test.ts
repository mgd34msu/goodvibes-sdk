/**
 * hosted-session-surface-identity.test.ts
 *
 * A hosted session runs inside the host and belongs to somebody else.
 *
 * That distinction was not made anywhere, and it cost a session. A daemon-hosted
 * AGENT conversation was composed on a floor whose services were rooted at
 * `tui`, so it took the TUI's identity and kept it: every client-owned setting
 * it read or wrote resolved against `~/.goodvibes/tui/settings.json`. Asked to
 * turn the wake word on, the model wrote `voice.wake.enabled` to the TUI's
 * store, read it straight back out of the same store, saw `true`, and reported
 * success — while the live agent process went on watching
 * `~/.goodvibes/agent/settings.json`, which nobody had touched. Every part of
 * that exchange was internally consistent and none of it was true.
 *
 * These tests pin the two halves of the fix:
 *   - identity TRAVELS: a session created for a surface carries that surface,
 *     through the create call, the record, and a rebuild after a restart;
 *   - identity is USED: client-owned keys resolve against the originating
 *     surface's own file, and the host's store is left alone.
 *
 * The second file covered here is the daemon-owned config migration, which was
 * the other suspect for the owner's "silent reverts". It is exonerated by
 * construction and pinned that way: it may strip DAEMON-owned keys out of a
 * surface store (that is the move, and it leaves a receipt), and it may never
 * touch a value the surface still owns.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRoutedConfigWrite,
  localStorePathForKey,
  readRoutedConfigValue,
  type ClientOwnedStore,
} from '../packages/sdk/src/platform/tools/goodvibes-runtime/config-routing.ts';
import { migrateDaemonOwnedConfig } from '../packages/sdk/src/platform/config/daemon-config-migration.ts';
import { applyDaemonConnectedHostSplitMigrationPass } from '../packages/sdk/src/platform/config/manager-migration-passes.ts';

/** A client-owned key — the exact one the lost session was about. */
const CLIENT_KEY = 'voice.wake.enabled';

const roots: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-surface-identity-'));
  roots.push(dir);
  return dir;
}

function surfaceStore(h: string, surface: string): string {
  const dir = join(h, '.goodvibes', surface);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'settings.json');
}

function write(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/**
 * A stand-in for the HOST's ConfigManager: it is the TUI, it has its own
 * opinions, and every one of them is the wrong answer for an agent session.
 */
function hostConfigManager(hostStorePath: string, held: Record<string, unknown>) {
  return {
    get: (key: string) => held[key],
    setDynamic: (key: string, value: unknown) => { held[key] = value; },
    getConfigPath: () => hostStorePath,
    getDaemonTierPath: () => null,
    getSharedTierPath: () => null,
    getProjectConfigPath: () => null,
  } as never;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('a hosted turn writes the surface it belongs to', () => {
  test('a client-owned write lands in the originating surface\'s store, not the host\'s', async () => {
    const h = home();
    const tuiStore = surfaceStore(h, 'tui');
    const agentStore = surfaceStore(h, 'agent');
    // The host is the TUI, and it holds the OPPOSITE value. If the write leaks
    // to the host, or the read answers from it, the assertions below catch it.
    write(tuiStore, { voice: { wake: { enabled: false } } });
    write(agentStore, {});

    const clientOwnedStore: ClientOwnedStore = { surface: 'agent', settingsPath: agentStore };
    const host = hostConfigManager(tuiStore, { [CLIENT_KEY]: false });

    const outcome = await applyRoutedConfigWrite(host, CLIENT_KEY as never, true, { clientOwnedStore });

    expect(outcome.appliedBy).toBe('local');
    expect(outcome.persistedTo).toBe(agentStore);
    expect(outcome.value).toBe(true);

    // The agent's own file holds it...
    expect(read(agentStore)).toEqual({ voice: { wake: { enabled: true } } });
    // ...and the TUI's file is exactly as it was. This is the assertion that
    // would have failed all session: the model changed the wrong product.
    expect(read(tuiStore)).toEqual({ voice: { wake: { enabled: false } } });
  });

  test('the read comes back from that same store, so a confirmation is real', async () => {
    const h = home();
    const tuiStore = surfaceStore(h, 'tui');
    const agentStore = surfaceStore(h, 'agent');
    write(tuiStore, { voice: { wake: { enabled: true } } });
    write(agentStore, { voice: { wake: { enabled: false } } });

    const clientOwnedStore: ClientOwnedStore = { surface: 'agent', settingsPath: agentStore };
    const host = hostConfigManager(tuiStore, { [CLIENT_KEY]: true });

    const result = await readRoutedConfigValue(host, CLIENT_KEY as never, { clientOwnedStore });

    expect(result.available).toBe(true);
    // The agent's value, not the host's — the two deliberately disagree here.
    expect((result as { value: unknown }).value).toBe(false);
    expect(result.source).toBe(agentStore);
    expect(result.scope).toBe('client');
  });

  test('a key absent from the origin store reads its DEFAULT, never the host\'s value', async () => {
    const h = home();
    const tuiStore = surfaceStore(h, 'tui');
    const agentStore = surfaceStore(h, 'agent');
    // The host has an explicit, deliberate choice. The agent has made none.
    write(tuiStore, { voice: { wake: { enabled: true } } });
    write(agentStore, {});

    const host = hostConfigManager(tuiStore, { [CLIENT_KEY]: true });
    const result = await readRoutedConfigValue(host, CLIENT_KEY as never, {
      clientOwnedStore: { surface: 'agent', settingsPath: agentStore },
    });

    // Falling back to the host's `true` would report one product's setting as
    // another's — the same lie in the other direction.
    expect((result as { value: unknown }).value).toBe(false);
  });

  test('with no origin store supplied, the host answers exactly as before', async () => {
    const h = home();
    const tuiStore = surfaceStore(h, 'tui');
    write(tuiStore, { voice: { wake: { enabled: true } } });
    const host = hostConfigManager(tuiStore, { [CLIENT_KEY]: true });

    expect(localStorePathForKey(host, CLIENT_KEY)).toBe(tuiStore);
    const result = await readRoutedConfigValue(host, CLIENT_KEY as never, {});
    expect((result as { value: unknown }).value).toBe(true);
  });
});

describe('the daemon-owned config migration touches only what the daemon owns', () => {
  test('a client-owned value in a surface store survives the migration untouched', () => {
    const h = home();
    const agentStore = surfaceStore(h, 'agent');
    // `voice.wake.*` is the agent's own; `surfaces.telegram.*` is the daemon's.
    write(agentStore, {
      voice: { wake: { enabled: true, retainAudio: 'session-temp' } },
      surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } },
    });
    const daemonStore = join(h, '.goodvibes', 'daemon', 'settings.json');
    mkdirSync(join(h, '.goodvibes', 'daemon'), { recursive: true });

    const result = migrateDaemonOwnedConfig({
      homeDir: h,
      daemonStorePath: daemonStore,
      surfaces: [{ surface: 'agent', path: agentStore }],
      primarySurface: 'agent',
    });

    expect(result.migrated).toBe(true);

    const after = read(agentStore);
    // The daemon reclaimed its own key — that is the move, and it is the whole
    // point of the migration.
    expect(after['surfaces']).toBeUndefined();
    // The agent's own settings are none of the migration's business. A value
    // changed here is the settings-ownership incident, not a migration.
    expect(after['voice']).toEqual({ wake: { enabled: true, retainAudio: 'session-temp' } });
  });

  test('what it moved is written down, so a changed store is never unexplained', () => {
    const h = home();
    const agentStore = surfaceStore(h, 'agent');
    write(agentStore, { surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } });
    const daemonStore = join(h, '.goodvibes', 'daemon', 'settings.json');
    mkdirSync(join(h, '.goodvibes', 'daemon'), { recursive: true });

    const result = migrateDaemonOwnedConfig({
      homeDir: h,
      daemonStorePath: daemonStore,
      surfaces: [{ surface: 'agent', path: agentStore }],
      primarySurface: 'agent',
    });

    const receipt = read(result.markerPath);
    expect(receipt['status']).toBe('complete');
    expect(JSON.stringify(receipt['moved'])).toContain('surfaces.telegram.botUsername');
    expect(receipt['sources']).toContain(agentStore);
  });
});

describe('the connected-host split leaves a receipt for the value it introduced', () => {
  test('an explicit daemon.enabled false gains a dial setting, on the record and in writing', () => {
    const h = home();
    const agentStore = surfaceStore(h, 'agent');
    // The owner's exact shape: daemon.enabled explicitly false, which used to
    // ALSO mean "never talk to a host you are already connected to" and blocked
    // daemon-owned writes for a whole session.
    const parsed: Record<string, unknown> = { daemon: { enabled: false } };
    write(agentStore, parsed);

    const receipts: { id: string; text: string }[] = [];
    const migrated = applyDaemonConnectedHostSplitMigrationPass(
      parsed,
      agentStore,
      (id, text) => { receipts.push({ id, text }); },
    );

    // The split resolved to "yes, keep talking to the connected host" — which is
    // what the owner's machine ended up with, confirmed live.
    expect((migrated['daemon'] as Record<string, unknown>)['connectedHost']).toEqual({ enabled: true });
    // `daemon.enabled` is NOT rewritten: it still means what it always meant.
    expect((migrated['daemon'] as Record<string, unknown>)['enabled']).toBe(false);
    // It landed in the file, not just in memory.
    expect(read(agentStore)).toEqual({ daemon: { enabled: false, connectedHost: { enabled: true } } });

    // And the transition is EXPLAINED. This is what makes a configured value
    // traceable without building an audit trail nobody asked for: the migration
    // that introduced it says so, once, in words the owner can act on.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.id).toContain('daemon-connected-host-split');
    expect(receipts[0]!.text).toContain('daemon.connectedHost.enabled');
    expect(receipts[0]!.text).toContain(agentStore);
    expect(receipts[0]!.text).toContain('unchanged');
  });

  test('a process that does not own the file changes memory only, and writes no receipt', () => {
    const h = home();
    const agentStore = surfaceStore(h, 'agent');
    const onDisk = { daemon: { enabled: false } };
    write(agentStore, onDisk);

    const receipts: { id: string; text: string }[] = [];
    const migrated = applyDaemonConnectedHostSplitMigrationPass(
      { daemon: { enabled: false } },
      agentStore,
      (id, text) => { receipts.push({ id, text }); },
      { ownsFile: false },
    );

    // The in-memory view is corrected so this process behaves correctly...
    expect((migrated['daemon'] as Record<string, unknown>)['connectedHost']).toEqual({ enabled: true });
    // ...and the file belonging to somebody else is left exactly alone.
    expect(read(agentStore)).toEqual(onDisk);
    expect(receipts).toEqual([]);
  });
});
