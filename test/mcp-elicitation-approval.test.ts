import { describe, expect, test } from 'bun:test';
import { McpClient } from '../packages/sdk/src/platform/mcp/client.js';
import {
  createMcpElicitationApprovalHandler,
  parseElicitationParams,
} from '../packages/sdk/src/platform/mcp/elicitation.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';

function dispatchJsonLine(client: McpClient, message: unknown): void {
  (client as unknown as { _dispatchLine(line: string): void })._dispatchLine(JSON.stringify(message));
}

function attachFakeProc(client: McpClient, writes: string[]): void {
  (client as unknown as { proc: unknown }).proc = {
    exitCode: null,
    stdin: { write: (line: string) => { writes.push(line); } },
  };
}

describe('MCP elicitation → approval broker', () => {
  test('parseElicitationParams extracts message + schema and falls back honestly', () => {
    const parsed = parseElicitationParams('acme', { message: 'Pick one', requestedSchema: { type: 'object' } });
    expect(parsed).toEqual({
      serverName: 'acme',
      message: 'Pick one',
      requestedSchema: { type: 'object' },
      rawParams: { message: 'Pick one', requestedSchema: { type: 'object' } },
    });
    const bare = parseElicitationParams('acme', {});
    expect(bare.message).toContain('acme');
    expect(bare.requestedSchema).toBeUndefined();
  });

  test('an approved elicitation returns action:accept with the surface content', async () => {
    const seen: PermissionPromptRequest[] = [];
    const handler = createMcpElicitationApprovalHandler(async ({ request }) => {
      seen.push(request);
      const decision: PermissionPromptDecision = { approved: true, modifiedArgs: { color: 'blue' } };
      return decision;
    });
    const outcome = await handler({ serverName: 'acme', message: 'Favourite colour?' });
    expect(outcome).toEqual({ action: 'accept', content: { color: 'blue' } });
    // The ask reaches the broker as a permission-shaped request attributed to the server.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.category).toBe('delegate');
    expect(seen[0]!.attribution).toEqual({ kind: 'mcp-server', serverName: 'acme' });
    expect(seen[0]!.analysis.summary).toContain('acme');
    expect(seen[0]!.tool).toBe('mcp:acme:elicitation');
  });

  test('a denied elicitation returns action:decline with no fabricated content', async () => {
    const handler = createMcpElicitationApprovalHandler(async () => ({ approved: false }));
    const outcome = await handler({ serverName: 'acme', message: 'Delete everything?' });
    expect(outcome).toEqual({ action: 'decline' });
  });

  test('the client routes elicitation/create to the resolver and writes its result', async () => {
    const writes: string[] = [];
    const client = new McpClient(
      { name: 'acme', command: 'unused' },
      {
        onElicitation: async ({ serverName, params }) => {
          const req = parseElicitationParams(serverName, params);
          expect(req.message).toBe('Proceed?');
          return { action: 'accept', content: { ok: true } };
        },
      },
    );
    attachFakeProc(client, writes);

    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      id: 'elicit-1',
      method: 'elicitation/create',
      params: { message: 'Proceed?' },
    });

    // The resolver is async; wait a microtask turn for the result to be written.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes.length).toBe(1);
    const response = JSON.parse(writes[0]!) as { id: string; result: { action: string; content: unknown } };
    expect(response.id).toBe('elicit-1');
    expect(response.result).toEqual({ action: 'accept', content: { ok: true } });
  });

  test('without a resolver, elicitation/create still hard-rejects with -32601', () => {
    const writes: string[] = [];
    const client = new McpClient({ name: 'acme', command: 'unused' }, {});
    attachFakeProc(client, writes);

    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      id: 'elicit-2',
      method: 'elicitation/create',
      params: { message: 'Proceed?' },
    });

    expect(writes.length).toBe(1);
    const response = JSON.parse(writes[0]!) as { id: string; error: { code: number } };
    expect(response.error.code).toBe(-32601);
  });
});
