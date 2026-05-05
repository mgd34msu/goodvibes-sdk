import { describe, expect, test } from 'bun:test';
import {
  McpClient,
  type McpClientNotification,
  type McpClientServerRequest,
  type McpClientUnhandledResponse,
} from '../packages/sdk/src/platform/mcp/client.js';

function dispatchJsonLine(client: McpClient, message: unknown): void {
  (client as unknown as { _dispatchLine(line: string): void })._dispatchLine(JSON.stringify(message));
}

describe('McpClient JSON-RPC protocol observability', () => {
  test('observes JSON-RPC notifications without treating missing id as an error', () => {
    const notifications: McpClientNotification[] = [];
    const client = new McpClient(
      { name: 'test-server', command: 'unused' },
      { onNotification: (notification) => notifications.push(notification) },
    );

    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: { reason: 'changed' },
    });
    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      id: null,
      method: 'notifications/progress',
    });

    expect(notifications).toEqual([
      {
        serverName: 'test-server',
        method: 'notifications/tools/list_changed',
        params: { reason: 'changed' },
      },
      {
        serverName: 'test-server',
        method: 'notifications/progress',
      },
    ]);
  });

  test('observes unsupported server requests and sends a JSON-RPC method-not-found response', () => {
    const requests: McpClientServerRequest[] = [];
    const writes: string[] = [];
    const client = new McpClient(
      { name: 'test-server', command: 'unused' },
      { onServerRequest: (request) => requests.push(request) },
    );
    (client as unknown as { proc: unknown }).proc = {
      exitCode: null,
      stdin: {
        write: (line: string) => {
          writes.push(line);
        },
      },
    };

    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      id: 'roots-1',
      method: 'roots/list',
      params: { cursor: 'next' },
    });

    expect(requests).toEqual([
      {
        serverName: 'test-server',
        id: 'roots-1',
        method: 'roots/list',
        params: { cursor: 'next' },
      },
    ]);
    expect(writes.length).toBe(1);
    const response = JSON.parse(writes[0]!) as { id: string; error: { code: number; message: string } };
    expect(response.id).toBe('roots-1');
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain('roots/list');
  });

  test('observes responses that no longer have a pending request', () => {
    const unhandled: McpClientUnhandledResponse[] = [];
    const client = new McpClient(
      { name: 'test-server', command: 'unused' },
      { onUnhandledResponse: (response) => unhandled.push(response) },
    );

    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      id: 99,
      result: { late: true },
    });

    expect(unhandled).toEqual([
      {
        serverName: 'test-server',
        id: 99,
        hasError: false,
      },
    ]);
  });

  test('does not match a string response id to a numeric pending request id', async () => {
    const unhandled: McpClientUnhandledResponse[] = [];
    const writes: string[] = [];
    const client = new McpClient(
      { name: 'test-server', command: 'unused' },
      {
        timeout: 10_000,
        onUnhandledResponse: (response) => unhandled.push(response),
      },
    );
    (client as unknown as { proc: unknown }).proc = {
      exitCode: null,
      stdin: {
        write: (line: string) => {
          writes.push(line);
        },
      },
    };

    const request = (client as unknown as {
      _request<T>(method: string, params?: unknown): Promise<T>;
    })._request<{ ok: boolean }>('tools/list');
    expect(JSON.parse(writes[0]!) as { id: number }).toMatchObject({ id: 1 });

    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      id: '1',
      result: { ok: true },
    });

    expect(unhandled).toEqual([
      {
        serverName: 'test-server',
        id: '1',
        hasError: false,
      },
    ]);

    dispatchJsonLine(client, {
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });
    await expect(request).resolves.toEqual({ ok: true });
  });
});
