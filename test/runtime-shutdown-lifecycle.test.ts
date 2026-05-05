import { describe, expect, test } from 'bun:test';
import { shutdownRuntime } from '../packages/sdk/src/platform/runtime/lifecycle.js';

describe('runtime shutdown lifecycle', () => {
  test('continues cleanup after session persistence fails and then reports the failure', async () => {
    const calls: string[] = [];

    await expect(shutdownRuntime(
      'session-1',
      { messages: [{ role: 'user', content: 'hello' }] },
      'model',
      'provider',
      'Title',
      { destroy: () => calls.push('scheduler') } as never,
      { fire: async () => ({ ok: true }) },
      { stopWatching: () => calls.push('provider') } as never,
      { dispose: () => calls.push('orchestration') } as never,
      {
        sessionManager: {
          save: () => {
            calls.push('save');
            throw new Error('session store unavailable');
          },
        } as never,
      },
    )).rejects.toThrow('failed to persist session');

    expect(calls).toEqual(['save', 'scheduler', 'provider', 'orchestration']);
  });
});
