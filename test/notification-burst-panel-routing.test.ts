/**
 * notification-burst-panel-routing.test.ts
 *
 * Adaptive notification suppression is on by default
 * (notifications.adaptiveSuppression), and the burst machinery routes
 * collapsed floods to the panel_only target the notifications panel consumes:
 * each collapsed decision carries `target: 'panel_only'`, the `{domain}:{level}`
 * batchKey the panel groups by, and the `burst_collapsed` reason code it
 * renders. Quiet/minimal conversation flow stays clean — operational churn is
 * suppressed to the panel while critical and alert items keep their surface.
 */
import { describe, expect, test } from 'bun:test';
import { createNotificationRouter, NotificationRouter } from '../packages/sdk/src/platform/runtime/notifications/index.js';
import type { Notification, RoutingDecision } from '../packages/sdk/src/platform/runtime/notifications/index.js';
import { DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: (key: string) => {
      if (key in overrides) return overrides[key] as never;
      return key.split('.').reduce<unknown>(
        (cursor, segment) => (cursor as Record<string, unknown>)?.[segment],
        DEFAULT_CONFIG as unknown,
      ) as never;
    },
  };
}

let seq = 0;
function notify(partial: Partial<Notification> & Pick<Notification, 'domain' | 'level'>): Notification {
  seq += 1;
  return {
    id: `n-${seq}`,
    title: partial.title ?? `event ${seq}`,
    timestamp: Date.now(),
    tag: 'operational',
    ...partial,
  };
}

describe('defaults', () => {
  test('the stock config turns adaptive suppression on and the factory derives it', () => {
    expect(DEFAULT_CONFIG.notifications.adaptiveSuppression).toBe(true);
    const router = createNotificationRouter(undefined, undefined, fakeConfig());
    // Prove the suppression stack is live: a minimal-verbosity operational
    // warning is suppressed to panel_only (mode-context), which only runs
    // when adaptive suppression is active.
    router.setDefaultDomainVerbosity('minimal');
    const decision = router.route(notify({ domain: 'tools', level: 'warning' }));
    expect(decision.target).toBe('panel_only');
    expect(decision.reasonCode).toBe('mode_context_minimal');
  });
});

describe('a flood becomes a panel_only collapsed group with its reason code', () => {
  function floodRouter(): NotificationRouter {
    return createNotificationRouter(undefined, undefined, fakeConfig({
      'notifications.burstWindowMs': 1_000,
      'notifications.burstThreshold': 3,
      'notifications.burstCooldownMs': 3_000,
    }));
  }

  test('rapid domain:level churn collapses after the threshold', () => {
    const router = floodRouter();
    const decisions: RoutingDecision[] = [];
    for (let i = 0; i < 10; i++) {
      decisions.push(router.route(notify({ domain: 'agents', level: 'info' })));
    }

    const collapsed = decisions.filter((d) => d.reasonCode === 'burst_collapsed');
    expect(collapsed.length).toBeGreaterThan(0);
    // Every collapsed decision is exactly what the panel consumes: the
    // panel_only target, the group key, and the burst_collapsed reason code.
    for (const decision of collapsed) {
      expect(decision.target).toBe('panel_only');
      expect(decision.batchKey).toBe('agents:info');
      expect(decision.reasonCode).toBe('burst_collapsed');
      expect(decision.suppressed).toBeUndefined();
    }
    // The router exposes the active group key for the panel's collapsed-count line.
    expect(router.getActiveBurstGroups()).toEqual(['agents:info']);
  });

  test('critical and alert notifications never collapse into the flood', () => {
    const router = floodRouter();
    for (let i = 0; i < 10; i++) {
      router.route(notify({ domain: 'agents', level: 'info' }));
    }
    const critical = router.route(notify({ domain: 'agents', level: 'critical' }));
    expect(critical.target).toBe('conversation');
    expect(critical.reasonCode).toBe('allowed');

    const alert = router.route(notify({ domain: 'agents', level: 'info', tag: 'alert' }));
    expect(alert.reasonCode).not.toBe('burst_collapsed');
  });

  test('turning notifications.adaptiveSuppression off keeps only the base policies', () => {
    const router = createNotificationRouter(undefined, undefined, fakeConfig({
      'notifications.adaptiveSuppression': false,
    }));
    const decisions: RoutingDecision[] = [];
    for (let i = 0; i < 10; i++) {
      decisions.push(router.route(notify({ domain: 'agents', level: 'info' })));
    }
    expect(decisions.some((d) => d.reasonCode === 'burst_collapsed')).toBe(false);
    expect(decisions.some((d) => d.reasonCode === 'mode_context_minimal')).toBe(false);
  });
});

describe('quiet/minimal conversation flow stays clean', () => {
  test('minimal mode suppresses operational churn before the conversation and status bar', () => {
    const router = createNotificationRouter(undefined, undefined, fakeConfig());
    router.setDefaultDomainVerbosity('minimal');

    // Operational warning would hit the conversation at normal verbosity;
    // minimal mode holds it to the panel with an honest reason code.
    const warning = router.route(notify({ domain: 'tools', level: 'warning' }));
    expect(warning.target).toBe('panel_only');
    expect(warning.reasonCode).toBe('mode_context_minimal');

    // Critical still reaches the conversation — suppression never eats it.
    const critical = router.route(notify({ domain: 'tools', level: 'critical' }));
    expect(critical.target).toBe('conversation');
    expect(critical.reasonCode).toBe('allowed');
  });
});
