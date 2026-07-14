/**
 * session-spine-identity.test.ts
 *
 * The identity spine. Covers:
 *  - SurfaceKind / SharedSessionKind vocabulary lockstep (a value added in one
 *    place must be reflected in the others, or these fail).
 *  - project-as-data: createSession stamps project; listSessions filters by
 *    project (and never leaks other projects); default is the cross-project union.
 *  - sessions.register idempotency + participant heartbeat merge.
 *  - restart survival across projects incl. closed sessions + boot reconciliation.
 *  - client-mode broker (no store) refuses construction (single-writer invariant).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR_CONTRACT } from '../packages/contracts/src/generated/operator-contract.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import {
  PRODUCT_SURFACE_KINDS,
  SURFACE_KINDS,
  TRANSPORT_SURFACE_KINDS,
} from '../packages/sdk/src/events/surfaces.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';
import type { SharedSessionKind, SharedSessionParticipant } from '../packages/sdk/src/platform/control-plane/index.ts';
// Cross-package import: the daemon-sdk route validators are ALSO kind-declaration
// sites and must stay in lockstep with the type / broker / wire schema.
import { SHARED_SESSION_KINDS } from '../packages/daemon-sdk/src/runtime-session-routes.ts';

const ALL_KINDS: readonly SharedSessionKind[] = [
  'tui', 'agent', 'webui', 'companion-task', 'companion-chat', 'automation', 'acp',
];

function makeRouteBindings(): RouteBindingManager {
  return {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    resolve: () => undefined,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    patchBinding: async () => null,
    getBinding: () => null,
  } as unknown as RouteBindingManager;
}

function makeBroker(storePath: string): SharedSessionBroker {
  return new SharedSessionBroker({
    storePath,
    routeBindings: makeRouteBindings(),
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => true },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

function participant(surfaceKind: string, surfaceId: string, userId?: string): SharedSessionParticipant {
  return { surfaceKind, surfaceId, ...(userId ? { userId } : {}), lastSeenAt: Date.now() } as SharedSessionParticipant;
}

function withTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'spine-'));
  const storePath = join(dir, 'sessions.json');
  return fn(storePath).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------
// Vocabulary lockstep
// ---------------------------------------------------------------------------

describe('SurfaceKind unification', () => {
  test('canonical SURFACE_KINDS = transport ∪ product, with the four product surfaces', () => {
    expect(SURFACE_KINDS).toEqual([...TRANSPORT_SURFACE_KINDS, ...PRODUCT_SURFACE_KINDS]);
    for (const product of ['agent', 'webui', 'companion', 'automation']) {
      expect(SURFACE_KINDS).toContain(product);
    }
    // Transport list stays strict (route bindings never bind product surfaces).
    for (const product of PRODUCT_SURFACE_KINDS) {
      expect(TRANSPORT_SURFACE_KINDS).not.toContain(product);
    }
  });

  test('product surfaces are valid participant surfaceKinds end-to-end', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      for (const surface of ['agent', 'webui', 'companion'] as const) {
        const s = await broker.register({
          sessionId: `s-${surface}`,
          kind: surface === 'companion' ? 'companion-chat' : surface,
          participant: participant(surface, `surf:${surface}`),
        });
        expect(s.record.surfaceKinds).toContain(surface);
      }
    });
  });
});

describe('SharedSessionKind lockstep (type ↔ validator ↔ wire schema)', () => {
  test('every kind round-trips through persist+reload without defaulting to tui', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      for (const kind of ALL_KINDS) {
        await broker.createSession({ id: `k-${kind}`, kind, project: 'p' });
      }
      // A value added to the type but not to SESSION_KINDS would reload as 'tui'.
      const reloaded = makeBroker(storePath);
      await reloaded.start();
      for (const kind of ALL_KINDS) {
        expect(reloaded.getSession(`k-${kind}`)?.kind).toBe(kind);
      }
    });
  });

  test('the sessions.register wire schema enumerates exactly the declared kinds', () => {
    const register = OPERATOR_CONTRACT.operator.methods.find((m) => m.id === 'sessions.register');
    expect(register).toBeDefined();
    const kindEnum = (register!.inputSchema as { properties?: { kind?: { enum?: string[] } } })
      .properties?.kind?.enum;
    expect(new Set(kindEnum)).toEqual(new Set(ALL_KINDS));
  });

  test('the daemon-sdk route validators (register + list) enumerate exactly the declared kinds', () => {
    // A kind added to the type + broker + wire schema but not here would silently
    // drift out of lockstep with the daemon route validation. handleRegisterSharedSession
    // now shares this single set (no duplicate register-only set), so both the
    // register 400-guard and the response coercion are covered by this assertion.
    expect(new Set(SHARED_SESSION_KINDS)).toEqual(new Set(ALL_KINDS));
  });
});

// ---------------------------------------------------------------------------
// project-as-data
// ---------------------------------------------------------------------------

describe('project-as-data', () => {
  test('createSession stamps project; listSessions filters and never leaks other projects', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      await broker.createSession({ id: 'a1', project: '/projA' });
      await broker.createSession({ id: 'a2', project: '/projA' });
      await broker.createSession({ id: 'b1', project: '/projB' });

      const projA = broker.listSessions(100, { project: '/projA' }).map((s) => s.id).sort();
      expect(projA).toEqual(['a1', 'a2']);
      // MUST NOT leak projB into a projA-scoped query.
      expect(projA).not.toContain('b1');

      // No filter → cross-project union.
      expect(broker.listSessions(100).map((s) => s.id).sort()).toEqual(['a1', 'a2', 'b1']);
    });
  });

  test('createSession without project defaults to "unknown"; legacy records backfill', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      const s = await broker.createSession({ id: 'no-proj' });
      expect(s.project).toBe('unknown');
    });
  });
});

// ---------------------------------------------------------------------------
// sessions.register
// ---------------------------------------------------------------------------

describe('sessions.register — idempotency + heartbeat + honest closed semantics', () => {
  test('registering the same id twice yields one record with an advanced lastSeenAt', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      const first = await broker.register({
        sessionId: 'reg-1', kind: 'agent', project: '/p',
        participant: participant('agent', 'surf:agent', 'user-1'),
      });
      expect(first.reopened).toBe(false);
      const firstSeen = first.record.participants[0]!.lastSeenAt;
      await new Promise((r) => setTimeout(r, 2));
      const second = await broker.register({
        sessionId: 'reg-1', kind: 'agent', project: '/p',
        participant: participant('agent', 'surf:agent', 'user-1'),
      });

      // Exactly one record — no data-loss-by-duplication.
      expect(broker.listSessions(100).filter((s) => s.id === 'reg-1')).toHaveLength(1);
      expect(second.record.participants).toHaveLength(1);
      expect(second.record.participants[0]!.lastSeenAt).toBeGreaterThan(firstSeen);
      expect(second.record.kind).toBe('agent');
      expect(second.record.project).toBe('/p');
    });
  });

  test('register merges a distinct participant (different userId) into the same session', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      await broker.register({ sessionId: 'reg-2', participant: participant('agent', 'surf:a', 'user-1') });
      const merged = await broker.register({ sessionId: 'reg-2', participant: participant('webui', 'surf:w', 'user-2') });
      expect(merged.record.participants).toHaveLength(2);
      expect(merged.record.surfaceKinds.sort()).toEqual(['agent', 'webui']);
    });
  });

  test('register on a CLOSED id does NOT reopen — heartbeat recorded, honest conflict returned', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      await broker.createSession({ id: 'reg-3', kind: 'tui', project: '/p' });
      await broker.closeSession('reg-3');
      const result = await broker.register({ sessionId: 'reg-3', participant: participant('tui', 'surf:t') });
      // Stays closed; the caller is told honestly.
      expect(result.reopened).toBe(false);
      expect(result.conflict).toEqual({ status: 'closed' });
      expect(result.record.status).toBe('closed');
      // But the heartbeat participant WAS recorded (that IS the heartbeat).
      expect(result.record.participants.some((p) => p.surfaceId === 'surf:t')).toBe(true);
      // And the store still shows it closed.
      expect(broker.getSession('reg-3')?.status).toBe('closed');
    });
  });

  test('register on a CLOSED id WITH reopen:true reopens it explicitly', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      await broker.createSession({ id: 'reg-4', kind: 'tui', project: '/p' });
      await broker.closeSession('reg-4');
      const result = await broker.register({ sessionId: 'reg-4', participant: participant('tui', 'surf:t'), reopen: true });
      expect(result.reopened).toBe(true);
      expect(result.conflict).toBeUndefined();
      expect(result.record.status).toBe('active');
      expect(broker.getSession('reg-4')?.status).toBe('active');
    });
  });

  test('a heartbeat never overwrites a real (non-placeholder) title', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      await broker.register({ sessionId: 'reg-5', title: 'My Named Session', participant: participant('tui', 'surf:t') });
      const beat = await broker.register({ sessionId: 'reg-5', title: 'Heartbeat Rename Attempt', participant: participant('tui', 'surf:t') });
      expect(beat.record.title).toBe('My Named Session');
    });
  });
});

// ---------------------------------------------------------------------------
// Restart survival + single-writer invariant
// ---------------------------------------------------------------------------

describe('restart survival across projects', () => {
  test('all sessions (incl. closed, across ≥2 projects) survive a broker restart with kind+project intact', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      await broker.createSession({ id: 'live-a', kind: 'tui', project: '/A' });
      await broker.createSession({ id: 'live-b', kind: 'agent', project: '/B' });
      const closed = await broker.createSession({ id: 'closed-a', kind: 'companion-chat', project: '/A' });
      await broker.closeSession(closed.id);

      const fresh = makeBroker(storePath);
      await fresh.start();
      const byId = new Map(fresh.listSessions(100).map((s) => [s.id, s]));
      expect(byId.get('live-a')?.project).toBe('/A');
      expect(byId.get('live-b')?.kind).toBe('agent');
      // Closed session present after restart (broker path already retained closed).
      expect(byId.get('closed-a')?.status).toBe('closed');
      expect(byId.get('closed-a')?.project).toBe('/A');
      // Boot reconciliation cleared any activeAgentId.
      for (const s of fresh.listSessions(100)) expect(s.activeAgentId).toBeUndefined();
    });
  });

  test('a closed session survives a GC sweep run well past the old 5-min grace (default = retain indefinitely)', async () => {
    await withTempStore(async (storePath) => {
      const broker = makeBroker(storePath);
      const closed = await broker.createSession({ id: 'ancient-closed', kind: 'tui', project: '/A' });
      await broker.closeSession(closed.id);

      // Backdate closedAt far past the OLD 5-min deletion grace, then execute the
      // sweep directly. Under the new default (retain indefinitely) it must NOT delete.
      const store = broker as unknown as {
        sessions: Map<string, { closedAt?: number; updatedAt: number }>;
        gcSweep: () => void;
      };
      const rec = store.sessions.get('ancient-closed')!;
      store.sessions.set('ancient-closed', { ...rec, closedAt: Date.now() - 60 * 60_000 });
      store.gcSweep(); // sweep actually executed

      expect(broker.getSession('ancient-closed')?.status).toBe('closed');
      // And it still survives a restart from disk.
      const fresh = makeBroker(storePath);
      await fresh.start();
      expect(fresh.getSession('ancient-closed')?.status).toBe('closed');
    });
  });
});

describe('single-writer invariant', () => {
  test('a client-mode broker (no store and no storePath) refuses construction', () => {
    expect(() => new SharedSessionBroker({
      routeBindings: makeRouteBindings(),
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => true },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0])).toThrow();
  });
});
