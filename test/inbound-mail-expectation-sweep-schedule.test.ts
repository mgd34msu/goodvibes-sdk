/**
 * The sweep has to RUN, not merely exist.
 *
 * `InboundExpectationRegistry.sweep()` is the only thing that turns an elapsed
 * window into an `onExpired` report, and it had exactly one caller repo-wide:
 * its own test. `onExpired` itself WAS wired, `facade-inbound-mail.ts` passes a
 * handler that logs the expiry with its reason, so the announcement path was
 * built, connected, and unreachable. A signup whose verification mail never
 * arrived was therefore never reported to anybody. That is the silent-death
 * class this whole round exists to close, in the component built to prevent it.
 *
 * Two different claims are checked here and they are not the same claim:
 *
 *  1. the registry can sweep on a schedule at all, and a swept expectation is
 *     reported with its reason (`startSweeping`);
 *  2. the DAEMON arms it, `composeInboundMail`, the real production
 *     composition, leaves a timer running that reaps an expired record with
 *     nothing in the test ever calling `sweep()`.
 *
 * (2) is the one that matters. A method that is reachable in principle is what
 * was already there.
 *
 * WHY THE SECOND TEST WATCHES THE FILE RATHER THAN `list()`. It would be
 * natural to assert that `registry.list()` drops to zero, and it would prove
 * nothing. `list()` answers "what is open at this instant", and an expired
 * record is not open, it is absent from the list whether or not anything has
 * swept, because the list filters on the window. The persisted file has no such
 * behaviour: only a write-through from a real sweep empties it, so it is the
 * one observable that cannot answer correctly by accident.
 *
 * (When this was written, `list()` reached the book's own `list()`, which
 * called `sweepExpired()` and discarded the return value, so the record was
 * not merely absent from the answer, it was destroyed by asking, and with it
 * the report `onExpired` owed the owner. That is fixed; reads filter and only
 * `sweepExpired` reaps. See
 * `test/inbound-mail-expectation-probe-is-a-read.test.ts`. The reason for
 * watching the file is unchanged either way.)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundExpectationRegistry,
  expectationSweepIntervalMs,
  type ExpectationExpiryReport,
} from '../packages/sdk/src/platform/email/inbound/expectation-registry.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';
import { composeInboundMail } from '../packages/sdk/src/platform/daemon/facade-inbound-mail.ts';
import {
  MAX_VERIFICATION_WINDOW_MS,
  MIN_VERIFICATION_WINDOW_MS,
} from '../packages/sdk/src/platform/google/verification-expectations.ts';
import type { GatewayMethodHandler } from '../packages/sdk/src/platform/control-plane/index.ts';

const dirs: string[] = [];
const registries: InboundExpectationRegistry[] = [];

afterEach(() => {
  // Stopped before the directory goes, or a timer that survives the test writes
  // into a path that no longer exists and fails an unrelated test later.
  for (const registry of registries.splice(0)) registry.stopSweeping();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('the sweep interval is derived from the window it is sweeping', () => {
  test('a fifteen-minute window sweeps every thirty seconds', () => {
    expect(expectationSweepIntervalMs(15 * 60_000)).toBe(30_000);
  });

  test('the floor stops a one-minute window arming a two-second timer', () => {
    // 60_000 / 30 is 2_000, which would be a wake-up every two seconds for the
    // life of the daemon to reap a list that is empty almost always.
    expect(expectationSweepIntervalMs(60_000)).toBe(5_000);
  });

  test('the ceiling stops the longest window pushing the cadence past a minute', () => {
    // MAX / 30 is 120_000. `list()` and `capabilityChanged` can retire an
    // expectation at any moment, so the book must not be allowed to disagree
    // with the file for two minutes at a stretch.
    expect(expectationSweepIntervalMs(MAX_VERIFICATION_WINDOW_MS)).toBe(60_000);
  });

  test('a window that is not a usable number falls back to the hard maximum', () => {
    expect(expectationSweepIntervalMs(Number.NaN)).toBe(60_000);
    expect(expectationSweepIntervalMs(0)).toBe(60_000);
    expect(expectationSweepIntervalMs(-5)).toBe(60_000);
  });
});

describe('a scheduled sweep reports an expiry with nobody calling sweep()', () => {
  test('onExpired fires from the timer, naming window-elapsed', async () => {
    const reports: ExpectationExpiryReport[] = [];
    const store = new PersistedExpectationStore(join(newDir('gv-sweep-timer-'), 'expectations.json'));
    let nowMs = Date.parse('2026-07-28T09:00:00.000Z');
    const registry = new InboundExpectationRegistry({
      store,
      now: () => new Date(nowMs),
      onExpired: (report) => reports.push(report),
    });
    registries.push(registry);

    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm the account for example.com',
      windowMs: 15 * 60_000,
    });
    expect(reports.length).toBe(0);

    // The window elapses on the registry's own clock; the test never advances
    // real time by fifteen minutes and never calls `sweep()`.
    nowMs += 16 * 60_000;
    registry.startSweeping(10);
    await sleep(150);

    expect(reports.length).toBe(1);
    expect(reports[0]?.reason).toBe('window-elapsed');
    expect(reports[0]?.recipientAddress).toBe('signup-a1@alias.test');
  });

  test('a second startSweeping replaces the timer rather than adding one', async () => {
    const reports: ExpectationExpiryReport[] = [];
    const store = new PersistedExpectationStore(join(newDir('gv-sweep-rearm-'), 'expectations.json'));
    let nowMs = Date.parse('2026-07-28T09:00:00.000Z');
    const registry = new InboundExpectationRegistry({
      store,
      now: () => new Date(nowMs),
      onExpired: (report) => reports.push(report),
    });
    registries.push(registry);

    registry.startSweeping(10);
    registry.startSweeping(10);
    registry.startSweeping(10);

    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-a1@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });
    nowMs += 16 * 60_000;
    await sleep(150);

    // One expectation, one report. Three timers would have swept it once and
    // then found nothing twice, so the count is the assertion that catches a
    // leaked interval rather than a proxy for it.
    expect(reports.length).toBe(1);

    registry.stopSweeping();
    const after = reports.length;
    await registry.open({
      serviceDomain: 'example.com',
      recipientAddress: 'signup-b2@alias.test',
      purpose: 'confirm',
      windowMs: 15 * 60_000,
    });
    nowMs += 16 * 60_000;
    await sleep(120);
    expect(reports.length).toBe(after);
  });
});

/**
 * The composed daemon graph, over a throwaway directory.
 *
 * Deliberately the real `composeInboundMail` and not a hand-built registry:
 * the finding is that the PRODUCTION wiring never sweeps, and a rig that
 * constructs its own registry would pass while the daemon stayed silent.
 */
function composeRig(overrides: Readonly<Record<string, unknown>> = {}): {
  readonly handlers: Map<string, GatewayMethodHandler>;
  readonly expectationsPath: string;
} {
  const root = newDir('gv-sweep-compose-');
  const values: Record<string, unknown> = {
    'surfaces.email.inbound.enabled': true,
    'surfaces.email.inbound.accounts': JSON.stringify(['primary']),
    'surfaces.email.inbound.source': 'imap',
    'surfaces.email.inbound.notice.mode': 'none',
    'surfaces.email.inbound.notice.route': 'default',
    // One minute, so the derived cadence sits on its 5 s floor and the test is
    // seconds rather than half a minute.
    'surfaces.email.inbound.expectationWindowMinutes': 1,
    'surfaces.email.imap.host': 'imap.example.test',
    'surfaces.email.user': 'watched@example.test',
    ...overrides,
  };
  const handlers = new Map<string, GatewayMethodHandler>();
  const supervisor = composeInboundMail({
    configManager: { get: (key: string) => values[key] } as never,
    secretsManager: { get: async () => null } as never,
    shellPaths: { resolveUserPath: (_scope: string, name: string) => join(root, name) } as never,
    routeBindings: {
      listBindings: () => [],
      getBinding: () => undefined,
      isRouteBindingEnabled: () => true,
    } as never,
    gatewayMethods: {
      get: (id: string) => ({ id }),
      register: (descriptor: { id: string }, handler: GatewayMethodHandler) => {
        handlers.set(descriptor.id, handler);
      },
    } as never,
    deliverStructuredNotice: async () => ({ delivered: true }) as never,
    // Required, and stated rather than omitted: an unfilled optional is exactly
    // what let the Gmail arm ship inert. This rig forces `source: 'imap'`, so
    // the honest answer for it is a machine with no Google account.
    gmailReader: async () => ({
      kind: 'unavailable' as const,
      detail: 'No Google account is connected on this machine.',
      fix: '',
    }),
  });
  expect(supervisor).not.toBeNull();
  return { handlers, expectationsPath: join(root, 'email-inbound-expectations.json') };
}

describe('composeInboundMail arms the sweep in the daemon itself', () => {
  test(
    'an expectation opened through the verb is reaped off disk with nothing calling sweep()',
    async () => {
      const rig = composeRig();

      // The path a signup workstream takes. `windowMs` is the book's own
      // minimum, so the window genuinely elapses in real time, the registry
      // built by `composeInboundMail` uses the real clock and there is nothing
      // to advance.
      const opened = await rig.handlers.get('email.expectation.open')!({
        methodId: 'email.expectation.open',
        body: {
          serviceDomain: 'example.com',
          recipientAddress: 'signup-a1@alias.test',
          purpose: 'confirm the account for example.com',
          windowMs: MIN_VERIFICATION_WINDOW_MS,
        },
      } as never) as { id: string };
      expect(opened.id).toBeTruthy();

      // Written through on open, so the file is the before-state, not an
      // assumption about one.
      expect(readFileSync(rig.expectationsPath, 'utf8')).toContain('signup-a1@alias.test');

      // Longer than one 5 s tick plus the 1 s window. Nothing else in this rig
      // touches the file: the supervisor was never started, so no recovery
      // sweep runs, and the housekeeper's own timer is six hours away.
      await sleep(7_000);

      expect(readFileSync(rig.expectationsPath, 'utf8')).not.toContain('signup-a1@alias.test');
    },
    20_000,
  );
});
