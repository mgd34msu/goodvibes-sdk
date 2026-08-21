/**
 * occasions-final-stretch-removal.test.ts, retiring `occasions.finalStretchDays`.
 *
 * The setting used to say how many days before a date the reminder rhythm went
 * DAILY. That rhythm is gone: an occasion is now raised once when it enters its
 * lead window and at most once more on the day itself, which is the owner's
 * ruling after being told about his own birthday five times in one day. A count
 * of two has nothing to tune, so the key is removed rather than left inert,
 * a settings entry that changes nothing is worse than no entry at all.
 *
 * Removing a schema key is the part with a history. An existing settings file
 * still carries the key, and a build that no longer declares it reads it as "a
 * setting this component does not know", so the removal ships WITH a load-time
 * migration that strips it, and the migration runs BEFORE the key screen so
 * nothing warns about a state that has already been handled.
 *
 * The ownership rule is the payments money-key incident's rule, and it applies
 * for the same reason: `occasions.` is a DAEMON-OWNED prefix, so the daemon
 * store is written by the daemon and read by every terminal product. The owner
 * rewrites the file and files a receipt; a non-owning reader strips the key from
 * its in-memory view, writes no bytes, and files no receipt, a receipt without
 * the change on disk would be a lie.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { ingestSettingsFile } from '../packages/sdk/src/platform/config/settings-ingestion.ts';
import {
  migrateOccasionsFinalStretchRemoval,
  RETIRED_OCCASIONS_FINAL_STRETCH_KEY,
} from '../packages/sdk/src/platform/config/migrations.ts';
import { applyOccasionsFinalStretchMigrationPass } from '../packages/sdk/src/platform/config/manager-migration-passes.ts';
import { occasionsConfigSettings } from '../packages/sdk/src/platform/config/schema-domain-occasions.ts';
import { OCCASIONS_DEFAULTS } from '../packages/sdk/src/platform/occasions/policy.ts';

/** A daemon store carrying the retired key, plus the surface dirs a manager needs. */
function makeHomeWithRetiredKey(label: string, surface: string, extra: Record<string, unknown> = {}): {
  home: string;
  configDir: string;
  daemonTierPath: string;
} {
  const home = makeProjectTempDir(label);
  const configDir = join(home, '.goodvibes', surface);
  const daemonTierPath = join(home, '.goodvibes', 'daemon', 'settings.json');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(
    daemonTierPath,
    JSON.stringify({ occasions: { finalStretchDays: 2, leadDays: 14, ...extra } }, null, 2),
    'utf-8',
  );
  return { home, configDir, daemonTierPath };
}

function receiptsText(manager: ConfigManager): string {
  const path = join(manager.getControlPlaneConfigDir(), 'control-plane', 'feature-announcements.json');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

describe('the settings catalog no longer offers the key', () => {
  test('it is not a declared occasions setting', () => {
    const keys = occasionsConfigSettings.map((setting) => setting.key);
    expect(keys).not.toContain(RETIRED_OCCASIONS_FINAL_STRETCH_KEY);
    // The neighbours it sat between are untouched, this is a removal, not a
    // reshuffle of the occasions domain.
    expect(keys).toContain('occasions.cadenceDays');
    expect(keys).toContain('occasions.leadDays');
  });

  test('it is not in the effective policy defaults', () => {
    expect(Object.keys(OCCASIONS_DEFAULTS)).not.toContain('finalStretchDays');
  });
});

describe('the migration itself', () => {
  test('the key is dropped and the rest of the section survives', () => {
    const result = migrateOccasionsFinalStretchRemoval({
      occasions: { finalStretchDays: 2, leadDays: 14 },
    });
    expect(result.migrated).toBe(true);
    expect(result.removedValue).toBe(2);
    expect(result.config).toEqual({ occasions: { leadDays: 14 } });
  });

  test('a section that held nothing else goes with it', () => {
    const result = migrateOccasionsFinalStretchRemoval({ occasions: { finalStretchDays: 2 } });
    // No empty `occasions: {}` left behind as a monument to a gone setting.
    expect(result.config).toEqual({});
  });

  test('it is idempotent, and a file without the key is returned untouched', () => {
    const clean = { occasions: { leadDays: 14 } };
    const first = migrateOccasionsFinalStretchRemoval(clean);
    expect(first.migrated).toBe(false);
    expect(first.config).toBe(clean);

    const migrated = migrateOccasionsFinalStretchRemoval({ occasions: { finalStretchDays: 2, leadDays: 14 } });
    expect(migrateOccasionsFinalStretchRemoval(migrated.config).migrated).toBe(false);
  });

  test('nothing else in the file is disturbed', () => {
    const result = migrateOccasionsFinalStretchRemoval({
      occasions: { finalStretchDays: 2 },
      payments: { budget: { dailyItem: 25 } },
      daemon: { timezone: 'Europe/London' },
    });
    expect(result.config).toEqual({
      payments: { budget: { dailyItem: 25 } },
      daemon: { timezone: 'Europe/London' },
    });
  });
});

describe('the owning process strips the key and files a receipt', () => {
  test('the file is rewritten without it', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithRetiredKey('gv-fs-owner', 'goodvibes');

    const daemon = new ConfigManager({
      configDir,
      homeDir: home,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      ownsDaemonTier: true,
    });
    // The neighbouring value is still resolved, this removes one key, not the
    // owner's occasions configuration.
    expect(daemon.get('occasions.leadDays')).toBe(14);

    const onDisk = readFileSync(daemonTierPath, 'utf-8');
    expect(onDisk).not.toContain('finalStretchDays');
    expect(onDisk).toContain('"leadDays": 14');
  });

  test('the receipt says what was set and what replaced the rhythm', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithRetiredKey('gv-fs-owner-receipt', 'goodvibes');

    const daemon = new ConfigManager({
      configDir,
      homeDir: home,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      ownsDaemonTier: true,
    });

    const receipts = receiptsText(daemon);
    expect(receipts).toContain('occasions.finalStretchDays');
    // The value he had, so the receipt is about HIS file rather than a generic
    // announcement.
    expect(receipts).toContain('it was 2');
    // And what the behaviour is now, plus the reassurance that matters most:
    // the last time one reminder was too loud, the whole feature got disabled.
    expect(receipts).toContain('raised twice');
    expect(receipts).toContain('unchanged');
  });
});

describe('a non-owning reader strips in memory only', () => {
  test('the file bytes are unchanged, byte for byte', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithRetiredKey('gv-fs-reader-bytes', 'tui');
    const before = readFileSync(daemonTierPath, 'utf-8');

    const client = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });
    expect(client.get('occasions.leadDays')).toBe(14);

    const after = readFileSync(daemonTierPath, 'utf-8');
    expect(after).toBe(before);
    // Said the other way round, because this is the shape an older daemon reads:
    expect(after).toContain('finalStretchDays');
  });

  test('no receipt is filed', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithRetiredKey('gv-fs-reader-receipt', 'tui');
    const client = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });
    expect(receiptsText(client)).not.toContain('occasions.finalStretchDays');
  });

  test('reading it repeatedly never drifts into a write', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithRetiredKey('gv-fs-reader-repeat', 'agent');
    const before = readFileSync(daemonTierPath, 'utf-8');

    for (let run = 0; run < 3; run += 1) {
      const client = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'agent', daemonTierPath });
      expect(client.get('occasions.leadDays')).toBe(14);
    }

    expect(readFileSync(daemonTierPath, 'utf-8')).toBe(before);
  });

  test('the pass is ownership-aware at its own boundary, not only through the manager', () => {
    const raw = { occasions: { finalStretchDays: 2, leadDays: 14 } };
    const filed: string[] = [];
    const asReader = applyOccasionsFinalStretchMigrationPass(
      structuredClone(raw),
      '/nowhere/settings.json',
      (id) => { filed.push(id); },
      { ownsFile: false },
    );
    // Stripped in the returned view, so the reader resolves what the owner will
    // resolve; nothing announced, because nothing was written.
    expect(asReader).toEqual({ occasions: { leadDays: 14 } });
    expect(filed).toHaveLength(0);
  });
});

describe('the ingestion screen does not warn about a key the migration handles', () => {
  test('a file carrying the retired key loads clean', () => {
    const notices: string[] = [];
    const result = ingestSettingsFile(
      { occasions: { finalStretchDays: 2, leadDays: 14 } },
      '/nowhere/settings.json',
      {
        write: () => undefined,
        onNotice: (entry) => { notices.push(`${entry.key}: ${entry.action}`); },
        // Exactly how ConfigManager.loadDaemonTier wires it: the migration runs
        // between the reader-floor check and the key screen.
        migrate: (raw) => applyOccasionsFinalStretchMigrationPass(
          raw,
          '/nowhere/settings.json',
          () => undefined,
          { ownsFile: false },
        ),
      },
    );

    expect(notices).toEqual([]);
    expect(JSON.stringify(result.config)).not.toContain('finalStretchDays');
  });

  test('the screen IS live in this section — it just has no prefix to catch', () => {
    // The control, and the reason it is shaped this way. The screen announces an
    // unknown key only when it looks like a newer FORM of a known one, matched
    // by prefix in either direction; `finalStretchDays` shares a prefix with no
    // remaining occasions key, so it would have gone unremarked even without the
    // migration. That is worth pinning rather than assuming, because it says the
    // migration is here to STRIP A DEAD KEY FROM HIS FILE, not to paper over a
    // warning, and it fails loudly if someone later makes the screen broader
    // and reintroduces a warning the migration is supposed to have handled.
    const announced: string[] = [];
    ingestSettingsFile(
      { occasions: { leadDaysAhead: 14, finalStretchDays: 2 } },
      '/nowhere/settings.json',
      {
        write: () => undefined,
        onNotice: (entry) => { announced.push(entry.key); },
      },
    );
    // A prefix-alike in the same section IS announced...
    expect(announced).toContain('occasions.leadDaysAhead');
    // ...and the retired key, in the same file and the same pass, is not.
    expect(announced).not.toContain('occasions.finalStretchDays');
  });

  test('the owner path is screened after its migration too, not only the reader path', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithRetiredKey('gv-fs-owner-screen', 'goodvibes');
    const daemon = new ConfigManager({
      configDir,
      homeDir: home,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      ownsDaemonTier: true,
    });
    // Loading did not refuse, the neighbour resolved, and the key is gone from
    // both the file and the resolved view.
    expect(daemon.get('occasions.leadDays')).toBe(14);
    expect(readFileSync(daemonTierPath, 'utf-8')).not.toContain('finalStretchDays');
  });
});
