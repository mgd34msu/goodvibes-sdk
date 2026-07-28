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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOrCreateDaemonPath } from '../packages/sdk/src/platform/config/daemon-tier-paths.ts';
import type { DaemonOwnedConfigPath } from '../packages/sdk/src/platform/config/config-ownership.ts';

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
