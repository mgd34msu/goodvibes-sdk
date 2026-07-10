/**
 * embed-session.test.ts
 *
 * Exercises the SDK Embedding API 1.0 facade (`createEmbeddedSession`) against a
 * real in-process daemon: the exposed seams (runtime bus, session broker,
 * approval broker), the injected permission-callback bridge, and idempotent
 * shutdown. LLM-free — it drives the brokers directly rather than a full turn.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmbeddedSession, type EmbeddedSession } from '../packages/sdk/src/embed.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';

function makeRequest(callId: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'read_file',
    args: { path: 'README.md' },
    category: 'read',
    analysis: { classification: 'read', riskLevel: 'low', summary: 'read a file', reasons: [] },
  };
}

describe('createEmbeddedSession', () => {
  let home: string;
  let work: string;
  let session: EmbeddedSession;
  const approved: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'embed-home-'));
    work = mkdtempSync(join(tmpdir(), 'embed-work-'));
    session = await createEmbeddedSession({
      workspace: work,
      homeDirectory: home,
      token: 'embed-test-token',
      boot: { daemonHomeDir: join(home, 'daemon'), port: 0, host: '127.0.0.1' },
      requestPermission: async (request) => {
        approved.push(request.callId);
        return { approved: request.category === 'read' };
      },
    });
  });

  afterAll(async () => {
    await session?.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('exposes the workspace, url, and the in-process seams', () => {
    expect(session.workspace).toBe(work);
    expect(session.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(session.events).toBeInstanceOf(RuntimeEventBus);
    expect(typeof session.approvals.requestApproval).toBe('function');
    expect(typeof session.sessions.createSession).toBe('function');
  });

  test('the injected permission callback answers pending approvals', async () => {
    const decision = await session.approvals.requestApproval({
      request: makeRequest('call-read-1'),
      timeoutMs: 5000,
    });
    expect(decision.approved).toBe(true);
    expect(approved).toContain('call-read-1');
  });

  test('the callback can deny an ask', async () => {
    const denial = await session.approvals.requestApproval({
      request: { ...makeRequest('call-write-1'), tool: 'write_file', category: 'write' },
      timeoutMs: 5000,
    });
    expect(denial.approved).toBe(false);
  });

  test('the session broker seam creates a workspace-bound session', async () => {
    const record = await session.sessions.createSession({ project: work, title: 'embed' });
    expect(record.id.length).toBeGreaterThan(0);
  });

  test('stop is idempotent', async () => {
    await session.stop();
    await session.stop();
  });
});
