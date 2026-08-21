/**
 * inbound-mail-supervisor.test.ts
 *
 * The lifecycle owner from docs/inbound-email.md §3.5, and the three things it
 * is responsible for that nothing else can be:
 *
 *  - it starts with the daemon, reports what it is ACTUALLY doing, and stops
 *    without leaving a source running;
 *  - a restart rehydrates before it serves: the stores are swept, the
 *    expectations come back with their ORIGINAL absolute expiry, and the
 *    source it starts sees the persisted cursor rather than a fresh mailbox;
 *  - `email.inbound.status` discloses the cursors, the open expectations, the
 *    capability verdict and the source in force WITH its latency, and email's
 *    health entry is read from that live state rather than from whether a
 *    credential happens to be present in config.
 *
 * Every source here is a stand-in that records what it was asked to do. That
 * is deliberate rather than a shortcut: the IMAP and Gmail sources are already
 * exercised against a scripted server elsewhere, and re-driving one here would
 * test them again while testing the supervisor not at all.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  type InboundMailSourceFactory,
  type InboundMailSupervisorDeps,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import { createEmailInboundStatusHandler } from '../packages/sdk/src/platform/control-plane/routes/email-inbound-status.ts';
import type { InboundMailSource, SourceLatency } from '../packages/sdk/src/platform/email/inbound/source.ts';
import type {
  InboundCapabilityVerdict,
  InboundMailObserver,
} from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { VerificationExpectation } from '../packages/sdk/src/platform/google/verification-expectations.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const T0 = new Date('2026-07-27T12:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-supervisor-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

type ConfigValues = Record<string, unknown>;

function fakeConfig(overrides: ConfigValues = {}): InboundMailSupervisorDeps['config'] {
  const values: ConfigValues = {
    'surfaces.email.inbound.enabled': true,
    'surfaces.email.inbound.source': 'auto',
    'surfaces.email.inbound.dedupTtlMinutes': 60,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as InboundMailSupervisorDeps['config'];
}

const HEALTHY: InboundCapabilityVerdict = {
  state: 'healthy',
  reason: 'idle-push',
  detail: 'The server advertised IDLE and is pushing.',
  fix: '',
};

/** A source that records its lifecycle instead of opening a socket. */
class RecordingSource implements InboundMailSource {
  readonly kind = 'imap' as const;
  readonly calls: string[] = [];
  /** Whatever the supervisor had persisted when this source was started. */
  cursorAtStart: unknown = undefined;

  constructor(
    private readonly verdict: InboundCapabilityVerdict,
    readonly latency: SourceLatency,
    private readonly onStart?: () => Promise<unknown>,
  ) {}

  async start(): Promise<InboundCapabilityVerdict> {
    this.calls.push('start');
    if (this.onStart) this.cursorAtStart = await this.onStart();
    return this.verdict;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.calls.push('run');
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
  }
}

function factoryFor(source: InboundMailSource | null): InboundMailSourceFactory {
  return { create: async () => source };
}

interface Rig {
  readonly supervisor: InboundMailSupervisor;
  readonly cursors: MailboxCursorStore;
  readonly records: InboundMailStore;
  readonly expectations: InboundExpectationRegistry;
  readonly expectationStore: PersistedExpectationStore;
  readonly housekeeper: InboundMailHousekeeper;
  readonly handled: unknown[];
}

function buildRig(options: {
  readonly sources: InboundMailSourceFactory;
  readonly config?: ConfigValues;
  readonly googleAdopted?: boolean;
  readonly mailAccountIsGmail?: boolean;
  readonly observer?: InboundMailObserver;
  readonly now?: () => number;
}): Rig {
  const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), {
    isAccountConfigured: (account) => account === ACCOUNT,
  });
  const records = new InboundMailStore(join(dir, 'records.json'));
  const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'), {
    now: () => T0,
  });
  const expectations = new InboundExpectationRegistry({
    store: expectationStore,
    now: () => T0,
  });
  const housekeeper = new InboundMailHousekeeper({
    cursors,
    records,
    expectations: expectationStore,
    disclosurePath: join(dir, 'housekeeping.json'),
  });
  const handled: unknown[] = [];
  const supervisor = new InboundMailSupervisor({
    config: fakeConfig(options.config ?? {}),
    account: ACCOUNT,
    mailbox: MAILBOX,
    sources: options.sources,
    selectionFacts: async () => ({
      googleAdopted: options.googleAdopted ?? false,
      mailAccountIsGmail: options.mailAccountIsGmail ?? false,
    }),
    cursors,
    records,
    expectations,
    expectationPolicy: expectationStore,
    housekeeper,
    handle: async (message) => { handled.push(message); },
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { supervisor, cursors, records, expectations, expectationStore, housekeeper, handled };
}

// ---------------------------------------------------------------------------
// It starts with the daemon, reports live status, and stops cleanly
// ---------------------------------------------------------------------------

describe('the supervisor starts, reports live status, and stops cleanly', () => {
  test('start() runs the selected source and status says what it is doing', async () => {
    const source = new RecordingSource(HEALTHY, { kind: 'push' });
    const rig = buildRig({ sources: factoryFor(source) });

    expect(rig.supervisor.status).toEqual({ mode: 'inactive', reason: 'not started', running: false });

    const status = await rig.supervisor.start();
    expect(status.running).toBe(true);
    expect(status.mode).toBe('idle');
    expect(status.reason).toContain('pushes new mail as it arrives');
    expect(source.calls).toEqual(['start', 'run']);

    await rig.supervisor.stop();
    expect(rig.supervisor.status.running).toBe(false);
    expect(rig.supervisor.status.mode).toBe('inactive');
    // stop() does not resolve until the source has genuinely stopped, the
    // ordered cluster handoff depends on that promise being honest.
    expect(source.calls).toEqual(['start', 'run', 'stop']);
  });

  test('a polled source reports polling, and its status names the delay rather than "real-time"', async () => {
    const source = new RecordingSource(HEALTHY, { kind: 'poll', worstCaseMs: 60_000 });
    const rig = buildRig({ sources: factoryFor(source) });
    const status = await rig.supervisor.start();
    expect(status.mode).toBe('polling');
    expect(status.reason).toContain('up to 60 seconds');
    expect(status.reason).not.toContain('real-time');
    await rig.supervisor.stop();
  });

  test('an insufficient verdict does not run and releases the source', async () => {
    const insufficient: InboundCapabilityVerdict = {
      state: 'insufficient',
      reason: 'credentials-rejected',
      detail: 'The server refused the credential.',
      fix: 'Store a current mail password.',
    };
    const source = new RecordingSource(insufficient, { kind: 'push' });
    const rig = buildRig({ sources: factoryFor(source) });

    const status = await rig.supervisor.start();
    expect(status.running).toBe(false);
    expect(status.mode).toBe('inactive');
    expect(status.reason).toContain('Store a current mail password.');
    // `run` is never entered, and the connection is released rather than held
    // through the re-check wait (§3.4b).
    expect(source.calls).toEqual(['start', 'stop']);
  });

  test('a source the build cannot construct is reported, never silently swapped for the other one', async () => {
    const rig = buildRig({
      sources: factoryFor(null),
      config: { 'surfaces.email.inbound.source': 'gmail' },
      googleAdopted: true,
      mailAccountIsGmail: true,
    });
    const status = await rig.supervisor.start();
    expect(status.running).toBe(false);
    expect(status.reason).toContain('gmail source');
    expect(status.reason).toContain('is NOT used in its place');
  });

  test('a refused selection stops with the refusal and its remedial step', async () => {
    const rig = buildRig({
      sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })),
      config: { 'surfaces.email.inbound.source': 'gmail' },
      googleAdopted: false,
    });
    const status = await rig.supervisor.start();
    expect(status.running).toBe(false);
    expect(status.reason).toContain('no Google credentials have been adopted');
    expect(status.reason).toContain('Connect Google');
  });

  test('the surface switched off does not start anything and says which key turns it on', async () => {
    const source = new RecordingSource(HEALTHY, { kind: 'push' });
    const rig = buildRig({
      sources: factoryFor(source),
      config: { 'surfaces.email.inbound.enabled': false },
    });
    const status = await rig.supervisor.start();
    expect(status.running).toBe(false);
    expect(status.reason).toContain('surfaces.email.inbound.enabled');
    expect(source.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Boot rehydration (§9, §9.2)
// ---------------------------------------------------------------------------

describe('a restart rehydrates before it serves', () => {
  function expectation(overrides: Partial<VerificationExpectation> = {}): VerificationExpectation {
    return {
      id: 'exp-restart',
      kind: 'signup',
      serviceDomain: 'github.com',
      recipientAddress: 'owner+gv-github-com@example.com',
      purpose: 'account signup',
      openedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 15 * 60_000).toISOString(),
      authority: 'evidence-only',
      ...overrides,
    };
  }

  test('the source it starts sees the persisted cursor, not a fresh mailbox', async () => {
    const seed = new MailboxCursorStore(join(dir, 'cursors.json'), {
      isAccountConfigured: (account) => account === ACCOUNT,
    });
    await seed.resolve({
      account: ACCOUNT,
      mailbox: MAILBOX,
      serverUidValidity: 42,
      currentHighestUid: 100,
      currentMessageCount: 100,
    });
    await seed.advance({ account: ACCOUNT, mailbox: MAILBOX, uidValidity: 42, lastSeenUid: 137 });

    let observed: unknown;
    const rig = buildRig({
      sources: {
        create: async () => new RecordingSource(HEALTHY, { kind: 'push' },
          async () => { observed = await rig.cursors.get(ACCOUNT, MAILBOX); return observed; }),
      },
    });
    await rig.supervisor.start();
    expect(observed).toMatchObject({ account: ACCOUNT, mailbox: MAILBOX, uidValidity: 42, lastSeenUid: 137 });
    await rig.supervisor.stop();
  });

  test('expectations come back with their ORIGINAL absolute expiry, never a fresh window', async () => {
    const original = expectation();
    const seed = new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => T0 });
    await seed.replaceAll([original]);

    // Ten minutes after it was opened: five of its fifteen remain. A fresh
    // window would show fifteen, and would mean a restart extended a grant.
    const later = new Date(T0.getTime() + 10 * 60_000);
    const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), {
      isAccountConfigured: (account) => account === ACCOUNT,
    });
    const records = new InboundMailStore(join(dir, 'records.json'));
    const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => later });
    const registry = new InboundExpectationRegistry({ store: expectationStore, now: () => later });
    const supervisor = new InboundMailSupervisor({
      config: fakeConfig(),
      account: ACCOUNT,
      mailbox: MAILBOX,
      sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })),
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors,
      records,
      expectations: registry,
      expectationPolicy: expectationStore,
      housekeeper: new InboundMailHousekeeper({
        cursors,
        records,
        expectations: expectationStore,
        disclosurePath: join(dir, 'housekeeping.json'),
      }),
      handle: async () => {},
    });

    await supervisor.start();
    const open = registry.list();
    expect(open).toHaveLength(1);
    expect(open[0]!.expiresAt).toBe(original.expiresAt);
    expect(open[0]!.remainingMs).toBe(5 * 60_000);
    await supervisor.stop();
  });

  test('an expectation already past its window is reaped on load, before it can match anything', async () => {
    const seed = new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => T0 });
    await seed.replaceAll([expectation()]);

    const afterExpiry = new Date(T0.getTime() + 60 * 60_000);
    const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), {
      isAccountConfigured: (account) => account === ACCOUNT,
    });
    const records = new InboundMailStore(join(dir, 'records.json'));
    const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => afterExpiry });
    const registry = new InboundExpectationRegistry({ store: expectationStore, now: () => afterExpiry });
    const supervisor = new InboundMailSupervisor({
      config: fakeConfig(),
      account: ACCOUNT,
      mailbox: MAILBOX,
      sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })),
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors,
      records,
      expectations: registry,
      expectationPolicy: expectationStore,
      housekeeper: new InboundMailHousekeeper({
        cursors,
        records,
        expectations: expectationStore,
        disclosurePath: join(dir, 'housekeeping.json'),
      }),
      handle: async () => {},
    });

    await supervisor.start();
    expect(registry.list()).toHaveLength(0);
    await supervisor.stop();
  });

  test('the recovery sweep runs before the source starts, not after', async () => {
    // The probe reads the housekeeper INSIDE `onStart`, which is the only
    // moment that can distinguish the two orderings. Reading it after
    // `start()` resolves, which this test used to do, passes whichever way
    // round the supervisor does the work, because by then both have happened.
    let sweepAtSourceStart = 'source-never-started';
    const rig = buildRig({
      sources: {
        create: async () => new RecordingSource(HEALTHY, { kind: 'push' }, async () => {
          const report = rig.housekeeper.getLastReport();
          sweepAtSourceStart = report === null ? 'no-sweep-yet' : `swept-${report.trigger}`;
          return null;
        }),
      },
    });
    const status = await rig.supervisor.start();
    expect(status.running).toBe(true);
    // The sweep had already run, and it was the RECOVERY one, not a periodic
    // pass that happened to land first.
    expect(sweepAtSourceStart).toBe('swept-recovery');
    await rig.supervisor.stop();
  });
});

// ---------------------------------------------------------------------------
// email.inbound.status (§9)
// ---------------------------------------------------------------------------

describe('email.inbound.status discloses what is held', () => {
  test('cursors, expectations, capability and the source latency all appear', async () => {
    const seedCursors = new MailboxCursorStore(join(dir, 'cursors.json'), {
      isAccountConfigured: (account) => account === ACCOUNT,
    });
    await seedCursors.resolve({
      account: ACCOUNT,
      mailbox: MAILBOX,
      serverUidValidity: 7,
      currentHighestUid: 10,
      currentMessageCount: 10,
    });
    const seedExpectations = new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => T0 });
    await seedExpectations.replaceAll([{
      id: 'exp-status',
      kind: 'signup',
      serviceDomain: 'stripe.com',
      recipientAddress: 'owner+gv-stripe-com@example.com',
      purpose: 'purchase confirmation',
      openedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 15 * 60_000).toISOString(),
      authority: 'evidence-only',
    }]);

    const rig = buildRig({
      sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'poll', worstCaseMs: 5_000 })),
      now: () => T0.getTime(),
    });
    await rig.supervisor.start();

    const handler = createEmailInboundStatusHandler(rig.supervisor);
    const disclosed = await handler({ methodId: 'email.inbound.status' } as never) as Record<string, unknown>;

    expect(disclosed.enabled).toBe(true);
    expect(disclosed.running).toBe(true);
    expect(disclosed.account).toBe(ACCOUNT);
    expect(disclosed.mailbox).toBe(MAILBOX);

    const cursors = disclosed.cursors as { source: string; position: string; ageMs: number }[];
    expect(cursors).toHaveLength(1);
    expect(cursors[0]!.source).toBe('imap');
    expect(cursors[0]!.position).toBe('UIDVALIDITY 7 / UID 10');
    expect(cursors[0]!.ageMs).toBeGreaterThanOrEqual(0);

    const expectations = disclosed.expectations as { id: string; remainingMs: number }[];
    expect(expectations.map((entry) => entry.id)).toEqual(['exp-status']);

    expect(disclosed.capability).toMatchObject({ state: 'healthy', reason: 'idle-push' });

    const source = disclosed.source as { kind: string; latency: string };
    expect(source.kind).toBe('imap');
    // The latency is a SENTENCE naming the delay, so no surface can render
    // "real-time" for a poll.
    expect(source.latency).toContain('every 5 seconds');
    expect(source.latency).toContain('This is polling, not push');

    const retention = disclosed.retention as Record<string, Record<string, number>>;
    expect(retention.cursors!.kept).toBe(1);
    expect(retention.expectations!.open).toBe(1);
    expect(retention.records!.retentionDays).toBeGreaterThan(0);
    expect(retention.records!.maxBodyExcerptChars).toBe(20_000);

    await rig.supervisor.stop();
  });

  /**
   * The disclosure measured against the FILE, through the real handler.
   *
   * Ported from a parallel branch that solved the same finding by redefining
   * `kept` to mean the file. This branch keeps `kept` as the served view and
   * adds `stored`, so the assertion is retargeted, but the thing it pins is
   * identical and is the thing that was missing here: every other test for this
   * fix is at the STORE level, so `supervisor.ts` reverting `stored` to
   * `records.length` (the served view) would have reddened nothing at all. A
   * disclosure fix with no test that reddens is the shape this round keeps
   * finding.
   *
   * Both numbers are asserted, and so is the gap between them, because the gap
   * is the disclosure: two served, ten on disk, eight of them past the window
   * and waiting for the next write or sweep.
   */
  test('retention.records reports the FILE in `stored` and the served view in `kept`', async () => {
    const rows = Array.from({ length: 10 }, (_unused, index) => ({
      id: `rec-${String(index)}`,
      account: ACCOUNT,
      mailbox: MAILBOX,
      source: 'imap',
      uidValidity: 7,
      uid: index + 1,
      senderDisplay: 'noreply@github.com',
      subject: 'Verify your email',
      deliveredToAddress: 'owner+alias@example.com',
      deliveryEvidenceSource: 'alias-mailbox',
      links: [],
      outcome: 'matched-expectation',
      noticeStatus: 'delivered',
      bodyExcerpt: 'hello',
      // Two inside the default thirty-day window, eight well past it.
      receivedAt: new Date(T0.getTime() - (index < 2 ? 0 : 60) * 86_400_000).toISOString(),
    }));
    writeFileSync(join(dir, 'records.json'), JSON.stringify({ version: 1, records: rows }), 'utf-8');

    const rig = buildRig({
      sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })),
      now: () => T0.getTime(),
    });
    expect(await rig.records.list()).toHaveLength(2);

    const handler = createEmailInboundStatusHandler(rig.supervisor);
    const disclosed = await handler({ methodId: 'email.inbound.status' } as never) as Record<string, unknown>;
    const retention = disclosed.retention as Record<string, Record<string, number>>;

    expect(retention.records!.stored).toBe(10);
    expect(retention.records!.kept).toBe(2);
    // Stated as its own assertion rather than left implicit: if these two ever
    // become the same expression again, the disclosure has gone back to
    // describing a filter instead of a file.
    expect(retention.records!.stored).toBeGreaterThan(retention.records!.kept!);
  });

  test('an absent capability and an absent sweep are omitted, never serialized as null', async () => {
    const rig = buildRig({ sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })) });
    const handler = createEmailInboundStatusHandler(rig.supervisor);
    const disclosed = await handler({ methodId: 'email.inbound.status' } as never) as Record<string, unknown>;
    expect('capability' in disclosed).toBe(false);
    const retention = disclosed.retention as Record<string, unknown>;
    expect('lastSweep' in retention).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Health reads live state, not config presence
// ---------------------------------------------------------------------------

describe('email health reads live supervisor state', () => {
  test('a configured mailbox whose watcher is not running is degraded, not healthy', async () => {
    const insufficient: InboundCapabilityVerdict = {
      state: 'insufficient',
      reason: 'mailbox-unreadable',
      detail: 'The mailbox would not open.',
      fix: 'Check surfaces.email.imap.mailbox.',
    };
    const rig = buildRig({ sources: factoryFor(new RecordingSource(insufficient, { kind: 'push' })) });
    await rig.supervisor.start();

    const health = rig.supervisor.health();
    // Config still says enabled, the credential and the switch are both
    // present, and the entry reports degraded anyway, because the watcher is
    // not running. That is the whole difference from the config-presence
    // computation used for channels.
    expect(health.enabled).toBe(true);
    expect(health.state).toBe('degraded');
    expect(health.mode).toBe('inactive');
    expect(health.reason).toContain('The mailbox would not open.');
    expect(health.metadata.capabilityState).toBe('insufficient');
  });

  test('a running healthy watcher is healthy, and a switched-off surface is disabled', async () => {
    const running = buildRig({ sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })) });
    await running.supervisor.start();
    expect(running.supervisor.health().state).toBe('healthy');
    await running.supervisor.stop();
    // Stopped, still enabled in config: degraded, because the surface is on
    // and nothing is reading it.
    expect(running.supervisor.health().state).toBe('degraded');

    const off = buildRig({
      sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })),
      config: { 'surfaces.email.inbound.enabled': false },
    });
    await off.supervisor.start();
    expect(off.supervisor.health().state).toBe('disabled');
  });

  test('the health entry carries no channel surface — email is not a ManagedSurface', async () => {
    const rig = buildRig({ sources: factoryFor(new RecordingSource(HEALTHY, { kind: 'push' })) });
    const health = rig.supervisor.health() as unknown as Record<string, unknown>;
    expect(health.kind).toBe('email-inbound');
    expect('surface' in health).toBe(false);
    expect('accountId' in health).toBe(false);
  });
});
