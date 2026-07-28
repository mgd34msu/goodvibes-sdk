/**
 * owner-profile-consumers.test.ts — docs/owner-profile.md §13.
 *
 * Covers test-plan item 20 (consumer fallback direction) and the three
 * properties the design attaches to it that are easy to get backwards:
 *
 *  - the fallback fills an UNSET key and never overrides a configured one;
 *  - it applies to `ConfigManager.get()` and to NOTHING else — not `getAll()`,
 *    not `getCategory()`, not `getRaw()` — because a config dump resolving
 *    through the profile would put a shipping address in front of a caller that
 *    asked for "the settings" and never triggered the closed-tier disclosure
 *    rule (§13.1);
 *  - an INVALID mechanical value falls back exactly as an unset one does (§4.3),
 *    so `timezone: Mars/Olympus` never reaches a consumer.
 *
 * Also proves the rows for keys that do not exist on this branch are genuinely
 * inert, and that `security/owner-identity.ts` is deliberately NOT wired.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { isUnsetConfigValue, resolveWithProfileFallback } from '../packages/sdk/src/platform/config/profile-fallback.ts';
import { DAEMON_OWNED_CONFIG_PREFIXES } from '../packages/sdk/src/platform/config/config-ownership.ts';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';
import {
  CONSUMER_FALLBACKS,
  closedTierRedactionValues,
  createConsumerFallbackReader,
  installOwnerProfileConsumers,
  profileFallbackStatus,
  splitPostalAddress,
} from '../packages/sdk/src/platform/owner-profile/consumers.ts';
import {
  registerSignupBaseAddressFallback,
  resolveSignupBaseAddress,
} from '../packages/sdk/src/platform/google/account-registry.ts';
import {
  OWNER_ADDRESS_CONFIG_KEYS,
  resolveOwnerAddresses,
} from '../packages/sdk/src/platform/security/owner-identity.ts';
import { registerProfileRedactionValues } from '../packages/sdk/src/platform/utils/redaction.ts';
import { registerOpenTierContextBlock } from '../packages/sdk/src/platform/owner-profile/context-block.ts';

const FIXTURE = [
  '# Mike\'s profile',
  '',
  '## Contact',
  '',
  'email: owner@example.com',
  '',
  '## Location',
  '',
  'timezone: Mars/Olympus',
  '',
  '## Commerce',
  '',
  'shipping address: 200 Office Way, Lansing, MI 48933, US',
  'currency: USD',
  '',
  '## Contacting me',
  '',
  'channel: telegram',
  'quiet hours: 22:00-07:00',
  '',
  '## People',
  '',
  '- Sarah, sister, sarah@example.com',
  '',
].join('\n');

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-consumers-'));
  tmpDirs.push(dir);
  return dir;
}
// installOwnerProfileConsumers registers three PROCESS-level readers, and the
// suite runs every test file in one process. Leaving them installed would let
// this file's fixture profile redact strings in a later file's assertions — a
// cross-file failure that looks like a defect in whichever file ran next.
afterEach(() => {
  registerSignupBaseAddressFallback(null);
  registerProfileRedactionValues(null);
  registerOpenTierContextBlock(null);
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadedStore(text: string = FIXTURE): Promise<OwnerProfileStore> {
  const dir = mkTemp();
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, text, 'utf-8');
  const store = new OwnerProfileStore({ path });
  await store.load();
  return store;
}

function freshConfig(): ConfigManager {
  const root = mkTemp();
  mkdirSync(join(root, 'cfg'), { recursive: true });
  return new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), homeDir: root });
}

describe('§12 — the profile config domain is real, editable and daemon-owned', () => {
  test('all eight keys exist with the design\'s defaults and carry a reasoned description', () => {
    const expected: Record<string, unknown> = {
      'profile.enabled': true,
      'profile.autonomousWrites': true,
      'profile.discloseWrites': true,
      'profile.injectOpenTier': true,
      'profile.discloseClosedTierReads': true,
      'profile.consumerFallback': true,
      'profile.reloadThrottleMs': 2000,
      'profile.path': '',
    };
    for (const [key, value] of Object.entries(expected)) {
      const setting = CONFIG_SCHEMA.find((entry) => entry.key === key);
      expect(setting, `missing schema row for ${key}`).toBeDefined();
      expect(setting?.default).toEqual(value);
      // A description that only restates the key name is not a reason.
      expect((setting?.description ?? '').length).toBeGreaterThan(80);
    }
    expect(DEFAULT_CONFIG.profile.reloadThrottleMs).toBe(2000);
    expect(DAEMON_OWNED_CONFIG_PREFIXES).toContain('profile.');
  });

  test('a live manager reads every profile key through get()', () => {
    const config = freshConfig();
    expect(config.get('profile.enabled')).toBe(true);
    expect(config.get('profile.injectOpenTier')).toBe(true);
    expect(config.get('profile.reloadThrottleMs')).toBe(2000);
    expect(config.get('profile.path')).toBe('');
  });
});

describe('§13.1 — fallback direction: an explicit value wins, the profile fills a gap', () => {
  test('an unset checkin key reads from the profile; a configured one does not', async () => {
    const store = await loadedStore();
    const config = freshConfig();

    // Before installation: the raw defaults, which are empty strings.
    expect(config.get('checkin.quietHours')).toBe('');
    expect(config.get('checkin.deliveryChannel')).toBe('');

    installOwnerProfileConsumers(store, {
      attachProfileFallback: (reader) => config.attachProfileFallback(reader),
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });

    expect(config.get('checkin.quietHours')).toBe('22:00-07:00');
    expect(config.get('checkin.deliveryChannel')).toBe('telegram');

    // An explicitly configured value beats the profile, in both directions of
    // the comparison: the stored value is returned and the profile is ignored.
    config.set('checkin.quietHours', '23:00-06:00');
    expect(config.get('checkin.quietHours')).toBe('23:00-06:00');
    expect(config.get('checkin.deliveryChannel')).toBe('telegram');
  });

  test('turning profile.consumerFallback off makes the key unset again, live', async () => {
    const store = await loadedStore();
    const config = freshConfig();
    let enabled = true;
    installOwnerProfileConsumers(store, {
      attachProfileFallback: (reader) => config.attachProfileFallback(reader),
      consumerFallbackEnabled: () => enabled,
      injectOpenTierEnabled: () => true,
    });
    expect(config.get('checkin.quietHours')).toBe('22:00-07:00');
    enabled = false;
    expect(config.get('checkin.quietHours')).toBe('');
  });

  test('the uninstall returned by the installer really disconnects it', async () => {
    const store = await loadedStore();
    const config = freshConfig();
    const uninstall = installOwnerProfileConsumers(store, {
      attachProfileFallback: (reader) => config.attachProfileFallback(reader),
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });
    expect(config.get('checkin.quietHours')).toBe('22:00-07:00');
    uninstall();
    expect(config.get('checkin.quietHours')).toBe('');
  });
});

describe('§13.1 — the fallback is confined to get(), and nothing else', () => {
  test('getAll, getCategory and getRaw all still report the key as unset', async () => {
    const store = await loadedStore();
    const config = freshConfig();
    installOwnerProfileConsumers(store, {
      attachProfileFallback: (reader) => config.attachProfileFallback(reader),
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });

    expect(config.get('checkin.quietHours')).toBe('22:00-07:00');

    expect(config.getAll().checkin.quietHours).toBe('');
    expect(config.getCategory('checkin').quietHours).toBe('');
    expect(config.getRaw().checkin.quietHours).toBe('');

    // And no bulk view carries a value that could only have come from the
    // profile. (`telegram` is deliberately not in this list: it is also a
    // surface name in the default config, so it would prove nothing.)
    const dumped = JSON.stringify(config.getAll());
    for (const value of ['22:00-07:00', '200 Office Way', 'owner@example.com', 'Sarah', 'Mars/Olympus']) {
      expect(dumped).not.toContain(value);
    }
  });
});

describe('§4.3 — an invalid mechanical value falls back exactly like an unset one', () => {
  test('timezone: Mars/Olympus never reaches a consumer through the fallback', async () => {
    const store = await loadedStore();
    const reader = createConsumerFallbackReader(store, () => true);
    expect(store.get('location.timezone')?.value).toBe('Mars/Olympus');
    expect(store.get('location.timezone')?.valid).toBe(false);
    expect(reader('daemon.timezone')).toBeUndefined();
  });
});

describe('§13.1 — rows for keys that do not exist yet are inert', () => {
  test('the declared map covers the design table, and the payments rows are absent from the schema', async () => {
    const store = await loadedStore();
    const keys = CONSUMER_FALLBACKS.map((row) => row.configKey);
    expect(keys).toContain('checkin.quietHours');
    expect(keys).toContain('checkin.deliveryChannel');
    expect(keys).toContain('daemon.timezone');
    expect(keys).toContain('payments.currency');
    expect(keys).toContain('payments.billingAddress.postalCode');
    expect(keys).toContain('payments.shippingAddress.line1');

    const schemaKeys = new Set(CONFIG_SCHEMA.map((entry) => entry.key as string));
    expect(schemaKeys.has('daemon.timezone')).toBe(false);
    expect(schemaKeys.has('payments.currency')).toBe(false);

    // A report over the map must not throw on the rows whose section does not
    // exist — resolvePath() throws for those, and the status helper catches it.
    const config = freshConfig();
    const status = profileFallbackStatus(store, (key) => config.get(key as never));
    const byKey = new Map(status.map((row) => [row.configKey, row]));
    expect(byKey.get('checkin.quietHours')?.keyExists).toBe(true);
    expect(byKey.get('checkin.quietHours')?.resolvesFromProfile).toBe(true);
    expect(byKey.get('payments.currency')?.keyExists).toBe(false);
    expect(byKey.get('payments.currency')?.resolvesFromProfile).toBe(false);
    // A status report names keys and fields; it never carries a value.
    expect(JSON.stringify(status)).not.toContain('22:00-07:00');
  });

  test('the payments address rows resolve their parts once such a key exists', async () => {
    const store = await loadedStore();
    const reader = createConsumerFallbackReader(store, () => true);
    expect(reader('payments.shippingAddress.line1')).toBe('200 Office Way');
    expect(reader('payments.shippingAddress.city')).toBe('Lansing');
    expect(reader('payments.shippingAddress.region')).toBe('MI');
    expect(reader('payments.shippingAddress.postalCode')).toBe('48933');
    expect(reader('payments.shippingAddress.country')).toBe('US');
    // Never invented: an address line holds an address, not an addressee.
    expect(reader('payments.shippingAddress.name')).toBeUndefined();
    expect(reader('payments.currency')).toBe('USD');
  });

  test('an address shape the parser cannot read yields nothing rather than a guess', () => {
    expect(splitPostalAddress('somewhere in Michigan')).toEqual({});
    expect(splitPostalAddress('')).toEqual({});
    // A multi-word region keeps all its words rather than losing the last one.
    expect(splitPostalAddress('Ring 4, Koeln, Nordrhein Westfalen, DE')).toEqual({
      country: 'DE',
      city: 'Koeln',
      region: 'Nordrhein Westfalen',
      line1: 'Ring 4',
    });
  });
});

describe('the unset predicate is narrow on purpose', () => {
  test('false and 0 are configured values, not gaps', () => {
    expect(isUnsetConfigValue(undefined)).toBe(true);
    expect(isUnsetConfigValue(null)).toBe(true);
    expect(isUnsetConfigValue('')).toBe(true);
    expect(isUnsetConfigValue('   ')).toBe(true);
    expect(isUnsetConfigValue(false)).toBe(false);
    expect(isUnsetConfigValue(0)).toBe(false);
    expect(isUnsetConfigValue('telegram')).toBe(false);
  });

  test('with no reader installed the stored value comes back untouched', () => {
    expect(resolveWithProfileFallback('checkin.quietHours', '', null)).toBe('');
    expect(resolveWithProfileFallback('checkin.quietHours', '', () => undefined)).toBe('');
    expect(resolveWithProfileFallback('checkin.quietHours', '', () => '22:00-07:00')).toBe('22:00-07:00');
    expect(resolveWithProfileFallback('checkin.quietHours', '09:00-10:00', () => '22:00-07:00'))
      .toBe('09:00-10:00');
  });
});

describe('§13.2 / §13.3 — the two direct consumers, and the one deliberately left alone', () => {
  test('signup base address falls back to the profile only when no mail account is configured', async () => {
    const store = await loadedStore();
    const config = freshConfig();

    expect(resolveSignupBaseAddress(undefined)).toBeUndefined();

    installOwnerProfileConsumers(store, {
      attachProfileFallback: (reader) => config.attachProfileFallback(reader),
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });

    expect(resolveSignupBaseAddress(undefined)).toBe('owner@example.com');
    expect(resolveSignupBaseAddress('')).toBe('owner@example.com');
    expect(resolveSignupBaseAddress('configured@example.com')).toBe('configured@example.com');
  });

  test('resolveOwnerAddresses still reads configuration only — the taint exemption is not widened', () => {
    // The keys that gate the send-to-owner-only exemption are all config paths;
    // no profile field id is among them, and none of them is a fallback row.
    const fallbackKeys = new Set(CONSUMER_FALLBACKS.map((row) => row.configKey));
    for (const key of OWNER_ADDRESS_CONFIG_KEYS) {
      expect(fallbackKeys.has(key)).toBe(false);
    }
  });
});

describe('closed-tier value set for redaction', () => {
  test('collects closed-tier field values and People lines, and nothing open-tier', async () => {
    const store = await loadedStore();
    const { guarded, absolute } = closedTierRedactionValues(store);
    expect(guarded).toContain('200 Office Way, Lansing, MI 48933, US');
    expect(guarded).toContain('owner@example.com');
    expect(guarded).toContain('22:00-07:00');
    // People is third-party data: absolute, never subject to the floor.
    expect(absolute).toContain('Sarah, sister, sarah@example.com');
    expect(guarded).not.toContain('Sarah, sister, sarah@example.com');
    // Open tier is in context already and must never become a redaction pattern.
    expect(guarded).not.toContain('Mars/Olympus');
    expect(absolute).not.toContain('Mars/Olympus');
  });

  test('an unloaded profile contributes nothing', () => {
    const store = new OwnerProfileStore({ path: join(mkTemp(), 'nope.md'), enabled: false });
    expect(closedTierRedactionValues(store)).toEqual({ guarded: [], absolute: [] });
  });
});

describe('the two halves of "inert until the payments branch merges" are not the same', () => {
  test('daemon.timezone is LIVE now, because the daemon section already exists', async () => {
    const store = await loadedStore();
    const config = freshConfig();

    // Not a schema key, so nothing legitimately reads it yet — but `resolvePath`
    // only walks as far as the PARENT section, and `daemon` exists. So the read
    // returns undefined, `isUnsetConfigValue` says unset, and the fallback fires.
    // Recorded here because the design table called this row inert and it is not.
    // The behaviour is the wanted one: the day `daemon.timezone` lands with an
    // empty default, nothing changes.
    expect(() => config.get('daemon.timezone' as never)).not.toThrow();
    expect(config.get('daemon.timezone' as never)).toBeUndefined();

    installOwnerProfileConsumers(store, {
      attachProfileFallback: (reader) => config.attachProfileFallback(reader),
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });

    // The fixture's timezone is invalid, so it falls back as if unset (§4.3).
    expect(config.get('daemon.timezone' as never)).toBeUndefined();

    // With a valid one it resolves, which is the behaviour the row is for.
    const valid = await loadedStore(FIXTURE.replace('timezone: Mars/Olympus', 'timezone: America/Detroit'));
    const config2 = freshConfig();
    installOwnerProfileConsumers(valid, {
      attachProfileFallback: (reader) => config2.attachProfileFallback(reader),
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });
    expect(config2.get('daemon.timezone' as never)).toBe('America/Detroit');
  });

  test('payments.* genuinely throws, so those rows really are inert', () => {
    const config = freshConfig();
    for (const key of ['payments.currency', 'payments.shippingAddress.city']) {
      expect(() => config.get(key as never)).toThrow(/section 'payments' does not exist/);
    }
  });
});

describe('§13.3 — the taint exemption must never be fed from the profile', () => {
  test('no owner-address config key is a fallback row, asserted not assumed', () => {
    const fallbackKeys = new Set(CONSUMER_FALLBACKS.map((row) => row.configKey));
    for (const key of OWNER_ADDRESS_CONFIG_KEYS) {
      expect(
        fallbackKeys.has(key),
        `${key} gates the send-to-owner-only exemption to the content-taint rule and must not `
        + 'resolve through the owner profile: a profile written autonomously from conversation is a '
        + 'weaker input than daemon config, and routing it here would lower a bar owner-identity.ts '
        + 'documents as high (docs/owner-profile.md §13.3).',
      ).toBe(false);
    }
  });

  test('and resolveOwnerAddresses reads none of them from a profile-backed manager', async () => {
    const store = await loadedStore();
    const config = freshConfig();
    installOwnerProfileConsumers(store, {
      attachProfileFallback: (reader) => config.attachProfileFallback(reader),
      consumerFallbackEnabled: () => true,
      injectOpenTierEnabled: () => true,
    });
    // contact.email is owner@example.com in the fixture. If any owner-address
    // key ever fell back to it, the exemption would fire on a value the owner
    // never wrote into daemon config.
    const addresses = resolveOwnerAddresses((key) => {
      try {
        return config.get(key as never);
      } catch {
        return undefined;
      }
    });
    expect([...addresses]).toEqual([]);
  });
});
