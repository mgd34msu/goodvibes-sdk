/**
 * inbound-email-config-schema.test.ts
 *
 * Gate tests for the `surfaces.email.inbound.*` config keys added for the
 * inbound-mail watcher (docs/inbound-email.md §8, §3.4d). Every one of these
 * keys is the owner's default to confirm, not a foregone conclusion, so this
 * file pins the exact defaults from the design table and the range each
 * numeric key is bounded to.
 *
 * Each test here was run BEFORE the schema keys existed and failed (missing
 * key / undefined default / `isDaemonOwnedConfigKey` false because the whole
 * key didn't exist yet). They are re-run now against the real schema.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { ConfigError } from '../packages/sdk/src/platform/types/errors.js';
import {
  isDaemonOwnedConfigKey,
  isClientOwnedConfigKey,
  configKeyScope,
  listDaemonOwnedConfigPaths,
} from '../packages/sdk/src/platform/config/config-ownership.js';
import {
  DEFAULT_VERIFICATION_WINDOW_MS,
  MAX_VERIFICATION_WINDOW_MS,
} from '../packages/sdk/src/platform/google/verification-expectations.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshManager(): ConfigManager {
  const root = mkdtempSync(join(tmpdir(), 'gv-inbound-email-schema-'));
  tmpRoots.push(root);
  return new ConfigManager({ configDir: join(root, 'config') });
}

/**
 * The twelve keys from docs/inbound-email.md §8, plus the two capability
 * keys added after the design doc landed (owner ruling relayed mid-round:
 * the daemon must state plainly, and refuse by default, when the mailbox
 * cannot do what inbound mail requires), plus the three source-selection keys
 * from §3.4d — Gmail is a first-class inbound source, and its poll interval is
 * adaptive because an open expectation and an idle week have genuinely
 * different needs.
 */
const EXPECTED_DEFAULTS: ReadonlyArray<{ key: string; default: unknown }> = [
  { key: 'surfaces.email.inbound.enabled', default: false },
  { key: 'surfaces.email.inbound.accounts', default: '[]' },
  { key: 'surfaces.email.inbound.source', default: 'auto' },
  { key: 'surfaces.email.inbound.gmailPollSecondsExpecting', default: 5 },
  { key: 'surfaces.email.inbound.gmailPollSecondsIdle', default: 60 },
  { key: 'surfaces.email.inbound.mode', default: 'auto' },
  { key: 'surfaces.email.inbound.pollIntervalSeconds', default: 120 },
  { key: 'surfaces.email.inbound.idleReissueMinutes', default: 27 },
  { key: 'surfaces.email.inbound.reconnect.maxBackoffSeconds', default: 300 },
  { key: 'surfaces.email.inbound.notice.route', default: 'default' },
  { key: 'surfaces.email.inbound.notice.mode', default: 'all' },
  { key: 'surfaces.email.inbound.expectationWindowMinutes', default: 15 },
  { key: 'surfaces.email.inbound.dedupTtlMinutes', default: 60 },
  { key: 'surfaces.email.inbound.retentionDays', default: 30 },
  { key: 'surfaces.email.inbound.maxRecords', default: 5000 },
  { key: 'surfaces.email.inbound.capabilityRecheckMinutes', default: 60 },
  { key: 'surfaces.email.inbound.onInsufficientCapability', default: 'refuse-and-notify' },
];

describe('every key from the §8 table is in CONFIG_SCHEMA with the exact default', () => {
  test.each(EXPECTED_DEFAULTS)('$key defaults to $default', ({ key, default: expected }) => {
    const row = CONFIG_SCHEMA.find((s) => s.key === key);
    expect(row, `${key} has no CONFIG_SCHEMA row at all`).toBeDefined();
    expect(row!.default).toBe(expected);
  });

  test('there are exactly seventeen inbound keys — not more, not fewer', () => {
    const inboundKeys = CONFIG_SCHEMA
      .map((s) => s.key)
      .filter((key) => key.startsWith('surfaces.email.inbound.'));
    expect(new Set(inboundKeys).size).toBe(17);
    expect(inboundKeys.sort()).toEqual(EXPECTED_DEFAULTS.map((e) => e.key).sort());
  });

  test.each(EXPECTED_DEFAULTS)('$key is reachable through DEFAULT_CONFIG with the same default', ({ key, default: expected }) => {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      DEFAULT_CONFIG,
    );
    expect(value).toBe(expected);
  });

  test.each(EXPECTED_DEFAULTS)('$key has a real, non-empty, user-facing description', ({ key }) => {
    const row = CONFIG_SCHEMA.find((s) => s.key === key)!;
    expect(row.description.length).toBeGreaterThan(20);
    // The description must not just restate the key name.
    expect(row.description.toLowerCase()).not.toBe(key.toLowerCase());
  });
});

describe('every new key is daemon-owned, because surfaces. is a daemon-owned prefix', () => {
  test.each(EXPECTED_DEFAULTS)('$key is daemon-owned', ({ key }) => {
    expect(isDaemonOwnedConfigKey(key)).toBe(true);
    expect(isClientOwnedConfigKey(key)).toBe(false);
    expect(configKeyScope(key)).toBe('daemon');
  });

  test('the owned-path walk includes every inbound key', () => {
    const paths = new Set(listDaemonOwnedConfigPaths());
    for (const { key } of EXPECTED_DEFAULTS) {
      expect(paths.has(key), `${key} is missing from listDaemonOwnedConfigPaths()`).toBe(true);
    }
  });

  test('a value set from the agent surface lands in the daemon store, not the agent silo', () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'gv-inbound-email-daemon-owned-'));
    tmpRoots.push(homeRoot);
    const agent = new ConfigManager({ homeDir: homeRoot, surfaceRoot: 'agent' });
    agent.set('surfaces.email.inbound.enabled', true);

    const daemonView = new ConfigManager({ homeDir: homeRoot, surfaceRoot: 'tui' });
    expect(daemonView.get('surfaces.email.inbound.enabled')).toBe(true);
    expect(daemonView.describeConfigKeySource('surfaces.email.inbound.enabled').tier).toBe('daemon');
  });
});

describe('range validators reject out-of-range values', () => {
  test('pollIntervalSeconds rejects below 30 and above 3600', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.pollIntervalSeconds', 29)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.pollIntervalSeconds', 3601)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.pollIntervalSeconds', 30)).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.pollIntervalSeconds', 3600)).not.toThrow();
  });

  test('idleReissueMinutes rejects below 5 and above 29 (RFC 2177 bound)', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.idleReissueMinutes', 4)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.idleReissueMinutes', 30)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.idleReissueMinutes', 5)).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.idleReissueMinutes', 29)).not.toThrow();
  });

  test('reconnect.maxBackoffSeconds rejects below 10 and above 3600', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.reconnect.maxBackoffSeconds', 9)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.reconnect.maxBackoffSeconds', 3601)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.reconnect.maxBackoffSeconds', 300)).not.toThrow();
  });

  test('expectationWindowMinutes rejects below 1 and above 60 (MAX_VERIFICATION_WINDOW_MS)', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.expectationWindowMinutes', 0)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.expectationWindowMinutes', 61)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.expectationWindowMinutes', 15)).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.expectationWindowMinutes', 60)).not.toThrow();
  });

  test('the 60-minute cap and 15-minute default track the shipped verification-window constants', () => {
    expect(MAX_VERIFICATION_WINDOW_MS / 60_000).toBe(60);
    expect(DEFAULT_VERIFICATION_WINDOW_MS / 60_000).toBe(15);
  });

  test('dedupTtlMinutes rejects below 5 and above 1440', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.dedupTtlMinutes', 4)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.dedupTtlMinutes', 1441)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.dedupTtlMinutes', 60)).not.toThrow();
  });

  test('retentionDays rejects below 1 and above 365', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.retentionDays', 0)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.retentionDays', 366)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.retentionDays', 30)).not.toThrow();
  });

  test('maxRecords rejects below 100 and above 100000', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.maxRecords', 99)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.maxRecords', 100_001)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.maxRecords', 5000)).not.toThrow();
  });

  test('mode rejects a value outside idle/poll/auto', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.mode' as never, 'push' as never)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.mode', 'idle')).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.mode', 'poll')).not.toThrow();
  });

  test('source rejects a value outside auto/gmail/imap', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.source' as never, 'exchange' as never)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.source', 'auto')).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.source', 'gmail')).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.source', 'imap')).not.toThrow();
  });

  test('gmailPollSecondsExpecting rejects below 2 and above 60', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsExpecting', 1)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsExpecting', 61)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsExpecting', 2)).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsExpecting', 60)).not.toThrow();
  });

  test('gmailPollSecondsIdle rejects below 10 and above 3600', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsIdle', 9)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsIdle', 3601)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsIdle', 10)).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.gmailPollSecondsIdle', 3600)).not.toThrow();
  });

  test('the expecting interval is the faster of the two, and both are polling latencies', () => {
    // Not a tautology: if these two defaults were ever swapped, the daemon
    // would poll every minute while someone waits on a signup form and every
    // five seconds all week when nobody is.
    const expecting = CONFIG_SCHEMA.find((s) => s.key === 'surfaces.email.inbound.gmailPollSecondsExpecting')!;
    const idle = CONFIG_SCHEMA.find((s) => s.key === 'surfaces.email.inbound.gmailPollSecondsIdle')!;
    expect(expecting.default as number).toBeLessThan(idle.default as number);
  });

  test('notice.mode rejects a value outside all/expected-only/none', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.notice.mode' as never, 'digest' as never)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.notice.mode', 'expected-only')).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.notice.mode', 'none')).not.toThrow();
  });

  test('accounts default parses as a valid, empty JSON array', () => {
    const row = CONFIG_SCHEMA.find((s) => s.key === 'surfaces.email.inbound.accounts')!;
    expect(JSON.parse(row.default as string)).toEqual([]);
  });

  test('capabilityRecheckMinutes rejects below 5 and above 1440', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.capabilityRecheckMinutes', 4)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.capabilityRecheckMinutes', 1441)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.capabilityRecheckMinutes', 60)).not.toThrow();
  });

  test('onInsufficientCapability rejects a value outside refuse-and-notify/notice-only', () => {
    const mgr = freshManager();
    expect(() => mgr.set('surfaces.email.inbound.onInsufficientCapability' as never, 'ignore' as never)).toThrow(ConfigError);
    expect(() => mgr.set('surfaces.email.inbound.onInsufficientCapability', 'notice-only')).not.toThrow();
    expect(() => mgr.set('surfaces.email.inbound.onInsufficientCapability', 'refuse-and-notify')).not.toThrow();
  });
});
