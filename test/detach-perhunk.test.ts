/**
 * sessions.detach + per-hunk approvals (broker + pure-function level).
 *
 * Covers the two new steer verbs at the unit boundary the wire sits on:
 *  A. SharedSessionBroker.detachParticipant — detach != close != kill.
 *  B. ApprovalBroker.resolveApproval({ selectedHunks }) — server-side per-hunk
 *     apply, with the PARITY GOLDEN against the retired TUI reducer.
 *
 * The over-HTTP proofs live in detach-perhunk-daemon-wire.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.ts';
import {
  buildModifiedEditArgs,
  readApprovalEditHunks,
  resolveApprovalHunkSelection,
} from '../packages/sdk/src/platform/control-plane/approval-hunk-apply.ts';
import { detachSharedSessionParticipant } from '../packages/sdk/src/platform/control-plane/session-broker-sessions.ts';
import { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';
import type { SharedSessionRecord } from '../packages/sdk/src/platform/control-plane/session-types.ts';

function makeBroker(): SharedSessionBroker {
  const store = new PersistentStore<never>(':memory:' as string);
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    patchBinding: async () => null,
    getBinding: () => null,
  } as unknown as RouteBindingManager;
  return new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: async () => {} },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

function participant(surfaceId: string, surfaceKind = 'tui') {
  return { surfaceKind, surfaceId, lastSeenAt: Date.now() };
}

function editRequest(edits: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): PermissionPromptRequest {
  return {
    callId: 'call-hunk',
    tool: 'edit',
    args: { edits, ...extra },
    category: 'write',
    analysis: { classification: 'edit', riskLevel: 'medium', summary: 'edit a.ts', reasons: ['multi-edit'] },
  } as PermissionPromptRequest;
}

// The retired TUI reducer, inlined verbatim from goodvibes-tui
// src/permissions/hunk-selection.ts:59-159 as the parity oracle.
function tuiIsEditItemLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c['path'] === 'string' && typeof c['find'] === 'string' && typeof c['replace'] === 'string'
    && (c['id'] === undefined || typeof c['id'] === 'string');
}
function tuiReadEditItems(args: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const edits = args['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const items: Array<Record<string, unknown>> = [];
  for (const entry of edits) {
    if (!tuiIsEditItemLike(entry)) return null;
    items.push(entry as Record<string, unknown>);
  }
  return items;
}
function tuiBuildModifiedEditArgs(request: PermissionPromptRequest, selected: ReadonlySet<number>): Record<string, unknown> {
  const hunks = tuiReadEditItems(request.args) ?? [];
  const filtered = hunks.filter((_, i) => selected.has(i));
  return { ...request.args, edits: filtered };
}

// ---------------------------------------------------------------------------
// PART A — detach (pure helper)
// ---------------------------------------------------------------------------

describe('detachSharedSessionParticipant (pure)', () => {
  const base: SharedSessionRecord = {
    id: 's1',
    kind: 'tui',
    project: 'p',
    title: 'S',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    messageCount: 0,
    participants: [
      { surfaceKind: 'tui', surfaceId: 'tui-1', routeId: 'r-tui', lastSeenAt: 1 },
      { surfaceKind: 'webui', surfaceId: 'web-1', routeId: 'r-web', lastSeenAt: 1 },
    ],
    surfaceKinds: ['tui', 'webui'],
    routeIds: ['r-tui', 'r-web'],
    metadata: {},
  } as unknown as SharedSessionRecord;

  test('removes only the matching participant and unbinds only its route', () => {
    const { session, changed } = detachSharedSessionParticipant(base, 'tui-1');
    expect(changed).toBe(true);
    expect(session.participants.map((p) => p.surfaceId)).toEqual(['web-1']);
    expect(session.routeIds).toEqual(['r-web']);
    expect(session.surfaceKinds).toEqual(['webui']);
    expect(session.status).toBe('active');
  });

  test('a shared route survived by another participant is NOT unbound', () => {
    const shared = {
      ...base,
      participants: [
        { surfaceKind: 'tui', surfaceId: 'tui-1', routeId: 'r-shared', lastSeenAt: 1 },
        { surfaceKind: 'webui', surfaceId: 'web-1', routeId: 'r-shared', lastSeenAt: 1 },
      ],
      routeIds: ['r-shared'],
    } as unknown as SharedSessionRecord;
    const { session } = detachSharedSessionParticipant(shared, 'tui-1');
    expect(session.routeIds).toEqual(['r-shared']);
  });

  test('no matching participant is an unchanged no-op', () => {
    const { session, changed } = detachSharedSessionParticipant(base, 'nope');
    expect(changed).toBe(false);
    expect(session).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// PART A — detach (broker)
// ---------------------------------------------------------------------------

describe('SharedSessionBroker.detachParticipant', () => {
  test('detaches one surface; the session stays active and other surface remains', async () => {
    const broker = makeBroker();
    await broker.register({ sessionId: 'd1', kind: 'tui', participant: participant('tui-1', 'tui') });
    await broker.register({ sessionId: 'd1', kind: 'tui', participant: participant('web-1', 'webui') });
    expect(broker.getSession('d1')?.participants.length).toBe(2);

    const updated = await broker.detachParticipant('d1', 'tui-1');
    expect(updated?.status).toBe('active');
    expect(updated?.participants.map((p) => p.surfaceId)).toEqual(['web-1']);
    expect(broker.getSession('d1')?.participants.map((p) => p.surfaceId)).toEqual(['web-1']);
  });

  test('detaching the last participant does NOT close the session', async () => {
    const broker = makeBroker();
    await broker.register({ sessionId: 'd2', kind: 'tui', participant: participant('only-1') });
    const updated = await broker.detachParticipant('d2', 'only-1');
    expect(updated?.status).toBe('active');
    expect(updated?.participants.length).toBe(0);
    expect(broker.getSession('d2')?.status).toBe('active');
  });

  test('detach on a closed session is an idempotent success (returns the closed record)', async () => {
    const broker = makeBroker();
    await broker.register({ sessionId: 'd3', kind: 'tui', participant: participant('tui-1') });
    await broker.closeSession('d3');
    const updated = await broker.detachParticipant('d3', 'tui-1');
    expect(updated?.status).toBe('closed');
    // Participant list is untouched — nothing to detach from a closed session.
    expect(updated?.participants.length).toBe(1);
  });

  test('detach on an unknown session is null (maps to 404 at the wire)', async () => {
    const broker = makeBroker();
    expect(await broker.detachParticipant('ghost', 'x')).toBeNull();
  });

  test('detaching an already-absent participant is an unchanged idempotent success', async () => {
    const broker = makeBroker();
    await broker.register({ sessionId: 'd4', kind: 'tui', participant: participant('tui-1') });
    const updated = await broker.detachParticipant('d4', 'never-attached');
    expect(updated?.participants.map((p) => p.surfaceId)).toEqual(['tui-1']);
  });
});

// ---------------------------------------------------------------------------
// PART B — per-hunk pure functions + parity golden
// ---------------------------------------------------------------------------

describe('approval-hunk-apply pure functions', () => {
  const e0 = { path: 'a.ts', find: 'foo', replace: 'FOO' };
  const e1 = { path: 'a.ts', find: 'bar', replace: 'BAR' };
  const e2 = { path: 'b.ts', find: 'baz', replace: 'BAZ', id: 'h2' };

  test('readApprovalEditHunks returns validated hunks or null', () => {
    expect(readApprovalEditHunks({ edits: [e0, e1] })).toHaveLength(2);
    expect(readApprovalEditHunks({ edits: [] })).toBeNull();
    expect(readApprovalEditHunks({})).toBeNull();
    expect(readApprovalEditHunks({ edits: [{ path: 'a', find: 'x' }] })).toBeNull(); // missing replace
  });

  test('buildModifiedEditArgs filters edits and preserves every other arg field', () => {
    const req = editRequest([e0, e1, e2], { transaction: true, dry_run: false });
    const out = buildModifiedEditArgs(req, [0, 2]);
    expect(out['edits']).toEqual([e0, e2]);
    expect(out['transaction']).toBe(true);
    expect(out['dry_run']).toBe(false);
  });

  test('resolveApprovalHunkSelection validates bounds and shape', () => {
    const req = editRequest([e0, e1, e2]);
    const ok = resolveApprovalHunkSelection(req, [0, 2]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.modifiedArgs['edits']).toEqual([e0, e2]);
      expect(ok.selectedCount).toBe(2);
      expect(ok.totalHunks).toBe(3);
    }
    expect(resolveApprovalHunkSelection(req, [5]).ok).toBe(false); // out of range
    expect(resolveApprovalHunkSelection(req, [-1]).ok).toBe(false);
    expect(resolveApprovalHunkSelection(req, [1.5]).ok).toBe(false); // non-integer
    // non-edit approval → not applicable
    expect(resolveApprovalHunkSelection(editRequest([], { edits: undefined }), [0]).ok).toBe(false);
  });

  test('PARITY GOLDEN: SDK buildModifiedEditArgs === retired TUI reducer', () => {
    const req = editRequest([e0, e1, e2], { transaction: true, match: 'all' });
    const selections: number[][] = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];
    for (const sel of selections) {
      const set = new Set(sel);
      expect(buildModifiedEditArgs(req, set)).toEqual(tuiBuildModifiedEditArgs(req, set));
    }
  });
});

// ---------------------------------------------------------------------------
// PART B — per-hunk through the ApprovalBroker
// ---------------------------------------------------------------------------

describe('ApprovalBroker.resolveApproval with selectedHunks', () => {
  const e0 = { path: 'a.ts', find: 'foo', replace: 'FOO' };
  const e1 = { path: 'a.ts', find: 'bar', replace: 'BAR' };
  const e2 = { path: 'b.ts', find: 'baz', replace: 'BAZ' };

  async function seed(): Promise<{ broker: ApprovalBroker; id: string; decided: Promise<{ modifiedArgs?: Record<string, unknown> }> }> {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    await broker.start();
    const decided = broker.requestApproval({ request: editRequest([e0, e1, e2]), sessionId: 's' }) as Promise<{ modifiedArgs?: Record<string, unknown> }>;
    // requestApproval persists the pending record on a microtask; poll until it lands.
    let id: string | undefined;
    for (let i = 0; i < 100 && !id; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      id = broker.listApprovals()[0]?.id;
    }
    return { broker, id: id!, decided };
  }

  test('selectedHunks=[0,2] resolves modifiedArgs to exactly those hunks (server-side)', async () => {
    const { broker, id, decided } = await seed();
    const record = await broker.resolveApproval(id, { approved: true, selectedHunks: [0, 2], actor: 'web', actorSurface: 'web' });
    expect(record?.decision?.modifiedArgs?.['edits']).toEqual([e0, e2]);
    // the awaiting tool-call path sees the same modified args
    expect((await decided).modifiedArgs?.['edits']).toEqual([e0, e2]);
  });

  test('no selectedHunks = approve-all: decision carries NO modifiedArgs (back-compat)', async () => {
    const { broker, id } = await seed();
    const record = await broker.resolveApproval(id, { approved: true, actor: 'web', actorSurface: 'web' });
    expect(record?.decision?.approved).toBe(true);
    expect(record?.decision?.modifiedArgs).toBeUndefined();
  });

  test('out-of-range selectedHunks throws a VALIDATION_FAILED (400) error', async () => {
    const { broker, id } = await seed();
    await expect(broker.resolveApproval(id, { approved: true, selectedHunks: [9], actor: 'web', actorSurface: 'web' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });

  test('selectedHunks on a DENY is ignored (deny is always whole-request)', async () => {
    const { broker, id } = await seed();
    const record = await broker.resolveApproval(id, { approved: false, selectedHunks: [0], actor: 'web', actorSurface: 'web' });
    expect(record?.decision?.approved).toBe(false);
    expect(record?.decision?.modifiedArgs).toBeUndefined();
  });
});
