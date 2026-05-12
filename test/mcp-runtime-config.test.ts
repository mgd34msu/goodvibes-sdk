import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMcpConfig,
  loadMcpEffectiveConfig,
  type McpServerConfig,
  removeMcpServerConfig,
  upsertMcpServerConfig,
} from '../packages/sdk/src/platform/mcp/config.js';
import { McpRegistry } from '../packages/sdk/src/platform/mcp/registry.js';
import { dispatchMcpRoutes } from '../packages/sdk/src/platform/daemon/http/mcp-routes.js';

function tempRoots() {
  const root = mkdtempSync(join(tmpdir(), 'gv-mcp-runtime-config-'));
  return {
    root,
    roots: {
      workingDirectory: join(root, 'project'),
      homeDirectory: join(root, 'home'),
    },
  };
}

describe('MCP runtime config', () => {
  test('loads effective config with project GoodVibes precedence and source metadata', () => {
    const { root, roots } = tempRoots();
    try {
      upsertMcpServerConfig(roots, 'global', {
        name: 'docs',
        command: 'global-docs',
        args: ['--global'],
      });
      upsertMcpServerConfig(roots, 'project', {
        name: 'docs',
        command: 'project-docs',
        args: ['--project'],
        env: { TOKEN: 'secret' },
      });

      const config = loadMcpConfig(roots);
      expect(config.servers).toHaveLength(1);
      expect(config.servers[0]?.command).toBe('project-docs');
      expect(config.servers[0]?.env?.TOKEN).toBe('secret');

      const effective = loadMcpEffectiveConfig(roots);
      expect(effective.servers).toHaveLength(1);
      expect(effective.servers[0]?.source.scope).toBe('project');
      expect(effective.servers[0]?.source.kind).toBe('project-goodvibes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('upsert and remove mutate only the selected writable scope', () => {
    const { root, roots } = tempRoots();
    try {
      upsertMcpServerConfig(roots, 'project', {
        name: 'fs',
        command: 'node',
        args: ['server.js'],
      });
      upsertMcpServerConfig(roots, 'global', {
        name: 'global-only',
        command: 'node',
      });

      expect(loadMcpConfig(roots).servers.map((server) => server.name).sort()).toEqual(['fs', 'global-only']);
      const removed = removeMcpServerConfig(roots, 'project', 'fs');
      expect(removed.removed).toBe(true);
      expect(loadMcpConfig(roots).servers.map((server) => server.name)).toEqual(['global-only']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('registry reload tracks configured servers even when connection fails', async () => {
    const registry = new McpRegistry({
      hookDispatcher: { fire: async () => ({ ok: true }) },
      sandboxSessions: { start: () => 'sandbox-1', stop: () => {} } as never,
    });

    const result = await registry.applyConfig([
      { name: 'bad', command: process.execPath, args: ['-e', 'process.exit(1)'] },
    ]);

    expect(result.added).toBe(1);
    expect(registry.listServers()).toEqual([{ name: 'bad', connected: false }]);
  });

  test('registry reload retries unchanged servers that are not connected', async () => {
    const registry = new McpRegistry({
      hookDispatcher: { fire: async () => ({ ok: true }) },
      sandboxSessions: { start: () => 'sandbox-1', stop: () => {} } as never,
    });
    const internals = registry as unknown as {
      _connectServer(serverConfig: McpServerConfig): Promise<void>;
    };
    let attempts = 0;
    internals._connectServer = async () => {
      attempts += 1;
    };

    const config = { name: 'retry-me', command: 'node' };
    const first = await registry.applyConfig([config]);
    const second = await registry.applyConfig([config]);

    expect(first.added).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(attempts).toBe(2);
  });

  test('daemon MCP config route redacts env values and reloads after upsert', async () => {
    const { root, roots } = tempRoots();
    try {
      const registry = new McpRegistry({
        hookDispatcher: { fire: async () => ({ ok: true }) },
        sandboxSessions: { start: () => 'sandbox-1', stop: () => {} } as never,
      });
      const context = {
        mcpRegistry: registry,
        roots,
        parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
        parseOptionalJsonBody: async (req: Request) => {
          const text = await req.text();
          return text ? JSON.parse(text) as Record<string, unknown> : null;
        },
        requireAdmin: () => null,
      };

      const upsert = await dispatchMcpRoutes(new Request('http://localhost/api/mcp/config/servers', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'project',
          server: {
            name: 'secret-server',
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
            env: { API_KEY: 'do-not-return' },
          },
        }),
      }), context);
      expect(upsert?.status).toBe(200);

      const response = await dispatchMcpRoutes(new Request('http://localhost/api/mcp/config'), context);
      expect(response?.status).toBe(200);
      const body = await response!.json() as { servers: Array<{ env?: unknown; envKeys?: string[] }> };
      expect(body.servers[0]?.env).toBeUndefined();
      expect(body.servers[0]?.envKeys).toEqual(['API_KEY']);
      expect(JSON.stringify(body)).not.toContain('do-not-return');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
