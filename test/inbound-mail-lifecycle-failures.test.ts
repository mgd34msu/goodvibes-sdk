/**
 * inbound-mail-lifecycle-failures.test.ts
 *
 * Four ways the inbound-mail watcher used to die permanently while reporting
 * healthy — the exact defect the whole capability exists to eliminate
 * (docs/inbound-email.md §3.4b). Each one is a gate:
 *
 *  1. A throw out of the run loop (a cursor-store write that fails) is caught,
 *     classified, reported through the observer, and reflected in status. It
 *     is never swallowed by a bare `.catch(() => undefined)`, and `running`
 *     never reads true for a loop that has exited.
 *  2. One unreadable byte in a store file is DISCARDED and disclosed, not a
 *     permanent hard failure: the other two stores still sweep, `start()`
 *     still starts, and `email.inbound.status` still answers — naming the
 *     corruption, because it is the one thing that can explain the state.
 *  3. A terminal capability failure reaches the OWNER, once per transition,
 *     rendered from structured fields.
 *  4. Recovery from `insufficient` back to healthy reaches `status` and
 *     `health()` — "fixing his scopes does not require a restart" has to be
 *     true of something he can see.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  ImapMailSource,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  createInboundTerminalFailureAnnouncer,
  imapMailboxConnectionPort,
  resolveWatcherSettings,
  type InboundCapabilityVerdict,
  type InboundMailObserver,
  type InboundMailSourceFactory,
  type InboundMailSupervisorDeps,
  type InboundMailTerminalFailure,
  type MailboxCursor,
  type MailboxCursorPort,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import { composeInboundMail } from '../packages/sdk/src/platform/daemon/facade-inbound-mail.ts';
import { createEmailInboundStatusHandler } from '../packages/sdk/src/platform/control-plane/routes/email-inbound-status.ts';
import type { InboundMailSource, SourceLatency } from '../packages/sdk/src/platform/email/inbound/source.ts';
import type { StructuredNotice } from '../packages/sdk/src/platform/email/inbound-notice.ts';
import {
  makeFakeMailbox,
  openMailboxSocket,
  type FakeMessage,
} from './_helpers/fake-imap-mailbox.ts';
import {
  FakeClock,
  RecordingObserver,
  RecordingSink,
  cleanupInboundScratch,
  fixedRandom,
  flush,
  makeCursorStore,
  nudgeUntil,
  waitFor,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-lifecycle-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => { cleanupInboundScratch(); });

function message(uid: number, subject: string): FakeMessage {
  return { uid, from: 'sender@example.test', subject, deliveredTo: 'watched@example.test' };
}

/** One observer that forwards to several. Nothing is filtered or re-ordered. */
function fanOut(observers: readonly (InboundMailObserver | undefined)[]): InboundMailObserver {
  const live = observers.filter((entry): entry is InboundMailObserver => entry !== undefined);
  return {
    stateChanged: (transition) => { for (const entry of live) entry.stateChanged?.(transition); },
    terminalFailure: (failure) => { for (const entry of live) entry.terminalFailure?.(failure); },
    note: (note) => { for (const entry of live) entry.note?.(note); },
  };
}

// ---------------------------------------------------------------------------
// 1. A store throw mid-drain does not kill the loop silently
// ---------------------------------------------------------------------------

/**
 * A cursor port that delegates every read and refuses every write.
 *
 * `ENOSPC` rather than a bare `Error` because the classification matters: a
 * disk that is full is transient and must be retried, and the watcher has to
 * reach that conclusion from the failure itself.
 */
class RefusingCursorStore implements MailboxCursorPort {
  advanceAttempts = 0;

  constructor(private readonly inner: MailboxCursorPort) {}

  async get(account: string, mailbox: string): Promise<MailboxCursor | null> {
    return this.inner.get(account, mailbox);
  }

  async resolve(input: Parameters<MailboxCursorPort['resolve']>[0]): ReturnType<MailboxCursorPort['resolve']> {
    return this.inner.resolve(input);
  }

  async advance(): Promise<MailboxCursor> {
    this.advanceAttempts += 1;
    const error = new Error('ENOSPC: no space left on device, write') as Error & { code?: string };
    error.code = 'ENOSPC';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Supervisor doubles
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

const REJECTED: InboundCapabilityVerdict = {
  state: 'insufficient',
  reason: 'credentials-rejected',
  detail: 'The server refused the credential.',
  fix: 'Store a current mail password.',
};

/** A source whose `run()` rejects, the way an unguarded store write would. */
class ThrowingSource implements InboundMailSource {
  readonly kind = 'imap' as const;
  readonly latency: SourceLatency = { kind: 'push' };
  readonly calls: string[] = [];

  async start(): Promise<InboundCapabilityVerdict> {
    this.calls.push('start');
    return HEALTHY;
  }

  async run(): Promise<void> {
    this.calls.push('run');
    await Promise.resolve();
    throw new Error('ENOSPC: no space left on device, write');
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
  }
}

/** A source that holds until aborted and exposes the observer it was handed. */
class SteadySource implements InboundMailSource {
  readonly kind = 'imap' as const;
  readonly latency: SourceLatency = { kind: 'push' };
  observer: InboundMailObserver | null = null;

  async start(): Promise<InboundCapabilityVerdict> {
    return HEALTHY;
  }

  async run(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
  }

  async stop(): Promise<void> {
    // Nothing to release.
  }
}

interface SupervisorRig {
  readonly supervisor: InboundMailSupervisor;
  readonly cursors: MailboxCursorStore;
  readonly records: InboundMailStore;
  readonly housekeeper: InboundMailHousekeeper;
}

function buildSupervisorRig(options: {
  readonly sources: InboundMailSourceFactory;
  readonly observer?: InboundMailObserver;
  readonly recordPolicy?: { readonly retentionMs: number };
  readonly now?: () => number;
}): SupervisorRig {
  const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), {
    isAccountConfigured: (account) => account === ACCOUNT,
  });
  const records = new InboundMailStore(join(dir, 'records.json'), {
    ...(options.recordPolicy === undefined ? {} : { policy: options.recordPolicy }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'));
  const expectations = new InboundExpectationRegistry({ store: expectationStore });
  const housekeeper = new InboundMailHousekeeper({
    cursors,
    records,
    expectations: expectationStore,
    disclosurePath: join(dir, 'housekeeping.json'),
  });
  const supervisor = new InboundMailSupervisor({
    config: fakeConfig(),
    account: ACCOUNT,
    mailbox: MAILBOX,
    sources: options.sources,
    selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
    cursors,
    records,
    expectations,
    expectationPolicy: expectationStore,
    housekeeper,
    handle: async () => undefined,
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  });
  return { supervisor, cursors, records, housekeeper };
}

describe('a cursor-store write that fails does not end inbound mail in silence', () => {
  /**
   * The reviewer's reproduction, through the supervisor rather than through the
   * drain: a REAL IMAP source against a scripted server, with a cursor store
   * that refuses every write. What used to happen is that the rejection
   * unwound `drainMailboxDelta -> drainOnce -> onWake -> runIdleLoop -> serve
   * -> run` into `source.run(signal).catch(() => undefined)`, and
   * `email.inbound.status` went on reporting `{state: healthy, reason:
   * idle-push}` with `running: true`, forever. Asserting that the drain rejects
   * would prove none of that; the observable state afterwards is the contract.
   */
  test('the loop is not left dead and healthy-looking: status, health and the observer all say so', async () => {
    const mailbox = await makeFakeMailbox({ initial: [message(101, 'already here')] });
    const clock = new FakeClock();
    const { store: inner } = await makeCursorStore();
    const refusing = new RefusingCursorStore(inner);
    const sink = new RecordingSink();
    const observer = new RecordingObserver();

    // Built INSIDE the factory with the supervisor's own observer, exactly as
    // `createInboundMailSourceFactory` does in production. Handing the source a
    // test observer instead would cut the supervisor out of its own status
    // path and leave this asserting nothing about `status` at all.
    // An array, not a nullable let: the assignment happens inside a closure
    // that flow analysis cannot see, so the nullable let stays narrowed to
    // `null` and `source?.status` resolves against `never`.
    const sources: ImapMailSource[] = [];
    const rig = buildSupervisorRig({
      sources: {
        create: async (input) => {
          sources.push(new ImapMailSource({
            settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX }),
            connections: imapMailboxConnectionPort({
              connect: () => openMailboxSocket(mailbox.port),
              username: 'watched@example.test',
              password: 'an-app-password',
              mailbox: MAILBOX,
              timeoutMs: 2_000,
            }),
            cursors: refusing,
            sink,
            clock,
            random: fixedRandom(0.5),
            observer: fanOut([observer, input.observer]),
          }));
          return sources[sources.length - 1]!;
        },
      },
    });

    try {
      const started = await rig.supervisor.start();
      expect(started.running).toBe(true);

      // Hold an IDLE, then let mail land: the drain hands UID 102 over and
      // then cannot record that it handled it.
      await waitFor(
        () => mailbox.commands.some((line) => /^\S+ IDLE$/.test(line)),
        'the watcher to reach an IDLE',
      );
      await clock.waitForSleepers(1, 'the IDLE re-issue timer');
      mailbox.deliver('mail that cannot be recorded');
      await nudgeUntil(
        mailbox,
        () => refusing.advanceAttempts >= 1,
        'the first refused cursor write',
        // The cursor write is REFUSED here, so the cursor never advances and a
        // duplicate wake would re-deliver UID 102 — which `sink.uids` asserts
        // exactly. A long interval keeps this a recovery from a lost edge.
        // `clock.waitForSleepers` above proves the re-issue timer is armed,
        // but that timer is armed one line BEFORE the untagged waiter, so it
        // does not close the window on its own.
        { intervalMs: 500 },
      );
      expect(sink.uids).toEqual([102]);

      // 1. It is caught and named, rather than unwinding into silence.
      await waitFor(
        () => observer.transitions.some((entry) => entry.to.reason === 'reconnecting'
          && entry.to.detail.includes('ENOSPC')),
        'a transition naming the refused write',
      );
      expect(sources[0]?.status.verdict.state).not.toBe('healthy');

      // 2. Transient, so it waits and tries again rather than exiting.
      await clock.waitForDue(600_000, 'the backoff after a refused cursor write');
      await clock.advance(600_000);
      await waitFor(() => mailbox.connectionCount >= 2, 'a reconnect after the refused write');

      // 3. A store that never recovers becomes a terminal failure that is
      //    announced — and time passing does not resurrect it.
      for (let round = 0; round < 30 && observer.terminals.length === 0; round += 1) {
        await clock.waitForDue(3_600_000, 'the next wait');
        await clock.advance(3_600_000);
      }
      expect(observer.terminals.length).toBeGreaterThanOrEqual(1);
      const terminal = observer.terminals[0] as InboundMailTerminalFailure;
      expect(terminal.reason).toBe('local-store-unwritable');
      expect(terminal.fix).toContain('~/.goodvibes/daemon');

      // 4. And the supervisor's OWN status agrees — this is the assertion the
      //    defect was hiding behind.
      expect(rig.supervisor.status.running).toBe(false);
      expect(rig.supervisor.status.mode).toBe('inactive');
      expect(rig.supervisor.capability?.state).not.toBe('healthy');
      expect(rig.supervisor.health().state).not.toBe('healthy');
      expect(rig.supervisor.terminalFailure).not.toBeNull();

      const snapshot = await rig.supervisor.describeStatus();
      expect(snapshot.running).toBe(false);
      expect(snapshot.capability?.state).toBe('insufficient');
    } finally {
      await rig.supervisor.stop();
      mailbox.close();
    }
  }, 30_000);
});

describe('a run loop that dies is observed, never swallowed', () => {
  test('a rejecting run() is caught, reported, and status stops saying running', async () => {
    const source = new ThrowingSource();
    const observer = new RecordingObserver();
    const rig = buildSupervisorRig({ sources: { create: async () => source }, observer });

    const started = await rig.supervisor.start();
    expect(started.running).toBe(true);

    await waitFor(() => rig.supervisor.status.running === false, 'status to stop claiming running');
    expect(rig.supervisor.status.mode).toBe('inactive');
    expect(rig.supervisor.status.reason).toContain('ENOSPC');
    expect(rig.supervisor.terminalFailure).not.toBeNull();
    expect(observer.terminals.length).toBe(1);
    expect(rig.supervisor.health().state).toBe('degraded');

    await rig.supervisor.stop();
  });
});

// ---------------------------------------------------------------------------
// 2. One unreadable byte does not disable everything else
// ---------------------------------------------------------------------------

describe('an unreadable store file is discarded and disclosed, not a permanent hard failure', () => {
  test('the other two stores still sweep, and the corruption is itemised', async () => {
    const cursorPath = join(dir, 'cursors.json');
    const recordPath = join(dir, 'records.json');
    const expectationPath = join(dir, 'expectations.json');
    const disclosurePath = join(dir, 'housekeeping.json');
    const now = Date.parse('2026-07-27T12:00:00.000Z');

    const records = new InboundMailStore(recordPath, {
      policy: { retentionMs: 1_000 },
      now: () => now,
    });
    // Seeded into the FILE rather than written through `record()`.
    //
    // `record()` applies both policy bounds to what it writes, so a record
    // already past `retentionMs` never lands — which is the point of that fix
    // and makes it useless as a way to manufacture rows for a sweep to find.
    // These five stand for what a sweep genuinely still has to reach: rows a
    // previous build wrote, rows a peer process wrote, rows that aged past the
    // window while nothing was writing.
    writeFileSync(recordPath, `${JSON.stringify({
      version: 1,
      records: Array.from({ length: 5 }, (_unused, index) => ({
        id: `seeded-${String(index)}`,
        account: ACCOUNT,
        mailbox: MAILBOX,
        source: 'imap',
        uidValidity: 1,
        uid: 100 + index,
        senderDisplay: 'sender@example.test',
        subject: `old ${String(index)}`,
        deliveredToAddress: null,
        deliveryEvidenceSource: 'none',
        links: [],
        outcome: 'no-expectation',
        noticeStatus: 'delivered',
        bodyExcerpt: 'nothing',
        receivedAt: new Date(now - 86_400_000).toISOString(),
      })),
    }, null, 2)}\n`, 'utf-8');
    expect((await records.list()).length).toBe(0); // read-time filter hides them
    expect(JSON.parse(readFileSync(recordPath, 'utf-8')).records.length).toBe(5);

    // One unreadable byte where the cursors live.
    writeFileSync(cursorPath, '{"version": 1, "cursors": [', 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(cursorPath),
      records,
      expectations: new PersistedExpectationStore(expectationPath),
      disclosurePath,
      now: () => now,
    });

    const report = await housekeeper.runRecoverySweep();

    // The two healthy stores were swept even though the first one was torn.
    expect(report.records?.removed.length).toBe(5);
    expect(JSON.parse(readFileSync(recordPath, 'utf-8')).records.length).toBe(0);
    expect(report.expectations).not.toBeNull();
    expect(housekeeper.getLastReport()).not.toBeNull();

    // The corruption is disclosed rather than merely survived.
    expect(report.cursors?.removed.some((entry) => entry.reason === 'file-unreadable')).toBe(true);
    expect(report.summary).toContain('could not be read');
    expect(existsSync(disclosurePath)).toBe(true);
    const disclosed = JSON.parse(readFileSync(disclosurePath, 'utf-8')) as { reports: { summary: string }[] };
    expect(disclosed.reports.at(-1)?.summary).toContain('could not be read');
  });

  test('start() still starts and email.inbound.status still answers, naming the corruption', async () => {
    writeFileSync(join(dir, 'cursors.json'), 'not json at all', 'utf-8');
    const source = new SteadySource();
    const rig = buildSupervisorRig({ sources: { create: async () => source } });

    const status = await rig.supervisor.start();
    expect(status.running).toBe(true);

    const snapshot = await rig.supervisor.describeStatus();
    expect(snapshot.cursors).toEqual([]);
    const cursorStore = snapshot.stores.find((entry) => entry.store === 'cursors');
    expect(cursorStore?.state).toBe('discarded-unreadable');
    expect(cursorStore?.detail.length).toBeGreaterThan(0);

    // The verb itself answers rather than erroring out in exactly the state it
    // exists to disclose.
    const handler = createEmailInboundStatusHandler(rig.supervisor);
    const answered = await handler({ methodId: 'email.inbound.status' } as never) as {
      stores: { store: string; state: string }[];
    };
    expect(answered.stores.some((entry) => entry.store === 'cursors' && entry.state === 'discarded-unreadable')).toBe(true);

    await rig.supervisor.stop();
  });
});

// ---------------------------------------------------------------------------
// 3. A terminal failure reaches the owner
// ---------------------------------------------------------------------------

describe('a terminal failure is announced to the owner, once per transition', () => {
  function failure(reason: InboundMailTerminalFailure['reason'], detail: string): InboundMailTerminalFailure {
    return {
      account: ACCOUNT,
      mailbox: MAILBOX,
      reason,
      detail,
      fix: 'Store a current mail password.',
      at: '2026-07-27T12:00:00.000Z',
      notice: null,
    };
  }

  test('the notice goes out through the structured-notice port, built from structured fields', async () => {
    const sent: StructuredNotice[] = [];
    const announcer = createInboundTerminalFailureAnnouncer({
      send: async (notice) => { sent.push(notice); return { delivered: true }; },
    });

    announcer.terminalFailure(failure('credentials-rejected', 'NO [AUTHENTICATIONFAILED] *bad* password'));
    await waitFor(() => sent.length === 1, 'the terminal-failure notice');

    const notice = sent[0] as StructuredNotice;
    expect(notice.title.map((span) => span.text).join('')).toContain('stopped');
    const spans = notice.fields.flatMap((field) => field.value);
    // The server's own wording is carried as untrusted, so the channel escapes
    // it rather than the producer holding formatted text (§7.1).
    expect(spans.some((span) => span.kind === 'untrusted' && span.text.includes('*bad*'))).toBe(true);
    // Our own words stay literal.
    expect(spans.some((span) => span.kind === 'literal' && span.text.includes('credentials-rejected'))).toBe(true);
    expect(spans.some((span) => span.kind === 'literal' && span.text.includes('Store a current mail password.'))).toBe(true);
  });

  test('the same condition twice is one notice; a recovery re-arms it', async () => {
    const sent: StructuredNotice[] = [];
    const announcer = createInboundTerminalFailureAnnouncer({
      send: async (notice) => { sent.push(notice); return { delivered: true }; },
    });

    announcer.terminalFailure(failure('credentials-rejected', 'refused'));
    // Awaited BEFORE the second call, so this exercises the confirmed-delivery
    // latch rather than the in-flight guard. Firing both synchronously would
    // pass either way and prove neither.
    await waitFor(() => sent.length >= 1, 'the first notice');
    announcer.terminalFailure(failure('credentials-rejected', 'refused again'));
    await flush(3);
    expect(sent.length).toBe(1);

    announcer.stateChanged({
      account: ACCOUNT,
      mailbox: MAILBOX,
      from: REJECTED,
      to: HEALTHY,
      at: '2026-07-27T13:00:00.000Z',
    });
    announcer.terminalFailure(failure('credentials-rejected', 'refused once more'));
    await waitFor(() => sent.length === 2, 'the notice after a recovery');
    expect(sent.length).toBe(2);
  });

  /**
   * The wiring, not the renderer.
   *
   * `composeInboundMail` is where `deliverStructuredNotice` and the terminal
   * failure were in the same function and never met: the only consumer of
   * `terminalFailure` was `logger.error`, so a test asserting the log line
   * would have passed the broken code. This drives a real supervisor built by
   * the real composition into a terminal `credentials-missing` (host and
   * account configured, no password stored) and asserts the OWNER's notice
   * port was called.
   */
  test('composeInboundMail routes a terminal failure to deliverStructuredNotice', async () => {
    const sent: StructuredNotice[] = [];
    const values: Record<string, unknown> = {
      'surfaces.email.inbound.enabled': true,
      'surfaces.email.inbound.accounts': JSON.stringify([ACCOUNT]),
      'surfaces.email.inbound.source': 'imap',
      'surfaces.email.imap.host': 'imap.example.test',
      'surfaces.email.user': 'watched@example.test',
      'surfaces.email.imap.mailbox': MAILBOX,
    };
    const supervisor = composeInboundMail({
      configManager: { get: (key: string) => values[key] } as never,
      // No mail password anywhere: the connection path throws
      // `EmailCredentialUnavailableError`, which is terminal.
      secretsManager: { get: async () => null } as never,
      shellPaths: { resolveUserPath: (_scope: string, name: string) => join(dir, name) } as never,
      routeBindings: {
        // The gate is ON with no bindings stored — the fresh-install shape.
        // `resolveNoticeRoute` now asks, so that it can tell this apart from
        // the gate being off, which answers `[]` identically.
        isRouteBindingEnabled: () => true,
        listBindings: () => [],
        getBinding: () => undefined,
      } as never,
      gatewayMethods: { get: () => undefined, register: () => undefined } as never,
      deliverStructuredNotice: async (_binding, notice) => {
        sent.push(notice);
        return { delivered: true } as never;
      },
      // This case is about the IMAP terminal-failure path, so the machine it
      // runs on has no Google account — STATED, rather than left as an absent
      // optional. `gmailReader` is required precisely because an unfilled
      // optional field is what let the Gmail arm ship inert.
      gmailReader: async () => ({
        kind: 'unavailable',
        detail: 'No Google account is connected on this machine.',
        fix: '',
      }),
    });

    expect(supervisor).not.toBeNull();
    try {
      await supervisor?.start();
      await waitFor(() => sent.length >= 1, 'the owner notice for a terminal failure', 10_000);
      const spans = (sent[0] as StructuredNotice).fields.flatMap((field) => field.value);
      expect(spans.some((span) => span.text.includes('credentials-missing'))).toBe(true);
    } finally {
      await supervisor?.stop();
    }
  }, 20_000);

  /**
   * The refusal the `.catch()` could never see.
   *
   * `deliverStructuredNotice` reports a refused delivery by RESOLVING
   * `{ delivered: false, reason: 'no-route-binding' }` — it does not reject.
   * With no route binding configured, which is a fresh install, the announcer
   * latched before the send, the rejection handler never fired, nothing
   * recorded the failure, and the log line said `announced: true`. The owner
   * was told nothing about the one condition that means no mail will ever
   * arrive again, and every later occurrence was suppressed as a repeat of an
   * announcement that never happened.
   */
  describe('a refusal that RESOLVES is a delivery failure, not a success', () => {
    function refusingAnnouncer() {
      const logs: { message: string; fields: Record<string, unknown> }[] = [];
      const attempts: StructuredNotice[] = [];
      const announcer = createInboundTerminalFailureAnnouncer({
        send: async (notice) => {
          attempts.push(notice);
          // Verbatim what surface-delivery.ts returns for a missing binding.
          return { delivered: false, reason: 'no-route-binding' };
        },
        log: (message, fields) => { logs.push({ message, fields }); },
      });
      return { announcer, attempts, logs };
    }

    test('the log never claims the owner was told', async () => {
      const { announcer, logs } = refusingAnnouncer();
      announcer.terminalFailure(failure('credentials-rejected', 'refused'));
      await flush(3);

      // No line anywhere may assert announced: true.
      expect(logs.some((entry) => entry.fields.announced === true)).toBe(false);
    });

    test('the delivery failure is RECORDED rather than swallowed', async () => {
      const { announcer, logs } = refusingAnnouncer();
      announcer.terminalFailure(failure('credentials-rejected', 'refused'));
      await flush(3);

      const failed = logs.find((entry) => entry.message.includes('could not be delivered'));
      expect(failed).toBeDefined();
      expect(failed?.fields.announced).toBe(false);
      expect(failed?.fields.delivery).toBe('no-route-binding');
    });

    test('a second occurrence tries AGAIN instead of being latched out', async () => {
      const { announcer, attempts } = refusingAnnouncer();
      announcer.terminalFailure(failure('credentials-rejected', 'refused'));
      await flush(3);
      announcer.terminalFailure(failure('credentials-rejected', 'refused again'));
      await flush(3);

      // The latch may only close on a delivery that actually happened.
      expect(attempts.length).toBe(2);
    });

    test('once it DOES get through, the latch closes as before', async () => {
      // The half the reviewer verified is correct must not regress.
      const attempts: StructuredNotice[] = [];
      let deliver = false;
      const announcer = createInboundTerminalFailureAnnouncer({
        send: async (notice) => {
          attempts.push(notice);
          return deliver ? { delivered: true } : { delivered: false, reason: 'no-route-binding' };
        },
        log: () => { /* not under test here */ },
      });

      announcer.terminalFailure(failure('credentials-rejected', 'refused'));
      await flush(3);
      expect(attempts.length).toBe(1);

      deliver = true;
      announcer.terminalFailure(failure('credentials-rejected', 'refused again'));
      await flush(3);
      expect(attempts.length).toBe(2);

      // Now it landed, so the third is suppressed.
      announcer.terminalFailure(failure('credentials-rejected', 'and again'));
      await flush(3);
      expect(attempts.length).toBe(2);
    });

    test('a send that rejects is also recorded, and also does not latch', async () => {
      const attempts: StructuredNotice[] = [];
      const logs: { message: string; fields: Record<string, unknown> }[] = [];
      const announcer = createInboundTerminalFailureAnnouncer({
        send: async (notice) => {
          attempts.push(notice);
          throw new Error('the route is down');
        },
        log: (message, fields) => { logs.push({ message, fields }); },
      });

      announcer.terminalFailure(failure('credentials-rejected', 'refused'));
      await flush(3);
      expect(logs.some((entry) => entry.message.includes('could not be delivered'))).toBe(true);
      expect(logs.some((entry) => entry.fields.announced === true)).toBe(false);

      announcer.terminalFailure(failure('credentials-rejected', 'refused again'));
      await flush(3);
      expect(attempts.length).toBe(2);
    });

    test('a port that returns no verdict is treated as undelivered, not assumed sent', async () => {
      // An untyped embedder returning undefined. It has not said the owner was
      // reached, so he was not reached.
      const attempts: StructuredNotice[] = [];
      const logs: { message: string; fields: Record<string, unknown> }[] = [];
      const announcer = createInboundTerminalFailureAnnouncer({
        send: (async (notice: StructuredNotice) => {
          attempts.push(notice);
        }) as never,
        log: (message, fields) => { logs.push({ message, fields }); },
      });

      announcer.terminalFailure(failure('credentials-rejected', 'refused'));
      await flush(3);

      expect(logs.some((entry) => entry.fields.announced === true)).toBe(false);
      const failed = logs.find((entry) => entry.message.includes('could not be delivered'));
      expect(failed?.fields.delivery).toBe('no-verdict');

      announcer.terminalFailure(failure('credentials-rejected', 'again'));
      await flush(3);
      expect(attempts.length).toBe(2);
    });
  });

  test('a notice route that throws does not become a second failure', () => {
    const announcer = createInboundTerminalFailureAnnouncer({
      send: async () => { throw new Error('the route is down'); },
    });
    expect(() => { announcer.terminalFailure(failure('credentials-rejected', 'refused')); }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Recovery from insufficient reaches status
// ---------------------------------------------------------------------------

describe('recovery from insufficient is visible without a restart', () => {
  test('status and health follow the watcher back to healthy', async () => {
    const source = new SteadySource();
    const rig = buildSupervisorRig({
      sources: {
        create: async (input) => { source.observer = input.observer; return source; },
      },
    });

    await rig.supervisor.start();
    expect(rig.supervisor.status.running).toBe(true);

    source.observer?.stateChanged?.({
      account: ACCOUNT, mailbox: MAILBOX, from: HEALTHY, to: REJECTED,
      at: '2026-07-27T12:00:00.000Z',
    });
    expect(rig.supervisor.status.running).toBe(false);
    expect(rig.supervisor.health().state).toBe('degraded');

    // The hourly re-probe cleared it.
    source.observer?.stateChanged?.({
      account: ACCOUNT, mailbox: MAILBOX, from: REJECTED, to: HEALTHY,
      at: '2026-07-27T13:00:00.000Z',
    });

    expect(rig.supervisor.status.running).toBe(true);
    expect(rig.supervisor.status.mode).toBe('idle');
    expect(rig.supervisor.health().state).toBe('healthy');

    const snapshot = await rig.supervisor.describeStatus();
    expect(snapshot.running).toBe(true);
    expect(snapshot.health.state).toBe('healthy');

    await rig.supervisor.stop();
  });
});
