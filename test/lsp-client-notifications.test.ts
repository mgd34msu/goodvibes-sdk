import { describe, expect, test } from 'bun:test';
import { LspClient } from '../packages/sdk/src/platform/intelligence/lsp/client.js';

function dispatch(client: LspClient, payload: unknown): void {
  (client as unknown as { _dispatchMessage(body: string): void })._dispatchMessage(JSON.stringify(payload));
}

describe('LspClient notification queue', () => {
  test('takes only matching notifications and retains the rest', () => {
    const client = new LspClient('unused', []);

    dispatch(client, {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///one.ts', diagnostics: [{ message: 'one' }] },
    });
    dispatch(client, {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///two.ts', diagnostics: [{ message: 'two' }] },
    });
    dispatch(client, {
      jsonrpc: '2.0',
      method: 'workspace/configuration',
      params: { section: 'typescript' },
    });

    const one = client.takeNotifications((notification) => {
      const params = notification.params as { uri?: unknown } | undefined;
      return notification.method === 'textDocument/publishDiagnostics' && params?.uri === 'file:///one.ts';
    });

    expect(one.map((notification) => notification.method)).toEqual(['textDocument/publishDiagnostics']);
    expect((one[0]!.params as { uri: string }).uri).toBe('file:///one.ts');

    const remaining = client.takeNotifications(() => true);
    expect(remaining.map((notification) => [
      notification.method,
      (notification.params as { uri?: string } | undefined)?.uri,
    ])).toEqual([
      ['textDocument/publishDiagnostics', 'file:///two.ts'],
      ['workspace/configuration', undefined],
    ]);
  });
});
