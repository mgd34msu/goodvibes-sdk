/**
 * daemon-tier-migration-ownership.test.ts — a process migrates ON DISK only the
 * files it owns.
 *
 * The defect this pins, from the owner's machine: `~/.goodvibes/daemon/
 * settings.json` is written by the daemon and READ by every terminal product,
 * because a client resolves daemon-owned keys in order to show and edit them.
 * The payments money-key migration ran during that read. So a client on the
 * 2.0.5 runtime renamed `payments.budget.perPurchaseCeilingCents` to
 * `perPurchaseCeiling` on disk while the running daemon was still 1.28.6 — and
 * that daemon, seeing a key its build did not know, skipped it. The configured
 * $100 ceiling stopped resolving. Nothing was corrupt and nothing was wrong
 * about the rename; the wrong process performed it.
 *
 * The rule under test: the owner migrates the file and files a receipt; a
 * non-owning reader migrates its in-memory view, writes no bytes, and files no
 * receipt — a receipt without the rename on disk would be a lie.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { ingestSettingsFile } from '../packages/sdk/src/platform/config/settings-ingestion.ts';
import {
  PAYMENTS_BUDGET_AMOUNTS_READER_FLOOR,
  readSettingsReaderFloor,
} from '../packages/sdk/src/platform/config/settings-reader-floor.ts';

/** An old-keys daemon store, plus the surface dirs a manager needs. */
function makeHomeWithOldKeysFile(label: string, surface: string): {
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
    JSON.stringify(
      { payments: { budget: { perPurchaseCeilingCents: 10_000, dailyItemCents: 2500 } } },
      null,
      2,
    ),
    'utf-8',
  );
  return { home, configDir, daemonTierPath };
}

/** The announce-once receipt file a migration writes into, as text ('' when absent). */
function receiptsText(manager: ConfigManager): string {
  const path = join(manager.getControlPlaneConfigDir(), 'control-plane', 'feature-announcements.json');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

describe('a client reads the daemon tier without rewriting it', () => {
  test('an old-keys file resolves under the NEW names in memory', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-own-client-view', 'tui');

    const client = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });

    // This is the half that must keep working: a freshly-installed client on a
    // file nobody has migrated yet still resolves the owner's real limits.
    expect(client.get('payments.budget.perPurchaseCeiling')).toBe(100);
    expect(client.get('payments.budget.dailyItem')).toBe(25);
  });

  test('the file bytes are UNCHANGED — byte for byte, not merely equivalent', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-own-client-bytes', 'tui');
    const before = readFileSync(daemonTierPath, 'utf-8');

    new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });

    const after = readFileSync(daemonTierPath, 'utf-8');
    expect(after).toBe(before);
    // Said the other way round, because this is the shape the older daemon reads:
    expect(after).toContain('perPurchaseCeilingCents');
    expect(after).not.toContain('"perPurchaseCeiling"');
  });

  test('no receipt is filed — a receipt without the rename on disk would lie', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-own-client-receipt', 'tui');

    const client = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });

    expect(receiptsText(client)).not.toContain('payments.budget.perPurchaseCeilingCents');
  });

  test('reading it repeatedly never drifts into a write', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-own-client-repeat', 'tui');
    const before = readFileSync(daemonTierPath, 'utf-8');

    for (let run = 0; run < 3; run += 1) {
      const client = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });
      expect(client.get('payments.budget.perPurchaseCeiling')).toBe(100);
    }

    expect(readFileSync(daemonTierPath, 'utf-8')).toBe(before);
  });

  test('ownership is opt-in: a manager that never mentions it is a reader', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-own-default', 'agent');
    const before = readFileSync(daemonTierPath, 'utf-8');

    // No `ownsDaemonTier` at all. The default has to be the non-writing answer:
    // a runtime that has not said it owns the file must not be assumed to.
    new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'agent', daemonTierPath });

    expect(readFileSync(daemonTierPath, 'utf-8')).toBe(before);
  });
});

describe('the daemon migrates the file it owns', () => {
  test('the file is rewritten under the new names and a receipt is filed', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-own-daemon', 'goodvibes');

    const daemon = new ConfigManager({
      configDir,
      homeDir: home,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      ownsDaemonTier: true,
    });

    expect(daemon.get('payments.budget.perPurchaseCeiling')).toBe(100);

    const onDisk = readFileSync(daemonTierPath, 'utf-8');
    expect(onDisk).toContain('"perPurchaseCeiling": 100');
    expect(onDisk).toContain('"dailyItem": 25');
    expect(onDisk).not.toContain('Cents');

    expect(receiptsText(daemon)).toContain(
      'payments.budget.perPurchaseCeilingCents 10000 is now payments.budget.perPurchaseCeiling 100',
    );
  });
});

describe('the migrated file says which reader can understand it', () => {
  test('the owner records the reader floor in the same file it just rewrote', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-floor-owner', 'goodvibes');

    new ConfigManager({
      configDir,
      homeDir: home,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      ownsDaemonTier: true,
    });

    const floor = readSettingsReaderFloor(
      JSON.parse(readFileSync(daemonTierPath, 'utf-8')) as Record<string, unknown>,
    );
    expect(floor).not.toBeNull();
    expect(floor!.minReaderVersion).toBe(PAYMENTS_BUDGET_AMOUNTS_READER_FLOOR);
    expect(floor!.setBy).toBe('payments-budget-amounts-migration');
    expect(floor!.at).not.toBe('');
  });

  test('the rename and the floor land in ONE write — no file state has one without the other', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-floor-atomic', 'goodvibes');

    new ConfigManager({
      configDir, homeDir: home, surfaceRoot: 'goodvibes', daemonTierPath, ownsDaemonTier: true,
    });

    // Whatever an older daemon reads next, it reads both facts together.
    const text = readFileSync(daemonTierPath, 'utf-8');
    expect(text).toContain('"perPurchaseCeiling": 100');
    expect(text).toContain('$goodvibes');
  });

  test('the client raises NOTHING — it wrote nothing to record a floor about', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-floor-client', 'tui');

    new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });

    const text = readFileSync(daemonTierPath, 'utf-8');
    expect(text).not.toContain('$goodvibes');
    expect(
      readSettingsReaderFloor(JSON.parse(text) as Record<string, unknown>),
    ).toBeNull();
  });

  test('the floor composes with the receipt: both are produced by the one owner load', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-floor-receipt', 'goodvibes');

    const daemon = new ConfigManager({
      configDir, homeDir: home, surfaceRoot: 'goodvibes', daemonTierPath, ownsDaemonTier: true,
    });

    // The receipt still names every key and both values...
    expect(receiptsText(daemon)).toContain(
      'payments.budget.perPurchaseCeilingCents 10000 is now payments.budget.perPurchaseCeiling 100',
    );
    // ...the floor is on the file...
    expect(
      readSettingsReaderFloor(JSON.parse(readFileSync(daemonTierPath, 'utf-8')) as Record<string, unknown>)
        ?.minReaderVersion,
    ).toBe(PAYMENTS_BUDGET_AMOUNTS_READER_FLOOR);
    // ...and the values still resolve.
    expect(daemon.get('payments.budget.perPurchaseCeiling')).toBe(100);
  });

  test('the marker never reaches the config: no key is reported as one this build does not know', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-floor-quiet', 'goodvibes');

    const daemon = new ConfigManager({
      configDir, homeDir: home, surfaceRoot: 'goodvibes', daemonTierPath, ownsDaemonTier: true,
    });

    // The floor is a marker ABOUT the file, not a setting in it. If it were
    // screened it would be announced as an unknown key — the exact sentence
    // this whole change exists to stop producing.
    expect(daemon.getIngestionQuarantine().filter((n) => n.key.includes('goodvibes'))).toEqual([]);

    // And a reader at or above the floor is not refused by its own marker.
    const reread = new ConfigManager({
      configDir, homeDir: home, surfaceRoot: 'goodvibes', daemonTierPath, ownsDaemonTier: true,
    });
    expect(reread.get('payments.budget.perPurchaseCeiling')).toBe(100);
  });

  test('an older reader refuses loudly and names the version, instead of skipping the limits', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-floor-old-reader', 'goodvibes');
    new ConfigManager({
      configDir, homeDir: home, surfaceRoot: 'goodvibes', daemonTierPath, ownsDaemonTier: true,
    });
    const migrated = JSON.parse(readFileSync(daemonTierPath, 'utf-8')) as Record<string, unknown>;

    // This is the daemon that was actually running on his machine.
    const said: string[] = [];
    let refusal = '';
    try {
      ingestSettingsFile(migrated, daemonTierPath, {
        readerVersion: '1.28.6',
        write: (line) => { said.push(line); },
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    // It refuses on the VERSION — the cause — naming both numbers and the fix.
    expect(refusal).toContain('1.28.6');
    expect(refusal).toContain(PAYMENTS_BUDGET_AMOUNTS_READER_FLOOR);
    expect(refusal).toContain('payments-budget-amounts-migration');
    // And it never blames one of the renamed keys, which is the symptom.
    expect(refusal).not.toContain('perPurchaseCeiling is not a setting');
    expect(said.join('\n')).toContain('update');
  });
});

describe('the skew that actually happened', () => {
  test('client load then daemon load: the file is migrated exactly once, by the daemon', () => {
    const { home, configDir, daemonTierPath } = makeHomeWithOldKeysFile('gv-own-skew', 'tui');
    const original = readFileSync(daemonTierPath, 'utf-8');

    // 1. The new client starts first — this is the step that broke the machine.
    const client = new ConfigManager({
      configDir: join(home, '.goodvibes', 'tui'),
      homeDir: home,
      surfaceRoot: 'tui',
      daemonTierPath,
    });
    expect(client.get('payments.budget.perPurchaseCeiling')).toBe(100);

    // The older daemon still running at this moment reads what it always read.
    expect(readFileSync(daemonTierPath, 'utf-8')).toBe(original);

    // 2. The daemon is updated and restarts. Now the owner migrates.
    const daemonConfigDir = join(home, '.goodvibes', 'goodvibes');
    mkdirSync(daemonConfigDir, { recursive: true });
    const daemon = new ConfigManager({
      configDir: daemonConfigDir,
      homeDir: home,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      ownsDaemonTier: true,
    });

    const migrated = readFileSync(daemonTierPath, 'utf-8');
    expect(migrated).toContain('"perPurchaseCeiling": 100');
    expect(migrated).not.toContain('Cents');
    expect(daemon.get('payments.budget.perPurchaseCeiling')).toBe(100);

    // 3. Exactly once. The migration is idempotent, so a second owner load has
    // nothing left to rename — the bytes settle and stop moving.
    const daemonAgain = new ConfigManager({
      configDir: daemonConfigDir,
      homeDir: home,
      surfaceRoot: 'goodvibes',
      daemonTierPath,
      ownsDaemonTier: true,
    });
    expect(readFileSync(daemonTierPath, 'utf-8')).toBe(migrated);
    expect(daemonAgain.get('payments.budget.perPurchaseCeiling')).toBe(100);

    // 4. And the client, back on the migrated file, reads the same number it
    // read before anything moved. Both sides agree throughout.
    const clientAfter = new ConfigManager({
      configDir: join(home, '.goodvibes', 'tui'),
      homeDir: home,
      surfaceRoot: 'tui',
      daemonTierPath,
    });
    expect(clientAfter.get('payments.budget.perPurchaseCeiling')).toBe(100);
    expect(readFileSync(daemonTierPath, 'utf-8')).toBe(migrated);
  });
});
