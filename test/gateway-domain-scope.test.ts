/**
 * gateway-domain-scope.test.ts
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

  test('EVENT_DOMAIN tags session-detached→session (W3-S3 detach discriminant, defense-in-depth)', () => {
    expect(EVENT_DOMAIN['session-detached']).toBe('session');
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

  test('(W3-S3) a session-detached update reaches only the session subscriber — detach rides the session-update channel', () => {
    const gateway = makeGateway();
    const sessionSub = connect(gateway, { clientKind: 'web', domains: ['session'] });
    const tasksSub = connect(gateway, { clientKind: 'web', domains: ['tasks'] });

    // The broker's detachParticipant publishes via publishUpdate: the top-level
    // wire event is session-update, session-detached is the payload discriminant.
    gateway.publishEvent('session-update', { event: 'session-detached', payload: { sessionId: 's1', surfaceId: 'tui-1' } });

    expect(sessionSub.received).toContain('session-update');
    expect(tasksSub.received).not.toContain('session-update');
  });

  test('an untagged broadcast event reaches a narrowed subscriber (opt-in narrowing never blacks out new events)', () => {
    const gateway = makeGateway();
    const narrow = connect(gateway, { clientKind: 'web', domains: ['tasks'] });

    gateway.publishEvent('conversation.followup.companion', { sessionId: 's1' });

    expect(narrow.received).toContain('conversation.followup.companion');
  });
});

// ---------------------------------------------------------------------------
// Replay parity (Finding 1) — a reconnecting client must receive the same
// approval-update it would have received live. Before the fix, both replay
// callers (WS + SSE) handed replayRecentTraffic the already-normalized
// `selectedDomains` (which falls back to DEFAULT_DOMAINS, excluding
// 'permissions'), so a default consumer's replay silently dropped
// approval-update even though the live path (null=deliver-all) would have
// delivered it. These tests reconnect DURING a pending approval (the event is
// recorded to the ring while no live client is connected/subscribed) and
// assert the replayed frame reaches a default consumer and a
// domains=permissions consumer, but not a domains=tasks consumer — on both
// transports.
// ---------------------------------------------------------------------------

/** Read SSE frames off a stream whose body is already fully buffered (synchronous replay). */
async function readSseFrames(
  res: Response,
  minCount: number,
  timeoutMs = 200,
): Promise<{ event: string; data: unknown }[]> {
  const frames: { event: string; data: unknown }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (frames.length < minCount && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        frames.push({ event, data: data ? JSON.parse(data) : undefined });
      }
    }
    return frames;
  } finally {
    reader.releaseLock();
    await res.body?.cancel().catch(() => {});
  }
}

describe('replay parity — reconnect must mirror live delivery (Finding 1)', () => {
  test('(WS) a default consumer that reconnects during a pending approval receives the replayed approval-update', () => {
    const gateway = makeGateway();
    // Connect + disconnect first so the event is recorded to the shared ring
    // while no live client is subscribed to it (mirrors "reconnect during a
    // pending approval").
    const first = connect(gateway, { clientKind: 'web' });
    gateway.closeWebSocketClient(first.clientId);
    gateway.publishEvent('approval-update', { id: 'a1' });

    const replayed: string[] = [];
    gateway.openWebSocketClient({ clientKind: 'web' }, (event) => replayed.push(event));

    expect(replayed).toContain('approval-update');
  });

  test('(WS) a domains=permissions consumer also receives the replayed approval-update', () => {
    const gateway = makeGateway();
    gateway.publishEvent('approval-update', { id: 'a1' });

    const replayed: string[] = [];
    gateway.openWebSocketClient({ clientKind: 'web', domains: ['permissions'] }, (event) => replayed.push(event));

    expect(replayed).toContain('approval-update');
  });

  test('(WS) a domains=tasks consumer does NOT receive the replayed approval-update', () => {
    const gateway = makeGateway();
    gateway.publishEvent('approval-update', { id: 'a1' });

    const replayed: string[] = [];
    gateway.openWebSocketClient({ clientKind: 'web', domains: ['tasks'] }, (event) => replayed.push(event));

    expect(replayed).not.toContain('approval-update');
  });

  test('(SSE) a default consumer that reconnects during a pending approval receives the replayed approval-update', async () => {
    const gateway = makeGateway();
    gateway.publishEvent('approval-update', { id: 'a1' });

    const res = gateway.createEventStream(new Request('http://localhost/stream'), { clientKind: 'web' });
    const frames = await readSseFrames(res, 2);

    expect(frames.map((frame) => frame.event)).toContain('approval-update');
  });

  test('(SSE) a domains=permissions consumer also receives the replayed approval-update', async () => {
    const gateway = makeGateway();
    gateway.publishEvent('approval-update', { id: 'a1' });

    const res = gateway.createEventStream(new Request('http://localhost/stream'), {
      clientKind: 'web',
      domains: ['permissions'],
    });
    const frames = await readSseFrames(res, 2);

    expect(frames.map((frame) => frame.event)).toContain('approval-update');
  });

  test('(SSE) a domains=tasks consumer does NOT receive the replayed approval-update', async () => {
    const gateway = makeGateway();
    gateway.publishEvent('approval-update', { id: 'a1' });

    const res = gateway.createEventStream(new Request('http://localhost/stream'), {
      clientKind: 'web',
      domains: ['tasks'],
    });
    const frames = await readSseFrames(res, 1, 150); // only 'ready' should ever arrive

    expect(frames.map((frame) => frame.event)).not.toContain('approval-update');
  });
});
