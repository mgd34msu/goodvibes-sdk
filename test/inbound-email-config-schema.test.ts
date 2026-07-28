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
 *
 * ## The half this file used to be missing
 *
 * Everything above is about the SCHEMA: the key exists, its default is the
 * documented one, its range refuses what it should. None of it says the
 * setting does anything. A key can have a perfect row, a validated range, a
 * daemon-owned scope and a user-facing description while nothing anywhere
 * reads it — and the coverage reads as complete precisely because the schema
 * half is thorough. `enabled` was the only key whose EFFECT was tested.
 *
 * So the last section drives `composeInboundMail` — the real production
 * assembly — with non-default values and asserts each one reaches the thing it
 * names. A setting that stops being read reddens there rather than continuing
 * to look configured.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
import { composeInboundMail } from '../packages/sdk/src/platform/daemon/facade-inbound-mail.js';
import { surfaceHasCommandAuthority } from '../packages/sdk/src/platform/security/untrusted-content.js';
import { capabilityVerdict } from '../packages/sdk/src/platform/email/inbound/capability.js';
import type {
  InboundCapabilityTransition,
  InboundCapabilityVerdict,
  InboundMailObserver,
} from '../packages/sdk/src/platform/email/inbound/ports.js';
import type {
  InboundMailSupervisor,
  InboundMailSupervisorDeps,
} from '../packages/sdk/src/platform/email/inbound/index.js';
import type { InboundWatcherSettings } from '../packages/sdk/src/platform/email/inbound/ports.js';
import type { StructuredNotice } from '../packages/sdk/src/platform/email/inbound-notice.js';
import type { GatewayMethodHandler } from '../packages/sdk/src/platform/control-plane/method-catalog.js';

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
// A mutable array: bun's scalar `test.each` overload is
// `each<const T>(table: T[])`, so a ReadonlyArray matches no overload and every
// row degrades to `any` — which is how these cases were running against
// untyped rows.
const EXPECTED_DEFAULTS: { key: string; default: unknown }[] = [
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
    expect(inboundKeys.map(String).sort()).toEqual(EXPECTED_DEFAULTS.map((e) => e.key).sort());
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
    // Compared as plain strings: listDaemonOwnedConfigPaths() returns the
    // branded DaemonOwnedConfigPath, and the expectation table is written in
    // ordinary key strings.
    const paths = new Set<string>(listDaemonOwnedConfigPaths().map(String));
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

// ---------------------------------------------------------------------------
// The settings TAKE EFFECT — driven through the real composition
// ---------------------------------------------------------------------------

const ACCOUNT = 'primary';
const WATCHED_MAILBOX = 'Verifications';

/** One capability transition, as the watcher's tracker emits them. */
function transitionTo(to: InboundCapabilityVerdict): InboundCapabilityTransition {
  return {
    account: ACCOUNT,
    mailbox: WATCHED_MAILBOX,
    from: null,
    to,
    at: '2026-07-28T09:00:00.000Z',
  };
}

/**
 * Announce a verdict down the path the SOURCE uses.
 *
 * Deliberately not `deps.observer` — that is the facade's observer, and
 * reaching it directly would skip the supervisor's own wrapper, which is where
 * `this.verdict` is recorded and therefore where the registry's capability
 * probe reads from. `observer()` is the object the supervisor hands to the
 * source it starts, so this is the whole chain: source → supervisor → facade
 * observer → registry.
 */
function announce(rig: ComposedRig, verdict: InboundCapabilityVerdict): void {
  const wrapped = (rig.supervisor as unknown as { observer(): InboundMailObserver }).observer();
  wrapped.stateChanged?.(transitionTo(verdict));
}

/**
 * Let the observer's `void`-ed continuation settle.
 *
 * `InboundMailObserver` is synchronous by contract — a report sink must never
 * hold up the watcher — so the registry write it starts finishes on the
 * microtask queue rather than before `stateChanged` returns.
 */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** One arriving message, shaped as the IMAP source hands it to the intake. */
function inboundMessage(): Parameters<InboundMailSupervisorDeps['handle']>[0] {
  return {
    source: 'imap',
    account: ACCOUNT,
    mailbox: WATCHED_MAILBOX,
    from: 'noreply@example.com',
    subject: 'Verify your email',
    claimedDate: 'Mon, 27 Jul 2026 11:59:00 +0000',
    messageId: '<abc@example.com>',
    deliveredTo: ['owner+gv-example-com@example.test'],
    unverifiedToHeaderClaim: 'owner@example.test',
    uidValidity: 42,
    uid: 137,
    envelope: {} as never,
    via: 'idle',
  } as never;
}

/**
 * Every production `.ts` under the SDK except the config definitions
 * themselves.
 *
 * Excluded on purpose: `config/` is where a key is DECLARED, and a declaration
 * is what an inert key already has. Counting it would make every key look
 * read.
 */
function readSourceFilesOutsideConfig(): string[] {
  const root = join(import.meta.dir, '..', 'packages', 'sdk', 'src');
  const texts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'config') walk(path);
        continue;
      }
      if (entry.name.endsWith('.ts')) texts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return texts;
}

/** Non-default everywhere, so a value that reached its destination is unambiguous. */
const NON_DEFAULT_CONFIG: Readonly<Record<string, unknown>> = {
  'surfaces.email.inbound.enabled': true,
  'surfaces.email.inbound.accounts': JSON.stringify([ACCOUNT, 'second-account']),
  'surfaces.email.inbound.source': 'imap',
  'surfaces.email.inbound.mode': 'poll',
  'surfaces.email.inbound.pollIntervalSeconds': 240,
  'surfaces.email.inbound.idleReissueMinutes': 11,
  'surfaces.email.inbound.reconnect.maxBackoffSeconds': 45,
  'surfaces.email.inbound.capabilityRecheckMinutes': 17,
  'surfaces.email.inbound.expectationWindowMinutes': 7,
  'surfaces.email.inbound.dedupTtlMinutes': 23,
  'surfaces.email.inbound.retentionDays': 3,
  'surfaces.email.inbound.maxRecords': 321,
  'surfaces.email.inbound.notice.mode': 'none',
  'surfaces.email.inbound.notice.route': 'default',
  // Needed for the IMAP source to be constructible at all.
  'surfaces.email.imap.host': 'imap.example.test',
  'surfaces.email.user': 'watched@example.test',
  'surfaces.email.imap.mailbox': WATCHED_MAILBOX,
};

interface ComposedRig {
  readonly supervisor: InboundMailSupervisor;
  readonly deps: InboundMailSupervisorDeps;
  readonly handlers: Map<string, GatewayMethodHandler>;
  readonly notices: { binding: unknown; notice: StructuredNotice }[];
}

/**
 * Build the real inbound-mail graph over a throwaway directory.
 *
 * Nothing here opens a socket: the IMAP source is CONSTRUCTED (which is where
 * the settings land) and never started, and the secrets reader is never
 * reached because credentials are resolved inside `open()`.
 */
function compose(
  overrides: Readonly<Record<string, unknown>> = {},
  bindings: readonly { id: string; lastSeenAt: number }[] = [],
): ComposedRig | null {
  const root = mkdtempSync(join(tmpdir(), 'gv-inbound-effect-'));
  tmpRoots.push(root);
  const values: Record<string, unknown> = { ...NON_DEFAULT_CONFIG, ...overrides };
  const handlers = new Map<string, GatewayMethodHandler>();
  const notices: { binding: unknown; notice: StructuredNotice }[] = [];

  const supervisor = composeInboundMail({
    configManager: { get: (key: string) => values[key] } as never,
    secretsManager: { get: async () => null } as never,
    shellPaths: { resolveUserPath: (_scope: string, name: string) => join(root, name) } as never,
    routeBindings: {
      listBindings: () => bindings,
      getBinding: (id: string) => bindings.find((entry) => entry.id === id),
      // Added when the notice path gained the feature-gate check: an off gate
      // makes `listBindings()` answer `[]`, which silently turns inbound mail
      // into a recorder. This stub predates that method, so it answered
      // `undefined` and the settings test died on the call rather than on its
      // assertion. Enabled here because these cases are about the SETTINGS
      // reaching their target, not about the gate.
      isRouteBindingEnabled: () => true,
    } as never,
    gatewayMethods: {
      // Every descriptor "exists", so the facade's `attach` registers all three
      // and the handlers are reachable from here.
      get: (id: string) => ({ id }),
      register: (descriptor: { id: string }, handler: GatewayMethodHandler) => {
        handlers.set(descriptor.id, handler);
      },
    } as never,
    deliverStructuredNotice: async (binding, notice) => {
      notices.push({ binding, notice });
      return { delivered: true } as never;
    },
    // These cases drive the IMAP source, so this rig's machine has no Google
    // account. Stated rather than omitted: the option is required because an
    // absent optional one is what let the Gmail arm ship with nothing behind
    // it. The two Gmail poll settings are covered where they are now read, in
    // test/inbound-mail-gmail-reachability.test.ts.
    gmailReader: async () => ({
      kind: 'unavailable' as const,
      detail: 'No Google account is connected on this machine.',
      fix: '',
    }),
  });

  if (supervisor === null) return null;
  const deps = (supervisor as unknown as { deps: InboundMailSupervisorDeps }).deps;
  return { supervisor, deps, handlers, notices };
}

/**
 * The watcher settings the composition actually handed to the source.
 *
 * Two private hops — the source's inner watcher, and that watcher's settings.
 * Reaching through them is deliberate: these four settings have no public
 * accessor anywhere, and "no way to observe it" is exactly how a setting stops
 * being wired without anything noticing.
 */
async function watcherSettingsFrom(rig: ComposedRig): Promise<InboundWatcherSettings> {
  const source = await rig.deps.sources.create({
    kind: 'imap',
    account: rig.deps.account,
    mailbox: rig.deps.mailbox,
    sink: { deliver: async () => {} },
    observer: {},
  } as never);
  if (source === null) throw new Error('the composition built no IMAP source to read settings from');
  return (source as unknown as { watcher: { settings: InboundWatcherSettings } }).watcher.settings;
}

describe('each inbound setting reaches the thing it names', () => {
  test('accounts names the watched account, and an empty list composes nothing', () => {
    const rig = compose();
    expect(rig?.deps.account).toBe(ACCOUNT);
    // Honest about watching nothing rather than defaulting to a mailbox
    // nobody named.
    expect(compose({ 'surfaces.email.inbound.accounts': '[]' })).toBeNull();
    expect(compose({ 'surfaces.email.inbound.accounts': undefined })).toBeNull();
  });

  test('imap.mailbox names the folder the watcher opens', () => {
    expect(compose()?.deps.mailbox).toBe(WATCHED_MAILBOX);
    expect(compose({ 'surfaces.email.imap.mailbox': undefined })?.deps.mailbox).toBe('INBOX');
  });

  test('retentionDays and maxRecords bound the record store', () => {
    const policy = compose()!.deps.records.getPolicy();
    expect(policy.retentionMs).toBe(3 * 86_400_000);
    expect(policy.maxRecords).toBe(321);
  });

  test('expectationWindowMinutes is the window an expectation actually gets', async () => {
    const rig = compose()!;
    const opened = await rig.deps.expectations.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup@example.test',
      purpose: 'confirm',
    });
    const windowMs = Date.parse(opened.expiresAt) - Date.parse(opened.openedAt);
    expect(windowMs).toBe(7 * 60_000);
  });

  test('the four watcher timings arrive at the source in milliseconds', async () => {
    const settings = await watcherSettingsFrom(compose()!);
    expect(settings.pollIntervalMs).toBe(240 * 1_000);
    expect(settings.idleReissueMs).toBe(11 * 60_000);
    expect(settings.maxBackoffMs).toBe(45 * 1_000);
    expect(settings.capabilityRecheckMs).toBe(17 * 60_000);
  });

  test('mode reaches the source, so configured polling is not an inferred fallback', async () => {
    expect((await watcherSettingsFrom(compose()!)).mode).toBe('poll');
    expect((await watcherSettingsFrom(compose({ 'surfaces.email.inbound.mode': 'idle' })!)).mode).toBe('idle');
    // Anything unrecognised is `auto`, not the last value that happened to be set.
    expect((await watcherSettingsFrom(compose({ 'surfaces.email.inbound.mode': 'push' })!)).mode).toBe('auto');
  });

  test('dedupTtlMinutes is the suppression window the supervisor uses', () => {
    const rig = compose()!;
    const readTtl = (supervisor: InboundMailSupervisor): number =>
      (supervisor as unknown as { dedupTtlMs(): number }).dedupTtlMs();
    expect(readTtl(rig.supervisor)).toBe(23 * 60_000);
    // An unusable value falls back to the correctness FLOOR — one hour, which
    // outlasts the daemon's own hourly restart — rather than to zero.
    expect(readTtl(compose({ 'surfaces.email.inbound.dedupTtlMinutes': 'soon' })!.supervisor))
      .toBe(60 * 60_000);
  });

  test('enabled=false stops the watcher and names the key that turns it on', async () => {
    const rig = compose({ 'surfaces.email.inbound.enabled': false })!;
    const status = await rig.supervisor.start();
    expect(status.running).toBe(false);
    expect(status.reason).toContain('surfaces.email.inbound.enabled');
    await rig.supervisor.stop();
  });

  test('source=gmail with no Google credential is refused, never quietly served over IMAP', async () => {
    const rig = compose({ 'surfaces.email.inbound.source': 'gmail' })!;
    const status = await rig.supervisor.start();
    expect(status.running).toBe(false);
    // The refusal now carries the reason the COMPOSITION found, which for this
    // rig is a machine with no Google account. It used to assert "no Google
    // credentials have been adopted" — a sentence the selector printed whether
    // or not any had been, because nothing had looked.
    expect(status.reason).toContain('No Google account is connected on this machine');
    expect(status.reason).toContain('surfaces.email.inbound.source is set to "gmail"');
    await rig.supervisor.stop();
  });

  test('notice.route picks the binding the notice is delivered to', async () => {
    const bindings = [
      { id: 'older', lastSeenAt: 1 },
      { id: 'newest', lastSeenAt: 2 },
    ];
    const deliveredTo = async (overrides: Readonly<Record<string, unknown>>): Promise<(string | undefined)[]> => {
      const rig = compose({ 'surfaces.email.inbound.notice.mode': 'all', ...overrides }, bindings)!;
      await rig.deps.handle(inboundMessage());
      return rig.notices.map((entry) => (entry.binding as { id: string } | undefined)?.id);
    };

    // A named binding id wins.
    expect(await deliveredTo({ 'surfaces.email.inbound.notice.route': 'older' })).toEqual(['older']);
    // `default` — the shipped value — means "inherit whatever he already
    // uses", which is the binding he was last seen on.
    expect(await deliveredTo({ 'surfaces.email.inbound.notice.route': 'default' })).toEqual(['newest']);
  });

  test('notice.mode=none suppresses the notice; all sends it', async () => {
    const quiet = compose({ 'surfaces.email.inbound.notice.mode': 'none' }, [{ id: 'r', lastSeenAt: 1 }])!;
    await quiet.deps.handle(inboundMessage());
    expect(quiet.notices).toHaveLength(0);

    const loud = compose({ 'surfaces.email.inbound.notice.mode': 'all' }, [{ id: 'r', lastSeenAt: 1 }])!;
    await loud.deps.handle(inboundMessage());
    expect(loud.notices).toHaveLength(1);
  });

  /**
   * ONE key now has a schema row, a validated range and a description, and
   * NOTHING in the tree reads it.
   *
   * There were three. `gmailPollSecondsExpecting` and `gmailPollSecondsIdle`
   * were documented on `GmailMailSourceDeps` as the origin of `pollExpectingMs`
   * / `pollIdleMs` with no code mapping one onto the other; they are now read in
   * `source-factory.ts` and handed to the `GmailSourceBuilder` at create time,
   * so the composition that talks to Google gets the owner's numbers instead of
   * inventing its own. This test reddened when that landed, exactly as its
   * previous version said it should.
   *
   * What is left is `onInsufficientCapability`, named in one comment in
   * `inbound-notice.ts` and read by nothing, so `notice-only` and
   * `refuse-and-notify` are the same behaviour today. It stays on this list for
   * a reason that is not "not got to yet": `notice-only` promises to keep
   * announcing arriving mail from envelope fields alone while bodies are
   * unavailable, and there is no path that can do that. On IMAP, `fetch-refused`
   * is minted from a FAILED envelope fetch (capability.ts), so when it fires
   * there are no envelopes; every other `insufficient` reason is "cannot log
   * in", "cannot open the mailbox" or "cannot keep a cursor". The one case that
   * could work is the one the schema text names — a Gmail `gmail.metadata`
   * grant, where `messages.get?format=metadata` would return headers — and
   * `collectHistoryDelta` refuses before calling, with no metadata-format fetch
   * anywhere in `api-client.ts`. Wiring the key without building that path would
   * make the settings UI offer a behaviour the daemon answers with silence.
   *
   * So this still asserts the CURRENT state rather than the desired one, and it
   * still fails the day the last one is fixed. That is the only honest shape for
   * a test over a known gap.
   */
  test('every inbound key is either read by production code or on the named inert list', () => {
    const INERT = new Set([
      'surfaces.email.inbound.onInsufficientCapability',
    ]);

    const sources = readSourceFilesOutsideConfig();
    const readByProduction = (key: string): boolean => sources.some((text) => {
      // A read, not a mention: the key's own text inside a config-read call. A
      // doc comment naming it does not count, which is the whole distinction —
      // the inert key IS named in a comment beside behaviour it never selects.
      //
      // `getConfig` is in the alternation because the `ConfigReader` a source
      // is handed is named that rather than `get`, and a genuine read the check
      // cannot see is worse than an unread key: it would look wired to a reader
      // and unwired here, and the next person would trust the wrong one. The
      // call still has to be a CALL — widening this to bare mentions is what
      // would make the check unable to fail.
      const quoted = key.replace(/\./g, '\\.');
      return new RegExp(`(?:get|getConfig|readNumberSetting)\\([^)]*['"]${quoted}['"]`, 's').test(text);
    });

    const wired = EXPECTED_DEFAULTS.map((entry) => entry.key).filter(readByProduction);
    const unread = EXPECTED_DEFAULTS.map((entry) => entry.key).filter((key) => !readByProduction(key));

    // Not a tautology in either direction: most keys ARE read, and the named
    // one is not.
    expect(wired.length).toBeGreaterThan(10);
    expect(unread.sort()).toEqual([...INERT].sort());
  });

  /**
   * The detector above can still answer "no", which is the property that makes
   * the assertion mean anything.
   *
   * Written after a night in which four checks turned out to be unable to fail.
   * A regex widened one alternation too far — `['"]key['"]` with no call in
   * front of it — would report every key in the schema as read, including the
   * inert one, and the test above would go on passing for as long as the
   * inert list happened to match. This asks the detector about text that
   * MENTIONS a key without reading it, and about a key nothing anywhere
   * contains.
   */
  test('the read-detector rejects a mention and an absent key', () => {
    const detect = (text: string, key: string): boolean => {
      const quoted = key.replace(/\./g, '\\.');
      return new RegExp(`(?:get|getConfig|readNumberSetting)\\([^)]*['"]${quoted}['"]`, 's').test(text);
    };
    const key = 'surfaces.email.inbound.pollIntervalSeconds';

    expect(detect(`/** See ${key} for the cadence. */`, key)).toBe(false);
    expect(detect(`const x = '${key}';`, key)).toBe(false);
    expect(detect(`configManager.get('${key}')`, key)).toBe(true);
    expect(detect(`getConfig('${key}' as never)`, key)).toBe(true);
    expect(detect('nothing here at all', key)).toBe(false);
  });

  /**
   * One key, one reader — for the two keys that had a reader in two places.
   *
   * The check above answers "is anything reading this", and it is `some(...)`:
   * it says yes just as happily for one reader as for three. That is the shape
   * that let `gmailPollSecondsExpecting` and `gmailPollSecondsIdle` acquire a
   * second reader without anything noticing. Two independent branches wired
   * them at two different tiers — `source-factory.ts` at source-CREATE time,
   * and `facade-inbound-mail.ts` at compose time — and the gate accepted both
   * call forms, so the duplication looked exactly like the fix.
   *
   * Create time is the tier that wins, and the reason is behavioural rather
   * than stylistic: `create()` runs on every supervisor start, so an interval
   * the owner edits while the daemon is running takes effect at the next source
   * start instead of waiting for the whole graph to be recomposed. That is the
   * same freshness rule `liveConnectionPort` applies to the IMAP host.
   *
   * Two readers of one key is the shape that made these settings inert in the
   * first place — a value that appears to apply, applied twice, is a value
   * whose effective setting depends on which caller ran last.
   */
  test('each Gmail poll interval is read exactly once, at source-create time', () => {
    const root = join(import.meta.dir, '..', 'packages', 'sdk', 'src');
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'config') walk(path);
          continue;
        }
        if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);

    for (const key of [
      'surfaces.email.inbound.gmailPollSecondsExpecting',
      'surfaces.email.inbound.gmailPollSecondsIdle',
      // The Gmail source's re-probe wait travels the same way and for the same
      // reason: read once for the watcher settings and handed on, never
      // re-derived beside the source that uses it.
      'surfaces.email.inbound.capabilityRecheckMinutes',
    ]) {
      const quoted = key.replace(/\./g, '\\.');
      const pattern = new RegExp(`(?:get|getConfig|readNumberSetting)\\([^)]*['"]${quoted}['"]`, 'gs');
      const readers = files.flatMap((path) => {
        const found = readFileSync(path, 'utf8').match(pattern) ?? [];
        return found.map(() => path);
      });
      expect({ key, readers: readers.length }).toEqual({ key, readers: 1 });
    }

    // And the one reader for the poll pair is the create-time one. Naming the
    // file is what makes the count above mean "the right single reader" rather
    // than "some single reader" — a count of one in the facade would be the
    // tier this was ruled out of.
    const factory = readFileSync(
      join(root, 'platform', 'email', 'inbound', 'source-factory.ts'), 'utf8');
    expect(factory).toContain("getConfig('surfaces.email.inbound.gmailPollSecondsExpecting' as never)");
    expect(factory).toContain("getConfig('surfaces.email.inbound.gmailPollSecondsIdle' as never)");
  });
});

describe('the expectation book is instantiated in production (gate #25)', () => {
  test('composeInboundMail builds a registry and registers its three verbs', async () => {
    const rig = compose()!;
    expect([...rig.handlers.keys()].sort()).toEqual([
      'email.expectation.cancel',
      'email.expectation.list',
      'email.expectation.open',
      'email.inbound.status',
    ]);

    // Driven through the registered verb, not the object: this is the path a
    // signup workstream takes, and it had no production call site at all
    // before the facade wired it.
    const opened = await rig.handlers.get('email.expectation.open')!({
      methodId: 'email.expectation.open',
      body: {
        serviceDomain: 'example.com',
        recipientAddress: 'signup@example.test',
        purpose: 'confirm the account',
      },
    } as never) as { id: string };
    expect(opened.id).toBeTruthy();

    const listed = await rig.handlers.get('email.expectation.list')!({
      methodId: 'email.expectation.list',
    } as never) as { total: number };
    expect(listed.total).toBe(1);
  });

  /**
   * The wiring, not the registry.
   *
   * `capabilityChanged` and the open-time capability refusal are both tested
   * directly in `inbound-mail-expectation-registry.test.ts`. Neither of those
   * says the composition CONNECTED them: the registry could have a perfect
   * capability mechanism and the facade could hand it no probe and route it no
   * transitions, and every one of those tests would still be green. That is
   * the same shape as the terminal-notice defect — a mechanism built, and its
   * only consumer never wired.
   */
  test('a capability transition reaches the registry through the composed observer', async () => {
    const rig = compose()!;
    await rig.deps.expectations.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup@example.test',
      purpose: 'confirm',
    });
    expect(rig.deps.expectations.list()).toHaveLength(1);

    // A reconnect first: "not yet" is not "cannot", and a wiring that failed
    // expectations on any transition at all would be caught here rather than
    // by the owner losing a live signup to a three-second socket drop.
    announce(rig, capabilityVerdict('reconnecting', 'dropped'));
    await flushMicrotasks();
    expect(rig.deps.expectations.list()).toHaveLength(1);

    announce(rig, capabilityVerdict('credentials-rejected', 'the server refused the credential'));
    await flushMicrotasks();
    expect(rig.deps.expectations.list()).toHaveLength(0);
  });

  test('the composed capability probe is the supervisor’s live verdict, so open() refuses on it', async () => {
    const rig = compose()!;
    // Nothing has probed yet — the honest answer is "unknown", and an unknown
    // mailbox does not block a signup.
    await rig.deps.expectations.open({
      serviceDomain: 'first.example',
      recipientAddress: 'a@example.test',
      purpose: 'confirm',
    });

    // The supervisor records the verdict off the same stream, and the
    // registry's probe reads it back off the supervisor.
    announce(rig, capabilityVerdict('mailbox-unreadable', 'the mailbox would not open'));
    await flushMicrotasks();
    expect(rig.supervisor.capability?.reason).toBe('mailbox-unreadable');

    await expect(rig.deps.expectations.open({
      serviceDomain: 'second.example',
      recipientAddress: 'b@example.test',
      purpose: 'confirm',
    })).rejects.toThrow('mailbox-unreadable');
  });

  test('the book carries the REAL authority probe, not a permissive stand-in', () => {
    // §2.2's defensive check — refuse to open an expectation if email ever
    // gained command authority — could not have fired before, because the book
    // was never constructed in production. Asserting it fires requires knowing
    // the probe in force is the shipped predicate, and asking about `email`
    // cannot establish that: the real function and every plausible stub both
    // answer `false`. `owner-direct` is where they differ.
    const probe = compose()!.deps.expectations.authority;
    expect(probe.surfaceHasCommandAuthority('email')).toBe(false);
    expect(probe.surfaceHasCommandAuthority('owner-direct')).toBe(true);
    expect(probe.surfaceHasCommandAuthority('owner-direct'))
      .toBe(surfaceHasCommandAuthority('owner-direct'));
  });
});
