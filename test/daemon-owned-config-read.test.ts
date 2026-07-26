/**
 * daemon-owned-config-read.test.ts
 *
 * Correct write routing with wrong read routing is still a system that lies.
 * The live failure: a daemon-owned setting was written, the user asked a client
 * to confirm it, the client read its OWN store, saw a blank, and reported the
 * setting as not set.
 *
 * Reads therefore follow ownership exactly as writes do, and an unreachable
 * daemon produces `unavailable` — never a default dressed up as the current
 * value.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { DaemonConfigUnreachableError } from '../packages/sdk/src/platform/config/daemon-config-route.js';
import {
  readConfigValue,
  readEffectiveConfig,
  resolveConfigReadRoute,
} from '../packages/sdk/src/platform/config/daemon-config-read.js';

const roots: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-daemon-read-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const runningDaemon = { host: '127.0.0.1', port: 3421 };

function daemonAnswers(config: Record<string, unknown>): typeof fetch {
  return (async () => new Response(JSON.stringify(config), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

const daemonDown = (async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:3421');
}) as unknown as typeof fetch;

describe('reads route by ownership', () => {
  test('a daemon-owned key reads the daemon LIVE value, not the local default', async () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    // The agent's own resolution has never seen this value.
    expect(agent.get('surfaces.telegram.botUsername')).toBe('');

    const entry = await readConfigValue('surfaces.telegram.botUsername', agent, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: daemonAnswers({ surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } }),
    });

    expect(entry.source).toBe('daemon');
    expect(entry.status).toBe('ok');
    expect(entry.value).toBe('goodvibes_agent_bot');
    expect(entry.store).toBe('http://127.0.0.1:3421');
  });

  test('a client-owned key reads locally even while the daemon is up', async () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('display.theme', 'nord');

    const entry = await readConfigValue('display.theme', agent, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => {
        throw new Error('a client-owned read must never call the daemon');
      }) as unknown as typeof fetch,
    });
    expect(entry.source).toBe('local');
    expect(entry.value).toBe('nord');
    expect(entry.store).toBe(agent.getConfigPath());
  });

  test('the daemon process itself reads its own store', () => {
    const route = resolveConfigReadRoute('surfaces.telegram.botUsername', {
      hostsDaemon: true,
      daemonHomeDir: '/tmp/irrelevant',
      readRuntimeRecord: () => runningDaemon,
    });
    expect(route.mode).toBe('local');
  });

  test('with no daemon running, a daemon-owned key reads the local daemon store', async () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('surfaces.telegram.botUsername', 'written_offline');

    const entry = await readConfigValue('surfaces.telegram.botUsername', agent, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => null,
    });
    expect(entry.source).toBe('local');
    expect(entry.value).toBe('written_offline');
    expect(entry.store).toBe(agent.getDaemonTierPath());
  });

  test('an unreachable daemon throws rather than answering with a default', async () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const attempt = readConfigValue('surfaces.telegram.botUsername', agent, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: daemonDown,
    });
    await expect(attempt).rejects.toBeInstanceOf(DaemonConfigUnreachableError);
  });
});

describe('the effective merged listing names the store per key', () => {
  const keys = [
    'surfaces.telegram.botUsername',
    'surfaces.telegram.defaultChatId',
    'display.theme',
    'provider.model',
  ];

  test('one daemon round-trip serves every daemon-owned key', async () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('display.theme', 'nord');
    let calls = 0;

    const entries = await readEffectiveConfig(keys, agent, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ surfaces: { telegram: { botUsername: 'goodvibes_agent_bot', defaultChatId: '8546431428' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    expect(calls).toBe(1);
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get('surfaces.telegram.botUsername')).toMatchObject({
      source: 'daemon', status: 'ok', value: 'goodvibes_agent_bot', scope: 'daemon',
    });
    expect(byKey.get('surfaces.telegram.defaultChatId')?.value).toBe('8546431428');
    expect(byKey.get('display.theme')).toMatchObject({ source: 'local', value: 'nord', scope: 'client' });
    expect(byKey.get('provider.model')?.scope).toBe('user');
    // Every entry names the store it came from — the missing explanation for
    // why one key read blank in one place and set in another.
    for (const entry of entries) expect(entry.store.length).toBeGreaterThan(0);
  });

  test('an unreachable daemon marks those keys unavailable and carries no value', async () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('display.theme', 'nord');

    const entries = await readEffectiveConfig(keys, agent, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: daemonDown,
    });
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));

    const telegram = byKey.get('surfaces.telegram.botUsername')!;
    expect(telegram.status).toBe('unavailable');
    expect('value' in telegram).toBe(false);
    expect(telegram.error).toContain('could not be reached');

    // Client-owned keys are unaffected — they were never the daemon's to answer.
    expect(byKey.get('display.theme')).toMatchObject({ status: 'ok', value: 'nord' });
  });
});
