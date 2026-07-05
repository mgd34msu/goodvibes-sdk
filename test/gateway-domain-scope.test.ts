/**
 * gateway-domain-scope.test.ts (W3-S1, Part A)
 *
 * The SSE/WS broadcast fan-out (ControlPlaneGateway.publishEvent) must reach only
 * the clients whose subscribed domains include the event's domain — WITHOUT
 * regressing consumers that did not opt into domain narrowing.
 *
 * These tests drive the domain filter through openWebSocketClient because it
 * exposes the live client's `send` callback directly, so delivery is asserted
 * deterministically with no stream-draining flake. The filter under test lives in
 * publishEvent and is identical for SSE (createEventStream) and WS clients — the
 * only difference between the two transports is how the `domains` field is
 * threaded onto the live client, which the boot-daemon SSE test exercises over
 * real HTTP.
 */

import { describe, expect, test } from 'bun:test';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.js';
import {
  EVENT_DOMAIN,
  clientMayReceiveEventDomain,
} from '../packages/sdk/src/platform/control-plane/gateway-scope-enforcement.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { RuntimeEventDomain } from '../packages/sdk/src/platform/runtime/events/index.js';

function makeGateway(): ControlPlaneGateway {
  return new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
}

/** Register a WS live client and return a recorder that only captures post-handshake sends. */
function connect(
  gateway: ControlPlaneGateway,
  options: Parameters<ControlPlaneGateway['openWebSocketClient']>[0],
): { received: string[]; clientId: string } {
  const received: string[] = [];
  const { clientId } = gateway.openWebSocketClient(options, (event) => {
    received.push(event);
  });
  received.length = 0; // drop 'ready' + replay handshake noise
  return { received, clientId };
}

// ---------------------------------------------------------------------------
// Pure helper — the null=deliver-all + untagged-inert contract
// ---------------------------------------------------------------------------
describe('clientMayReceiveEventDomain — the migration-safe default', () => {
  test('null client domains deliver everything (opt-in narrowing)', () => {
    expect(clientMayReceiveEventDomain(null, 'session-update')).toBe(true);
    expect(clientMayReceiveEventDomain(null, 'approval-update')).toBe(true);
    expect(clientMayReceiveEventDomain(null, 'anything-untagged')).toBe(true);
  });

  test('a narrowed set only receives tagged events in that set', () => {
    const tasksOnly = new Set<RuntimeEventDomain>(['tasks']);
    expect(clientMayReceiveEventDomain(tasksOnly, 'session-update')).toBe(false);
    const sessionOnly = new Set<RuntimeEventDomain>(['session']);
    expect(clientMayReceiveEventDomain(sessionOnly, 'session-update')).toBe(true);
  });

  test('an untagged event is delivered even to a narrowed client (never silently dropped)', () => {
    const narrow = new Set<RuntimeEventDomain>(['tasks']);
    expect(clientMayReceiveEventDomain(narrow, 'brand-new-untagged-event')).toBe(true);
  });

  test('EVENT_DOMAIN tags session-update→session and approval-update→permissions', () => {
    expect(EVENT_DOMAIN['session-update']).toBe('session');
    expect(EVENT_DOMAIN['approval-update']).toBe('permissions');
  });
});

// ---------------------------------------------------------------------------
// Fan-out behavior
// ---------------------------------------------------------------------------
describe('publishEvent — domain-scoped delivery', () => {
  test('(1) session-update reaches only the session subscriber, not the tasks subscriber', () => {
    const gateway = makeGateway();
    const sessionSub = connect(gateway, { clientKind: 'web', domains: ['session'] });
    const tasksSub = connect(gateway, { clientKind: 'web', domains: ['tasks'] });

    gateway.publishEvent('session-update', { event: 'session-created' });

    expect(sessionSub.received).toContain('session-update');
    expect(tasksSub.received).not.toContain('session-update');
  });

  test('(2) a client with NO domains param receives every domain (default-all preserved)', () => {
    const gateway = makeGateway();
    const defaultSub = connect(gateway, { clientKind: 'web' }); // no domains → null → deliver-all

    gateway.publishEvent('session-update', { event: 'session-created' });
    gateway.publishEvent('approval-update', { id: 'a1' });

    // permissions is NOT in DEFAULT_DOMAINS — this proves the default is null
    // (deliver-all) and not the normalized DEFAULT_DOMAINS set, which would have
    // wrongly excluded approval-update.
    expect(defaultSub.received).toContain('session-update');
    expect(defaultSub.received).toContain('approval-update');
  });

  test('(3) the webui profile (tasks,permissions,providers,knowledge,control-plane) drops session-update but keeps approval-update, no error', () => {
    const gateway = makeGateway();
    const webui = connect(gateway, {
      clientKind: 'web',
      domains: ['tasks', 'permissions', 'providers', 'knowledge', 'control-plane'],
    });

    expect(() => {
      gateway.publishEvent('session-update', { event: 'session-created' });
      gateway.publishEvent('approval-update', { id: 'a1' });
    }).not.toThrow();

    expect(webui.received).not.toContain('session-update'); // the fix — was over-delivered before
    expect(webui.received).toContain('approval-update'); // permissions ∈ webui domains
  });

  test('(4) scope and domain filters are AND-ed: matching domain but missing scope is still denied', () => {
    const gateway = makeGateway();
    // domain includes session, but the principal lacks read:sessions (session-update's required scope)
    const scopedDown = connect(gateway, {
      clientKind: 'web',
      domains: ['session'],
      scopes: ['read:tasks'],
    });

    gateway.publishEvent('session-update', { event: 'session-created' });

    expect(scopedDown.received).not.toContain('session-update');
  });

  test('an untagged broadcast event reaches a narrowed subscriber (opt-in narrowing never blacks out new events)', () => {
    const gateway = makeGateway();
    const narrow = connect(gateway, { clientKind: 'web', domains: ['tasks'] });

    gateway.publishEvent('conversation.followup.companion', { sessionId: 's1' });

    expect(narrow.received).toContain('conversation.followup.companion');
  });
});
