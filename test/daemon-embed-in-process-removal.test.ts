/**
 * Deleting `daemon.embedInProcess` as a product-facing setting.
 *
 * The key described a topology the product does not have. Every surface starts
 * host services in adopt-only mode, and the adoption policy answers adopt-only
 * before it looks at the embed preference — so a settings file carrying
 * `embedInProcess: true` behaved exactly like one without it, while the
 * schema-driven settings UI presented it as a live toggle complete with a "NOT
 * RECOMMENDED" warning.
 *
 * Hosting a daemon in-process is still possible; it is an argument to the
 * composition API (`startHostServices({ embedDaemonInProcess })`), which is what
 * an embedder or a test uses. These tests pin both halves: the key is gone from
 * the schema and swept from disk with a receipt, and the composition option
 * still reaches the embed branch.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDaemonEmbedInProcessRemoval } from '../packages/sdk/src/platform/config/migrations.js';
import { applyDaemonEmbedInProcessMigrationPass } from '../packages/sdk/src/platform/config/manager-migration-passes.js';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';
import { decideDaemonAdoption } from '../packages/sdk/src/platform/runtime/daemon-adoption-policy.js';

describe('the key is gone from the schema', () => {
  test('no schema row offers daemon.embedInProcess', () => {
    // Read through `string` deliberately: `ConfigKey` no longer contains the
    // literal, so a direct comparison is a type error rather than a test. That
    // the type rejects it is the stronger half of the guarantee; this half
    // proves the runtime schema array agrees with the type.
    const keys: readonly string[] = CONFIG_SCHEMA.map((entry) => entry.key);
    expect(keys).not.toContain('daemon.embedInProcess');
  });

  test('no settings surface can render it, because the schema is what they enumerate', () => {
    // The settings modals in every product build their rows by walking
    // CONFIG_SCHEMA. A key absent from it cannot be offered anywhere.
    const daemonRows = CONFIG_SCHEMA.filter((entry) => entry.key.startsWith('daemon.')).map((e) => e.key);
    expect(daemonRows).not.toContain('daemon.embedInProcess');
    // The keys that remain are the ones with live meanings.
    expect(daemonRows).toContain('daemon.enabled');
  });

  test('the default config carries no embedInProcess field', () => {
    expect(DEFAULT_CONFIG.daemon).not.toHaveProperty('embedInProcess');
  });

  test('daemon.enabled survives and its description states what it decides', () => {
    const row = CONFIG_SCHEMA.find((entry) => entry.key === 'daemon.enabled');
    expect(row).toBeDefined();
    expect(row!.default).toBe(true);
    // It governs whether THIS surface talks to a daemon — not how one is hosted.
    expect(row!.description).toContain('surface');
  });
});

describe('migrateDaemonEmbedInProcessRemoval (pure function)', () => {
  test('removes a stored embedInProcess and reports the value it dropped', () => {
    const result = migrateDaemonEmbedInProcessRemoval({
      daemon: { enabled: true, embedInProcess: true, timezone: 'UTC' },
    });
    expect(result.migrated).toBe(true);
    expect(result.removedValue).toBe(true);
    expect(result.config['daemon']).toEqual({ enabled: true, timezone: 'UTC' });
  });

  test('a stored false is swept too — an explicit default is still a stored key', () => {
    const result = migrateDaemonEmbedInProcessRemoval({ daemon: { enabled: true, embedInProcess: false } });
    expect(result.migrated).toBe(true);
    expect(result.removedValue).toBe(false);
    expect(result.config['daemon']).toEqual({ enabled: true });
  });

  test('does not invent a replacement setting to receive the value', () => {
    const result = migrateDaemonEmbedInProcessRemoval({ daemon: { embedInProcess: true, enabled: true } });
    const daemon = result.config['daemon'] as Record<string, unknown>;
    expect(Object.keys(daemon)).toEqual(['enabled']);
  });

  test('drops the daemon section entirely when embedInProcess was its only key', () => {
    const result = migrateDaemonEmbedInProcessRemoval({ daemon: { embedInProcess: true }, display: {} });
    expect(result.config).not.toHaveProperty('daemon');
    expect(result.config).toHaveProperty('display');
  });

  test('is idempotent — a file with no legacy key is returned untouched', () => {
    const input = { daemon: { enabled: false } };
    const result = migrateDaemonEmbedInProcessRemoval(input);
    expect(result.migrated).toBe(false);
    expect(result.config).toBe(input);
  });

  test('a non-object daemon section is left alone', () => {
    expect(migrateDaemonEmbedInProcessRemoval({ daemon: 'nonsense' }).migrated).toBe(false);
    expect(migrateDaemonEmbedInProcessRemoval({ daemon: ['nonsense'] }).migrated).toBe(false);
    expect(migrateDaemonEmbedInProcessRemoval({}).migrated).toBe(false);
  });

  test('a null value still counts as present and is removed', () => {
    const result = migrateDaemonEmbedInProcessRemoval({ daemon: { embedInProcess: null, enabled: true } });
    expect(result.migrated).toBe(true);
    expect(result.removedValue).toBeUndefined();
    expect(result.config['daemon']).toEqual({ enabled: true });
  });
});

describe('applyDaemonEmbedInProcessMigrationPass', () => {
  function settingsFile(contents: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'gv-daemon-embed-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify(contents));
    return file;
  }

  test('rewrites the settings file on disk and emits one receipt', () => {
    const file = settingsFile({ daemon: { enabled: true, embedInProcess: true } });
    const receipts: Array<{ id: string; text: string }> = [];

    const result = applyDaemonEmbedInProcessMigrationPass(
      JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>,
      file,
      (id, text) => receipts.push({ id, text }),
    );

    expect(result['daemon']).toEqual({ enabled: true });
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(onDisk['daemon']).toEqual({ enabled: true });
    expect(receipts).toHaveLength(1);
  });

  test('the receipt names the key, quotes the value, and says why it is gone', () => {
    const file = settingsFile({ daemon: { embedInProcess: true, enabled: true } });
    const receipts: Array<{ id: string; text: string }> = [];
    applyDaemonEmbedInProcessMigrationPass(
      JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>,
      file,
      (id, text) => receipts.push({ id, text }),
    );

    const { id, text } = receipts[0]!;
    expect(id).toContain('settings-migration-daemon-embed-in-process');
    expect(id).toContain(file);
    expect(text).toContain('daemon.embedInProcess');
    expect(text).toContain('(it was true)');
    expect(text).toContain(file);
    // The reason, and the reassurance that nothing about the running daemon moves.
    expect(text).toContain('no surface could act on');
    expect(text).toContain('Nothing about how your daemon runs changes.');
  });

  test('a file without the legacy key produces no receipt and no rewrite', () => {
    const file = settingsFile({ daemon: { enabled: true } });
    const receipts: string[] = [];
    const result = applyDaemonEmbedInProcessMigrationPass({ daemon: { enabled: true } }, file, (id) => receipts.push(id));
    expect(receipts).toEqual([]);
    expect(result['daemon']).toEqual({ enabled: true });
  });

  test('an unwritable path still yields the migrated result in memory', () => {
    // The file rewrite is best-effort; a read-only tree must not stop the
    // process from running on the corrected shape, and the next start retries.
    const receipts: string[] = [];
    const result = applyDaemonEmbedInProcessMigrationPass(
      { daemon: { enabled: true, embedInProcess: true } },
      join(tmpdir(), 'gv-nonexistent-dir-for-embed-migration', 'settings.json'),
      (id) => receipts.push(id),
    );
    expect(result['daemon']).toEqual({ enabled: true });
  });
});

describe('the embed capability itself survives as composition machinery', () => {
  const base = {
    localVersion: '1.0.0',
    versionCompatible: () => true,
    enabled: true,
    portInUse: false,
    identity: null,
  };

  test('an embedder asking to host in-process still reaches the embed branch', () => {
    const decision = decideDaemonAdoption({ ...base, embedInProcess: true, adoptOnly: false });
    expect(decision.action).toBe('embed');
    // And the reason no longer cites a settings key, because none selects it.
    expect(decision.reason).not.toContain('daemon.embedInProcess');
  });

  test('a product surface — adopt-only — never embeds', () => {
    const decision = decideDaemonAdoption({ ...base, embedInProcess: true, adoptOnly: true });
    expect(decision.action).toBe('adopt-only-idle');
  });

  test('without the composition option the port-free default is a detached spawn', () => {
    expect(decideDaemonAdoption({ ...base, embedInProcess: false, adoptOnly: false }).action).toBe('spawn');
  });
});
