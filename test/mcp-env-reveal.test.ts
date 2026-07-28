/**
 * mcp-env-reveal.test.ts
 *
 * The read half of the MCP env fix. `envKeys` alone made env values readable
 * by nothing at all — an admin who had set them could not see what was set,
 * and could not resend them when the whole-object write path asked for them.
 *
 * The narrowing is that the values become readable to an ADMIN, on a route
 * that has to be asked for by name, while every existing caller keeps the
 * redacted view it already had.
 */
import { describe, expect, test } from 'bun:test';

import { dispatchMcpRoutes } from '../packages/sdk/src/platform/daemon/http/mcp-routes.ts';
import type { McpEffectiveConfig } from '../packages/sdk/src/platform/mcp/config.ts';

const LOCATION = {
  scope: 'project' as const,
  kind: 'project-goodvibes' as const,
  path: '/tmp/mcp.json',
  writable: true,
};

const EFFECTIVE: McpEffectiveConfig = {
  locations: [LOCATION],
  servers: [
    {
      server: {
        name: 'billing',
        command: 'billing-mcp',
        args: [],
        env: { BILLING_TOKEN: 'secret-value', REGION: 'eu' },
      },
      source: LOCATION,
    },
  ],
};

function makeContext(opts: { admin: boolean }) {
  return {
    mcpRegistry: {
      getEffectiveConfig: () => EFFECTIVE,
      reload: async () => ({}),
      upsertServerConfig: async () => ({}),
      removeServerConfig: async () => ({}),
      listServers: () => [],
      listServerSecurity: () => [],
      listServerSandboxBindings: () => [],
      listAllTools: async () => [],
    },
    roots: { workingDirectory: '/tmp', homeDirectory: '/tmp' },
    parseJsonBody: async () => ({}),
    parseOptionalJsonBody: async () => null,
    requireAdmin: (_req: Request) =>
      opts.admin ? null : new Response(JSON.stringify({ error: 'admin required' }), { status: 403 }),
  } as unknown as Parameters<typeof dispatchMcpRoutes>[1];
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

describe('MCP env values are readable by an admin and nobody else', () => {
  test('the reveal route returns env VALUES for an admin', async () => {
    const res = await dispatchMcpRoutes(get('/api/mcp/servers/reveal'), makeContext({ admin: true }));
    expect(res?.status).toBe(200);
    const body = await res!.json() as { servers: Array<{ name: string; env: Record<string, string>; envKeys: string[] }> };
    const billing = body.servers.find((s) => s.name === 'billing')!;
    expect(billing.env).toEqual({ BILLING_TOKEN: 'secret-value', REGION: 'eu' });
    // envKeys is still there, so a caller reading the reveal view does not
    // lose the shape the redacted view gave it.
    expect(billing.envKeys).toEqual(['BILLING_TOKEN', 'REGION']);
  });

  test('a non-admin is refused before any value is serialized', async () => {
    const res = await dispatchMcpRoutes(get('/api/mcp/servers/reveal'), makeContext({ admin: false }));
    expect(res?.status).toBe(403);
    expect(await res!.text()).not.toContain('secret-value');
  });

  test('the ordinary config route still shows envKeys only, for an admin too', async () => {
    const res = await dispatchMcpRoutes(get('/api/mcp/config'), makeContext({ admin: true }));
    const raw = await res!.text();
    // The redacted view must not quietly gain values because a reveal route
    // now exists — a surface that wants envKeys should not be able to acquire
    // secrets by accident.
    expect(raw).not.toContain('secret-value');
    expect(raw).toContain('envKeys');
  });
});
