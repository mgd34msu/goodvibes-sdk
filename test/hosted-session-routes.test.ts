/**
 * hosted-session-routes.test.ts
 *
 * The `sessions.hosted.*` handlers: argument reading, and the error mapping
 * that is the real content of this layer.
 *
 * Each engine refusal has its own wire shape on purpose — "no such session",
 * "that session ended and here is why", "the path is not absolute" and "you are
 * at the configured cap" want four different reactions, and collapsing them
 * into one 400 is how a caller retries the one thing that can never work. That
 * mapping is what these tests hold in place.
 */

import { expect, test } from 'bun:test';
import {
  createHostedSessionAttachHandler,
  createHostedSessionCreateHandler,
  createHostedSessionDetachHandler,
  createHostedSessionKillHandler,
  createHostedSessionListHandler,
  refuseHostedSessionGatewayMethods,
  registerHostedSessionGatewayMethods,
  HOSTED_SESSION_METHOD_IDS,
  type HostedSessionVerbService,
} from '../packages/sdk/src/platform/control-plane/routes/hosted-sessions.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { readGatewayVerbRefusal } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../packages/sdk/src/platform/daemon/control-plane.ts';
import { SDKErrorCodes } from '../packages/errors/src/index.ts';
import {
  HostedSessionArgumentError,
  HostedSessionLimitError,
  HostedSessionNotFoundError,
  HostedSessionUnavailableError,
} from '../packages/sdk/src/platform/hosted-sessions/manager.ts';
import type {
  CreateHostedSessionInput,
  HostedSessionRecord,
} from '../packages/sdk/src/platform/hosted-sessions/types.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

function record(id = 'hosted-1'): HostedSessionRecord {
  return {
    id,
    workspaceRoot: '/w',
    title: 'a session',
    status: 'idle',
    detachPolicy: null,
    effectiveDetachPolicy: 'kill',
    attachedClients: [],
    createdAt: 1,
    updatedAt: 1,
    turnCount: 0,
    messageCount: 0,
    restoredFromDisk: false,
  };
}

/** Params ride the invoke BODY — the schema-validated channel these verbs read. */
function invocation(body: Record<string, unknown>): GatewayMethodInvocation {
  return { methodId: 'test', body, context: {} } as unknown as GatewayMethodInvocation;
}

function service(overrides: Partial<HostedSessionVerbService>): HostedSessionVerbService {
  return {
    create: async () => record(),
    attach: async () => ({ session: record(), history: [] }),
    detach: async () => record(),
    kill: async () => record(),
    list: () => [record()],
    ...overrides,
  };
}

test('create passes only the arguments that were given', async () => {
  let seen: CreateHostedSessionInput | null = null;
  const handler = createHostedSessionCreateHandler(service({
    create: async (input) => { seen = input; return record(); },
  }));

  await handler(invocation({
    workspaceRoot: '/w  ',
    title: '   ',
    modelId: 'anthropic/claude',
    detachPolicy: 'survive',
    clientId: 'terminal-1',
  }));

  const input = seen as unknown as CreateHostedSessionInput;
  expect(input.workspaceRoot).toBe('/w');
  // A whitespace-only title is not a title; it must not reach the engine as one.
  expect('title' in input).toBe(false);
  expect('initialPrompt' in input).toBe(false);
  expect(input.modelId).toBe('anthropic/claude');
  expect(input.detachPolicy).toBe('survive');
  expect(input.clientId).toBe('terminal-1');
});

test('a missing workspaceRoot is refused with the field named', async () => {
  const handler = createHostedSessionCreateHandler(service({}));
  await expect(handler(invocation({}))).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
    status: 400,
    field: 'workspaceRoot',
  });
});

test('an unknown detachPolicy value is refused rather than silently ignored', async () => {
  const handler = createHostedSessionCreateHandler(service({}));
  await expect(handler(invocation({ workspaceRoot: '/w', detachPolicy: 'maybe' }))).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
    field: 'detachPolicy',
  });
});

test('an unknown session is a 404 that names the id', async () => {
  const handler = createHostedSessionAttachHandler(service({
    attach: async () => { throw new HostedSessionNotFoundError('hosted-x'); },
  }));
  await expect(handler(invocation({ sessionId: 'hosted-x', clientId: 'a' }))).rejects.toMatchObject({
    code: 'SESSION_NOT_FOUND',
    status: 404,
  });
});

test('a terminated session is a 409 carrying the reason, not a 404', async () => {
  const handler = createHostedSessionAttachHandler(service({
    attach: async () => { throw new HostedSessionUnavailableError('hosted-1', 'it is terminated (killed)'); },
  }));
  // 404 would invite a retry against an id that is perfectly real; 409 says the
  // session exists and cannot serve this, and the message says why.
  await expect(handler(invocation({ sessionId: 'hosted-1', clientId: 'a' }))).rejects.toMatchObject({
    code: 'HOSTED_SESSION_UNAVAILABLE',
    status: 409,
    message: expect.stringContaining('terminated (killed)'),
  });
});

test('the session cap is a 429, distinct from a bad argument', async () => {
  const handler = createHostedSessionCreateHandler(service({
    create: async () => { throw new HostedSessionLimitError('already hosts 8 (hostedSessions.maxSessions)'); },
  }));
  await expect(handler(invocation({ workspaceRoot: '/w' }))).rejects.toMatchObject({
    code: 'HOSTED_SESSION_LIMIT_REACHED',
    status: 429,
  });
});

test('an unusable workspace root maps onto the field the caller supplied', async () => {
  const handler = createHostedSessionCreateHandler(service({
    create: async () => { throw new HostedSessionArgumentError('workspaceRoot must be an absolute path'); },
  }));
  await expect(handler(invocation({ workspaceRoot: 'relative' }))).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
    field: 'workspaceRoot',
  });
});

test('an error the engine did not raise is not disguised as one', async () => {
  const handler = createHostedSessionKillHandler(service({
    kill: async () => { throw new Error('the disk is on fire'); },
  }));
  await expect(handler(invocation({ sessionId: 'hosted-1' }))).rejects.toThrow('the disk is on fire');
});

test('detach and kill return the record as it stands afterwards', async () => {
  const detached = { ...record(), status: 'terminated' as const, terminatedReason: 'detached' as const };
  const detach = createHostedSessionDetachHandler(service({ detach: async () => detached }));
  expect(await detach(invocation({ sessionId: 'hosted-1', clientId: 'a' }))).toEqual({ session: detached });

  const kill = createHostedSessionKillHandler(service({ kill: async () => detached }));
  expect(await kill(invocation({ sessionId: 'hosted-1' }))).toEqual({ session: detached });
});

test('list excludes terminated sessions unless asked', () => {
  let asked: boolean | undefined;
  const handler = createHostedSessionListHandler(service({
    list: (options) => { asked = options?.includeTerminated; return [record()]; },
  }));

  handler(invocation({}));
  expect(asked).toBe(false);
  handler(invocation({ includeTerminated: true }));
  expect(asked).toBe(true);
});

test('every hosted verb descriptor gets a handler attached', () => {
  const catalog = new GatewayMethodCatalog();
  registerHostedSessionGatewayMethods(catalog, service({}));
  for (const id of HOSTED_SESSION_METHOD_IDS) {
    expect(catalog.get(id), `${id} descriptor`).toBeDefined();
    expect(catalog.hasHandler(id), `${id} handler`).toBe(true);
  }
});

// A daemon that never stated how a hosted session's workspace floor is built
// hosts nothing, and the verbs have to say that as a refusal a client can act
// on. They used to reach the branch for a verb with neither handler nor route:
// a 501 carrying no code over the wire, and a plain Error — a 500 — for anyone
// invoking the catalog directly.
test('with no engine the hosted verbs refuse with the catalog\'s own code, on every path', async () => {
  const catalog = new GatewayMethodCatalog();
  refuseHostedSessionGatewayMethods(catalog);
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);

  for (const id of HOSTED_SESSION_METHOD_IDS) {
    expect(catalog.get(id)?.invokable, `${id} invokable`).toBe(false);

    const dispatched = await helper.invokeGatewayMethodCall({ authToken: 't', methodId: id, body: {} });
    expect(dispatched.status, `${id} status`).toBe(400);
    expect((dispatched.body as Record<string, unknown>).code, `${id} code`).toBe(SDKErrorCodes.NOT_INVOKABLE);

    let caught: unknown;
    try {
      await catalog.invoke(id, { methodId: id, body: {}, context: {} } as unknown as GatewayMethodInvocation);
    } catch (error) {
      caught = error;
    }
    expect(readGatewayVerbRefusal(caught)?.code, `${id} direct-invoke code`).toBe('NOT_INVOKABLE');
  }
});

test('registering the engine leaves the verbs invokable', () => {
  const catalog = new GatewayMethodCatalog();
  refuseHostedSessionGatewayMethods(catalog);
  registerHostedSessionGatewayMethods(catalog, service({}));
  for (const id of HOSTED_SESSION_METHOD_IDS) {
    expect(catalog.hasHandler(id), `${id} handler`).toBe(true);
    expect(catalog.get(id)?.invokable, `${id} invokable`).not.toBe(false);
  }
});
