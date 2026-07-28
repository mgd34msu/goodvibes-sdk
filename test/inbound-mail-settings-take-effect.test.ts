/**
 * Two inbound-mail settings paths that were built and never connected.
 *
 * **`recheckNow()` had no external caller.** It exists on
 * `InboundMailboxWatcher`, `ImapMailSource` delegates to it verbatim, and its
 * own comment says "Called when configuration changed" — while nothing in the
 * tree subscribed to any `surfaces.email.*` key at all. Only Telegram had a
 * config watcher. So an owner who corrected a wrong IMAP host waited out
 * `capabilityRecheckMinutes` (an hour by default) to learn whether the
 * correction worked, or restarted the daemon; both are the restart this
 * platform is supposed not to need. The tests below drive the real
 * subscription, not a mock of one.
 *
 * **The two Gmail poll intervals had no reader.** `gmailPollSecondsExpecting`
 * and `gmailPollSecondsIdle` each had a schema row, a validated range, a
 * description the owner reads in the settings UI, and a doc comment on
 * `GmailMailSourceDeps` naming them as the origin of `pollExpectingMs` /
 * `pollIdleMs` — with no code mapping one onto the other. The builder was left
 * to invent its own numbers, and the only composition that can see the config
 * is not the one that knows how to talk to Google, so they never crossed.
 *
 * WHAT MAKES THESE ABLE TO FAIL. The recheck tests assert the CALL, counted, on
 * a supervisor double that records — not that a subscription was registered,
 * which a `subscribe()` that dropped its callback would also satisfy. The
 * interval tests read the values back out of what the builder was actually
 * handed and use numbers that are not the schema defaults, so a factory that
 * quietly fell back to 5 s / 60 s fails rather than passing on a coincidence.
 */

import { describe, expect, test } from 'bun:test';
import { BuiltinChannelRuntime } from '../packages/sdk/src/platform/channels/builtin-runtime.ts';
import { createInboundMailSourceFactory } from '../packages/sdk/src/platform/email/inbound/source-factory.ts';
import { resolveWatcherSettings } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { InboundMailSource } from '../packages/sdk/src/platform/email/inbound/source.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The coalescing window in `watchInboundMailConfig`, plus room for the timer. */
const AFTER_COALESCE_MS = 400;

/**
 * A config manager with a real subscription table.
 *
 * Not a `subscribe` that returns a no-op: the point of the test is that a
 * change REACHES the recheck, and a stub that never fires its callbacks would
 * make a broken subscription indistinguishable from a working one.
 */
function fakeConfig(values: Record<string, unknown> = {}) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    manager: {
      get: (key: string) => values[key],
      subscribe: (key: string, cb: () => void) => {
        const forKey = listeners.get(key) ?? [];
        forKey.push(cb);
        listeners.set(key, forKey);
        return () => {
          listeners.set(key, (listeners.get(key) ?? []).filter((entry) => entry !== cb));
        };
      },
    },
    change: (key: string): void => {
      for (const cb of listeners.get(key) ?? []) cb();
    },
    subscriberCount: (key: string): number => (listeners.get(key) ?? []).length,
  };
}

/** A supervisor double that counts what the runtime asks of it. */
function fakeSupervisor() {
  const calls = { start: 0, stop: 0, recheckNow: 0 };
  return {
    calls,
    supervisor: {
      start: async () => { calls.start += 1; return { mode: 'idle', reason: '', running: true }; },
      stop: async () => { calls.stop += 1; },
      recheckNow: () => { calls.recheckNow += 1; },
      health: () => null,
      describeStatus: async () => ({}),
    },
  };
}

function runtimeWith(
  config: ReturnType<typeof fakeConfig>,
  supervisor: unknown,
): BuiltinChannelRuntime {
  return new BuiltinChannelRuntime({
    configManager: config.manager,
    inboundMail: supervisor,
  } as never);
}

describe('an inbound-mail setting edit reaches the running source', () => {
  test('changing the IMAP host re-probes without a restart', async () => {
    const config = fakeConfig({ 'surfaces.email.inbound.enabled': true });
    const { calls, supervisor } = fakeSupervisor();
    const runtime = runtimeWith(config, supervisor);

    await runtime.startInboundMail();
    expect(calls.start).toBe(1);
    expect(calls.recheckNow).toBe(0);

    config.change('surfaces.email.imap.host');
    await sleep(AFTER_COALESCE_MS);

    expect(calls.recheckNow).toBe(1);
    // The distinction the whole fix rests on: a corrected password or host is a
    // re-probe, not a re-decision. A restart would re-run the recovery sweep,
    // re-select the source and rebuild the dedup cache for an edit that changes
    // none of them.
    expect(calls.start).toBe(1);
    expect(calls.stop).toBe(0);
  });

  test('every key the connection port re-reads is watched', async () => {
    const config = fakeConfig({ 'surfaces.email.inbound.enabled': true });
    const { calls, supervisor } = fakeSupervisor();
    await runtimeWith(config, supervisor).startInboundMail();

    // Both spellings of host and account, because `readSurfaceEmailSettings`
    // genuinely reads both and a subscription to the one the owner did not edit
    // is a subscription that never fires.
    const watched = [
      'surfaces.email.imap.host',
      'surfaces.email.imapHost',
      'surfaces.email.imap.port',
      'surfaces.email.user',
      'surfaces.email.username',
    ];
    for (const key of watched) expect(config.subscriberCount(key)).toBe(1);

    for (const key of watched) {
      const before = calls.recheckNow;
      config.change(key);
      await sleep(AFTER_COALESCE_MS);
      expect(calls.recheckNow).toBe(before + 1);
    }
  });

  test('keys that decide WHICH source is built are deliberately not watched', async () => {
    const config = fakeConfig({ 'surfaces.email.inbound.enabled': true });
    const { calls, supervisor } = fakeSupervisor();
    await runtimeWith(config, supervisor).startInboundMail();

    // A re-probe cannot change what the running source IS, so wiring these here
    // would look like they took effect while they did not — the same defect one
    // level up. They need a restart, which is a separate decision.
    for (const key of [
      'surfaces.email.inbound.accounts',
      'surfaces.email.inbound.source',
      'surfaces.email.inbound.mode',
      'surfaces.email.imap.mailbox',
    ]) {
      expect(config.subscriberCount(key)).toBe(0);
      config.change(key);
    }
    await sleep(AFTER_COALESCE_MS);
    expect(calls.recheckNow).toBe(0);
  });

  test('a settings page that writes five keys re-probes once, not five times', async () => {
    const config = fakeConfig({ 'surfaces.email.inbound.enabled': true });
    const { calls, supervisor } = fakeSupervisor();
    await runtimeWith(config, supervisor).startInboundMail();

    config.change('surfaces.email.imap.host');
    config.change('surfaces.email.imap.port');
    config.change('surfaces.email.user');
    config.change('surfaces.email.username');
    config.change('surfaces.email.imapHost');
    await sleep(AFTER_COALESCE_MS);

    expect(calls.recheckNow).toBe(1);
  });

  test('stopping inbound mail unsubscribes, so a stopped daemon is not re-probed', async () => {
    const config = fakeConfig({ 'surfaces.email.inbound.enabled': true });
    const { calls, supervisor } = fakeSupervisor();
    const runtime = runtimeWith(config, supervisor);

    await runtime.startInboundMail();
    await runtime.stopInboundMail();
    expect(config.subscriberCount('surfaces.email.imap.host')).toBe(0);

    config.change('surfaces.email.imap.host');
    await sleep(AFTER_COALESCE_MS);
    expect(calls.recheckNow).toBe(0);
  });
});

describe('the supervisor passes a recheck to the source it is running', () => {
  test('recheckNow reaches the live source', async () => {
    const { InboundMailSupervisor } = await import(
      '../packages/sdk/src/platform/email/inbound/supervisor.ts'
    );
    let rechecks = 0;
    const source: InboundMailSource = {
      kind: 'imap',
      start: async () => ({ state: 'healthy', reason: 'idle-push', detail: '', fix: '' }),
      // Ends when the supervisor aborts. A run loop that ignored the signal
      // would hang `stop()`, which awaits it.
      run: (signal: AbortSignal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      }),
      stop: async () => {},
      latency: { kind: 'push' },
      recheckNow: () => { rechecks += 1; },
    };
    const supervisor = new InboundMailSupervisor({
      config: { get: (key: string) => (key === 'surfaces.email.inbound.enabled' ? true : undefined) },
      account: 'primary',
      mailbox: 'INBOX',
      sources: { create: async () => source },
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors: {} as never,
      records: {} as never,
      expectations: { hydrate: async () => ({ restored: 0, dropped: 0 }) } as never,
      expectationPolicy: {} as never,
      housekeeper: { runRecoverySweep: async () => ({}) } as never,
      handle: async () => {},
    } as never);

    // Before start there is no source; asking is a no-op rather than a throw.
    supervisor.recheckNow();
    expect(rechecks).toBe(0);

    await supervisor.start();
    supervisor.recheckNow();
    expect(rechecks).toBe(1);

    await supervisor.stop();
    supervisor.recheckNow();
    expect(rechecks).toBe(1);
  });

  test('a source that declares no recheckNow is a no-op, not a throw', async () => {
    const { InboundMailSupervisor } = await import(
      '../packages/sdk/src/platform/email/inbound/supervisor.ts'
    );
    const source: InboundMailSource = {
      kind: 'gmail-history',
      start: async () => ({ state: 'healthy', reason: 'polling-configured', detail: '', fix: '' }),
      // Ends when the supervisor aborts. A run loop that ignored the signal
      // would hang `stop()`, which awaits it.
      run: (signal: AbortSignal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      }),
      stop: async () => {},
      latency: { kind: 'poll', worstCaseMs: 5_000 },
    };
    const supervisor = new InboundMailSupervisor({
      config: { get: (key: string) => (key === 'surfaces.email.inbound.enabled' ? true : undefined) },
      account: 'primary',
      mailbox: 'INBOX',
      sources: { create: async () => source },
      selectionFacts: async () => ({ googleAdopted: true, mailAccountIsGmail: true }),
      cursors: {} as never,
      records: {} as never,
      expectations: { hydrate: async () => ({ restored: 0, dropped: 0 }) } as never,
      expectationPolicy: {} as never,
      housekeeper: { runRecoverySweep: async () => ({}) } as never,
      handle: async () => {},
    } as never);

    await supervisor.start();
    expect(() => { supervisor.recheckNow(); }).not.toThrow();
    await supervisor.stop();
  });
});

describe('the Gmail poll intervals come from the owner settings', () => {
  /** Deliberately none of the schema defaults (5, 60, 60), so a fallback fails. */
  const CONFIG: Record<string, unknown> = {
    'surfaces.email.inbound.gmailPollSecondsExpecting': 7,
    'surfaces.email.inbound.gmailPollSecondsIdle': 43,
  };

  async function buildGmailWith(overrides: Record<string, unknown> = {}) {
    const values = { ...CONFIG, ...overrides };
    let captured: Record<string, unknown> | null = null;
    const factory = createInboundMailSourceFactory({
      getConfig: ((key: string) => values[key]) as never,
      secrets: { get: async () => null } as never,
      transport: { connectImapTls: async () => { throw new Error('not used'); } } as never,
      cursors: {} as never,
      settings: resolveWatcherSettings({
        account: 'primary',
        mailbox: 'INBOX',
        capabilityRecheckMs: 11 * 60_000,
      } as never),
      gmail: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return null;
      },
    });
    await factory.create({
      kind: 'gmail',
      account: 'primary',
      mailbox: 'INBOX',
      sink: { deliver: async () => {} },
      observer: {},
    } as never);
    return captured;
  }

  test('both intervals reach the builder in milliseconds', async () => {
    const input = await buildGmailWith();
    expect(input).not.toBeNull();
    expect(input!.pollExpectingMs).toBe(7_000);
    expect(input!.pollIdleMs).toBe(43_000);
  });

  test('the capability recheck the owner set reaches it too', async () => {
    const input = await buildGmailWith();
    // Not the watcher's own 60-minute default: a Gmail source re-probing on a
    // different schedule from the configured one is the same defect as the two
    // above, a setting that appears to apply and does not.
    expect(input!.capabilityRecheckMs).toBe(11 * 60_000);
  });

  test('an unset interval falls back to the shipped default rather than NaN', async () => {
    const input = await buildGmailWith({
      'surfaces.email.inbound.gmailPollSecondsExpecting': undefined,
      'surfaces.email.inbound.gmailPollSecondsIdle': undefined,
    });
    expect(input!.pollExpectingMs).toBe(5_000);
    expect(input!.pollIdleMs).toBe(60_000);
  });

  test('a hand-edited config file that put a string there does not become NaN', async () => {
    const input = await buildGmailWith({
      'surfaces.email.inbound.gmailPollSecondsExpecting': 'soon',
      'surfaces.email.inbound.gmailPollSecondsIdle': -4,
    });
    expect(input!.pollExpectingMs).toBe(5_000);
    expect(input!.pollIdleMs).toBe(60_000);
  });

  test('an interval edited while the daemon runs is read at the next source start', async () => {
    const values: Record<string, unknown> = { ...CONFIG };
    const seen: number[] = [];
    const factory = createInboundMailSourceFactory({
      getConfig: ((key: string) => values[key]) as never,
      secrets: { get: async () => null } as never,
      transport: { connectImapTls: async () => { throw new Error('not used'); } } as never,
      cursors: {} as never,
      settings: resolveWatcherSettings({ account: 'primary', mailbox: 'INBOX' } as never),
      gmail: async (input) => { seen.push(input.pollIdleMs); return null; },
    });
    const create = async (): Promise<void> => {
      await factory.create({
        kind: 'gmail', account: 'primary', mailbox: 'INBOX',
        sink: { deliver: async () => {} }, observer: {},
      } as never);
    };

    await create();
    values['surfaces.email.inbound.gmailPollSecondsIdle'] = 90;
    await create();

    // Read per create, not captured once at factory construction — the same
    // freshness rule `liveConnectionPort` applies to the IMAP host.
    expect(seen).toEqual([43_000, 90_000]);
  });
});
