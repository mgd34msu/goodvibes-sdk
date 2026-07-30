/**
 * config-daemon-tier-app-sections.test.ts
 *
 * Storing a daemon-owned value must never make reading it back impossible.
 *
 * `email.*`, `calendar.*` and `google.*` are app-layer sections a product
 * materializes at runtime; they are not CONFIG_SCHEMA keys. The whole mail and
 * calendar connection was then made daemon-owned, so a value set from any
 * surface lands in the daemon tier instead of stranding in that surface's silo.
 *
 * Those two facts collided in the `ConfigManager` CONSTRUCTOR: the daemon-tier
 * overlay runs there, before any product has called its `ensure*` seeding, so a
 * daemon settings file containing `email.imapHost` made `resolvePath` throw
 * "section 'email' does not exist" — and every `ConfigManager` built against
 * that directory failed to construct. A daemon that had been configured
 * correctly could not start.
 *
 * That is strictly worse than the stranding the ownership change cured, so it
 * is pinned here: the section is created, the value survives, and the failure
 * mode is gone in both directions.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOrCreateDaemonPath } from '../packages/sdk/src/platform/config/daemon-tier-paths.ts';
import type { DaemonOwnedConfigPath } from '../packages/sdk/src/platform/config/config-ownership.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import {
  announceIngestionNotice,
  ingestSettingsFile,
  isSafetyGateConfigKey,
  SAFETY_GATE_CONFIG_PREFIXES,
} from '../packages/sdk/src/platform/config/settings-ingestion.ts';
import { CONFIG_SCHEMA } from '../packages/sdk/src/platform/config/schema.ts';

describe('resolveOrCreateDaemonPath', () => {
  test('creates a missing app-layer section instead of throwing', () => {
    const root: Record<string, unknown> = {};
    const slot = resolveOrCreateDaemonPath(root, 'email.imapHost' as DaemonOwnedConfigPath);
    slot.parent[slot.field] = 'imap.gmail.com';
    expect(root).toEqual({ email: { imapHost: 'imap.gmail.com' } });
  });

  test('creates nested sections, which is the shape surfaces.email.imap.host needs', () => {
    const root: Record<string, unknown> = {};
    const slot = resolveOrCreateDaemonPath(root, 'surfaces.email.imap.host' as DaemonOwnedConfigPath);
    slot.parent[slot.field] = 'imap.fastmail.com';
    expect(root).toEqual({ surfaces: { email: { imap: { host: 'imap.fastmail.com' } } } });
  });

  test('an existing section is used, not replaced — sibling values survive', () => {
    const root: Record<string, unknown> = { email: { username: 'someone@example.com' } };
    const slot = resolveOrCreateDaemonPath(root, 'email.imapHost' as DaemonOwnedConfigPath);
    slot.parent[slot.field] = 'imap.gmail.com';
    expect(root).toEqual({ email: { username: 'someone@example.com', imapHost: 'imap.gmail.com' } });
  });

  test('a non-object squatting where a section belongs is replaced rather than walked into', () => {
    // A hand edit can leave a string here. Throwing during construction is the
    // failure this module exists to remove, so the bad value loses.
    const root: Record<string, unknown> = { email: 'not-a-section' };
    const slot = resolveOrCreateDaemonPath(root, 'email.imapHost' as DaemonOwnedConfigPath);
    slot.parent[slot.field] = 'imap.gmail.com';
    expect(root).toEqual({ email: { imapHost: 'imap.gmail.com' } });
  });

  test('an array is treated the same way — indexing into it would corrupt the store', () => {
    const root: Record<string, unknown> = { email: ['stale'] };
    const slot = resolveOrCreateDaemonPath(root, 'email.imapHost' as DaemonOwnedConfigPath);
    slot.parent[slot.field] = 'imap.gmail.com';
    expect(root).toEqual({ email: { imapHost: 'imap.gmail.com' } });
  });
});

describe('a ConfigManager constructed over a daemon tier holding app-layer keys', () => {
  test('constructs, and the stored value is readable back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-daemon-tier-'));
    const daemonDir = join(root, 'daemon');
    mkdirSync(daemonDir, { recursive: true });
    // Exactly what a surface writes once the mail connection is daemon-owned.
    writeFileSync(
      join(daemonDir, 'settings.json'),
      // Nested, which is how the daemon tier is actually stored.
      JSON.stringify({ email: { imapHost: 'imap.gmail.com', enabled: true } }, null, 2),
      'utf-8',
    );

    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.ts');
    // The regression: this constructor used to throw
    // "section 'email' does not exist" and take the whole daemon down with it.
    const manager = new ConfigManager({
      homeDir: root,
      surfaceRoot: 'goodvibes',
      daemonTierPath: join(daemonDir, 'settings.json'),
    });
    expect(manager).toBeDefined();
    // And the daemon's value is the one that answers, which is the whole point
    // of the tier: a surface stored it, the daemon reads it back.
    // 'email.*' is an app-layer section, not a CONFIG_SCHEMA key — `get()`'s
    // generic signature has no ConfigKey literal for it, so the key is cast to
    // `never` (the only type assignable to every `K extends ConfigKey`) and the
    // resulting `ConfigValue<never>` (itself `never`) is widened to `unknown`
    // before asserting, rather than casting to a specific expected shape.
    expect(manager.get('email.imapHost' as never) as unknown).toBe('imap.gmail.com');
    expect(manager.get('email.enabled' as never) as unknown).toBe(true);
  });
});

/**
 * A daemon that cannot ingest a setting must refuse LOUDLY, never mutely.
 *
 * The 23:09 incident: a daemon read `calendar.google.clientSecretRef` — the
 * swept-credential reference a NEWER component wrote into the shared daemon
 * settings file — and exited 1 with nothing on stderr, nothing in the journal.
 * It crash-looped 77 times overnight and the owner found out by everything
 * being dead.
 *
 * These pin every ingestion failure mode's behaviour: what it prints, whether
 * the daemon carries on, and that the printed line always names the FILE, the
 * KEY and the REASON. See config/settings-ingestion.ts for the skip-or-refuse
 * rule and config/settings-reader-floor.ts for the mixed-version half.
 */

/** A ConfigManager over a temp home whose daemon tier holds exactly `settings`. */
function managerOverDaemonTier(settings: unknown): { manager: ConfigManager; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'gv-ingest-'));
  const daemonDir = join(root, 'daemon');
  mkdirSync(daemonDir, { recursive: true });
  const path = join(daemonDir, 'settings.json');
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
  const manager = new ConfigManager({ homeDir: root, surfaceRoot: 'goodvibes', daemonTierPath: path });
  return { manager, path };
}

/** Ingest a settings object, capturing what would have gone to stderr. */
function ingestCapturing(settings: Record<string, unknown>, file = '/tmp/settings.json'): {
  lines: string[];
  result: ReturnType<typeof ingestSettingsFile> | null;
  thrown: Error | null;
} {
  const lines: string[] = [];
  try {
    const result = ingestSettingsFile(settings, file, { write: (line) => { lines.push(line); } });
    return { lines, result, thrown: null };
  } catch (error) {
    return { lines, result: null, thrown: error as Error };
  }
}

describe('settings ingestion: the exact 23:09 shape', () => {
  test('a swept credential reference on an app-layer key ingests, with nothing quarantined', () => {
    const { manager } = managerOverDaemonTier({
      calendar: { google: { clientSecretRef: 'goodvibes://secrets/goodvibes/calendar.google.clientSecret' } },
    });
    expect(manager.get('calendar.google.clientSecretRef' as never) as unknown)
      .toBe('goodvibes://secrets/goodvibes/calendar.google.clientSecret');
    // The incident shape is now ordinary, readable settings — not a notice and
    // certainly not an exit.
    expect(manager.getIngestionQuarantine()).toHaveLength(0);
  });
});

describe('settings ingestion: a value the reader rejects', () => {
  test('a wrong-shaped value on a known key is skipped loudly and the rest still serves', () => {
    const { manager, path } = managerOverDaemonTier({
      controlPlane: { port: 'not-a-number' },
      display: { theme: 'dark' },
    });
    // The daemon is alive and running on the default for the one bad key.
    expect(manager.get('controlPlane.port')).toBe(3421);
    const [entry] = manager.getIngestionQuarantine();
    expect(entry).toBeDefined();
    expect(entry?.action).toBe('skipped');
    expect(entry?.key).toBe('controlPlane.port');
    expect(entry?.file).toBe(path);
    expect(entry?.reason).toContain('expects a number');
    expect(entry?.remedy).toContain('resolves to its default');
  });

  test('the notice names the file, the key and the reason on stderr', () => {
    const { lines } = ingestCapturing({ controlPlane: { port: 'not-a-number' } }, '/tmp/daemon/settings.json');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/tmp/daemon/settings.json');
    expect(lines[0]).toContain('controlPlane.port');
    expect(lines[0]).toContain('expects a number');
  });

  test('a section of the wrong type is skipped loudly, not silently discarded', () => {
    const { manager, path } = managerOverDaemonTier({ controlPlane: 'the-whole-section-is-a-string' });
    expect(manager.get('controlPlane.port')).toBe(3421);
    const [entry] = manager.getIngestionQuarantine();
    expect(entry?.key).toBe('controlPlane');
    expect(entry?.action).toBe('skipped');
    expect(entry?.file).toBe(path);
    expect(entry?.reason).toContain('is a section of settings');
  });
});

describe('settings ingestion: a key form from a newer component', () => {
  test('an unknown suffix on a known key is announced as one, and the file is left alone', () => {
    const { manager, path } = managerOverDaemonTier({
      calendar: { google: { 'clientSecretRef@v2': { ref: 'goodvibes://secrets/goodvibes/x' } } },
    });
    const [entry] = manager.getIngestionQuarantine();
    expect(entry?.key).toBe('calendar.google.clientSecretRef@v2');
    expect(entry?.action).toBe('skipped');
    expect(entry?.reason).toContain('newer form of calendar.google.clientSecretRef');
    // Never deleted: the file is shared, and a component that understands the
    // newer form must still find it there.
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(JSON.stringify(onDisk)).toContain('clientSecretRef@v2');
  });

  test('a genuinely unrelated app-layer key is left unremarked', () => {
    // App-layer sections legitimately carry keys the SDK has never heard of.
    // Flagging those would be noise, not a signal.
    const { manager } = managerOverDaemonTier({ email: { imapHost: 'imap.example.com', someProductKey: 1 } });
    expect(manager.getIngestionQuarantine()).toHaveLength(0);
  });
});

describe('settings ingestion: a secret reference that cannot be resolved', () => {
  test('is skipped loudly, and the notice never contains the value', () => {
    const { manager } = managerOverDaemonTier({ email: { passwordRef: 'goodvibes://secrets/' } });
    const [entry] = manager.getIngestionQuarantine();
    expect(entry?.key).toBe('email.passwordRef');
    // A credential is never in the refusing class: one connector down is a
    // degraded surface, not an open door, and it must not crash-loop.
    expect(entry?.action).toBe('skipped');
    expect(entry?.reason).toContain('secret reference that cannot be resolved');
  });

  test('a reference-shaped credential is described by shape only, never quoted', () => {
    const secret = 'goodvibes://secrets/hunter2-not-a-real-provider-path';
    const { lines } = ingestCapturing({ email: { passwordRef: secret } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('hunter2');
  });
});

describe('settings ingestion: the keys that refuse instead of skipping', () => {
  test('a rejected value on a tool approval gate refuses, naming file, key and reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-gate-'));
    const daemonDir = join(root, 'daemon');
    mkdirSync(daemonDir, { recursive: true });
    const path = join(daemonDir, 'settings.json');
    writeFileSync(path, JSON.stringify({ permissions: { tools: { exec: 'sometimes' } } }), 'utf-8');

    let message = '';
    try {
      new ConfigManager({ homeDir: root, surfaceRoot: 'goodvibes', daemonTierPath: path });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(path);
    expect(message).toContain('permissions.tools.exec');
    expect(message).toContain('expects one of allow, prompt, deny');
  });

  test('every refusing key has a shipped default that permits more than its strictest value', () => {
    // The rule the list encodes, checked rather than asserted in a comment: a
    // key only refuses when falling back to its default could OPEN something
    // the operator closed. `permissions.tools.*` defaults to allow/prompt while
    // `deny` exists; `permissions.mode` defaults to prompt while `plan` exists.
    const gated = CONFIG_SCHEMA.filter((setting) => isSafetyGateConfigKey(setting.key));
    expect(gated.length).toBeGreaterThan(0);
    for (const setting of gated) {
      if (setting.type !== 'enum' || !setting.enumValues) continue;
      const strictest = setting.enumValues[setting.enumValues.length - 1];
      expect(setting.default).not.toBe(strictest);
    }
  });

  test('the restrictive-by-default switches are NOT in the refusing class', () => {
    // danger.*, behavior.autoApprove and the control-plane exposure switches all
    // ship as false. Falling back to those can only ever close something, so
    // refusing to start over them would trade a safe fallback for a dead daemon.
    for (const key of ['danger.httpListener', 'behavior.autoApprove', 'controlPlane.allowRemote', 'controlPlane.trustProxy', 'sandbox.enabled']) {
      expect(isSafetyGateConfigKey(key)).toBe(false);
    }
    expect(SAFETY_GATE_CONFIG_PREFIXES.length).toBeGreaterThan(0);
  });
});

describe('settings ingestion: mixed versions', () => {
  test('a file migrated by a newer component reports the version gap, not the symptom', () => {
    const { lines, thrown } = ingestCapturing(
      {
        $goodvibes: { minReaderVersion: '99.0.0', setBy: 'credential-sweep', at: '2026-07-29T23:09:00.000Z' },
        // A key this reader would ALSO have rejected. The floor must win, so the
        // operator is told to update rather than sent hunting for a bad value.
        controlPlane: { port: 'not-a-number' },
      },
      '/tmp/daemon/settings.json',
    );
    expect(thrown?.name).toBe('SettingsIngestionRefusal');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('was migrated by a newer component (credential-sweep');
    expect(lines[0]).toContain('is older than the floor (99.0.0) — update it');
    expect(lines[0]).not.toContain('controlPlane.port');
  });

  test('a reader at or above the floor ingests normally, and the marker never becomes config', () => {
    const { manager } = managerOverDaemonTier({
      $goodvibes: { minReaderVersion: '0.0.1', setBy: 'credential-sweep', at: '2026-07-29T23:09:00.000Z' },
      calendar: { google: { clientSecretRef: 'goodvibes://secrets/goodvibes/calendar.google.clientSecret' } },
    });
    expect(manager.getIngestionQuarantine()).toHaveLength(0);
    expect(manager.get('calendar.google.clientSecretRef' as never) as unknown)
      .toBe('goodvibes://secrets/goodvibes/calendar.google.clientSecret');
    expect('$goodvibes' in (manager.getAll() as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('settings ingestion runs after the load-time migrations, not before', () => {
  test('a retired key the platform itself folds away is not reported as unknown', () => {
    // `sandbox.judgmentAutoApprove` is a key the legacy-settings migration
    // rewrites onto `sandbox.judgment` on every load. Screening the RAW file
    // would report it as an unknown form of a key the reader knows — true of
    // the bytes on disk and false of the config the reader actually builds.
    // A key the platform is about to rewrite itself is not one it fails to
    // understand, so the migrations run first and the screen sees the result.
    const configDir = mkdtempSync(join(tmpdir(), 'gv-ingest-order-'));
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ sandbox: { judgmentAutoApprove: true } }),
      'utf-8',
    );

    const manager = new ConfigManager({ configDir });
    expect(manager.getIngestionQuarantine()).toHaveLength(0);
  });
});

describe('the refusal reaches the operator even when the host has taken over stderr', () => {
  test('announceIngestionNotice writes to the descriptor, not through process.stderr', () => {
    // goodvibes-tui replaces `process.stderr.write` while a screen is rendered
    // (runtime/terminal-output-guard.ts), recording writes instead of printing
    // them. A fatal settings refusal routed through that wrapper is recorded
    // into a process that is about to stop existing — which is silence.
    //
    // So the default writer is `writeSync(2, …)`. This pins that: with
    // `process.stderr.write` replaced by a recorder, the recorder must stay
    // empty and the bytes must still leave the process.
    const recorded: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
      recorded.push(String(chunk));
      return true;
    }) as never;
    try {
      announceIngestionNotice({
        file: '/tmp/daemon/settings.json',
        key: 'permissions.tools.exec',
        reason: 'expects one of allow, prompt, deny',
        remedy: 'fix the value',
        action: 'refused',
      });
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original as never;
    }
    // Nothing was routed through the replaceable stream property.
    expect(recorded).toHaveLength(0);
  });
});
