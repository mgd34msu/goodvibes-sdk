/**
 * Coverage backfill for packages/operator-sdk/src/client-core.ts and client.ts
 *
 * Targets:
 * - client-core.ts line 63-65: splitArgs function
 * - client-core.ts lines 161-164: requireMethod throw when method not found
 * - client-core.ts lines 168-175: requireMethodRoute throw when no HTTP binding
 * - client-core.ts lines 192-346: listOperations, getOperation, invoke, stream + all shorthand methods
 * - client.ts line 57: validateResponses: false returns base client
 * - client.ts line 68: getSchemaRegistry
 * - client.ts lines 74-83: invoke with schema validation
 */
import { describe, expect, test } from 'bun:test';
import { createOperatorSdk } from '../packages/operator-sdk/dist/index.js';
import { createOperatorRemoteClient } from '../packages/operator-sdk/src/client-core.js';
import { createHttpTransport } from '../packages/transport-http/dist/index.js';
import { getOperatorContract } from '../packages/contracts/dist/index.js';
import { GoodVibesSdkError } from '../packages/errors/dist/index.js';
import { buildOperatorContract } from '../packages/sdk/src/platform/control-plane/operator-contract.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeTransport(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return createHttpTransport({
    baseUrl: 'http://127.0.0.1:3210',
    fetch,
  });
}

// ---------------------------------------------------------------------------
// createOperatorRemoteClient — contract/manifest inspection
// ---------------------------------------------------------------------------

describe('createOperatorRemoteClient — listOperations / getOperation', () => {
  test('listOperations returns all methods from contract', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getOperatorContract();
    const client = createOperatorRemoteClient(transport, contract);
    const methods = client.listOperations();
    expect(methods).toBeInstanceOf(Array);
    expect(methods).toHaveLength(contract.operator.methods.length);
    expect(methods.some((m) => m.id === 'accounts.snapshot')).toBe(true);
  });

  test('getOperation returns the matching method contract', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getOperatorContract();
    const client = createOperatorRemoteClient(transport, contract);
    const method = client.getOperation('accounts.snapshot');
    expect(method.id).toBe('accounts.snapshot');
  });

  test('getOperation throws GoodVibesSdkError for unknown method id', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getOperatorContract();
    const client = createOperatorRemoteClient(transport, contract);
    expect(() => client.getOperation('does.not.exist')).toThrow(GoodVibesSdkError);
    expect(() => client.getOperation('does.not.exist')).toThrow(/Unknown operator method/);
  });

  test('transport and contract are exposed as properties', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getOperatorContract();
    const client = createOperatorRemoteClient(transport, contract);
    expect(client.transport).toBe(transport);
    expect(client.contract).toBe(contract);
  });
});

describe('createOperatorRemoteClient — invoke throws for missing HTTP binding', () => {
  test('invoke throws GoodVibesSdkError with category contract when method has no http', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    // Build a minimal fake contract with a method that has no http binding
    const contract = {
      operator: {
        methods: [
          { id: 'internal.only', description: 'internal only', http: null },
        ],
      },
    };
    const client = createOperatorRemoteClient(transport, contract as ReturnType<typeof getOperatorContract>);
    // requireMethodRoute throws synchronously when method.http is null
    expect(() => client.invoke('internal.only' as never)).toThrow(GoodVibesSdkError);
    const caught = (() => { try { client.invoke('internal.only' as never); } catch (e) { return e; } })();
    expect(caught).toBeInstanceOf(GoodVibesSdkError);
    expect((caught as GoodVibesSdkError).category).toBe('contract');
  });
});

// ---------------------------------------------------------------------------
// createOperatorRemoteClient — shorthand method coverage
// ---------------------------------------------------------------------------

describe('createOperatorRemoteClient — shorthand methods', () => {
  test('sessions.get builds path from sessionId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ id: 'session-1', status: 'active', messages: [] });
      },
    });
    const result = await sdk.sessions.get('session-1');
    expect(calls[0]).toContain('/sessions/session-1');
    expect(result).toMatchObject({ id: 'session-1' });
  });

  test('sessions.messages.create builds path from sessionId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ id: 'msg-1' });
      },
    });
    const result = await sdk.sessions.messages.create('session-1', { role: 'user', content: 'hello' });
    expect(calls[0]).toContain('/sessions/session-1/messages');
    expect(result).toMatchObject({ id: 'msg-1' });
  });

  test('sessions.inputs.cancel builds path from sessionId + inputId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ cancelled: true });
      },
    });
    const result = await sdk.sessions.inputs.cancel('session-1', 'input-1');
    expect(calls[0]).toContain('session-1');
    expect(calls[0]).toContain('input-1');
    expect(result).toMatchObject({ cancelled: true });
  });

  test('sessions.close builds path from sessionId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ closed: true });
      },
    });
    const result = await sdk.sessions.close('session-1');
    expect(calls[0]).toContain('session-1');
    expect(result).toMatchObject({ closed: true });
  });

  test('sessions.reopen builds path from sessionId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ reopened: true });
      },
    });
    const result = await sdk.sessions.reopen('session-1');
    expect(calls[0]).toContain('session-1');
    expect(result).toMatchObject({ reopened: true });
  });

  test('tasks.get builds path from taskId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ id: 'task-1' });
      },
    });
    const result = await sdk.tasks.get('task-1');
    expect(calls[0]).toContain('task-1');
    expect(result).toMatchObject({ id: 'task-1' });
  });

  test('tasks.cancel builds path from taskId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ cancelled: true });
      },
    });
    const result = await sdk.tasks.cancel('task-1');
    expect(calls[0]).toContain('task-1');
    expect(result).toMatchObject({ cancelled: true });
  });

  test('tasks.retry builds path from taskId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ retried: true });
      },
    });
    const result = await sdk.tasks.retry('task-1');
    expect(calls[0]).toContain('task-1');
    expect(result).toMatchObject({ retried: true });
  });

  test('approvals.claim builds path from approvalId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ claimed: true });
      },
    });
    const result = await sdk.approvals.claim('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ claimed: true });
  });

  test('approvals.approve builds path from approvalId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ approved: true });
      },
    });
    const result = await sdk.approvals.approve('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ approved: true });
  });

  test('approvals.deny builds path from approvalId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ denied: true });
      },
    });
    const result = await sdk.approvals.deny('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ denied: true });
  });

  test('approvals.cancel builds path from approvalId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ cancelled: true });
      },
    });
    const result = await sdk.approvals.cancel('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ cancelled: true });
  });

  test('providers.get builds path from providerId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ id: 'provider-1' });
      },
    });
    const result = await sdk.providers.get('provider-1');
    expect(calls[0]).toContain('provider-1');
    expect(result).toMatchObject({ id: 'provider-1' });
  });

  test('providers.usage builds path from providerId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ usage: [] });
      },
    });
    const result = await sdk.providers.usage('provider-1');
    expect(calls[0]).toContain('provider-1');
    expect(result).toMatchObject({ usage: [] });
  });

  test('control.methods.get builds path from methodId', async () => {
    const calls: string[] = [];
    const sdk = createOperatorSdk({
      validateResponses: false,
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ id: 'method-1' });
      },
    });
    const result = await sdk.control.methods.get('method-1');
    expect(calls[0]).toContain('method-1');
    expect(result).toMatchObject({ id: 'method-1' });
  });
});

// ---------------------------------------------------------------------------
// createOperatorSdk — validateResponses option
// ---------------------------------------------------------------------------

describe('createOperatorSdk — validateResponses option', () => {
  test('validateResponses: false skips Zod validation and returns base client', async () => {
    const sdk = createOperatorSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: async () => createJsonResponse({ custom_field: 'no_zod_here', capturedAt: 0, providers: [], configuredCount: 0, issueCount: 0 }),
    });
    // Should not throw even if response shape is unexpected — Zod is bypassed
    const result = await sdk.accounts.snapshot();
    expect(result).not.toBeNull(); // presence-only: validateResponses:false bypasses schema, no guaranteed shape
  });

  test('validateResponses: true (default) validates response against Zod schema', async () => {
    const sdk = createOperatorSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: true,
      fetch: async () => createJsonResponse({ capturedAt: Date.now(), providers: [], configuredCount: 0, issueCount: 0 }),
    });
    const result = await sdk.accounts.snapshot();
    expect(result).toMatchObject({ configuredCount: 0, issueCount: 0 });
  });

  test('getOperation is accessible on OperatorSdk', () => {
    const sdk = createOperatorSdk({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async () => createJsonResponse({ ok: true }),
    });
    expect(() => sdk.getOperation('accounts.snapshot')).not.toThrow();
    const method = sdk.getOperation('accounts.snapshot');
    expect(method.id).toBe('accounts.snapshot');
  });
});


// ---------------------------------------------------------------------------
// createOperatorRemoteClient (src) — shorthand methods via src client
// These cover the arrow-function method bindings in client-core.ts
// ---------------------------------------------------------------------------

describe('createOperatorRemoteClient (src) — shorthand method bindings', () => {
  function makeSrcClient(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
    const transport = makeTransport(fetch);
    const contract = getOperatorContract();
    return createOperatorRemoteClient(transport, contract, { validateResponses: false });
  }

  test('sessions.create invokes sessions.create route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ id: 'session-1', status: 'active' });
    });
    const result = await client.sessions.create({ task: 'hello' });
    expect(calls[0]).toContain('/sessions');
    expect(result).toMatchObject({ id: 'session-1', status: 'active' });
  });

  test('sessions.create validates the shared-session shape returned by daemon routes', async () => {
    const createdAt = Date.now();
    const client = createOperatorRemoteClient(
      makeTransport(async () => createJsonResponse({
        session: {
          id: 'sess-1',
          kind: 'tui',
          title: 'Test session',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          lastActivityAt: createdAt,
          messageCount: 0,
          pendingInputCount: 0,
          routeIds: [],
          surfaceKinds: [],
          participants: [],
          metadata: {},
        },
      }, 201)),
      buildOperatorContract(new GatewayMethodCatalog()),
    );

    const result = await client.sessions.create({ title: 'Test session' });
    const session = result.session as Record<string, unknown>;
    expect(session.kind).toBe('tui');
    expect(session.lastActivityAt).toBe(createdAt);
  });

  test('sessions.get builds path from sessionId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ id: 'session-1', status: 'active' });
    });
    const result = await client.sessions.get('session-abc');
    expect(calls[0]).toContain('session-abc');
    expect(result).toMatchObject({ id: 'session-1', status: 'active' });
  });

  test('sessions.list invokes sessions.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ sessions: [], total: 0 });
    });
    const result = await client.sessions.list();
    expect(calls[0]).toContain('/sessions');
    expect(result).toMatchObject({ sessions: [], total: 0 });
  });

  test('sessions.messages.create builds path from sessionId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ id: 'msg-1' });
    });
    const result = await client.sessions.messages.create('session-1', { role: 'user', content: 'hi' });
    expect(calls[0]).toContain('session-1');
    expect(result).toMatchObject({ id: 'msg-1' });
  });

  test('sessions.messages.list builds path from sessionId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ messages: [] });
    });
    const result = await client.sessions.messages.list('session-1');
    expect(calls[0]).toContain('session-1');
    expect(result).toMatchObject({ messages: [] });
  });

  test('sessions.inputs.cancel builds path from sessionId + inputId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ cancelled: true });
    });
    const result = await client.sessions.inputs.cancel('session-1', 'input-1');
    expect(calls[0]).toContain('session-1');
    expect(result).toMatchObject({ cancelled: true });
  });

  test('sessions.followUp invokes followUp route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ ok: true });
    });
    const result = await client.sessions.followUp({ sessionId: 's-1', task: 'continue' });
    expect(calls[0]).toContain('follow');
    expect(result).toMatchObject({ ok: true });
  });

  test('sessions.steer invokes steer route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ ok: true });
    });
    const result = await client.sessions.steer({ sessionId: 's-1', guidance: 'go left' });
    expect(calls[0]).toContain('steer');
    expect(result).toMatchObject({ ok: true });
  });

  test('sessions.close builds path from sessionId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ closed: true });
    });
    const result = await client.sessions.close('session-1');
    expect(calls[0]).toContain('session-1');
    expect(result).toMatchObject({ closed: true });
  });

  test('sessions.reopen builds path from sessionId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ reopened: true });
    });
    const result = await client.sessions.reopen('session-1');
    expect(calls[0]).toContain('session-1');
    expect(result).toMatchObject({ reopened: true });
  });

  test('tasks.create invokes task creation route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ taskId: 'task-1' });
    });
    const result = await client.tasks.create({ task: 'do it', sessionId: 's-1', routing: { target: 'main' } });
    expect(calls[0]).toContain('task');
    expect(result).toMatchObject({ taskId: 'task-1' });
  });

  test('tasks.get builds path from taskId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ id: 'task-1' });
    });
    const result = await client.tasks.get('task-1');
    expect(calls[0]).toContain('task-1');
    expect(result).toMatchObject({ id: 'task-1' });
  });

  test('tasks.list invokes tasks.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ tasks: [] });
    });
    const result = await client.tasks.list();
    expect(calls[0]).toContain('task');
    expect(result).toMatchObject({ tasks: [] });
  });

  test('tasks.status throws for no HTTP binding (internal-only route)', () => {
    const client = makeSrcClient(async () => createJsonResponse({ ok: true }));
    // tasks.status has no HTTP binding in the contract — requireMethodRoute throws
    expect(() => client.tasks.status()).toThrow(GoodVibesSdkError);
  });

  test('tasks.cancel builds path from taskId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ cancelled: true });
    });
    const result = await client.tasks.cancel('task-1');
    expect(calls[0]).toContain('task-1');
    expect(result).toMatchObject({ cancelled: true });
  });

  test('tasks.retry builds path from taskId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ retried: true });
    });
    const result = await client.tasks.retry('task-1');
    expect(calls[0]).toContain('task-1');
    expect(result).toMatchObject({ retried: true });
  });

  test('approvals.list invokes approvals.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ approvals: [] });
    });
    const result = await client.approvals.list();
    expect(calls[0]).toContain('approval');
    expect(result).toMatchObject({ approvals: [] });
  });

  test('approvals.claim builds path from approvalId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ claimed: true });
    });
    const result = await client.approvals.claim('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ claimed: true });
  });

  test('approvals.approve builds path from approvalId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ approved: true });
    });
    const result = await client.approvals.approve('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ approved: true });
  });

  test('approvals.deny builds path from approvalId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ denied: true });
    });
    const result = await client.approvals.deny('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ denied: true });
  });

  test('approvals.cancel builds path from approvalId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ cancelled: true });
    });
    const result = await client.approvals.cancel('approval-1');
    expect(calls[0]).toContain('approval-1');
    expect(result).toMatchObject({ cancelled: true });
  });

  test('providers.list invokes providers.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ providers: [] });
    });
    const result = await client.providers.list();
    expect(calls[0]).toContain('provider');
    expect(result).toMatchObject({ providers: [] });
  });

  test('providers.get builds path from providerId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ id: 'provider-1' });
    });
    const result = await client.providers.get('provider-1');
    expect(calls[0]).toContain('provider-1');
    expect(result).toMatchObject({ id: 'provider-1' });
  });

  test('providers.usage builds path from providerId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ usage: [] });
    });
    const result = await client.providers.usage('provider-1');
    expect(calls[0]).toContain('provider-1');
    expect(result).toMatchObject({ usage: [] });
  });

  test('accounts.snapshot invokes accounts.snapshot route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ capturedAt: Date.now(), providers: [], configuredCount: 0, issueCount: 0 });
    });
    const result = await client.accounts.snapshot();
    expect(calls[0]).toContain('account');
    expect(result).toMatchObject({ configuredCount: 0, issueCount: 0 });
  });

  test('localAuth.status invokes local_auth.status route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({
        userStorePath: '/tmp/auth-users.json',
        bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
        bootstrapCredentialPresent: false,
        userCount: 0,
        sessionCount: 0,
        users: [],
        sessions: [],
      });
    });
    const result = await client.localAuth.status();
    expect(calls[0]).toContain('auth');
    expect(result).toMatchObject({ userCount: 0, sessionCount: 0 });
  });

  test('control.snapshot invokes control.snapshot route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ ok: true });
    });
    const result = await client.control.snapshot();
    expect(calls[0]).toContain('control');
    expect(result).toMatchObject({ ok: true });
  });

  test('control.status invokes control.status route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ status: 'running', version: '0.19.7' });
    });
    const result = await client.control.status();
    expect(calls).toHaveLength(1); // route was called
    expect(result).toMatchObject({ version: '0.19.7' });
  });

  test('control.contract invokes control.contract route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ version: 1 });
    });
    const result = await client.control.contract();
    expect(calls[0]).toContain('control');
    expect(result).toMatchObject({ version: 1 });
  });

  test('control.methods.list invokes methods.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ methods: [] });
    });
    const result = await client.control.methods.list();
    expect(calls[0]).toContain('method');
    expect(result).toMatchObject({ methods: [] });
  });

  test('control.methods.get builds path from methodId', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ id: 'method-1' });
    });
    const result = await client.control.methods.get('method-1');
    expect(calls[0]).toContain('method-1');
    expect(result).toMatchObject({ id: 'method-1' });
  });

  test('control.auth.current invokes auth.current route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ authenticated: true, authMode: 'session', tokenPresent: false, authorizationHeaderPresent: false, sessionCookiePresent: true, principalId: 'alice', principalKind: 'user', admin: false, scopes: [], roles: [] });
    });
    const result = await client.control.auth.current();
    expect(calls[0]).toContain('auth');
    expect(result).toMatchObject({ authenticated: true, principalId: 'alice' });
  });

  test('control.auth.login invokes auth.login route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ token: 'tok', authenticated: true, username: 'alice', expiresAt: Date.now() + 60000 });
    });
    const result = await client.control.auth.login({ username: 'alice', password: 'pw' });
    expect(calls).toHaveLength(1); // route was called
    expect(result).toMatchObject({ token: 'tok', authenticated: true });
  });

  test('control.events.catalog invokes events.catalog route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ events: [] });
    });
    const result = await client.control.events.catalog();
    expect(calls[0]).toContain('event');
    expect(result).toMatchObject({ events: [] });
  });

  test('telemetry.snapshot invokes telemetry.snapshot route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ ok: true });
    });
    const result = await client.telemetry.snapshot();
    expect(calls[0]).toContain('telemetry');
    expect(result).toMatchObject({ ok: true });
  });

  test('telemetry.events invokes telemetry.events.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ events: [] });
    });
    const result = await client.telemetry.events();
    expect(calls[0]).toContain('telemetry');
    expect(result).toMatchObject({ events: [] });
  });

  test('telemetry.errors invokes telemetry.errors.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ errors: [] });
    });
    const result = await client.telemetry.errors();
    expect(calls[0]).toContain('telemetry');
    expect(result).toMatchObject({ errors: [] });
  });

  test('telemetry.traces invokes telemetry.traces.list route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ traces: [] });
    });
    const result = await client.telemetry.traces();
    expect(calls[0]).toContain('telemetry');
    expect(result).toMatchObject({ traces: [] });
  });

  test('telemetry.metrics invokes telemetry.metrics.get route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ metrics: [] });
    });
    const result = await client.telemetry.metrics();
    expect(calls[0]).toContain('telemetry');
    expect(result).toMatchObject({ metrics: [] });
  });

  test('telemetry.otlp.traces invokes telemetry.otlp.traces route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ ok: true });
    });
    const result = await client.telemetry.otlp.traces({ resourceSpans: [] });
    expect(calls[0]).toContain('otlp');
    expect(result).toMatchObject({ ok: true });
  });

  test('telemetry.otlp.logs invokes telemetry.otlp.logs route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ ok: true });
    });
    const result = await client.telemetry.otlp.logs({ resourceLogs: [] });
    expect(calls[0]).toContain('otlp');
    expect(result).toMatchObject({ ok: true });
  });

  test('telemetry.otlp.metrics invokes telemetry.otlp.metrics route', async () => {
    const calls: string[] = [];
    const client = makeSrcClient(async (input) => {
      calls.push(String(input));
      return createJsonResponse({ ok: true });
    });
    const result = await client.telemetry.otlp.metrics({ resourceMetrics: [] });
    expect(calls[0]).toContain('otlp');
    expect(result).toMatchObject({ ok: true });
  });
});
