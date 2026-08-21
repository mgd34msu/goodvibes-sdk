/**
 * subscriptions-shared-tier.test.ts
 *
 * Provider subscriptions (OAuth sessions for providers like
 * 'openai-subscriber') used to be stored per surface,
 * `~/.goodvibes/<surfaceRoot>/subscriptions.json`. The daemon hosts every
 * conversational turn but had its own store, so a login completed in the TUI
 * was invisible to it: the daemon kept refreshing whatever it already had,
 * and a successful login changed nothing from its point of view. That defect
 * was measured live, a real 401 loop against a revoked token the daemon
 * never learned had been replaced.
 *
 * This file pins the fix: subscriptions live in the platform's SHARED tier
 * (`~/.goodvibes/shared/subscriptions.json`, the same tier the config
 * shared-key store, the canonical memory store, and the workspace register
 * already use), with a one-time, non-destructive fold of whatever a legacy
 * per-surface store still holds.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SubscriptionManager,
  sharedSubscriptionsPath,
  type ProviderSubscription,
} from '../packages/sdk/src/platform/config/subscriptions.ts';
import { createShellPathService } from '../packages/sdk/src/platform/runtime/shell-paths.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import { createRuntimeServices } from '../packages/sdk/src/platform/runtime/services.ts';
import { createClientRuntimeServices } from '../packages/sdk/src/platform/runtime/client-services.ts';

const roots: string[] = [];
function makeHome(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  roots.push(root);
  return root;
}
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixtureSubscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  const now = Date.now();
  return {
    provider: 'openai-subscriber',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    expiresAt: now + 3_600_000,
    authMode: 'oauth',
    overrideAmbientApiKeys: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function writeStoreFile(path: string, subscriptions: Record<string, ProviderSubscription>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, subscriptions, pending: {} }, null, 2));
}

describe('sharedSubscriptionsPath', () => {
  test('resolves under <home>/.goodvibes/shared/, not any surface root', () => {
    const home = makeHome('gv-sub-path');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    expect(sharedSubscriptionsPath(shellPaths)).toBe(join(home, '.goodvibes', 'shared', 'subscriptions.json'));
  });

  test('differs from the legacy per-surface path', () => {
    const home = makeHome('gv-sub-path-diff');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const shared = sharedSubscriptionsPath(shellPaths);
    const legacyTui = shellPaths.resolveUserPath('tui', 'subscriptions.json');
    const legacyDaemon = shellPaths.resolveUserPath('daemon', 'subscriptions.json');
    expect(shared).not.toBe(legacyTui);
    expect(shared).not.toBe(legacyDaemon);
  });
});

describe('both runtime service factories resolve the shared path', () => {
  test('createRuntimeServices (the daemon graph) writes subscriptions under .goodvibes/shared/, not .goodvibes/<surfaceRoot>/', () => {
    const home = makeHome('gv-sub-daemon-factory');
    const daemon = createRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'daemon', configDir: join(home, 'cfg'), workingDir: home, homeDir: home }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'daemon',
      workingDir: home,
      homeDirectory: home,
    });
    try {
      daemon.subscriptionManager.saveSubscription(fixtureSubscription());

      const sharedPath = join(home, '.goodvibes', 'shared', 'subscriptions.json');
      const legacyPath = join(home, '.goodvibes', 'daemon', 'subscriptions.json');
      expect(existsSync(sharedPath)).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      daemon.dispose();
    }
  });

  test('createClientRuntimeServices (the TUI/agent graph) writes subscriptions under .goodvibes/shared/, not .goodvibes/<surfaceRoot>/', () => {
    const home = makeHome('gv-sub-client-factory');
    const client = createClientRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'tui', configDir: join(home, 'cfg'), workingDir: home, homeDir: home }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'tui',
      workingDir: home,
      homeDirectory: home,
      requestApproval: async () => ({ approved: false }),
    });
    try {
      client.subscriptionManager.saveSubscription(fixtureSubscription());

      const sharedPath = join(home, '.goodvibes', 'shared', 'subscriptions.json');
      const legacyPath = join(home, '.goodvibes', 'tui', 'subscriptions.json');
      expect(existsSync(sharedPath)).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      client.dispose();
    }
  });

  test('a login recorded by one surface graph is visible to another surface graph on the same home — the defect this round fixes', () => {
    const home = makeHome('gv-sub-cross-surface-factories');
    const tui = createClientRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'tui', configDir: join(home, 'tui-cfg'), workingDir: home, homeDir: home }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'tui',
      workingDir: home,
      homeDirectory: home,
      requestApproval: async () => ({ approved: false }),
    });
    const daemon = createRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'daemon', configDir: join(home, 'daemon-cfg'), workingDir: home, homeDir: home }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'daemon',
      workingDir: home,
      homeDirectory: home,
    });
    try {
      // The TUI completes a login...
      tui.subscriptionManager.saveSubscription(fixtureSubscription({ accessToken: 'tui-issued-token' }));
      // ...and the daemon, which hosts the actual turns, sees it without
      // constructing anything new or restarting.
      expect(daemon.subscriptionManager.get('openai-subscriber')?.accessToken).toBe('tui-issued-token');
    } finally {
      tui.dispose();
      daemon.dispose();
    }
  });
});

describe('legacy surface store migration', () => {
  test('a legacy record newer than the shared one is folded in, and the shared store wins thereafter', () => {
    const home = makeHome('gv-sub-migrate-newer');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const sharedPath = sharedSubscriptionsPath(shellPaths);
    const legacyPath = shellPaths.resolveUserPath('tui', 'subscriptions.json');

    const older = fixtureSubscription({ accessToken: 'shared-stale', updatedAt: 1_000 });
    const newer = fixtureSubscription({ accessToken: 'legacy-fresh', updatedAt: 2_000 });
    writeStoreFile(sharedPath, { 'openai-subscriber': older });
    writeStoreFile(legacyPath, { 'openai-subscriber': newer });

    const first = new SubscriptionManager(sharedPath, { legacyPath });
    expect(first.get('openai-subscriber')?.accessToken).toBe('legacy-fresh');

    // Folded onto disk, not just held in memory.
    const onDisk = JSON.parse(readFileSync(sharedPath, 'utf-8'));
    expect(onDisk.subscriptions['openai-subscriber'].accessToken).toBe('legacy-fresh');

    // A second boot (fresh instance, same paths) must not re-fold: the shared
    // record is now the newer one, so the legacy value stays where it is,
    // the shared store already reflects it and wins on read.
    const second = new SubscriptionManager(sharedPath, { legacyPath });
    expect(second.get('openai-subscriber')?.accessToken).toBe('legacy-fresh');
  });

  test('a legacy record older than the shared one is never adopted — no downgrade', () => {
    const home = makeHome('gv-sub-migrate-no-downgrade');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const sharedPath = sharedSubscriptionsPath(shellPaths);
    const legacyPath = shellPaths.resolveUserPath('tui', 'subscriptions.json');

    const sharedNewer = fixtureSubscription({ accessToken: 'shared-fresh', updatedAt: 5_000 });
    const legacyOlder = fixtureSubscription({ accessToken: 'legacy-stale', updatedAt: 1_000 });
    writeStoreFile(sharedPath, { 'openai-subscriber': sharedNewer });
    writeStoreFile(legacyPath, { 'openai-subscriber': legacyOlder });

    const manager = new SubscriptionManager(sharedPath, { legacyPath });
    expect(manager.get('openai-subscriber')?.accessToken).toBe('shared-fresh');

    const onDisk = JSON.parse(readFileSync(sharedPath, 'utf-8'));
    expect(onDisk.subscriptions['openai-subscriber'].accessToken).toBe('shared-fresh');
  });

  test('a provider present only in the legacy store (shared store empty) is adopted', () => {
    const home = makeHome('gv-sub-migrate-empty-shared');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const sharedPath = sharedSubscriptionsPath(shellPaths);
    const legacyPath = shellPaths.resolveUserPath('daemon', 'subscriptions.json');

    writeStoreFile(legacyPath, { 'openai-subscriber': fixtureSubscription({ accessToken: 'only-in-legacy' }) });
    expect(existsSync(sharedPath)).toBe(false);

    const manager = new SubscriptionManager(sharedPath, { legacyPath });
    expect(manager.get('openai-subscriber')?.accessToken).toBe('only-in-legacy');
    expect(existsSync(sharedPath)).toBe(true);
  });

  test('legacy files are never modified or deleted by the fold, even when corrupt', () => {
    const home = makeHome('gv-sub-migrate-legacy-untouched');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const sharedPath = sharedSubscriptionsPath(shellPaths);
    const legacyPath = shellPaths.resolveUserPath('tui', 'subscriptions.json');

    const newer = fixtureSubscription({ accessToken: 'legacy-fresh', updatedAt: 9_000 });
    writeStoreFile(legacyPath, { 'openai-subscriber': newer });
    const legacyBytesBefore = readFileSync(legacyPath, 'utf-8');

    new SubscriptionManager(sharedPath, { legacyPath });

    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, 'utf-8')).toBe(legacyBytesBefore);

    // A corrupt legacy file: must not be quarantined (renamed) or deleted,
    // it is not this manager's file to touch, and an older build still
    // pointed at it must find it exactly as it left it.
    const corruptHome = makeHome('gv-sub-migrate-legacy-corrupt');
    const corruptShellPaths = createShellPathService({ workingDirectory: corruptHome, homeDirectory: corruptHome });
    const corruptShared = sharedSubscriptionsPath(corruptShellPaths);
    const corruptLegacy = corruptShellPaths.resolveUserPath('tui', 'subscriptions.json');
    mkdirSync(join(corruptLegacy, '..'), { recursive: true });
    writeFileSync(corruptLegacy, '{ not valid json');

    expect(() => new SubscriptionManager(corruptShared, { legacyPath: corruptLegacy })).not.toThrow();
    expect(readFileSync(corruptLegacy, 'utf-8')).toBe('{ not valid json');
    expect(existsSync(corruptShared)).toBe(false); // nothing to fold, so nothing was written
  });

  test('omitting legacyPath does nothing extra — the pre-migration constructor shape still works', () => {
    const home = makeHome('gv-sub-no-legacy');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const sharedPath = sharedSubscriptionsPath(shellPaths);
    const manager = new SubscriptionManager(sharedPath);
    expect(manager.get('openai-subscriber')).toBeNull();
    manager.saveSubscription(fixtureSubscription());
    expect(manager.get('openai-subscriber')?.accessToken).toBe('access-token');
  });
});

describe('cross-instance visibility on the shared path', () => {
  test('a save through one manager instance is visible to a fresh instance on the same shared path', () => {
    const home = makeHome('gv-sub-cross-instance');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const sharedPath = sharedSubscriptionsPath(shellPaths);

    const writer = new SubscriptionManager(sharedPath);
    writer.saveSubscription(fixtureSubscription({ accessToken: 'written-by-writer' }));

    const reader = new SubscriptionManager(sharedPath);
    expect(reader.get('openai-subscriber')?.accessToken).toBe('written-by-writer');
  });

  test('get() re-reads on every call rather than caching — a write from elsewhere on disk is picked up by an existing instance', () => {
    const home = makeHome('gv-sub-no-cache');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const sharedPath = sharedSubscriptionsPath(shellPaths);

    const manager = new SubscriptionManager(sharedPath);
    expect(manager.get('openai-subscriber')).toBeNull();

    // Simulate a second process (another surface) writing the same file
    // directly, without going through this instance.
    writeStoreFile(sharedPath, { 'openai-subscriber': fixtureSubscription({ accessToken: 'written-elsewhere' }) });

    expect(manager.get('openai-subscriber')?.accessToken).toBe('written-elsewhere');
  });
});
