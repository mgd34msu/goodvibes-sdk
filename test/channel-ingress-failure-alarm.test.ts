/**
 * channel-ingress-failure-alarm.test.ts
 *
 * "The first time it logged unavailable should have been a red flag."
 *
 * When a route binding pointed at a closed session, every inbound Telegram
 * update threw, the poller logged `update processing failed; advancing past it`
 * at WARN into a multi-megabyte debug file, and advanced its cursor. Channel
 * health went on reporting Telegram healthy the whole time, because health
 * asked whether the poll LOOP was running, and it was, perfectly. The owner
 * found out by noticing silence.
 *
 * These pin the two things that now happen instead:
 *
 *  1. the surface's reported health goes `degraded`, through the observation
 *     the existing health rule already reads, no parallel mechanism;
 *  2. the owner is told once, on a channel that works, and NOT again for every
 *     subsequent message; recovery says so once and clears the state.
 *
 * Advancing the cursor is unchanged and deliberately so: a wedged cursor
 * redelivering one poison update forever takes the whole channel down instead
 * of one message. What changed is that advancing past is loud.
 */

import { describe, expect, test } from 'bun:test';
import { ChannelIngressAlarm } from '../packages/sdk/src/platform/channels/ingress-alarm.ts';
import { observeTelegramRuntime } from '../packages/sdk/src/platform/channels/builtin/health.ts';
import { resolveChannelHealthState } from '../packages/sdk/src/platform/channels/health.ts';
import { orderOwnerAlertRoutes, deliverOwnerAlert } from '../packages/sdk/src/platform/daemon/owner-alert.ts';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.ts';
import type { ChannelSurface } from '../packages/sdk/src/platform/channels/types.ts';
import type { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.ts';
import type { DaemonSurfaceDeliveryHelper } from '../packages/sdk/src/platform/daemon/surface-delivery.ts';

interface Sent { readonly surface: ChannelSurface; readonly text: string }

function makeAlarm(windowMs = 30 * 60 * 1000) {
  const sent: Sent[] = [];
  let clock = 1_000_000;
  const alarm = new ChannelIngressAlarm({
    notify: (surface, text) => { sent.push({ surface, text }); },
    windowMs,
    now: () => clock,
  });
  return { alarm, sent, advance: (ms: number) => { clock += ms; } };
}

describe('a skipped inbound message alarms once, not once per message', () => {
  test('the FIRST failure notifies the owner', () => {
    const { alarm, sent } = makeAlarm();
    const notified = alarm.recordFailure('telegram', 'Session is closed');
    expect(notified).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.surface).toBe('telegram');
    expect(sent[0]?.text).toContain('could not be processed');
    expect(sent[0]?.text).toContain('Session is closed');
    expect(alarm.failure('telegram')?.count).toBe(1);
  });

  test('a second failure inside the window is counted, not re-sent', () => {
    const { alarm, sent, advance } = makeAlarm(30 * 60 * 1000);
    alarm.recordFailure('telegram', 'Session is closed');
    advance(60_000);
    const notified = alarm.recordFailure('telegram', 'Session is closed');
    expect(notified).toBe(false);
    expect(sent).toHaveLength(1);
    // The count still climbs, "37 messages skipped" is the number that makes
    // the state undeniable, and suppressing it would hide the scale.
    expect(alarm.failure('telegram')?.count).toBe(2);
  });

  test('a failure AFTER the window re-notifies, and says how many have been skipped', () => {
    const { alarm, sent, advance } = makeAlarm(30 * 60 * 1000);
    alarm.recordFailure('telegram', 'Session is closed');
    advance(10 * 60 * 1000);
    alarm.recordFailure('telegram', 'Session is closed');
    advance(21 * 60 * 1000);
    expect(alarm.recordFailure('telegram', 'Session is closed')).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('3 skipped');
  });

  test('recovery clears the state and says so exactly once', () => {
    const { alarm, sent, advance } = makeAlarm();
    alarm.recordFailure('telegram', 'Session is closed');
    advance(1000);
    alarm.recordFailure('telegram', 'Session is closed');
    alarm.recordSuccess('telegram');

    expect(alarm.failure('telegram')).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('processing arriving messages again');
    expect(sent[1]?.text).toContain('2 messages were skipped');

    // Nothing more to announce; a healthy channel is silent.
    alarm.recordSuccess('telegram');
    expect(sent).toHaveLength(2);
  });

  test('a run that was never notified recovers silently', () => {
    const { alarm, sent } = makeAlarm(0);
    // windowMs 0 means every failure notifies, so build the un-notified case
    // directly: a surface with no failure at all must not announce a recovery.
    alarm.recordSuccess('signal');
    expect(sent).toHaveLength(0);
  });

  test('surfaces are latched independently', () => {
    const { alarm, sent } = makeAlarm();
    alarm.recordFailure('telegram', 'Session is closed');
    alarm.recordFailure('slack', 'boom');
    expect(sent.map((entry) => entry.surface)).toEqual(['telegram', 'slack']);
    alarm.recordSuccess('telegram');
    expect(alarm.failure('telegram')).toBeNull();
    expect(alarm.failure('slack')?.count).toBe(1);
  });

  test('a notify that throws does not take down the caller reporting the failure', () => {
    const alarm = new ChannelIngressAlarm({
      notify: () => { throw new Error('no channel available'); },
    });
    expect(() => alarm.recordFailure('telegram', 'Session is closed')).not.toThrow();
    expect(alarm.failure('telegram')?.count).toBe(1);
  });
});

describe('a running poll loop that cannot process is degraded, not healthy', () => {
  test('polling + running + a processing failure reports degraded', () => {
    const observation = observeTelegramRuntime({
      mode: 'polling',
      reason: 'long-polling every 30s',
      running: true,
      lastError: 'Session is closed',
    });
    expect(observation.lastError).toBe('Session is closed');
    expect(resolveChannelHealthState({
      enabled: true,
      configured: true,
      credentialResolves: true,
      runtime: observation,
    })).toBe('degraded');
  });

  test('the same loop with nothing failing still reports healthy', () => {
    const observation = observeTelegramRuntime({
      mode: 'polling',
      reason: 'long-polling every 30s',
      running: true,
    });
    expect(observation.lastError).toBeUndefined();
    expect(resolveChannelHealthState({
      enabled: true,
      configured: true,
      credentialResolves: true,
      runtime: observation,
    })).toBe('healthy');
  });

  test('an armed webhook that cannot process is degraded too', () => {
    const observation = observeTelegramRuntime({
      mode: 'webhook',
      reason: 'a webhook is registered',
      running: false,
      lastError: 'Session is closed',
    });
    expect(resolveChannelHealthState({
      enabled: true,
      configured: true,
      credentialResolves: true,
      runtime: observation,
    })).toBe('degraded');
  });
});

describe('the alert reaches the owner on a channel that still works', () => {
  const binding = (id: string, surfaceKind: string, lastSeenAt: number): AutomationRouteBinding => ({
    id,
    kind: 'channel',
    surfaceKind: surfaceKind as AutomationRouteBinding['surfaceKind'],
    surfaceId: `${surfaceKind}-bot`,
    externalId: id,
    lastSeenAt,
    createdAt: 0,
    updatedAt: lastSeenAt,
    metadata: {},
  });

  test('the failing surface is tried FIRST — inbound and outbound fail independently', () => {
    // Telegram's sends worked all day while its receives were being dropped.
    const ordered = orderOwnerAlertRoutes(
      [binding('ntfy-1', 'ntfy', 900), binding('tg-old', 'telegram', 100), binding('tg-new', 'telegram', 500)],
      'telegram',
    );
    expect(ordered.map((entry) => entry.id)).toEqual(['tg-new', 'tg-old', 'ntfy-1']);
  });

  test('a refusal on the failing surface falls through to another connected channel', async () => {
    const attempts: string[] = [];
    const delivered = await deliverOwnerAlert(
      { listBindings: () => [binding('ntfy-1', 'ntfy', 900), binding('tg-1', 'telegram', 500)] } as unknown as RouteBindingManager,
      {
        deliverSurfaceNotice: async (target: AutomationRouteBinding | undefined) => {
          attempts.push(target?.id ?? 'none');
          return target?.surfaceKind === 'telegram'
            ? { delivered: false, reason: 'delivery-failed' as const }
            : { delivered: true };
        },
      } as unknown as Pick<DaemonSurfaceDeliveryHelper, 'deliverSurfaceNotice'>,
      'telegram',
      'telegram is skipping messages',
    );
    expect(attempts).toEqual(['tg-1', 'ntfy-1']);
    expect(delivered?.id).toBe('ntfy-1');
  });

  test('nothing accepting it answers null rather than pretending it was sent', async () => {
    const delivered = await deliverOwnerAlert(
      { listBindings: () => [binding('tg-1', 'telegram', 500)] } as unknown as RouteBindingManager,
      {
        deliverSurfaceNotice: async () => ({ delivered: false, reason: 'no-deliverable-target' as const }),
      } as unknown as Pick<DaemonSurfaceDeliveryHelper, 'deliverSurfaceNotice'>,
      'telegram',
      'telegram is skipping messages',
    );
    expect(delivered).toBeNull();
  });

  test('route binding being switched off is an answer, not a crash', async () => {
    const delivered = await deliverOwnerAlert(
      { listBindings: () => { throw new Error('route binding is turned off'); } } as unknown as RouteBindingManager,
      {
        deliverSurfaceNotice: async () => ({ delivered: true }),
      } as unknown as Pick<DaemonSurfaceDeliveryHelper, 'deliverSurfaceNotice'>,
      'telegram',
      'telegram is skipping messages',
    );
    expect(delivered).toBeNull();
  });
});
