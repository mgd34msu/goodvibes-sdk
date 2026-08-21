/**
 * daemon-tier-app-layer-sections.test.ts
 *
 * A daemon settings file holding a daemon-owned APP-LAYER path must not stop a
 * ConfigManager from being constructed.
 *
 * The mail and calendar connection was made daemon-owned so setup performed in
 * any surface reaches the daemon instead of stranding in that surface's silo.
 * But `email.*`, `calendar.*` and `google.*` are not CONFIG_SCHEMA sections,
 * a product materializes them at runtime through `ensureEmailConfigDefaults`
 * and friends.
 *
 * Those two facts collided. The daemon-tier overlay runs inside the
 * ConfigManager CONSTRUCTOR, before any product can call its `ensure*`, and the
 * path resolver threw on a section that was not already present. The result was
 * the worst possible shape: writing `email.imapHost` to the daemon store, the
 * correct place, by the platform's own ownership rule, made every later
 * ConfigManager built against that directory throw "section 'email' does not
 * exist" on construction. Storing the value bricked reading it back.
 *
 * The fix materializes the section. These tests pin both halves of why that is
 * safe: a declared daemon-owned app-layer path round-trips, and a path the
 * daemon does not own is not smuggled in alongside it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A config directory whose daemon tier already holds `daemonSettings`. */
function configRootWithDaemonTier(daemonSettings: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-daemon-tier-'));
  roots.push(root);
  const daemonDir = join(root, '.goodvibes', 'daemon');
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(daemonDir, 'settings.json'), JSON.stringify(daemonSettings, null, 2));
  return root;
}

function managerFor(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

/**
 * Read a dot-path out of the resolved config.
 *
 * `get()` is typed to CONFIG_SCHEMA keys and these paths deliberately are not
 * schema keys, that is the whole point of the case, so the read goes through
 * the raw resolved config the same way the app layer's own readers do.
 */
function readPath(manager: ConfigManager, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    manager.getRaw(),
  );
}

describe('a daemon-owned app-layer section does not brick config construction', () => {
  test('email.* in the daemon tier constructs, and the value is readable', () => {
    const root = configRootWithDaemonTier({
      email: { imapHost: 'imap.example.org', imapPort: 993 },
    });

    const manager = managerFor(root);

    // The point of the round trip: the value the daemon store held is the value
    // a reader gets back, not a default and not a throw.
    expect(readPath(manager, 'email.imapHost')).toBe('imap.example.org');
    expect(readPath(manager, 'email.imapPort')).toBe(993);
  });

  test('a second manager over the same directory sees it too', () => {
    const root = configRootWithDaemonTier({ email: { imapHost: 'imap.example.org' } });
    managerFor(root);
    // Survives a fresh process: this is what "the daemon reads it at 3am" means.
    expect(readPath(managerFor(root), 'email.imapHost')).toBe('imap.example.org');
  });

  test('google.* and calendar.* behave the same way', () => {
    const root = configRootWithDaemonTier({
      google: { oauth: { projectId: 'proj-1' } },
      calendar: { google: { clientId: 'client-1' } },
    });
    const manager = managerFor(root);
    expect(readPath(manager, 'google.oauth.projectId')).toBe('proj-1');
    expect(readPath(manager, 'calendar.google.clientId')).toBe('client-1');
  });

  test('a schema-declared daemon key still loads normally alongside them', () => {
    const root = configRootWithDaemonTier({
      email: { imapHost: 'imap.example.org' },
      surfaces: { email: { host: 'mail.example.org' } },
    });
    const manager = managerFor(root);
    expect(readPath(manager, 'email.imapHost')).toBe('imap.example.org');
    expect(manager.get('surfaces.email.host')).toBe('mail.example.org');
  });
});

describe('materializing a section is not a hole for arbitrary keys', () => {
  test('a section the daemon does not own is not overlaid from the daemon tier', () => {
    const root = configRootWithDaemonTier({
      email: { imapHost: 'imap.example.org' },
      // Not on any daemon-owned prefix or path. The overlay enumerates
      // daemon-owned paths, so this must not be picked up, and must not be
      // created as a side effect of the email section being created.
      notADaemonDomain: { invented: 'value' },
    });

    const manager = managerFor(root);

    expect(readPath(manager, 'email.imapHost')).toBe('imap.example.org');
    expect(readPath(manager, 'notADaemonDomain.invented')).toBeUndefined();
  });
});
