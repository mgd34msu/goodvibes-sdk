/**
 * telegram-bot-identity.test.ts — the bot's handle comes from its token.
 *
 * `surfaces.telegram.botUsername` being blank never meant "this bot has no
 * username"; it meant nobody typed one in. Telegram's getMe returns the handle,
 * the id and the display name for any valid token, so the daemon asks instead of
 * degrading: without a handle, @mentions in groups are not recognised,
 * `/goodvibes@thebot` is not stripped, and a `/start@someotherbot` in a shared
 * group is answered as if it were ours.
 *
 * What is pinned here: discovery from the token, the cache keyed to the bot id,
 * re-discovery when the token rotates, an explicit config value winning, and a
 * getMe failure never blocking ingress.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramIngressSupervisor } from '../packages/sdk/src/platform/channels/telegram/ingress.ts';
import { TelegramBotApi } from '../packages/sdk/src/platform/channels/telegram/api.ts';

interface ApiCall { readonly method: string; }

/** A Bot API stand-in: records calls, answers getMe from a script. */
class FakeTelegram {
  readonly calls: ApiCall[] = [];
  getMeResult: Record<string, unknown> | null = { id: 123456, username: 'goodvibes_bot', first_name: 'GoodVibes' };
  getMeFails = false;

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = input.split('/').pop() ?? '';
    this.calls.push({ method });
    if (method === 'getMe') {
      if (this.getMeFails) {
        return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, result: this.getMeResult }), { status: 200 });
    }
    if (method === 'getUpdates') {
      const signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
}

interface Harness {
  readonly supervisor: TelegramIngressSupervisor;
  readonly telegram: FakeTelegram;
  readonly config: Record<string, unknown>;
  readonly writes: Array<{ key: string; value: unknown }>;
  cleanup(): Promise<void>;
}

function makeHarness(configOverrides: Record<string, unknown> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gv-tg-identity-'));
  const telegram = new FakeTelegram();
  const writes: Array<{ key: string; value: unknown }> = [];
  const config: Record<string, unknown> = {
    'surfaces.telegram.enabled': true,
    'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123456:test-token',
    'surfaces.telegram.botUsername': '',
    'web.publicBaseUrl': 'https://daemon.example.com',
    ...configOverrides,
  };

  const supervisor = new TelegramIngressSupervisor({
    configManager: {
      get: (key: string) => config[key],
      set: (key: string, value: unknown) => {
        writes.push({ key, value });
        config[key] = value;
      },
    } as never,
    secretsManager: { get: () => null, getGlobalHome: () => undefined } as never,
    serviceRegistry: { resolveSecret: async () => null } as never,
    offsetFilePath: join(dir, 'telegram-offset.json'),
    createApi: (token) => new TelegramBotApi(token, telegram.fetch),
    buildSurfaceAdapterContext: () => ({
      serviceRegistry: { resolveSecret: async () => null },
      configManager: { get: (key: string) => config[key] },
      routeBindings: { upsertBinding: async () => ({ id: 'binding-1' }) },
      sessionBroker: { submitMessage: async () => ({ mode: 'spawn' }), bindAgent: async () => {} },
      authorizeSurfaceIngress: async () => ({ allowed: true }),
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      trySpawnAgent: () => ({ id: 'agent-1' }),
      queueSurfaceReplyFromBinding: () => {},
    }) as never,
  });

  return {
    supervisor,
    telegram,
    config,
    writes,
    async cleanup(): Promise<void> {
      await supervisor.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('telegram bot identity is discovered from the token', () => {
  test('a blank botUsername is filled from getMe and cached against the bot id', async () => {
    const h = makeHarness();
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('polling');

      expect(h.telegram.countOf('getMe')).toBe(1);
      expect(h.supervisor.identity).toEqual({ id: '123456', username: 'goodvibes_bot', displayName: 'GoodVibes' });
      // The handle is written back, and so is the token id it belongs to —
      // that pairing is what makes a rotation detectable later.
      expect(h.writes).toContainEqual({ key: 'surfaces.telegram.botUsername', value: 'goodvibes_bot' });
      expect(h.writes).toContainEqual({ key: 'surfaces.telegram.discoveredBotTokenId', value: '123456' });
    } finally {
      await h.cleanup();
    }
  });

  test('a cached handle for the SAME token is reused without asking Telegram again', async () => {
    const h = makeHarness({
      'surfaces.telegram.botUsername': 'goodvibes_bot',
      'surfaces.telegram.discoveredBotTokenId': '123456',
    });
    try {
      await h.supervisor.start();
      expect(h.telegram.countOf('getMe')).toBe(0);
      expect(h.supervisor.identity?.username).toBe('goodvibes_bot');
    } finally {
      await h.cleanup();
    }
  });

  test('rotating the token re-discovers rather than serving the previous bot handle', async () => {
    // The handle on file belongs to bot 111111; the configured token is bot
    // 999999. Serving the cached handle would run a new bot under the old bot's
    // identity, which is how two bots collide on the surfaceId 'telegram'.
    const h = makeHarness({
      'surfaces.telegram.botToken': '999999:rotated-token',
      'surfaces.telegram.botUsername': 'old_bot',
      'surfaces.telegram.discoveredBotTokenId': '111111',
    });
    h.telegram.getMeResult = { id: 999999, username: 'new_bot', first_name: 'New' };
    try {
      await h.supervisor.start();
      expect(h.telegram.countOf('getMe')).toBe(1);
      expect(h.supervisor.identity?.username).toBe('new_bot');
      expect(h.config['surfaces.telegram.discoveredBotTokenId']).toBe('999999');
    } finally {
      await h.cleanup();
    }
  });

  test('an explicitly configured handle wins over discovery and is never overwritten', async () => {
    const h = makeHarness({ 'surfaces.telegram.botUsername': '@operator_choice' });
    h.telegram.getMeResult = { id: 123456, username: 'discovered_bot', first_name: 'Discovered' };
    try {
      await h.supervisor.start();
      // Honoured as-is (minus the leading @), and getMe is not consulted to
      // second-guess it.
      expect(h.supervisor.identity?.username).toBe('operator_choice');
      expect(h.telegram.countOf('getMe')).toBe(0);
      expect(h.writes.some((write) => write.key === 'surfaces.telegram.botUsername')).toBe(false);
      // The token it belongs to is still recorded, so a later rotation is seen.
      expect(h.writes).toContainEqual({ key: 'surfaces.telegram.discoveredBotTokenId', value: '123456' });
    } finally {
      await h.cleanup();
    }
  });

  test('a getMe failure degrades the handle but never blocks ingress', async () => {
    const h = makeHarness();
    h.telegram.getMeFails = true;
    try {
      const status = await h.supervisor.start();
      // Receiving messages matters more than perfect mention matching.
      expect(status.mode).toBe('polling');
      expect(status.running).toBe(true);
      expect(h.supervisor.identity).toBeNull();
      expect(h.writes.some((write) => write.key === 'surfaces.telegram.botUsername')).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test('getMe returning no username is not cached as if it were an answer', async () => {
    const h = makeHarness();
    h.telegram.getMeResult = { id: 123456, first_name: 'Handleless' };
    try {
      await h.supervisor.start();
      expect(h.supervisor.identity).toBeNull();
      expect(h.writes.some((write) => write.key === 'surfaces.telegram.botUsername')).toBe(false);
      expect(h.writes.some((write) => write.key === 'surfaces.telegram.discoveredBotTokenId')).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});

describe('TelegramBotApi.getMe', () => {
  test('normalizes the handle and falls back to the token id when Telegram omits one', async () => {
    const telegram = new FakeTelegram();
    telegram.getMeResult = { username: '@spaced_bot  ', first_name: 'Bot' };
    const api = new TelegramBotApi('777777:token', telegram.fetch);
    const identity = await api.getMe();
    expect(identity.username).toBe('spaced_bot');
    expect(identity.id).toBe('777777');
    expect(identity.displayName).toBe('Bot');
  });
});
