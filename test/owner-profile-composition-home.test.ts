/**
 * owner-profile-composition-home.test.ts — a runtime with an injected home
 * reads the profile under THAT home.
 *
 * The defect: `composeOwnerProfile` resolved the profile path through
 * `profile.path` → `--daemon-home` → `GOODVIBES_DAEMON_HOME` → the LOGIN user's
 * home, and nothing in that chain could see the home the runtime was actually
 * constructed with. A runtime given a scratch home — a test suite, an isolated
 * daemon, a second instance — therefore opened the profile of whoever was
 * logged in. That is how the daemon test suite came to read the owner's real
 * birthdays.
 *
 * The composition now takes `homeDir` and threads it into the resolver's own
 * `homeDir` option, in the position the login home occupied.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { composeOwnerProfile } from '../packages/sdk/src/platform/control-plane/routes/owner-profile-composition.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';

/** The `profile.*` slice the composition reads, with everything at its default. */
function configFor(overrides: Record<string, unknown> = {}): {
  get(key: string): never;
  attachProfileFallback(reader: unknown): void;
} {
  const values: Record<string, unknown> = {
    'profile.path': '',
    'profile.enabled': true,
    'profile.reloadThrottleMs': 1000,
    'profile.autonomousWrites': false,
    'profile.discloseWrites': true,
    'profile.discloseClosedTierReads': false,
    'profile.consumerFallback': true,
    'profile.injectOpenTier': true,
    ...overrides,
  };
  return {
    get: ((key: string): unknown => values[key]) as (key: string) => never,
    attachProfileFallback: (): void => undefined,
  };
}

/** Write a profile document under `<home>/.goodvibes/daemon/`. */
function seedProfile(home: string, marker: string): string {
  const dir = join(home, '.goodvibes', 'daemon');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, `# Owner profile\n\n- name: ${marker}\n`, 'utf-8');
  return path;
}

describe('owner-profile composition honours an injected home', () => {
  let savedDaemonHome: string | undefined;

  beforeEach(() => {
    savedDaemonHome = process.env['GOODVIBES_DAEMON_HOME'];
    delete process.env['GOODVIBES_DAEMON_HOME'];
  });

  afterEach(() => {
    if (savedDaemonHome === undefined) delete process.env['GOODVIBES_DAEMON_HOME'];
    else process.env['GOODVIBES_DAEMON_HOME'] = savedDaemonHome;
  });

  test('with the env unset, the profile resolves under the injected home', () => {
    const home = makeProjectTempDir('gv-profile-home');
    const expected = seedProfile(home, 'injected-home-owner');

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), {
      configManager: configFor(),
      homeDir: home,
    });

    try {
      expect(composed.store.path).toBe(expected);
    } finally {
      composed.dispose();
    }
  });

  test('the document actually read is the one under the injected home', () => {
    const home = makeProjectTempDir('gv-profile-home-content');
    seedProfile(home, 'injected-home-owner');

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), {
      configManager: configFor(),
      homeDir: home,
    });

    try {
      const state = composed.store.loadSync();
      expect(state.path).toContain(home);
    } finally {
      composed.dispose();
    }
  });

  test('no injected home still resolves — the login home remains the last resort', () => {
    const composed = composeOwnerProfile(new GatewayMethodCatalog(), { configManager: configFor() });
    try {
      expect(composed.store.path.length).toBeGreaterThan(0);
    } finally {
      composed.dispose();
    }
  });

  test('an explicit profile.path still wins over the injected home', () => {
    const home = makeProjectTempDir('gv-profile-home-override');
    seedProfile(home, 'not-this-one');
    const elsewhere = join(makeProjectTempDir('gv-profile-elsewhere'), 'chosen-profile.md');
    mkdirSync(join(elsewhere, '..'), { recursive: true });
    writeFileSync(elsewhere, '# Owner profile\n', 'utf-8');

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), {
      configManager: configFor({ 'profile.path': elsewhere }),
      homeDir: home,
    });

    try {
      expect(composed.store.path).toBe(elsewhere);
    } finally {
      composed.dispose();
    }
  });

  test('--daemon-home still wins over the injected home', () => {
    const home = makeProjectTempDir('gv-profile-home-loses');
    seedProfile(home, 'not-this-one');
    const daemonHome = makeProjectTempDir('gv-profile-daemon-home');

    const composed = composeOwnerProfile(new GatewayMethodCatalog(), {
      configManager: configFor(),
      daemonHome,
      homeDir: home,
    });

    try {
      expect(composed.store.path.startsWith(daemonHome)).toBe(true);
    } finally {
      composed.dispose();
    }
  });
});
