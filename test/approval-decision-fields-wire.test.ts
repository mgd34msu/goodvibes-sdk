/**
 * Approval decision fields over REAL HTTP: rememberTier, deny reason, and
 * modifiedArgs (the exec terminal-prompt answer) must reach the same broker
 * resolution the in-process path uses — and the response's `recorded` block
 * must report what the broker actually recorded, never echo the request.
 *
 * Follows the boot-daemon-factory pattern: a live daemon on an ephemeral
 * port, token auth, exercised over HTTP including its honest 400 shapes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';

const TOKEN = 'approval-fields-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'approval-fields-home-'));
  work = mkdtempSync(join(tmpdir(), 'approval-fields-work-'));
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

interface Decision {
  approved: boolean;
  rememberTier?: string;
  reason?: string;
  modifiedArgs?: Record<string, unknown>;
}

interface ActionResponse {
  approval: { status: string; decision?: Decision };
  recorded: {
    approved: boolean;
    rememberTier: string | null;
    reasonStored: boolean;
    modifiedArgsDelivered: boolean;
  };
}

function execRequest(callId: string, command: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'exec',
    args: { command },
    category: 'execute',
    analysis: { classification: 'exec', riskLevel: 'medium', summary: `run ${command}`, reasons: ['command execution'] },
  } as PermissionPromptRequest;
}

function execPromptRequest(callId: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'exec:prompt',
    args: { command: 'npx create-thing', prompt: 'Ok to proceed? (y)' },
    category: 'execute',
    analysis: { classification: 'exec-terminal-prompt', riskLevel: 'medium', summary: 'command waiting on its terminal', reasons: ['terminal prompt'] },
  } as PermissionPromptRequest;
}

// Seed a pending approval into the daemon's own broker and return its id +
// the promise the awaiting tool-call path is blocked on.
async function seedPending(request: PermissionPromptRequest): Promise<{ id: string; decided: Promise<Decision> }> {
  const before = new Set(daemon.approvals.listApprovals().map((a) => a.id));
  const decided = daemon.approvals.requestApproval({ request, sessionId: 'sx' }) as Promise<Decision>;
  let id: string | undefined;
  for (let i = 0; i < 100 && !id; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    id = daemon.approvals.listApprovals().map((a) => a.id).find((candidate) => !before.has(candidate));
  }
  return { id: id!, decided };
}

describe('approval decision fields round-trip over HTTP', () => {
  test('deny with reason + rememberTier: both recorded and delivered to the waiting call', async () => {
    const { id, decided } = await seedPending(execRequest('deny-reason', 'rm -r ./dist'));
    const res = await fetch(`${daemon.url}/api/approvals/${id}/deny`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ reason: 'wrong directory — build output lives in out/', rememberTier: 'session' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as ActionResponse;
    expect(body.approval.decision?.reason).toBe('wrong directory — build output lives in out/');
    expect(body.approval.decision?.rememberTier).toBe('session');
    expect(body.recorded.approved).toBe(false);
    expect(body.recorded.reasonStored).toBe(true);
    expect(body.recorded.rememberTier).toBe('session');
    // The blocked tool-call path receives the same reason (deny-is-feedback).
    const decision = await decided;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('wrong directory — build output lives in out/');
  });

  test('approve with modifiedArgs delivers the exec terminal-prompt answer to the waiting call', async () => {
    const { id, decided } = await seedPending(execPromptRequest('prompt-answer'));
    const res = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ modifiedArgs: { answer: 'y' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as ActionResponse;
    expect(body.approval.decision?.modifiedArgs).toEqual({ answer: 'y' });
    expect(body.recorded.modifiedArgsDelivered).toBe(true);
    const decision = await decided;
    expect(decision.approved).toBe(true);
    expect(decision.modifiedArgs).toEqual({ answer: 'y' });
  });

  test('a generalizing rememberTier over HTTP sweeps a queued ask the decision covers', async () => {
    const first = await seedPending(execRequest('tier-a', 'git status'));
    const second = await seedPending(execRequest('tier-b', 'git status'));
    const res = await fetch(`${daemon.url}/api/approvals/${first.id}/approve`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ rememberTier: 'exact' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as ActionResponse;
    expect(body.recorded.approved).toBe(true);
    expect(body.recorded.rememberTier).toBe('exact');
    // The tier reached the broker's own generalization logic, not just the
    // record: the second identical ask resolves without a second answer.
    const swept = await second.decided;
    expect(swept.approved).toBe(true);
    expect((await first.decided).approved).toBe(true);
  });

  test('recorded reports the ORIGINAL decision when a late action no-ops on a resolved approval', async () => {
    const { id } = await seedPending(execRequest('late-deny', 'ls'));
    await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    });
    // Late deny with a reason: the approval stays approved and recorded must
    // not claim the reason was stored.
    const res = await fetch(`${daemon.url}/api/approvals/${id}/deny`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ reason: 'too late' }),
    });
    const body = await res.json() as ActionResponse;
    expect(body.approval.status).toBe('approved');
    expect(body.recorded.approved).toBe(true);
    expect(body.recorded.reasonStored).toBe(false);
  });

  test('malformed decision fields are honest 400s and leave the approval pending', async () => {
    const { id } = await seedPending(execRequest('bad-fields', 'pwd'));

    const badTier = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ rememberTier: 'forever' }),
    });
    expect(badTier.status).toBe(400);

    const badReason = await fetch(`${daemon.url}/api/approvals/${id}/deny`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ reason: 42 }),
    });
    expect(badReason.status).toBe(400);

    const badArgs = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ modifiedArgs: ['not', 'an', 'object'] }),
    });
    expect(badArgs.status).toBe(400);

    // Still pending: none of the malformed requests resolved it.
    const list = await fetch(`${daemon.url}/api/approvals`, { headers: auth() });
    const snapshot = await list.json() as { approvals: Array<{ id: string; status: string }> };
    expect(snapshot.approvals.find((a) => a.id === id)?.status).toBe('pending');

    // Clean up so the pending record does not leak into other assertions.
    await fetch(`${daemon.url}/api/approvals/${id}/deny`, { method: 'POST', headers: auth() });
  });

  test('selectedHunks supersedes caller modifiedArgs on an edit approval', async () => {
    const e0 = { path: 'a.ts', find: 'foo', replace: 'FOO' };
    const e1 = { path: 'a.ts', find: 'bar', replace: 'BAR' };
    const { id, decided } = await seedPending({
      callId: 'hunks-vs-args',
      tool: 'edit',
      args: { edits: [e0, e1], transaction: true },
      category: 'write',
      analysis: { classification: 'edit', riskLevel: 'medium', summary: 'edit files', reasons: ['multi-edit'] },
    } as PermissionPromptRequest);
    const res = await fetch(`${daemon.url}/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ selectedHunks: [1], modifiedArgs: { edits: [e0] } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as ActionResponse;
    // Server-side per-hunk computation wins over the caller's own args.
    expect(body.approval.decision?.modifiedArgs?.['edits']).toEqual([e1]);
    expect((await decided).modifiedArgs?.['edits']).toEqual([e1]);
  });
});
