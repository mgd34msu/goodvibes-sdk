import { describe, expect, test } from 'bun:test';
import { McpRegistry } from '../packages/sdk/src/platform/mcp/registry.js';

describe('McpRegistry pre-call hooks', () => {
  test('blocks tool execution when a pre-call hook returns ok false', async () => {
    const registry = new McpRegistry({
      hookDispatcher: {
        fire: async () => ({ ok: false, error: 'policy rejected call' }),
      },
      sandboxSessions: {
        start: () => 'sandbox-1',
        stop: () => {},
      } as never,
    });
    let called = false;
    (registry as unknown as {
      permissions: { registerServer: (name: string, trustLevel: 'trusted') => void };
    }).permissions.registerServer('server', 'trusted');
    (registry as unknown as { clients: Map<string, unknown> }).clients.set('server', {
      isConnected: true,
      callTool: async () => {
        called = true;
        return { ok: true };
      },
    });

    await expect(registry.callTool('mcp:server:write_file', {})).rejects.toThrow('pre-call hook failed');
    expect(called).toBe(false);
  });
});
