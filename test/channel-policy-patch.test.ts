/**
 * channel-policy-patch.test.ts
 *
 * Tests for F19 — PATCH /api/channels/policies/:surface
 *
 * - PATCH with partial body → 200, response policy reflects merged fields
 * - PATCH without admin context → requireAdmin rejects (returns non-null Response)
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonChannelRouteHandlers } from '../packages/daemon-sdk/src/channel-routes.js';
import { dispatchOperatorRoutes } from '../packages/daemon-sdk/src/operator.js';
import type { DaemonChannelRouteContext } from '../packages/daemon-sdk/src/channel-route-types.js';
import type { DaemonApiRouteHandlers } from '../packages/daemon-sdk/src/context.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type PolicyRecord = Record<string, unknown>;

function makePolicyStore(initial: PolicyRecord = {}): {
  policies: Map<string, PolicyRecord>;
  service: DaemonChannelRouteContext['channelPolicy'];
} {
  const policies = new Map<string, PolicyRecord>([['slack', initial]]);

  const service: DaemonChannelRouteContext['channelPolicy'] = {
    listPolicies: () => [...policies.values()],
    upsertPolicy: async (surface, input) => {
      const existing = policies.get(surface) ?? {};
      const merged = { ...existing, ...input };
      policies.set(surface, merged);
      return merged;
    },
    listAudit: () => [],
  };
  return { policies, service };
}

function makeChannelPlugins(): DaemonChannelRouteContext['channelPlugins'] {
  return {
    listAccounts: async () => [],
    getAccount: async () => null,
    getSetupSchema: async () => null,
    doctor: async () => null,
    listRepairActions: async () => [],
    getLifecycleState: async () => null,
    migrateLifecycle: async () => null,
    runAccountAction: async () => null,
    listCapabilities: async () => [],
    listTools: async () => [],
    listAgentTools: () => [],
    runTool: async () => null,
    listOperatorActions: async () => [],
    runOperatorAction: async () => null,
    resolveTarget: async () => null,
    authorizeActorAction: async () => null,
    resolveAllowlist: async () => null,
    editAllowlist: async () => null,
    listStatus: async () => [],
    queryDirectory: async () => [],
  };
}

function makeContext(
  channelPolicy: DaemonChannelRouteContext['channelPolicy'],
  requireAdmin: DaemonChannelRouteContext['requireAdmin'] = () => null,
): DaemonChannelRouteContext {
  return {
    channelPlugins: makeChannelPlugins(),
    channelPolicy,
    parseJsonBody: async (req) => {
      try { return await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    parseOptionalJsonBody: async (req) => {
      const text = await req.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    requireAdmin,
    surfaceRegistry: { list: () => [] },
  };
}

function makePatchRequest(surface: string, body: unknown): Request {
  return new Request(`http://localhost/api/channels/policies/${surface}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F19 — PATCH /api/channels/policies/:surface: partial update', () => {
  test('PATCH with partial body → 200 and response reflects merged policy', async () => {
    const { service } = makePolicyStore({ enabled: false, requireMention: false });
    const ctx = makeContext(service);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', { enabled: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // Merged: enabled from patch, requireMention from existing
    expect(body['enabled']).toBe(true);
    expect(body['requireMention']).toBe(false);
  });

  test('PATCH with multiple fields → all merged into response', async () => {
    const { service } = makePolicyStore({ enabled: false, allowDirectMessages: false, requireMention: true });
    const ctx = makeContext(service);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', { enabled: true, allowDirectMessages: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['enabled']).toBe(true);
    expect(body['allowDirectMessages']).toBe(true);
    expect(body['requireMention']).toBe(true); // preserved from existing
  });

  test('PATCH with empty body → 200, existing policy unchanged', async () => {
    const { service } = makePolicyStore({ enabled: true, requireMention: false });
    const ctx = makeContext(service);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', {}),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['enabled']).toBe(true);
    expect(body['requireMention']).toBe(false);
  });
});

describe('F19 — PATCH /api/channels/policies/:surface: admin guard', () => {
  test('PATCH without admin context → requireAdmin response returned', async () => {
    const { service } = makePolicyStore({});
    // Simulate requireAdmin returning a 403
    const requireAdmin: DaemonChannelRouteContext['requireAdmin'] = () =>
      new Response(JSON.stringify({ error: 'Admin required' }), { status: 403 });
    const ctx = makeContext(service, requireAdmin);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', { enabled: true }),
    );
    expect(res.status).toBe(403);
  });
});

describe('F19 — PATCH /api/channels/policies/:surface: field filter', () => {
  test('handler strips untyped fields — only known typed fields reach upsertPolicy', async () => {
    // B3: production field-filter test
    // Posts a body mixing typed + untyped fields; asserts the handler's
    // field-by-field spread only forwards known typed fields to upsertPolicy.
    let capturedPatch: Record<string, unknown> = {};
    const channelPolicy: DaemonChannelRouteContext['channelPolicy'] = {
      listPolicies: () => [],
      upsertPolicy: async (_surface, patch) => {
        capturedPatch = patch as Record<string, unknown>;
        return patch as Record<string, unknown>;
      },
      listAudit: () => [],
    };
    const ctx = makeContext(channelPolicy);
    const handlers = createDaemonChannelRouteHandlers(ctx);

    const res = await handlers.patchChannelPolicy(
      'slack',
      makePatchRequest('slack', {
        enabled: true,
        requireMention: false,
        rate_limit: 999,
        bogusField: 'x',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // Typed fields forwarded — present in response
    expect(body['enabled']).toBe(true);
    expect(body['requireMention']).toBe(false);

    // Untyped fields must not reach upsertPolicy or appear in response
    expect('rate_limit' in capturedPatch).toBe(false);
    expect('bogusField' in capturedPatch).toBe(false);
    expect('rate_limit' in body).toBe(false);
    expect('bogusField' in body).toBe(false);
  });
});

describe('F19 — PATCH /api/channels/policies/:surface: dispatcher integration', () => {
  test('PATCH via dispatchOperatorRoutes routes to patchChannelPolicy and merges fields', async () => {
    // Existing policy: { enabled: true, rate_limit: 5 }
    // Patch: { enabled: false }
    // Expected response: { enabled: false, rate_limit: 5 }
    const { service } = makePolicyStore({ enabled: true, rate_limit: 5 });
    const ctx = makeContext(service);
    const channelHandlers = createDaemonChannelRouteHandlers(ctx);
    const handlers = { ...channelHandlers } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/channels/policies/slack', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    // Patch applied: enabled flipped
    expect(body['enabled']).toBe(false);
    // Existing field preserved via merge
    expect(body['rate_limit']).toBe(5);
  });

  test('PATCH via dispatcher with admin gate: requireAdmin 403 short-circuits before handler', async () => {
    const { service } = makePolicyStore({ enabled: true });
    const requireAdmin: DaemonChannelRouteContext['requireAdmin'] = () =>
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    const ctx = makeContext(service, requireAdmin);
    const channelHandlers = createDaemonChannelRouteHandlers(ctx);
    const handlers = { ...channelHandlers } as unknown as DaemonApiRouteHandlers;
    const req = new Request('http://localhost/api/channels/policies/slack', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
