/**
 * owner-profile-composition-readiness.test.ts, docs/owner-profile.md §4.4.
 *
 * "Your profile has not been loaded yet" is not one of the three states.
 *
 * `composeOwnerProfile` is called from a synchronous composition root, and it
 * used to start the load and return: `void store.load().then(() => watch())`.
 * For the first milliseconds of daemon life every verb answered with a pre-load
 * sentinel that §4.4 does not sanction, a fourth state, and the empty-profile
 * dishonesty wearing a different sentence.
 *
 * Below the verb layer it was worse, because nothing logged it.
 * `installOwnerProfileConsumers` runs in that same window: the fallback is
 * attached but resolves nothing, so `checkin.quietHours` reads as UNSET rather
 * than as its profile value, and a first turn landing there gets no open-tier
 * block. The owner would see a check-in fire at the wrong hour once after a
 * restart with nothing to connect it to.
 *
 * That second half is why the fix is a synchronous read and not a readiness
 * promise: `ConfigManager.get()` is synchronous, so a fallback reader has
 * nothing to await with. No promise could have closed it.
 *
 * Every case here calls through the real `composeOwnerProfile` and asserts
 * WITHOUT awaiting anything, because the window only exists for a caller that
 * does not await. A stubbed store constructed already-loaded cannot see this
 * bug at all, which is why it survived the round that introduced it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { composeOwnerProfile } from '../packages/sdk/src/platform/control-plane/routes/owner-profile-composition.ts';
import { openTierContextBlock } from '../packages/sdk/src/platform/owner-profile/context-block.ts';
import { registerProfileRedactionValues } from '../packages/sdk/src/platform/utils/redaction.ts';
import { registerOpenTierContextBlock } from '../packages/sdk/src/platform/owner-profile/context-block.ts';
import { registerSignupBaseAddressFallback } from '../packages/sdk/src/platform/google/account-registry.ts';

const FIXTURE = [
  "# Mike's profile",
  '',
  '## Identity',
  '',
  'goes by: Mike',
  '',
  '## Location',
  '',
  'city: Lansing, MI',
  'timezone: America/Detroit',
  '',
  '## Contact',
  '',
  'email: owner@example.com',
  '',
  '## Contacting me',
  '',
  'channel: telegram',
  'quiet hours: 22:00-07:00',
  '',
].join('\n');

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-ready-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  // composeOwnerProfile installs process-level readers; a later file must not
  // inherit this fixture's profile.
  registerProfileRedactionValues(null);
  registerOpenTierContextBlock(null);
  registerSignupBaseAddressFallback(null);
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A composed daemon, exactly as `registerGatewayVerbGroups` composes one. */
function compose(text: string = FIXTURE): {
  catalog: GatewayMethodCatalog;
  config: ConfigManager;
  dispose: () => void;
} {
  const root = mkTemp();
  mkdirSync(join(root, 'cfg'), { recursive: true });
  const profilePath = join(root, 'owner-profile.md');
  writeFileSync(profilePath, text, 'utf-8');

  const config = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), homeDir: root });
  config.set('profile.path', profilePath);

  const catalog = new GatewayMethodCatalog();
  // NOT awaited, deliberately. This is the call the composition root makes.
  const composed = composeOwnerProfile(catalog, { configManager: config });
  return { catalog, config, dispose: composed.dispose };
}

describe('§4.4 — a composed profile is never in a pre-load state', () => {
  test('profile.status answers loaded immediately, with no await anywhere', async () => {
    const { catalog, dispose } = compose();
    try {
      const status = await catalog.invoke('profile.status', { context: { admin: true }, body: {} }) as {
        kind: string;
        reason?: string;
        fieldCount?: number;
      };
      expect(status.kind).toBe('loaded');
      expect(status.reason).toBeUndefined();
      expect(status.fieldCount).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  test('the pre-load sentence is not reachable from any verb', async () => {
    const { catalog, dispose } = compose();
    try {
      for (const [id, body] of [
        ['profile.status', {}],
        ['profile.read', {}],
        ['profile.get', { fieldId: 'contact.email' }],
      ] as const) {
        const answer = await catalog.invoke(id, { context: { admin: true }, body });
        expect(JSON.stringify(answer)).not.toContain('has not been loaded');
      }
    } finally {
      dispose();
    }
  });

  test('a named read returns the real value on the very first call', async () => {
    const { catalog, dispose } = compose();
    try {
      const answer = await catalog.invoke('profile.get', {
        context: { admin: true },
        body: { fieldId: 'contact.email' },
      }) as { present: boolean; field?: { value: string } };
      expect(answer.present).toBe(true);
      expect(answer.field?.value).toBe('owner@example.com');
    } finally {
      dispose();
    }
  });
});

describe('§13 — the consumer half, which no readiness promise could have fixed', () => {
  test('checkin.quietHours resolves from the profile on the first synchronous read', () => {
    const { config, dispose } = compose();
    try {
      // `ConfigManager.get` is synchronous. There is nothing here that could
      // await a load, which is exactly why the window had to be removed rather
      // than made awaitable.
      expect(config.get('checkin.quietHours')).toBe('22:00-07:00');
      expect(config.get('checkin.deliveryChannel')).toBe('telegram');
    } finally {
      dispose();
    }
  });

  test('daemon.timezone resolves too, on the same first read', () => {
    const { config, dispose } = compose();
    try {
      // `daemon.timezone` is not in ConfigKey on this tree, the payments lane
      // is what declares it (as a daemon-owned prefix in config-ownership.ts).
      // `as never` made the call match no `get` overload at all rather than
      // widening the key, so it is widened at the manager instead.
      const anyKeyConfig = config as unknown as { get(key: string): unknown };
      expect(anyKeyConfig.get('daemon.timezone')).toBe('America/Detroit');
    } finally {
      dispose();
    }
  });

  test('the open-tier block is populated for the first turn, not the second', () => {
    const { dispose } = compose();
    try {
      const block = openTierContextBlock();
      expect(block).toContain('Goes by: Mike');
      expect(block).toContain('City: Lansing, MI');
      // And never a closed-tier value, window or no window.
      expect(block).not.toContain('owner@example.com');
      expect(block).not.toContain('22:00-07:00');
    } finally {
      dispose();
    }
  });
});

describe('the three real states still arrive intact through composition', () => {
  test('a missing file is loaded-and-empty, not unavailable', async () => {
    const root = mkTemp();
    mkdirSync(join(root, 'cfg'), { recursive: true });
    const config = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), homeDir: root });
    config.set('profile.path', join(root, 'nothing-here.md'));
    const catalog = new GatewayMethodCatalog();
    const composed = composeOwnerProfile(catalog, { configManager: config });
    try {
      const status = await catalog.invoke('profile.status', { context: { admin: true }, body: {} }) as {
        kind: string;
        exists?: boolean;
      };
      expect(status.kind).toBe('loaded');
      expect(status.exists).toBe(false);
    } finally {
      composed.dispose();
    }
  });

  test('a file that is not valid UTF-8 is unavailable WITH the reason, immediately', async () => {
    const root = mkTemp();
    mkdirSync(join(root, 'cfg'), { recursive: true });
    const profilePath = join(root, 'owner-profile.md');
    // A UTF-16 mis-save: the accident behind almost every occurrence.
    writeFileSync(profilePath, Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]));
    const config = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), homeDir: root });
    config.set('profile.path', profilePath);
    const catalog = new GatewayMethodCatalog();
    const composed = composeOwnerProfile(catalog, { configManager: config });
    try {
      const status = await catalog.invoke('profile.status', { context: { admin: true }, body: {} }) as {
        kind: string;
        reason?: string;
      };
      expect(status.kind).toBe('unavailable');
      expect(status.reason).toContain('not valid UTF-8');
      // The reason names the real failure, never the pre-load sentinel.
      expect(status.reason).not.toContain('has not been loaded');
    } finally {
      composed.dispose();
    }
  });

  test('profile.enabled false is disabled, immediately', async () => {
    const root = mkTemp();
    mkdirSync(join(root, 'cfg'), { recursive: true });
    const profilePath = join(root, 'owner-profile.md');
    writeFileSync(profilePath, FIXTURE, 'utf-8');
    const config = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), homeDir: root });
    config.set('profile.path', profilePath);
    config.set('profile.enabled', false);
    const catalog = new GatewayMethodCatalog();
    const composed = composeOwnerProfile(catalog, { configManager: config });
    try {
      const status = await catalog.invoke('profile.status', { context: { admin: true }, body: {} }) as {
        kind: string;
      };
      expect(status.kind).toBe('disabled');
    } finally {
      composed.dispose();
    }
  });
});
