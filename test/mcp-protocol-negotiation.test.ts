/**
 * MCP protocol currency over stdio: era detection via server/discover,
 * per-request _meta on the stateless revision, initialize fallback for
 * handshake-era servers, Multi Round-Trip Requests, and the near-zero
 * attach-time context guarantee.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpClient } from '../packages/sdk/src/platform/mcp/client.js';
import { createMcpTool } from '../packages/sdk/src/platform/tools/mcp/index.js';
import type { McpRegistry } from '../packages/sdk/src/platform/mcp/registry.js';
import { MCP_STATELESS_REVISION } from '../packages/sdk/src/platform/mcp/protocol.js';

const scratch = mkdtempSync(join(tmpdir(), 'gv-mcp-negotiation-'));
const serverScript = join(scratch, 'mock-mcp-server.ts');

writeFileSync(serverScript, `
import { appendFileSync } from 'fs';

const mode = process.env.MCP_MOCK_MODE ?? 'modern';
const toolCount = Number(process.env.MCP_MOCK_TOOLS ?? '3');
const logPath = process.env.MCP_MOCK_LOG ?? '';

function log(method: string): void {
  if (logPath) appendFileSync(logPath, method + '\\n');
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

const tools = Array.from({ length: toolCount }, (_, i) => ({
  name: 'tool-' + i,
  description: 'Tool number ' + i + ' — ' + 'd'.repeat(200),
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string', description: 'v'.repeat(400) } },
  },
}));

function handle(msg: Record<string, unknown>): void {
  const method = String(msg.method ?? '');
  log(method);
  if (msg.id === undefined || msg.id === null) return; // notification
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    if (mode === 'modern' || mode === 'modern-mrtr') {
      send({ jsonrpc: '2.0', id, result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-modern', version: '1.0.0' },
        ttlMs: 60000,
        cacheScope: 'private',
      } });
    } else if (mode === 'silent-legacy') {
      // Stays silent: the probe must time out and fall back.
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: server/discover' } });
    }
    return;
  }

  if (method === 'initialize') {
    if (mode === 'modern' || mode === 'modern-mrtr') {
      send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'initialize is not supported; supported protocol versions: 2026-07-28' } });
    } else if (mode === 'legacy-2025') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock-legacy-2025', version: '1.0.0' } } });
    } else if (mode === 'version-mismatch') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2099-01-01', capabilities: {}, serverInfo: { name: 'mock-future', version: '1.0.0' } } });
    } else {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-legacy-old', version: '1.0.0' } } });
    }
    return;
  }

  if (method === 'tools/list') {
    const base: Record<string, unknown> = { tools };
    if (mode === 'modern' || mode === 'modern-mrtr') {
      base.resultType = 'complete';
      base.ttlMs = 1000;
      base.cacheScope = 'private';
    }
    send({ jsonrpc: '2.0', id, result: base });
    return;
  }

  if (method === 'tools/call') {
    const meta = (params._meta ?? null) as Record<string, unknown> | null;
    if ((mode === 'modern' || mode === 'modern-mrtr')
      && (!meta || typeof meta['io.modelcontextprotocol/protocolVersion'] !== 'string')) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'request is missing per-request _meta protocol version' } });
      return;
    }
    if (mode === 'modern-mrtr' && params.name === 'needs-input' && params.inputResponses === undefined) {
      send({ jsonrpc: '2.0', id, result: {
        resultType: 'input_required',
        inputRequests: {
          user_name: {
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: 'Please provide your name',
              requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            },
          },
        },
        requestState: 'opaque-state-1',
      } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: {
      ...(mode === 'modern' || mode === 'modern-mrtr' ? { resultType: 'complete' } : {}),
      content: [{ type: 'text', text: 'ok' }],
      echo: {
        name: params.name ?? null,
        args: params.arguments ?? null,
        meta,
        inputResponses: params.inputResponses ?? null,
        requestState: params.requestState ?? null,
      },
    } });
    return;
  }

  if (method === 'ping') {
    if (mode === 'modern' || mode === 'modern-mrtr') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'ping was removed in 2026-07-28' } });
    } else {
      send({ jsonrpc: '2.0', id, result: {} });
    }
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let idx: number;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
});
`);

const clients: McpClient[] = [];

function makeClient(mode: string, extraEnv: Record<string, string> = {}, options: ConstructorParameters<typeof McpClient>[1] = {}): McpClient {
  const client = new McpClient(
    {
      name: `mock-${mode}`,
      command: process.execPath,
      args: [serverScript],
      env: { MCP_MOCK_MODE: mode, ...extraEnv },
    },
    { timeout: 10_000, ...options },
  );
  clients.push(client);
  return client;
}

afterAll(async () => {
  for (const client of clients) {
    await client.disconnect().catch(() => {});
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('MCP stdio protocol negotiation', () => {
  test('negotiates the stateless revision with a current-spec server and round-trips a tool call with per-request _meta', async () => {
    const client = makeClient('modern');
    await client.connect();
    expect(client.protocolInfo).toEqual({ era: 'modern', version: MCP_STATELESS_REVISION, transport: 'stdio' });

    const result = await client.callTool('tool-1', { value: 'hello' }) as Record<string, unknown>;
    const echo = result.echo as Record<string, unknown>;
    expect(echo.name).toBe('tool-1');
    expect(echo.args).toEqual({ value: 'hello' });
    const meta = echo.meta as Record<string, unknown>;
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe(MCP_STATELESS_REVISION);
    expect((meta['io.modelcontextprotocol/clientInfo'] as Record<string, unknown>).name).toBe('goodvibes-sdk');
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({});
  });

  test('health check uses server/discover on the stateless revision (ping was removed)', async () => {
    const client = makeClient('modern');
    await client.connect();
    expect(await client.ping()).toBe(true);
  });

  test('still speaks 2024-11-05 to an old handshake server, and the negotiated version is visible', async () => {
    const client = makeClient('legacy-old');
    await client.connect();
    expect(client.protocolInfo).toEqual({ era: 'legacy', version: '2024-11-05', transport: 'stdio' });

    const result = await client.callTool('tool-0', { value: 'legacy' }) as Record<string, unknown>;
    const echo = result.echo as Record<string, unknown>;
    expect(echo.args).toEqual({ value: 'legacy' });
    // Handshake-era requests carry no modern _meta.
    expect(echo.meta).toBeNull();
    expect(await client.ping()).toBe(true);
  });

  test('negotiates 2025-11-25 with a current handshake server', async () => {
    const client = makeClient('legacy-2025');
    await client.connect();
    expect(client.protocolInfo).toEqual({ era: 'legacy', version: '2025-11-25', transport: 'stdio' });
  });

  test('falls back to initialize when the discover probe stays silent', async () => {
    const client = makeClient('silent-legacy');
    await client.connect();
    expect(client.protocolInfo).toEqual({ era: 'legacy', version: '2024-11-05', transport: 'stdio' });
  }, 15_000);

  test('refuses a server that negotiates a version this client does not speak, honestly', async () => {
    const client = makeClient('version-mismatch');
    await expect(client.connect()).rejects.toThrow(/unsupported protocol version 2099-01-01/);
  });

  test('resolves a Multi Round-Trip Request through the elicitation resolver and retries with inputResponses', async () => {
    const elicited: unknown[] = [];
    const client = makeClient('modern-mrtr', {}, {
      timeout: 10_000,
      onElicitation: async (input) => {
        elicited.push(input.params);
        return { action: 'accept', content: { name: 'octocat' } };
      },
    });
    await client.connect();

    const result = await client.callTool('needs-input', { value: 'x' }) as Record<string, unknown>;
    const echo = result.echo as Record<string, unknown>;
    expect(echo.inputResponses).toEqual({ user_name: { action: 'accept', content: { name: 'octocat' } } });
    expect(echo.requestState).toBe('opaque-state-1');
    expect(elicited).toHaveLength(1);
  });

  test('an input_required result without a wired resolver fails honestly instead of looping', async () => {
    const client = makeClient('modern-mrtr');
    await client.connect();
    await expect(client.callTool('needs-input', {})).rejects.toThrow(/requested 'elicitation\/create' input this client cannot provide/);
  });
});

describe('MCP attach-time context cost', () => {
  test('a 20-tool server contributes near-zero context at attach: no tool fetch on the wire, constant model-visible surface', async () => {
    const logPath = join(scratch, `attach-log-${Date.now()}.txt`);
    const client = makeClient('modern', { MCP_MOCK_TOOLS: '20', MCP_MOCK_LOG: logPath });

    // The model-visible surface for MCP is the single static `mcp` tool; its
    // definition size is the whole attach-time context contribution.
    const surface = createMcpTool({} as unknown as McpRegistry);
    const surfaceBytes = JSON.stringify(surface.definition).length;

    await client.connect();

    const attachMethods = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    // Attach performed era detection only — no tool names, no schemas.
    expect(attachMethods).toEqual(['server/discover']);

    const surfaceBytesAfterAttach = JSON.stringify(createMcpTool({} as unknown as McpRegistry).definition).length;
    expect(surfaceBytesAfterAttach).toBe(surfaceBytes);
    expect(surfaceBytes).toBeLessThan(1024);

    // First actual use lazily fetches schemas, exactly once.
    const result = await client.callTool('tool-3', { value: 'lazy' }) as Record<string, unknown>;
    expect((result.echo as Record<string, unknown>).name).toBe('tool-3');
    const methodsAfterCall = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(methodsAfterCall).toEqual(['server/discover', 'tools/list', 'tools/call']);
  });
});
