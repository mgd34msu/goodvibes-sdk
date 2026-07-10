/**
 * mcp-operator-server.test.ts
 *
 * The local-first MCP server that exposes the operator catalog: tool definitions
 * generated from the real operator contract (session lifecycle first-class,
 * dotted method ids mapped to MCP-safe names), and the JSON-RPC 2.0 protocol
 * core (initialize / tools/list / tools/call) dispatching through an injected
 * invoker.
 */
import { describe, expect, test } from 'bun:test';
import { getOperatorContract } from '../packages/contracts/src/index.ts';
import {
  buildOperatorMcpTools,
  createOperatorMcpServer,
  operatorMethodIdToToolName,
  OperatorMcpServer,
  readLines,
  SESSION_LIFECYCLE_METHOD_IDS,
} from '../packages/sdk/src/platform/mcp/server/index.ts';

const contract = getOperatorContract();

describe('buildOperatorMcpTools', () => {
  test('generates one MCP tool per invokable operator method, name-mapped from the id', () => {
    const { tools, methodIdByToolName } = buildOperatorMcpTools(contract);
    expect(tools.length).toBeGreaterThan(0);
    const create = tools.find((t) => t.operatorMethodId === 'skills.create');
    expect(create?.name).toBe('skills_create');
    expect(methodIdByToolName.get('skills_create')).toBe('skills.create');
    // Every generated tool carries a valid MCP-safe name and an object input schema.
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect((tool.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  test('session lifecycle tools are lifted to the front, in lifecycle order', () => {
    const { tools } = buildOperatorMcpTools(contract);
    const leading = tools.slice(0, SESSION_LIFECYCLE_METHOD_IDS.length).map((t) => t.operatorMethodId);
    expect(leading).toEqual([...SESSION_LIFECYCLE_METHOD_IDS]);
  });

  test('read-only methods are annotated readOnlyHint', () => {
    const { tools } = buildOperatorMcpTools(contract);
    const list = tools.find((t) => t.operatorMethodId === 'skills.list');
    expect(list?.annotations?.readOnlyHint).toBe(true);
    const create = tools.find((t) => t.operatorMethodId === 'skills.create');
    expect(create?.annotations?.readOnlyHint).toBe(false);
  });

  test('category filters narrow the exposed surface', () => {
    const { tools } = buildOperatorMcpTools(contract, { includeCategories: ['skills'] });
    expect(tools.length).toBe(5);
    expect(tools.every((t) => t.operatorMethodId.startsWith('skills.'))).toBe(true);
  });

  test('id-to-name mapping replaces dots with underscores', () => {
    expect(operatorMethodIdToToolName('sessions.messages.create')).toBe('sessions_messages_create');
  });
});

async function rpc(server: OperatorMcpServer, message: unknown): Promise<Record<string, unknown> | null> {
  const line = await server.handleLine(JSON.stringify(message));
  return line === null ? null : (JSON.parse(line) as Record<string, unknown>);
}

describe('OperatorMcpServer protocol', () => {
  function makeServer(invoke = async () => ({ ok: true })): OperatorMcpServer {
    return createOperatorMcpServer({
      contract,
      invoke,
      tools: { includeCategories: ['skills'] },
      serverInfo: { name: 'test', version: '9.9.9' },
    });
  }

  test('initialize returns capabilities and server info', async () => {
    const res = await rpc(makeServer(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const result = res?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect((result.serverInfo as { name: string }).name).toBe('test');
    expect((result.capabilities as { tools?: unknown }).tools).toBeDefined();
  });

  test('notifications/initialized yields no response', async () => {
    expect(await rpc(makeServer(), { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  test('tools/list returns the generated tools', async () => {
    const res = await rpc(makeServer(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['skills_create', 'skills_delete', 'skills_get', 'skills_list', 'skills_update'].sort(),
    );
  });

  test('tools/call dispatches to the invoker and wraps the result as text content', async () => {
    let seen: { methodId: string; input: Record<string, unknown> } | null = null;
    const server = makeServer(async (methodId: string, input: Record<string, unknown>) => {
      seen = { methodId, input };
      return { skills: [] };
    });
    const res = await rpc(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'skills_list', arguments: {} },
    });
    expect(seen).toEqual({ methodId: 'skills.list', input: {} });
    const content = (res?.result as { content: { type: string; text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toEqual({ skills: [] });
  });

  test('tools/call on an unknown tool returns an isError result, not a crash', async () => {
    const res = await rpc(makeServer(), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    expect((res?.result as { isError?: boolean }).isError).toBe(true);
  });

  test('an invoker failure surfaces as an isError tool result', async () => {
    const server = makeServer(async () => { throw new Error('daemon unreachable'); });
    const res = await rpc(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'skills_get', arguments: { name: 'x' } },
    });
    const result = res?.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('daemon unreachable');
  });

  test('malformed JSON returns a JSON-RPC parse error', async () => {
    const line = await makeServer().handleLine('{not json');
    expect(JSON.parse(line!).error.code).toBe(-32700);
  });

  test('an unknown method returns method-not-found', async () => {
    const res = await rpc(makeServer(), { jsonrpc: '2.0', id: 6, method: 'no/such/method' });
    expect((res?.error as { code: number }).code).toBe(-32601);
  });
});

describe('readLines', () => {
  test('splits a chunked byte stream into newline-delimited lines', async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      const enc = new TextEncoder();
      yield enc.encode('{"a":1}\n{"b":');
      yield enc.encode('2}\n');
    }
    const out: string[] = [];
    for await (const line of readLines(chunks())) out.push(line);
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});
