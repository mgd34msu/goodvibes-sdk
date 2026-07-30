/**
 * A credential must not sit in the clear in a settings file — and getting it
 * out must never be what breaks it.
 *
 * Three write paths put credentials there: the settings modal for any key its
 * secret-key set had missed (`surfaces.email.password` and
 * `surfaces.calendar.caldavPassword` were both missing, and both carry schema
 * descriptions reading "Stored in the daemon secret tier, never in config"), the
 * generic `/config set`, which had no detection at all, and the web UI's
 * settings editor, which wrote every value through one untyped call.
 *
 * Those are closed. This is the other half: the values already written.
 */

import { describe, expect, test } from 'bun:test';
import {
  describePlaintextSweep,
  secretReferenceFor,
  sweepPlaintextCredentials,
  type SweepableConfig,
  type SweepableSecrets,
} from '../packages/sdk/src/platform/config/plaintext-credential-sweep.ts';
import {
  isDeclaredSecretBearingConfigKey,
  isSecretBearingConfigKey,
  SECRET_BEARING_CONFIG_PATHS,
} from '../packages/sdk/src/platform/config/secret-bearing-config-keys.ts';
import { daemonSecretKeyFor } from '../packages/sdk/src/platform/config/daemon-secret-keys.ts';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { raiseReaderFloorInFile } from '../packages/sdk/src/platform/config/shared-config-tier.ts';
import {
  compareReaderVersions,
  readSettingsReaderFloor,
  SWEPT_CREDENTIAL_READER_FLOOR,
} from '../packages/sdk/src/platform/config/settings-reader-floor.ts';

const MAIL_PASSWORD = 'surfaces.email.password';
const MAIL_SECRET_KEY = daemonSecretKeyFor(MAIL_PASSWORD);

function fakeConfig(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  const config: SweepableConfig & { values: Record<string, unknown> } = {
    values,
    get: (key) => values[key],
    set: (key, value) => { values[key] = value; },
  };
  return config;
}

function fakeSecrets(initial: Record<string, string> = {}) {
  const stored: Record<string, string> = { ...initial };
  const failures: { write?: boolean; readBackReturns?: string | null } = {};
  const secrets: SweepableSecrets & { stored: Record<string, string>; failures: typeof failures } = {
    stored,
    failures,
    async set(key, value) {
      if (failures.write) throw new Error('the secret store is not writable');
      stored[key] = value;
    },
    async get(key) {
      if ('readBackReturns' in failures) return failures.readBackReturns ?? null;
      return stored[key] ?? null;
    },
    async getFromScope(key) {
      return stored[key] ?? null;
    },
  };
  return secrets;
}

describe('the declared set is the rule, and the name pattern is only a backstop', () => {
  test('the two keys whose own schema says "never in config" are declared', () => {
    expect(isDeclaredSecretBearingConfigKey('surfaces.email.password')).toBe(true);
    expect(isDeclaredSecretBearingConfigKey('surfaces.calendar.caldavPassword')).toBe(true);
  });

  test('every declared path is a real dotted config path, not a bare word', () => {
    for (const path of SECRET_BEARING_CONFIG_PATHS) {
      expect(path).toContain('.');
      expect(path.trim()).toBe(path);
    }
  });

  test('a key nobody declared is still caught by name rather than printed', () => {
    expect(isDeclaredSecretBearingConfigKey('surfaces.somethingnew.botToken')).toBe(false);
    expect(isSecretBearingConfigKey('surfaces.somethingnew.botToken')).toBe(true);
  });

  test('an ordinary setting is not treated as a credential', () => {
    for (const key of ['surfaces.email.imapHost', 'surfaces.telegram.botUsername', 'display.theme']) {
      expect(isSecretBearingConfigKey(key)).toBe(false);
    }
  });
});

describe('the sweep moves a literal out of config, and never breaks it doing so', () => {
  test('a plaintext password becomes a reference, and the value lands in the store', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const secrets = fakeSecrets();

    const report = await sweepPlaintextCredentials(config, secrets);

    expect(report.moved).toBe(1);
    expect(secrets.stored[MAIL_SECRET_KEY]).toBe('hunter2-test-only');
    expect(config.values[MAIL_PASSWORD]).toBe(secretReferenceFor(MAIL_SECRET_KEY));
    // The literal is gone from the config value entirely.
    expect(String(config.values[MAIL_PASSWORD])).not.toContain('hunter2');
  });

  test('running it again does nothing', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const secrets = fakeSecrets();
    await sweepPlaintextCredentials(config, secrets);
    const second = await sweepPlaintextCredentials(config, secrets);

    expect(second.noop).toBe(true);
    expect(config.values[MAIL_PASSWORD]).toBe(secretReferenceFor(MAIL_SECRET_KEY));
  });

  test('a value already stored as a reference is left alone', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: secretReferenceFor(MAIL_SECRET_KEY) });
    const report = await sweepPlaintextCredentials(config, fakeSecrets({ [MAIL_SECRET_KEY]: 'stored' }));
    expect(report.noop).toBe(true);
  });

  test('the literal survives when the store write throws', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const secrets = fakeSecrets();
    secrets.failures.write = true;

    const report = await sweepPlaintextCredentials(config, secrets);

    expect(report.failed).toBe(1);
    expect(report.entries[0]?.outcome).toBe('left-in-place');
    // Readable in the clear is bad. Replaced by a reference that resolves to
    // nothing is worse: that is the mailbox going silent.
    expect(config.values[MAIL_PASSWORD]).toBe('hunter2-test-only');
  });

  test('the literal survives when the store does not read back', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const secrets = fakeSecrets();
    secrets.failures.readBackReturns = null;

    const report = await sweepPlaintextCredentials(config, secrets);

    expect(report.failed).toBe(1);
    expect(config.values[MAIL_PASSWORD]).toBe('hunter2-test-only');
  });

  test('a value already in the store is not overwritten by an older config copy', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'old-pasted-copy' });
    const secrets = fakeSecrets({ [MAIL_SECRET_KEY]: 'the-one-in-use' });

    const report = await sweepPlaintextCredentials(config, secrets);

    expect(report.entries[0]?.outcome).toBe('already-stored');
    expect(secrets.stored[MAIL_SECRET_KEY]).toBe('the-one-in-use');
    expect(config.values[MAIL_PASSWORD]).toBe(secretReferenceFor(MAIL_SECRET_KEY));
  });

  test('a config section that does not exist is not an error', async () => {
    const config: SweepableConfig = {
      get: () => { throw new Error("Invalid config path: section 'surfaces' does not exist"); },
      set: () => { throw new Error('should never be reached'); },
    };
    const report = await sweepPlaintextCredentials(config, fakeSecrets());
    expect(report.noop).toBe(true);
  });

  test('the summary names what happened and never a value', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const report = await sweepPlaintextCredentials(config, fakeSecrets());
    const summary = describePlaintextSweep(report);
    expect(summary).toContain('moved out of config');
    expect(summary).not.toContain('hunter2');
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  test('a product may name a key the platform set does not', async () => {
    const config = fakeConfig({ 'surfaces.custom.apiToken': 'tok-test-only' });
    const secrets = fakeSecrets();
    const report = await sweepPlaintextCredentials(config, secrets, ['surfaces.custom.apiToken']);
    expect(report.moved).toBe(1);
    expect(secrets.stored[daemonSecretKeyFor('surfaces.custom.apiToken')]).toBe('tok-test-only');
  });

  test('a product cannot smuggle an ordinary setting through the extra-keys door', async () => {
    const config = fakeConfig({ 'display.theme': 'dark' });
    const report = await sweepPlaintextCredentials(config, fakeSecrets(), ['display.theme']);
    expect(report.noop).toBe(true);
    expect(config.values['display.theme']).toBe('dark');
  });
});

/**
 * A migration that rewrites SHARED state must record what a reader now needs.
 *
 * `~/.goodvibes/daemon/settings.json` is read by every component on the machine
 * and they are not all the same version at once. When this sweep rewrote a
 * literal into a `goodvibes://secrets/…` reference on `calendar.google.
 * clientSecretRef`, the daemon of the day could not walk that form and failed
 * while constructing its ConfigManager — reporting the KEY it tripped over
 * rather than the version gap that caused it. The floor is what lets the older
 * reader say the true thing instead. See config/settings-reader-floor.ts.
 */
describe('the sweep records the reader version its rewrite requires', () => {
  test('a rewrite raises the floor, naming the sweep as the cause', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const recorded: Array<{ version: string; setBy: string }> = [];

    await sweepPlaintextCredentials(config, fakeSecrets(), [], (version, setBy) => {
      recorded.push({ version, setBy });
    });

    expect(recorded).toEqual([{ version: SWEPT_CREDENTIAL_READER_FLOOR, setBy: 'credential-sweep' }]);
  });

  test('a sweep that rewrote nothing records nothing — a floor describes a rewrite', async () => {
    const config = fakeConfig({});
    const recorded: string[] = [];
    await sweepPlaintextCredentials(config, fakeSecrets(), [], (version) => { recorded.push(version); });
    expect(recorded).toHaveLength(0);
  });

  test('a rewrite that could not be verified leaves the literal AND records no floor', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const secrets = fakeSecrets();
    secrets.set = async () => { throw new Error('store unavailable'); };
    const recorded: string[] = [];

    const report = await sweepPlaintextCredentials(config, secrets, [], (version) => { recorded.push(version); });

    expect(report.failed).toBe(1);
    expect(config.values[MAIL_PASSWORD]).toBe('hunter2-test-only');
    expect(recorded).toHaveLength(0);
  });

  test('a floor that cannot be written does not undo a sweep that already succeeded', async () => {
    const config = fakeConfig({ [MAIL_PASSWORD]: 'hunter2-test-only' });
    const report = await sweepPlaintextCredentials(config, fakeSecrets(), [], () => {
      throw new Error('settings file is read-only');
    });
    // The credential is in the store and the config points at it. What was lost
    // is the paperwork, which must never cost a credential.
    expect(report.moved).toBe(1);
    expect(config.values[MAIL_PASSWORD]).toBe(secretReferenceFor(MAIL_SECRET_KEY));
  });
});

describe('raiseReaderFloorInFile', () => {
  test('writes the floor into an existing settings file, and never lowers it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-floor-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ display: { theme: 'dark' } }), 'utf-8');

    expect(raiseReaderFloorInFile(path, '1.20.0', 'credential-sweep')).toBe(true);
    const first = readSettingsReaderFloor(JSON.parse(readFileSync(path, 'utf-8')));
    expect(first?.minReaderVersion).toBe('1.20.0');
    expect(first?.setBy).toBe('credential-sweep');

    // Two migrations can rewrite the same file; the highest requirement governs.
    expect(raiseReaderFloorInFile(path, '1.19.0', 'something-older')).toBe(false);
    expect(readSettingsReaderFloor(JSON.parse(readFileSync(path, 'utf-8')))?.minReaderVersion).toBe('1.20.0');
    expect(raiseReaderFloorInFile(path, '1.21.0', 'a-newer-migration')).toBe(true);
    expect(readSettingsReaderFloor(JSON.parse(readFileSync(path, 'utf-8')))?.minReaderVersion).toBe('1.21.0');

    // The rest of the file is untouched.
    expect((JSON.parse(readFileSync(path, 'utf-8')) as { display: { theme: string } }).display.theme).toBe('dark');
  });

  test('a file that does not exist gets no marker — nothing was rewritten there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-floor-absent-'));
    const path = join(dir, 'settings.json');
    expect(raiseReaderFloorInFile(path, '1.20.0', 'credential-sweep')).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test('version comparison ignores a prerelease suffix rather than refusing to read', () => {
    // Ignoring a suffix can only make a reader MORE willing to read a file,
    // which is the safe direction for a check whose failure mode is not starting.
    expect(compareReaderVersions('1.21.0-rc.1', '1.21.0')).toBe(0);
    expect(compareReaderVersions('1.20.0', '1.21.0')).toBeLessThan(0);
    expect(compareReaderVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
});
