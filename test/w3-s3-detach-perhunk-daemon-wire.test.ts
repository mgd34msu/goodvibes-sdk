/**
 * W3-S3 — sessions.detach + per-hunk approvals, proven over a REAL bootDaemon.
 *
 * Follows the boot-daemon-factory R1 pattern: a live daemon on an ephemeral
 * port, token auth, exercised over HTTP including its honest 4xx shapes.
 *
 *  - sessions.detach: register two participants to one session, detach one over
 *    the wire, and prove the session stays active with the other participant
 *    still bound; plus the 400 (missing surfaceId) and 404 (unknown session).
 *  - per-hunk approvals: seed a pending edit approval into the daemon's OWN
 *    broker (BootedDaemon.approvals), then approve/deny it over HTTP with and
 *    without selectedHunks and prove the resolved decision's modifiedArgs is
 *    computed server-side — including the out-of-range 400.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';

const TOKEN = 'w3-s3-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'w3s3-home-'));
  work = mkdtempSync(join(tmpdir(), 'w3s3-work-'));
  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
  });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

async function register(sessionId: string, surfaceKind: string, surfaceId: string): Promise<void> {
  await fetch(`${daemon.url}/api/sessions/register`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      sessionId,
      kind: 'tui',
      participant: { surfaceKind, surfaceId, lastSeenAt: Date.now() },
    }),
  });
}

describe('sessions.detach over HTTP', () => {
  test('detaching one surface leaves the session active with the other participant', async () => {
    await register('det-1', 'tui', 'tui-A');
    await register('det-1', 'webui', 'web-B');

    const res = await fetch(`${daemon.url}/api/sessions/det-1/detach`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ surfaceId: 'tui-A' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { session: { status: string; participants: Array<{ surfaceId: string }>; surfaceKinds: string[] } };
    expect(body.session.status).toBe('active');
    expect(body.session.participants.map((p) => p.surfaceId)).toEqual(['web-B']);
    expect(body.session.surfaceKinds).toEqual(['webui']);

    // The other surface still sees a live session (persisted, not just echoed).
    const get = await fetch(`${daemon.url}/api/sessions/det-1`, { headers: auth() });
    const getBody = await get.json() as { session: { status: string; participants: Array<{ surfaceId: string }> } };
    expect(getBody.session.status).toBe('active');
    expect(getBody.session.participants.map((p) => p.surfaceId)).toEqual(['web-B']);
  });

  test('detaching the last participant does NOT close the session', async () => {
    await register('det-2', 'tui', 'only-A');
    const res = await fetch(`${daemon.url}/api/sessions/det-2/detach`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ surfaceId: 'only-A' }),
    });
    const body = await res.json() as { session: { status: string; participants: unknown[] } };
    expect(body.session.status).toBe('active');
    expect(body.session.participants).toHaveLength(0);
  });

  test('missing surfaceId is an honest 400', async () => {
    await register('det-3', 'tui', 'tui-A');
    const res = await fetch(`${daemon.url}/api/sessions/det-3/detach`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('detach on an unknown session is a 404', async () => {
    const res = await fetch(`${daemon.url}/api/sessions/ghost-session/detach`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ surfaceId: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('per-hunk approvals over HTTP', () => {
  const e0 = { path: 'a.ts', find: 'foo', replace: 'FOO' };
  const e1 = { path: 'a.ts', find: 'bar', replace: 'BAR' };
  const e2 = { path: 'b.ts', find: 'baz', replace: 'BAZ' };

  function editRequest(callId: string): PermissionPromptRequest {
    return {
      callId,
      tool: 'edit',
      args: { edits: [e0, e1, e2], transaction: true },
      category: 'write',
      analysis: { classification: 'edit', riskLevel: 'medium', summary: 'edit files', reasons: ['multi-edit'] },
    } as PermissionPromptRequest;
  }

  // Seed a pending approval into the daemon's own broker and return its id +
  // the promise the awaiting tool-call path is blocked on.
  async function seedPending(callId: string): Promise<{ id: string; decided: Promise<{ modifiedArgs?: Record<string, unknown> }> }> {
    const before = new Set(daemon.approvals.listApprovals().map((a) => a.id));
    const decided = daemon.approvals.requestApproval({ request: editRequest(callId), sessionId: 'sx' }) as Promise<{ modifiedArgs?: Record<string, unknown> }>;
    let id: string | undefined;
    for (let i = 0; i < 100 && !id; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      id = daemon.approvals.listApprovals().map((a) => a.id).find((candidate) => !before.has(candidate));
    }
    return { id: id!, decided };
  }

  test('approvals.list surfaces the edit hunks of a pending approval', async () => {
    const { id } = await seedPending('call-list');
    const res = await fetch(`${daemon.url}/api/approvals`, { headers: auth() });
    const body = await res.json() as { approvals: Array<{ id: string; request: { args: { edits: unknown[] } } }> };
    const record = body.approvals.find((a) => a.id === id);
    expect(record?.request.args.edits).toHaveLength(3);
    // clean up the pending record so it does not leak into other assertions
    await fetch(`${daemon.url}/api/approvals/${id}/deny`, { method: 'POST', headers: auth() });
  });

  test('approve with selectedHunks=[0,2] resolves modifiedArgs server-side to exactly those hunks', async () => {
    const { id, decided } = await seedPending('call-approve');
    const res = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ selectedHunks: [0, 2] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { approval: { decision: { modifiedArgs?: { edits: unknown[] } } } };
    expect(body.approval.decision.modifiedArgs?.edits).toEqual([e0, e2]);
    // the blocked tool-call path receives the identical modified args
    expect((await decided).modifiedArgs?.['edits']).toEqual([e0, e2]);
  });

  test('approve with NO selectedHunks is approve-all (no modifiedArgs) — back-compat', async () => {
    const { id, decided } = await seedPending('call-all');
    const res = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { approval: { decision: { approved: boolean; modifiedArgs?: unknown } } };
    expect(body.approval.decision.approved).toBe(true);
    expect(body.approval.decision.modifiedArgs).toBeUndefined();
    expect((await decided).modifiedArgs).toBeUndefined();
  });

  test('an out-of-range selectedHunks index is an honest 400', async () => {
    const { id } = await seedPending('call-oob');
    const res = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ selectedHunks: [9] }),
    });
    expect(res.status).toBe(400);
    // the approval is still pending — the failed approve did not resolve it
    await fetch(`${daemon.url}/api/approvals/${id}/deny`, { method: 'POST', headers: auth() });
  });

  test('a malformed selectedHunks (non-integer) is a 400', async () => {
    const { id } = await seedPending('call-bad');
    const res = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ selectedHunks: ['nope'] }),
    });
    expect(res.status).toBe(400);
    await fetch(`${daemon.url}/api/approvals/${id}/deny`, { method: 'POST', headers: auth() });
  });

  test('approving an already-resolved approval is guarded (returns the terminal record, not a re-approve)', async () => {
    const { id } = await seedPending('call-twice');
    await fetch(`${daemon.url}/api/approvals/${id}/approve`, { method: 'POST', headers: auth(), body: JSON.stringify({ selectedHunks: [0] }) });
    const res = await fetch(`${daemon.url}/api/approvals/${id}/deny`, { method: 'POST', headers: auth() });
    const body = await res.json() as { approval: { status: string } };
    // Already approved: the deny is a no-op, the record stays approved.
    expect(body.approval.status).toBe('approved');
  });

  // -------------------------------------------------------------------------
  // W3-S1 invoke-gate interplay (landing integration): the generic invoke
  // endpoint POST /api/control-plane/methods/{id}/invoke validates the body
  // against our typed inputSchemas BEFORE delegating to the HTTP route. These
  // pins record WHICH validation source fires on each failure mode so the
  // honest-400 contract is owned deliberately, not accidentally:
  //   - shape/type errors (missing required, wrong element type) -> S1 gate
  //     (code INVALID_INPUT), pre-empting our handlers — fine, still honest;
  //   - request-specific errors (hunk index out of range) -> OUR broker
  //     (VALIDATION_FAILED), because only it knows the pending edit list.
  // The plain-HTTP tests above bypass the gate entirely and pin our handler
  // paths (surfaceId 400, malformed/oob selectedHunks 400).
  // -------------------------------------------------------------------------
  describe('invoke-layer (S1 gate) interplay', () => {
    async function invokeVerb(methodId: string, body: Record<string, unknown>): Promise<{ status: number; json: { error?: string; code?: string } & Record<string, unknown> }> {
      const res = await fetch(`${daemon.url}/api/control-plane/methods/${methodId}/invoke`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ body }),
      });
      return { status: res.status, json: await res.json() as { error?: string; code?: string } & Record<string, unknown> };
    }

    test('sessions.detach via invoke: typed schema passes the gate and reaches the handler', async () => {
      await register('det-inv', 'tui', 'tui-inv');
      const { status, json } = await invokeVerb('sessions.detach', { sessionId: 'det-inv', surfaceId: 'tui-inv' });
      expect(status).toBe(200);
      const session = (json as { session?: { status: string; participants: unknown[] } }).session;
      expect(session?.status).toBe('active');
      expect(session?.participants).toHaveLength(0);
    });

    test('sessions.detach via invoke with MISSING surfaceId: the S1 gate pre-empts with INVALID_INPUT (honest 400)', async () => {
      await register('det-inv2', 'tui', 'tui-inv2');
      const { status, json } = await invokeVerb('sessions.detach', { sessionId: 'det-inv2' });
      expect(status).toBe(400);
      expect(json.code).toBe('INVALID_INPUT');
    });

    test('approvals.approve via invoke with non-numeric selectedHunks: the S1 gate pre-empts with INVALID_INPUT', async () => {
      const { id } = await seedPending('call-inv-bad');
      const { status, json } = await invokeVerb('approvals.approve', { approvalId: id, selectedHunks: ['nope'] });
      expect(status).toBe(400);
      expect(json.code).toBe('INVALID_INPUT');
      await fetch(`${daemon.url}/api/approvals/${id}/deny`, { method: 'POST', headers: auth() });
    });

    test('approvals.approve via invoke with an OUT-OF-RANGE index: type-valid passes the gate, OUR broker rejects (request-specific 400)', async () => {
      const { id } = await seedPending('call-inv-oob');
      const { status, json } = await invokeVerb('approvals.approve', { approvalId: id, selectedHunks: [9] });
      expect(status).toBe(400);
      // Not the S1 gate's INVALID_INPUT — the broker's range check fired.
      expect(json.code).not.toBe('INVALID_INPUT');
      expect(String(json.error)).toContain('out of range');
      await fetch(`${daemon.url}/api/approvals/${id}/deny`, { method: 'POST', headers: auth() });
    });

    test('approvals.approve via invoke with a valid selection resolves server-side modifiedArgs end-to-end', async () => {
      const { id, decided } = await seedPending('call-inv-ok');
      const { status } = await invokeVerb('approvals.approve', { approvalId: id, selectedHunks: [1] });
      expect(status).toBe(200);
      expect((await decided).modifiedArgs?.['edits']).toEqual([e1]);
    });
  });
});
