/**
 * settings-migration-legacy-toggles.test.ts
 *
 * The invisible migration: a user config populated with legacy featureFlags
 * entries (and the renamed sandbox.judgmentAutoApprove key) is rewritten onto
 * the per-domain settings keys on first load — no user edits, one persisted
 * rewrite, honest receipts. Covers the pure mapping (migrateLegacyFeatureToggles)
 * and the ConfigManager.load() integration including the write-back that makes
 * the migration run exactly once.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyFeatureToggles } from '../packages/sdk/src/platform/config/migrations.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../packages/sdk/src/platform/runtime/feature-announcements.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('migrateLegacyFeatureToggles — pure mapping', () => {
  test('a config with no legacy keys comes back unchanged, same reference', () => {
    const parsed = { behavior: { hitlMode: 'quiet' } };
    const result = migrateLegacyFeatureToggles(parsed);
    expect(result.migrated).toBe(false);
    expect(result.config).toBe(parsed);
  });

  test('a populated legacy record dissolves onto its domain keys', () => {
    const parsed = {
      display: { theme: 'vaporwave' },
      featureFlags: {
        'hitl-ux-modes': 'disabled',
        'session-compaction': 'disabled',
        'fetch-sanitization': 'disabled',
        'exec-sandbox': 'disabled',
        'web-surface': 'disabled',
        'permissions-policy-engine': 'enabled',
        'shell-ast-normalization': 'disabled',
        'agent-passive-code-injection': 'enabled',
        'token-scope-rotation-audit': 'disabled',
        'provider-optimizer': 'enabled',
        'otel-foundation': 'enabled',
        'otel-remote-export': 'enabled',
        'tool-result-reconciliation': 'killed',
      },
    };
    const result = migrateLegacyFeatureToggles(parsed as never);
    expect(result.migrated).toBe(true);
    const c = result.config as Record<string, Record<string, unknown>>;
    expect('featureFlags' in result.config).toBe(false);
    expect(c['behavior']?.['hitlMode']).toBe('off');
    expect(c['behavior']?.['compactionStrategy']).toBe('off');
    expect(c['fetch']?.['sanitizeMode']).toBe('none');
    expect(c['sandbox']?.['enabled']).toBe(false);
    expect(c['web']?.['enabled']).toBe(false);
    expect(c['permissions']?.['engine']).toBe('policy-engine');
    expect(c['permissions']?.['commandParser']).toBe('flat');
    expect((c['agents']?.['passiveInjection'] as Record<string, unknown>)?.['code']).toBe(true);
    expect((c['security']?.['tokenAudit'] as Record<string, unknown>)?.['enabled']).toBe(false);
    expect(c['provider']?.['optimizerMode']).toBe('manual');
    expect(c['telemetry']?.['otelMode']).toBe('remote-export');
    // killed maps to the off value of the domain key.
    expect(c['behavior']?.['toolResultReconciliation']).toBe('warn-only');
    // untouched sections survive.
    expect(c['display']?.['theme']).toBe('vaporwave');
  });

  test('legacy enabled defers to an existing domain switch (the AND rule)', () => {
    // Legacy effective state was flag AND automation.enabled; an enabled flag
    // with the domain switch off must NOT switch automation on.
    const result = migrateLegacyFeatureToggles({
      featureFlags: { 'automation-domain': 'enabled', 'slack-surface': 'enabled' },
      automation: { enabled: false },
    } as never);
    const c = result.config as Record<string, Record<string, unknown>>;
    expect(c['automation']?.['enabled']).toBe(false);
    // No surfaces section is invented for a deferring 'enabled' entry.
    expect('surfaces' in result.config).toBe(false);
  });

  test('the compaction pair collapses onto behavior.compactionStrategy', () => {
    const distillerOn = migrateLegacyFeatureToggles({
      featureFlags: { 'session-compaction': 'enabled', 'compaction-distiller-strategy': 'enabled' },
    } as never);
    expect((distillerOn.config as Record<string, Record<string, unknown>>)['behavior']?.['compactionStrategy']).toBe('distiller');

    const distillerOffWithSelection = migrateLegacyFeatureToggles({
      featureFlags: { 'compaction-distiller-strategy': 'disabled' },
      behavior: { compactionStrategy: 'distiller' },
    } as never);
    // Legacy resolved a dark distiller selection back to structured — preserved explicitly.
    expect((distillerOffWithSelection.config as Record<string, Record<string, unknown>>)['behavior']?.['compactionStrategy']).toBe('structured');
  });

  test('judgmentAutoApprove and the judgment toggle collapse onto sandbox.judgment', () => {
    const auto = migrateLegacyFeatureToggles({
      featureFlags: { 'sandbox-model-judgment': 'enabled' },
      sandbox: { judgmentAutoApprove: true },
    } as never);
    const autoSandbox = (auto.config as Record<string, Record<string, unknown>>)['sandbox']!;
    expect(autoSandbox['judgment']).toBe('auto-approve');
    expect('judgmentAutoApprove' in autoSandbox).toBe(false);

    const off = migrateLegacyFeatureToggles({
      featureFlags: { 'sandbox-model-judgment': 'disabled' },
      sandbox: { judgmentAutoApprove: true },
    } as never);
    expect((off.config as Record<string, Record<string, unknown>>)['sandbox']?.['judgment']).toBe('off');

    const renameOnly = migrateLegacyFeatureToggles({
      sandbox: { judgmentAutoApprove: false, enabled: true },
    } as never);
    const renamed = (renameOnly.config as Record<string, Record<string, unknown>>)['sandbox']!;
    expect(renameOnly.migrated).toBe(true);
    expect('judgmentAutoApprove' in renamed).toBe(false);
    expect(renamed['enabled']).toBe(true);
    // autoApprove=false with no explicit toggle: the default (annotate) applies.
    expect('judgment' in renamed).toBe(false);
  });

  test('unknown legacy ids are reported, never invented into settings', () => {
    const result = migrateLegacyFeatureToggles({
      featureFlags: { 'made-up-toggle': 'enabled', 'exec-sandbox': 'disabled', junk: 42 },
    } as never);
    expect(result.unknownIds).toContain('made-up-toggle');
    expect(result.unknownIds).toContain('junk');
    expect((result.config as Record<string, Record<string, unknown>>)['sandbox']?.['enabled']).toBe(false);
  });
});

describe('ConfigManager.load() — invisible migration on first start', () => {
  function writeConfig(dir: string, value: unknown): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(value, null, 2));
    return path;
  }

  test('a populated legacy config migrates, resolves, and persists back exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-legacy-migration-'));
    tmpRoots.push(root);
    const configDir = join(root, 'config');
    const path = writeConfig(configDir, {
      featureFlags: {
        'hitl-ux-modes': 'disabled',
        'exec-sandbox': 'disabled',
        'session-compaction': 'disabled',
        'permissions-policy-engine': 'enabled',
      },
      sandbox: { judgmentAutoApprove: true },
      behavior: { autoCompactThreshold: 70 },
    });

    const manager = new ConfigManager({ configDir });
    manager.load();

    // Resolved config honors the migrated choices.
    expect(manager.get('behavior.hitlMode')).toBe('off');
    expect(manager.get('behavior.compactionStrategy')).toBe('off');
    expect(manager.get('sandbox.enabled')).toBe(false);
    expect(manager.get('permissions.engine')).toBe('policy-engine');
    expect(manager.get('sandbox.judgment')).toBe('auto-approve');
    // Untouched explicit values survive.
    expect(manager.get('behavior.autoCompactThreshold')).toBe(70);

    // The file itself was rewritten: legacy keys gone, domain keys present.
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect('featureFlags' in onDisk).toBe(false);
    expect((onDisk['behavior'] as Record<string, unknown>)['hitlMode']).toBe('off');
    expect('judgmentAutoApprove' in (onDisk['sandbox'] as Record<string, unknown>)).toBe(false);

    // Second load is a clean no-op over the migrated file.
    const manager2 = new ConfigManager({ configDir });
    manager2.load();
    expect(manager2.get('behavior.hitlMode')).toBe('off');
    expect(migrateLegacyFeatureToggles(onDisk).migrated).toBe(false);
  });

  test('the migration receipt reaches the surface-delivery queue exactly once — not only the activity log', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-legacy-migration-receipt-'));
    tmpRoots.push(root);
    const configDir = join(root, 'config');
    writeConfig(configDir, { featureFlags: { 'hitl-ux-modes': 'disabled' } });

    const manager = new ConfigManager({ configDir });
    manager.load();

    // The receipt sits in the announce-once pending queue the consuming
    // status receipts read drains at attach.
    const store = new FeatureAnnouncementStore(featureAnnouncementsPath(manager));
    const pending = store.drainPending();
    const receipt = pending.find((entry) => entry.id.startsWith('settings-migration-feature-toggles:'));
    expect(receipt).toBeDefined();
    expect(receipt!.text).toContain('Settings migrated');
    expect(receipt!.text).toContain('behavior.hitlMode');

    // Exactly once: a second load of the already-migrated file queues nothing.
    const manager2 = new ConfigManager({ configDir });
    manager2.load();
    expect(new FeatureAnnouncementStore(featureAnnouncementsPath(manager2)).drainPending()).toEqual([]);
  });

  test('a fresh config without legacy keys loads untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-legacy-migration-fresh-'));
    tmpRoots.push(root);
    const configDir = join(root, 'config');
    const path = writeConfig(configDir, { display: { theme: 'vaporwave' } });
    const before = readFileSync(path, 'utf-8');

    const manager = new ConfigManager({ configDir });
    manager.load();
    expect(manager.get('display.theme')).toBe('vaporwave');
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});
