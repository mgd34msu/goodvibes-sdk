/**
 * inbound-mail-notice-refusal-surfaced.test.ts
 *
 * The retryable/permanent split in the intake is right and is not what these
 * are about. Retrying `no-route-binding` forever would pin the cursor on a
 * message that fails identically on every pass while the mailbox never drained,
 * so a structural refusal completes the pass. The defect is what "completes"
 * meant: the message was recorded, the cursor advanced, nothing ever
 * re-announced it, and every surface a person reads went on saying the
 * capability was fine. The owner had mail arriving that he was never told
 * about, and nothing anywhere said so.
 *
 * Two triggers reached it and neither was visible:
 *
 *  - the shipped `notice.route: 'default'` resolves to "the newest route
 *    binding", which is nothing on a fresh install;
 *  - `RouteBindingManager.listBindings()` returns `[]` whenever the
 *    `route-binding` feature gate is off, so an unrelated flag turned inbound
 *    mail into a recorder while its status reported healthy.
 *
 * So: a refusal is latched and counted, `email.inbound.status` says so, the
 * health entry says `degraded`, the log fires once per condition rather than
 * once per message, and the two triggers no longer arrive as the same answer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInboundMailIntake,
  createInboundNoticeHealth,
  describeInboundMailHealth,
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  type InboundMailSourceFactory,
  type InboundMailSupervisorDeps,
  type InboundNoticeHealth,
  type NoticeRouteResolution,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import { composeInboundMail } from '../packages/sdk/src/platform/daemon/facade-inbound-mail.ts';
import { createEmailInboundStatusHandler } from '../packages/sdk/src/platform/control-plane/routes/email-inbound-status.ts';
import type { InboundMailSource } from '../packages/sdk/src/platform/email/inbound/source.ts';
import type {
  ImapInboundMessage,
  InboundCapabilityVerdict,
} from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { SurfaceNoticeDelivery } from '../packages/sdk/src/platform/daemon/types.ts';

const NOW = new Date('2026-07-28T09:00:00.000Z');
const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-notice-refusal-'));
  dirs.push(dir);
  return dir;
}

function mail(uid: number): ImapInboundMessage {
  return {
    source: 'imap',
    account: ACCOUNT,
    mailbox: MAILBOX,
    from: 'verify@service.test',
    subject: 'Confirm your account',
    claimedDate: 'Tue, 28 Jul 2026 08:59:00 +0000',
    messageId: `<${String(uid)}@service.test>`,
    deliveredTo: ['signup-9f31@his-catchall.test'],
    unverifiedToHeaderClaim: 'signup-9f31@his-catchall.test',
    uidValidity: 1000,
    uid,
    envelope: {} as ImapInboundMessage['envelope'],
    via: 'idle',
  };
}

const NO_ROUTE: NoticeRouteResolution = {
  kind: 'unavailable',
  reason: 'no-route-binding',
  detail: 'no channel has ever been connected.',
  fix: 'Connect a channel the daemon can reach you on.',
};

function intakeWith(options: {
  readonly dir: string;
  readonly noticeHealth: InboundNoticeHealth;
  readonly route: NoticeRouteResolution;
  readonly delivery?: SurfaceNoticeDelivery;
}) {
  const expectationStore = new PersistedExpectationStore(
    join(options.dir, 'expectations.json'), { now: () => NOW },
  );
  const records = new InboundMailStore(join(options.dir, 'records.json'));
  const sent: unknown[] = [];
  const intake = createInboundMailIntake({
    expectations: new InboundExpectationRegistry({
      store: expectationStore, now: () => NOW,
    }).matcher,
    records,
    notices: {
      resolveBinding: () => options.route,
      send: async (notice) => {
        sent.push(notice);
        return options.delivery ?? { delivered: true };
      },
    },
    noticeMode: () => 'all',
    now: () => NOW,
    noticeHealth: options.noticeHealth,
  });
  return { intake, records, sent };
}

describe('a structural refusal is surfaced, not merely recorded', () => {
  test('the condition is latched with its fix and the count of what went unannounced', async () => {
    const dir = scratch();
    const logs: { message: string; fields: Record<string, unknown> }[] = [];
    const health = createInboundNoticeHealth({
      log: (message, fields) => { logs.push({ message, fields }); },
    });
    const rig = intakeWith({ dir, noticeHealth: health, route: NO_ROUTE });

    await rig.intake(mail(205));
    await rig.intake(mail(206));
    await rig.intake(mail(207));

    const state = health.get();
    expect(state).not.toBeNull();
    expect(state!.reason).toBe('no-route-binding');
    expect(state!.fix).toContain('Connect a channel');
    // The number that makes it undeniable. A latch that suppressed the COUNT
    // as well as the log line would hide exactly the fact worth reporting.
    expect(state!.unannounced).toBe(3);

    // Once per condition, not once per message.
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('recorded but not announced');
    // And never phrased as a claim about what the owner has seen.
    expect(logs[0]!.fields.announcedToOwner).toBe(false);

    // Still recorded, with the delivery layer's own vocabulary, and still
    // completing the pass — the retryable/permanent split is unchanged.
    const stored = await rig.records.list();
    expect(stored).toHaveLength(3);
    expect(stored.every((record) => record.noticeStatus === 'no-route-binding')).toBe(true);
    expect(rig.sent).toHaveLength(0);
  });

  test('a refusal that comes back from the transport is surfaced with its own reason', async () => {
    const dir = scratch();
    const health = createInboundNoticeHealth({ log: () => undefined });
    const rig = intakeWith({
      dir,
      noticeHealth: health,
      route: { kind: 'bound', binding: { surfaceKind: 'telegram' } },
      delivery: { delivered: false, reason: 'surface-delivery-disabled' },
    });

    await rig.intake(mail(205));

    expect(health.get()?.reason).toBe('surface-delivery-disabled');
    expect(health.get()?.fix).toContain('Turn delivery on');
  });

  test('a notice that gets through clears the condition and re-arms the report', async () => {
    const dir = scratch();
    const logs: { message: string }[] = [];
    const health = createInboundNoticeHealth({ log: (message) => { logs.push({ message }); } });
    const refusing = intakeWith({ dir, noticeHealth: health, route: NO_ROUTE });
    await refusing.intake(mail(205));
    expect(health.get()).not.toBeNull();

    const working = intakeWith({
      dir,
      noticeHealth: health,
      route: { kind: 'bound', binding: { surfaceKind: 'telegram' } },
    });
    await working.intake(mail(206));

    expect(health.get()).toBeNull();
    expect(logs.some((entry) => entry.message.includes('reaching the owner again'))).toBe(true);

    // Re-armed: the SECOND time it starts failing he is told again rather than
    // the first report standing in for every later one.
    await refusing.intake(mail(207));
    expect(health.get()?.unannounced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The supervisor's surfaces
// ---------------------------------------------------------------------------

const HEALTHY: InboundCapabilityVerdict = {
  state: 'healthy',
  reason: 'idle-push',
  detail: 'The server advertised IDLE and is pushing.',
  fix: '',
};

class QuietSource implements InboundMailSource {
  readonly kind = 'imap' as const;
  readonly latency = { kind: 'push' } as const;
  async start(): Promise<InboundCapabilityVerdict> { return HEALTHY; }
  async run(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
  }
  async stop(): Promise<void> { /* nothing to release */ }
}

function supervisorWith(dir: string, noticeHealth: InboundNoticeHealth): InboundMailSupervisor {
  const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), {
    isAccountConfigured: (account) => account === ACCOUNT,
  });
  const records = new InboundMailStore(join(dir, 'records.json'));
  const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'), {
    now: () => NOW,
  });
  const sources: InboundMailSourceFactory = { create: async () => new QuietSource() };
  return new InboundMailSupervisor({
    config: {
      get: (key: string) => ({
        'surfaces.email.inbound.enabled': true,
        'surfaces.email.inbound.source': 'imap',
      } as Record<string, unknown>)[key],
    } as unknown as InboundMailSupervisorDeps['config'],
    account: ACCOUNT,
    mailbox: MAILBOX,
    sources,
    selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
    cursors,
    records,
    expectations: new InboundExpectationRegistry({ store: expectationStore, now: () => NOW }),
    expectationPolicy: expectationStore,
    housekeeper: new InboundMailHousekeeper({
      cursors,
      records,
      expectations: expectationStore,
      disclosurePath: join(dir, 'housekeeping.json'),
    }),
    handle: async () => undefined,
    noticeHealth,
  });
}

describe('a mailbox that announces nothing does not report healthy', () => {
  test('status, health and the disclosure verb all say it, while the watcher is running', async () => {
    const dir = scratch();
    const health = createInboundNoticeHealth({ log: () => undefined });
    const supervisor = supervisorWith(dir, health);
    try {
      const started = await supervisor.start();
      // The watcher IS fine. Every fact these surfaces used to be built from
      // is satisfied, which is exactly why the refusal was invisible.
      expect(started.running).toBe(true);
      expect(supervisor.health().state).toBe('healthy');

      const rig = intakeWith({ dir, noticeHealth: health, route: NO_ROUTE });
      await rig.intake(mail(205));
      await rig.intake(mail(206));

      expect(supervisor.status.running).toBe(true);
      expect(supervisor.status.mode).toBe('idle');
      expect(supervisor.status.reason).toContain('is NOT being announced');
      expect(supervisor.status.reason).toContain('2 messages have been recorded without a notice');

      const entry = supervisor.health();
      expect(entry.state).toBe('degraded');
      expect(entry.metadata.noticeRefusedReason).toBe('no-route-binding');
      expect(entry.metadata.unannouncedMessages).toBe(2);

      const snapshot = await supervisor.describeStatus();
      expect(snapshot.noticeDelivery.state).toBe('refused');
      if (snapshot.noticeDelivery.state !== 'refused') throw new Error('narrowing failed');
      expect(snapshot.noticeDelivery.reason).toBe('no-route-binding');
      expect(snapshot.noticeDelivery.unannounced).toBe(2);

      // And it reaches the wire, not only the in-process snapshot.
      const wire = await createEmailInboundStatusHandler(supervisor)({}, {} as never);
      expect((wire as { noticeDelivery: { state: string } }).noticeDelivery.state).toBe('refused');
    } finally {
      await supervisor.stop();
    }
  });

  test('with notices getting through it reports healthy and ok', async () => {
    const dir = scratch();
    const health = createInboundNoticeHealth({ log: () => undefined });
    const supervisor = supervisorWith(dir, health);
    try {
      await supervisor.start();
      const rig = intakeWith({
        dir,
        noticeHealth: health,
        route: { kind: 'bound', binding: { surfaceKind: 'telegram' } },
      });
      await rig.intake(mail(205));

      expect(supervisor.health().state).toBe('healthy');
      expect(supervisor.status.reason).not.toContain('is NOT being announced');
      expect((await supervisor.describeStatus()).noticeDelivery.state).toBe('ok');
    } finally {
      await supervisor.stop();
    }
  });

  test('describeInboundMailHealth alone reports degraded for a refusal', () => {
    // The health function is what the doctor report and the channel-health
    // view render, so the arm is asserted at its own boundary too.
    const base = {
      account: ACCOUNT,
      mailbox: MAILBOX,
      enabled: true,
      running: true,
      mode: 'idle' as const,
      reason: 'pushing',
      verdict: HEALTHY,
    };
    expect(describeInboundMailHealth(base).state).toBe('healthy');
    expect(describeInboundMailHealth({
      ...base,
      noticeRefusal: {
        reason: 'no-route-binding',
        detail: 'nothing connected.',
        fix: 'Connect a channel.',
        at: NOW.toISOString(),
        since: NOW.toISOString(),
        unannounced: 4,
      },
    }).state).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// The feature gate: an unrelated flag must not read as "you configured nothing"
// ---------------------------------------------------------------------------

function composeWith(dir: string, routeBindings: Record<string, unknown>) {
  const values: Record<string, unknown> = {
    'surfaces.email.inbound.enabled': true,
    'surfaces.email.inbound.accounts': JSON.stringify([ACCOUNT]),
    'surfaces.email.inbound.source': 'imap',
    'surfaces.email.imap.mailbox': MAILBOX,
    'surfaces.email.inbound.notice.route': 'default',
    'surfaces.email.inbound.notice.mode': 'all',
  };
  const deliveries: (string | undefined)[] = [];
  const supervisor = composeInboundMail({
    configManager: { get: (key: string) => values[key] } as never,
    secretsManager: { get: async () => null } as never,
    shellPaths: { resolveUserPath: (_scope: string, name: string) => join(dir, name) } as never,
    routeBindings: routeBindings as never,
    gatewayMethods: { get: () => undefined, register: () => undefined } as never,
    deliverStructuredNotice: async (binding) => {
      deliveries.push((binding as { id?: string } | undefined)?.id);
      return { delivered: true } as never;
    },
  });
  return { supervisor, deliveries };
}

/** A stored binding that `listBindings()` would return when the gate is on. */
const STORED_BINDING = {
  id: 'route-abc123',
  surfaceKind: 'telegram',
  externalId: '55512345',
  lastSeenAt: 1_000,
};

describe('route binding switched off is reported as itself, not as "nothing configured"', () => {
  test('the gate being off names integrations.routeBinding, with bindings actually stored', async () => {
    const dir = scratch();
    const composed = composeWith(dir, {
      // The exact shape `RouteBindingManager` presents with the gate off: it
      // holds the binding and answers `[]` anyway.
      isRouteBindingEnabled: () => false,
      listBindings: () => [],
      getBinding: () => undefined,
    });
    expect(composed.supervisor).not.toBeNull();

    const snapshot = await composed.supervisor!.describeStatus();
    expect(snapshot.noticeDelivery.state).toBe('ok');

    // Drive one message through the composed intake by way of the supervisor's
    // own handler seam: the composition is what wires the notice health, so
    // this is the boot wiring being exercised rather than a rebuilt graph.
    await (composed.supervisor as unknown as {
      deps: { handle: (message: ImapInboundMessage) => Promise<void> };
    }).deps.handle(mail(205));

    const after = await composed.supervisor!.describeStatus();
    expect(after.noticeDelivery.state).toBe('refused');
    if (after.noticeDelivery.state !== 'refused') throw new Error('narrowing failed');
    expect(after.noticeDelivery.reason).toBe('route-binding-disabled');
    expect(after.noticeDelivery.fix).toContain('integrations.routeBinding');
    expect(after.health.state).toBe('degraded');
  });

  test('the gate being ON with no bindings is a different reason and a different fix', async () => {
    const dir = scratch();
    const composed = composeWith(dir, {
      isRouteBindingEnabled: () => true,
      listBindings: () => [],
      getBinding: () => undefined,
    });
    await (composed.supervisor as unknown as {
      deps: { handle: (message: ImapInboundMessage) => Promise<void> };
    }).deps.handle(mail(205));

    const after = await composed.supervisor!.describeStatus();
    if (after.noticeDelivery.state !== 'refused') throw new Error('expected a refusal');
    expect(after.noticeDelivery.reason).toBe('no-route-binding');
    expect(after.noticeDelivery.fix).toContain('Connect a channel');
  });

  test('the gate being ON with a binding announces, and nothing is refused', async () => {
    const dir = scratch();
    const composed = composeWith(dir, {
      isRouteBindingEnabled: () => true,
      listBindings: () => [STORED_BINDING],
      getBinding: () => undefined,
    });
    await (composed.supervisor as unknown as {
      deps: { handle: (message: ImapInboundMessage) => Promise<void> };
    }).deps.handle(mail(205));

    expect(composed.deliveries).toEqual(['route-abc123']);
    expect((await composed.supervisor!.describeStatus()).noticeDelivery.state).toBe('ok');
  });

  test('a notice.route naming a binding that does not exist says so', async () => {
    const dir = scratch();
    const values: Record<string, unknown> = {
      'surfaces.email.inbound.enabled': true,
      'surfaces.email.inbound.accounts': JSON.stringify([ACCOUNT]),
      'surfaces.email.inbound.source': 'imap',
      'surfaces.email.imap.mailbox': MAILBOX,
      'surfaces.email.inbound.notice.route': 'route-typo',
      'surfaces.email.inbound.notice.mode': 'all',
    };
    const supervisor = composeInboundMail({
      configManager: { get: (key: string) => values[key] } as never,
      secretsManager: { get: async () => null } as never,
      shellPaths: { resolveUserPath: (_scope: string, name: string) => join(dir, name) } as never,
      routeBindings: {
        isRouteBindingEnabled: () => true,
        listBindings: () => [STORED_BINDING],
        getBinding: () => undefined,
      } as never,
      gatewayMethods: { get: () => undefined, register: () => undefined } as never,
      deliverStructuredNotice: async () => ({ delivered: true } as never),
    });
    await (supervisor as unknown as {
      deps: { handle: (message: ImapInboundMessage) => Promise<void> };
    }).deps.handle(mail(205));

    const after = await supervisor!.describeStatus();
    if (after.noticeDelivery.state !== 'refused') throw new Error('expected a refusal');
    expect(after.noticeDelivery.reason).toBe('notice-route-not-found');
    // And it does NOT silently fall back to the newest binding, which would be
    // announcing somewhere the owner did not name.
    expect(after.noticeDelivery.detail).toContain('route-typo');
  });
});
