/**
 * MCP Streamable HTTP transport: stateless-revision requests with mirrored
 * headers, SSE response streams, legacy (initialize + Mcp-Session-Id)
 * fallback, dual-era negotiation, and x-mcp-header parameter mirroring.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { McpClient } from '../packages/sdk/src/platform/mcp/client.js';
import {
  buildParamHeaders,
  collectHeaderAnnotations,
  encodeHeaderValue,
} from '../packages/sdk/src/platform/mcp/http-headers.js';
import { MCP_STATELESS_REVISION } from '../packages/sdk/src/platform/mcp/protocol.js';

interface SeenRequest {
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const servers: Array<{ stop: () => void }> = [];
const clients: McpClient[] = [];

afterAll(async () => {
  for (const client of clients) await client.disconnect().catch(() => {});
  for (const server of servers) server.stop();
});

function trackServer<T extends { stop: () => void }>(server: T): T {
  servers.push(server);
  return server;
}

function makeHttpClient(url: string, options: ConstructorParameters<typeof McpClient>[1] = {}): McpClient {
  const client = new McpClient({ name: 'http-mock', url }, { timeout: 10_000, ...options });
  clients.push(client);
  return client;
}

function captureHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

describe('MCP Streamable HTTP transport — stateless revision', () => {
  test('negotiates via server/discover, mirrors headers, and round-trips a tool call over an SSE response stream', async () => {
    const seen: SeenRequest[] = [];
    const toolSchema = {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'target region', 'x-mcp-header': 'Region' },
        query: { type: 'string' },
      },
      required: ['region', 'query'],
    };

    const server = trackServer(Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method !== 'POST') return new Response(null, { status: 405 });
        const body = await req.json() as Record<string, unknown>;
        const headers = captureHeaders(req);
        const method = String(body.method ?? '');
        seen.push({ method, headers, body });
        const params = (body.params ?? {}) as Record<string, unknown>;
        const meta = (params._meta ?? {}) as Record<string, unknown>;

        // Modern server validation: header must match body _meta.
        if (headers['mcp-protocol-version'] !== meta['io.modelcontextprotocol/protocolVersion']) {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32020, message: 'Header mismatch' } }, { status: 400 });
        }
        if (headers['mcp-method'] !== method) {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32020, message: 'Mcp-Method mismatch' } }, { status: 400 });
        }

        if (method === 'server/discover') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            serverInfo: { name: 'http-modern', version: '1.0.0' },
          } });
        }
        if (method === 'tools/list') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
            resultType: 'complete',
            ttlMs: 1000,
            cacheScope: 'private',
            tools: [{ name: 'execute_sql', description: 'run a query', inputSchema: toolSchema }],
          } });
        }
        if (method === 'tools/call') {
          const finalResponse = { jsonrpc: '2.0', id: body.id, result: {
            resultType: 'complete',
            content: [{ type: 'text', text: 'done' }],
            echo: { args: params.arguments, meta },
          } };
          const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(notification)}\n\n`));
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finalResponse)}\n\n`));
              controller.close();
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not found: ${method}` } }, { status: 404 });
      },
    }));

    const notifications: string[] = [];
    const client = makeHttpClient(`http://127.0.0.1:${server.port}/mcp`, {
      timeout: 10_000,
      onNotification: (n) => notifications.push(n.method),
    });
    await client.connect();
    expect(client.protocolInfo).toEqual({ era: 'modern', version: MCP_STATELESS_REVISION, transport: 'http' });

    const result = await client.callTool('execute_sql', { region: 'us-west1', query: 'SELECT 1' }) as Record<string, unknown>;
    expect((result.echo as Record<string, unknown>).args).toEqual({ region: 'us-west1', query: 'SELECT 1' });
    expect(notifications).toContain('notifications/progress');

    const call = seen.find((r) => r.method === 'tools/call');
    expect(call).toBeDefined();
    expect(call!.headers['mcp-method']).toBe('tools/call');
    expect(call!.headers['mcp-name']).toBe('execute_sql');
    expect(call!.headers['mcp-protocol-version']).toBe(MCP_STATELESS_REVISION);
    // x-mcp-header parameter mirrored from the fetched inputSchema.
    expect(call!.headers['mcp-param-region']).toBe('us-west1');
    // No protocol-level session anywhere in the modern era.
    expect(Object.keys(call!.headers)).not.toContain('mcp-session-id');
  });

  test('a modern server advertising only handshake versions gets the legacy handshake (dual-era negotiation)', async () => {
    const methods: string[] = [];
    let sawInitialized = false;
    const server = trackServer(Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method !== 'POST') return new Response(null, { status: 405 });
        const body = await req.json() as Record<string, unknown>;
        const method = String(body.method ?? '');
        methods.push(method);
        if (method === 'server/discover') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, error: {
            code: -32022,
            message: 'Unsupported protocol version',
            data: { supported: ['2025-11-25'], requested: MCP_STATELESS_REVISION },
          } }, { status: 400 });
        }
        if (method === 'initialize') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'dual-era', version: '1.0.0' },
          } }, { headers: { 'Mcp-Session-Id': 'sess-42' } });
        }
        if (method === 'notifications/initialized') {
          sawInitialized = true;
          return new Response(null, { status: 202 });
        }
        if (method === 'tools/list') {
          expect(captureHeaders(req)['mcp-session-id']).toBe('sess-42');
          expect(captureHeaders(req)['mcp-protocol-version']).toBe('2025-11-25');
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'a', description: 'a tool' }] } });
        }
        return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }, { status: 404 });
      },
    }));

    const client = makeHttpClient(`http://127.0.0.1:${server.port}/mcp`);
    await client.connect();
    expect(client.protocolInfo).toEqual({ era: 'legacy', version: '2025-11-25', transport: 'http' });
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'a', description: 'a tool' }]);
    expect(sawInitialized).toBe(true);
    expect(methods[0]).toBe('server/discover');
    expect(methods).toContain('initialize');
  });

  test('falls back to initialize when a legacy server rejects the modern probe without a recognized modern error', async () => {
    const server = trackServer(Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method !== 'POST') return new Response(null, { status: 405 });
        const body = await req.json() as Record<string, unknown>;
        const method = String(body.method ?? '');
        if (method === 'server/discover') {
          return new Response('Bad Request', { status: 400 });
        }
        if (method === 'initialize') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'legacy-http', version: '0.9.0' },
          } });
        }
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
      },
    }));

    const client = makeHttpClient(`http://127.0.0.1:${server.port}/mcp`);
    await client.connect();
    expect(client.protocolInfo).toEqual({ era: 'legacy', version: '2025-03-26', transport: 'http' });
  });

  test('excludes tool definitions whose x-mcp-header annotations are invalid, keeping valid tools usable', async () => {
    const server = trackServer(Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method !== 'POST') return new Response(null, { status: 405 });
        const body = await req.json() as Record<string, unknown>;
        const method = String(body.method ?? '');
        if (method === 'server/discover') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' }, resultType: 'complete' } });
        }
        if (method === 'tools/list') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', tools: [
            { name: 'good', description: 'ok', inputSchema: { type: 'object', properties: { p: { type: 'string', 'x-mcp-header': 'P' } } } },
            { name: 'bad', description: 'invalid annotation', inputSchema: { type: 'object', properties: { p: { type: 'number', 'x-mcp-header': 'P' } } } },
          ] } });
        }
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete' } });
      },
    }));

    const client = makeHttpClient(`http://127.0.0.1:${server.port}/mcp`);
    await client.connect();
    expect(await client.getToolSchema('good')).not.toBeNull();
    expect(await client.getToolSchema('bad')).toBeNull();
  });
});

describe('MCP HTTP header value encoding', () => {
  test('plain ASCII passes through; non-ASCII, padded, and sentinel-shaped values use the base64 sentinel', () => {
    expect(encodeHeaderValue('us-west1')).toBe('us-west1');
    expect(encodeHeaderValue('Hello, 世界')).toBe(`=?base64?${Buffer.from('Hello, 世界', 'utf8').toString('base64')}?=`);
    expect(encodeHeaderValue(' padded ')).toBe(`=?base64?${Buffer.from(' padded ', 'utf8').toString('base64')}?=`);
    expect(encodeHeaderValue('line1\nline2')).toBe(`=?base64?${Buffer.from('line1\nline2', 'utf8').toString('base64')}?=`);
    expect(encodeHeaderValue('=?base64?literal?=')).toBe(`=?base64?${Buffer.from('=?base64?literal?=', 'utf8').toString('base64')}?=`);
  });

  test('collectHeaderAnnotations enforces reachability, uniqueness, and primitive types', () => {
    // Nested properties chains are reachable.
    expect(collectHeaderAnnotations({
      type: 'object',
      properties: { outer: { type: 'object', properties: { inner: { type: 'string', 'x-mcp-header': 'Inner' } } } },
    })).toEqual([{ headerName: 'Inner', path: ['outer', 'inner'] }]);
    // Annotations under array/composition keywords invalidate the definition.
    expect(collectHeaderAnnotations({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'X' } } },
    })).toBeNull();
    // number type is not permitted.
    expect(collectHeaderAnnotations({
      type: 'object',
      properties: { n: { type: 'number', 'x-mcp-header': 'N' } },
    })).toBeNull();
    // Case-insensitive duplicates invalidate.
    expect(collectHeaderAnnotations({
      type: 'object',
      properties: {
        a: { type: 'string', 'x-mcp-header': 'Dup' },
        b: { type: 'string', 'x-mcp-header': 'dup' },
      },
    })).toBeNull();
  });

  test('buildParamHeaders converts values and omits absent or null parameters', () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        limit: { type: 'integer', 'x-mcp-header': 'Limit' },
        dryRun: { type: 'boolean', 'x-mcp-header': 'Dry-Run' },
        skipped: { type: 'string', 'x-mcp-header': 'Skipped' },
      },
    };
    expect(buildParamHeaders(schema, { region: 'eu', limit: 42, dryRun: false, skipped: null as unknown as string })).toEqual({
      'Mcp-Param-Region': 'eu',
      'Mcp-Param-Limit': '42',
      'Mcp-Param-Dry-Run': 'false',
    });
  });
});
