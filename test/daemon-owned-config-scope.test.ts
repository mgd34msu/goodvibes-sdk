/**
 * daemon-owned-config-scope.test.ts
 *
 * The bug this covers: a daemon-owned setting written from a non-daemon client
 * (the agent) reported SUCCESS, landed in `~/.goodvibes/agent/settings.json`,
 * and configured nothing, the daemon reads a different file. Telegram runs in
 * the daemon, so the owner's bot username, bot token and chat id were set and
 * had no effect.
 *
 * What must now hold:
 *   - a daemon-owned key set from ANY surface lands in the daemon's own store,
 *     and a config manager rooted at a different surface reads it back;
 *   - a client-owned key stays in that client's surface silo, unchanged;
 *   - when a daemon is running and cannot be reached, the write FAILS loudly
 *     and writes nothing locally.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import {
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  configKeyScope,
  isClientOwnedConfigKey,
  isDaemonOwnedConfigKey,
  listDaemonOwnedConfigPaths,
} from '../packages/sdk/src/platform/config/config-ownership.js';
import {
  DaemonConfigRejectedError,
  DaemonConfigUnreachableError,
  applyConfigWrite,
  resolveConfigWriteRoute,
} from '../packages/sdk/src/platform/config/daemon-config-route.js';
import {
  deriveControlPlaneBaseUrl,
  describeBaseUrlDrift,
} from '../packages/sdk/src/platform/config/control-plane-base-url.js';

const roots: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-daemon-scope-'));
  roots.push(dir);
  return dir;
}
function surfaceSettings(h: string, surface: string): string {
  return join(h, '.goodvibes', surface, 'settings.json');
}
function daemonSettings(h: string): string {
  return join(h, '.goodvibes', 'daemon', 'settings.json');
}
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('config ownership classification', () => {
  test('everything the daemon executes unattended is daemon-owned', () => {
    for (const key of [
      'surfaces.telegram.botUsername',
      'surfaces.telegram.defaultChatId',
      'surfaces.slack.botToken',
      'controlPlane.hostMode',
      'controlPlane.port',
      'watchers.triggers.enabled',
      'device.grants.expiryDays',
      'device.nodes.maxPaired',
      'atRest.retentionMaxAgeDays',
      'voice.local.ttsBinary',
      'danger.httpListener',
    ]) {
      expect(isDaemonOwnedConfigKey(key)).toBe(true);
      expect(configKeyScope(key)).toBe('daemon');
    }
  });

  test('presentation and per-installation lifecycle stay client-owned', () => {
    for (const key of [
      'display.theme',
      'display.showThinking',
      'ui.systemMessages',
      'behavior.hitlMode',
      // These decide whether THIS installation runs a daemon at all. If the
      // daemon owned them, the agent would start a daemon because the TUI does.
      'daemon.enabled',
      'service.enabled',
      'voice.wake.enabled',
    ]) {
      expect(isDaemonOwnedConfigKey(key)).toBe(false);
      expect(isClientOwnedConfigKey(key)).toBe(true);
    }
  });

  test('cross-client defaults are user-level', () => {
    expect(configKeyScope('tts.voice')).toBe('user');
    expect(configKeyScope('provider.model')).toBe('user');
    expect(configKeyScope('provider.reasoningEffort')).toBe('user');
  });
});

describe('daemon-owned keys have exactly one home', () => {
  test('a value set from the agent surface lands in the daemon store, not the agent silo', () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });

    agent.set('surfaces.telegram.botUsername', 'goodvibes_agent_bot');

    // It is in the daemon store...
    expect(existsSync(daemonSettings(h))).toBe(true);
    const store = readJson(daemonSettings(h));
    expect((store['surfaces'] as Record<string, Record<string, unknown>>)['telegram']!['botUsername'])
      .toBe('goodvibes_agent_bot');

    // ...and NOT in the agent's own settings file, which is what made the
    // original write a no-op for the runtime that actually uses the value.
    const agentRaw = existsSync(surfaceSettings(h, 'agent')) ? readJson(surfaceSettings(h, 'agent')) : {};
    expect(agentRaw['surfaces']).toBeUndefined();
  });

  test('the daemon (a different surface root, same home) reads it back', () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('surfaces.telegram.defaultChatId', '8546431428');

    const daemon = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    expect(daemon.get('surfaces.telegram.defaultChatId')).toBe('8546431428');
    expect(daemon.describeConfigKeySource('surfaces.telegram.defaultChatId').tier).toBe('daemon');
  });

  test('a leftover surface-local value cannot shadow the daemon store', () => {
    const h = home();
    mkdirSync(join(h, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(
      surfaceSettings(h, 'tui'),
      JSON.stringify({ surfaces: { telegram: { botUsername: 'stale_bot' } } }, null, 2),
      'utf-8',
    );
    mkdirSync(join(h, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(
      daemonSettings(h),
      JSON.stringify({ surfaces: { telegram: { botUsername: 'real_bot' } } }, null, 2),
      'utf-8',
    );

    const daemon = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    expect(daemon.get('surfaces.telegram.botUsername')).toBe('real_bot');
  });

  test('a client-owned key stays in the client surface silo', () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('display.theme', 'nord');

    expect(readJson(surfaceSettings(h, 'agent'))['display']).toEqual({ theme: 'nord' });
    // A different surface must NOT see it, presentation is genuinely local.
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    expect(tui.get('display.theme')).not.toBe('nord');
    // And the daemon store stays out of it entirely.
    expect(existsSync(daemonSettings(h))).toBe(false);
  });

  test('reset clears the daemon store, not just the in-memory value', () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('surfaces.telegram.botUsername', 'temp_bot');
    agent.reset('surfaces.telegram.botUsername');

    const reloaded = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    expect(reloaded.get('surfaces.telegram.botUsername')).toBe('');
  });

  test('a whole-config save never re-seeds daemon-owned keys into a surface file', () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.set('surfaces.telegram.botUsername', 'goodvibes_agent_bot');
    agent.set('display.theme', 'nord');
    agent.save();

    const raw = readJson(surfaceSettings(h, 'agent'));
    expect(raw['surfaces']).toBeUndefined();
    expect(raw['display']).toEqual({ theme: 'nord' });
  });

  test('a category patch on a daemon-owned domain goes to the daemon store', () => {
    const h = home();
    const agent = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    agent.mergeCategory('watchers', { enabled: true, pollIntervalMs: 12_345 });

    const store = readJson(daemonSettings(h));
    expect(store['watchers']).toEqual({ enabled: true, pollIntervalMs: 12_345 });
    const agentRaw = existsSync(surfaceSettings(h, 'agent')) ? readJson(surfaceSettings(h, 'agent')) : {};
    expect(agentRaw['watchers']).toBeUndefined();
  });
});

describe('routing decides by ownership, and unreachable is a failure', () => {
  const runningDaemon = { host: '127.0.0.1', port: 3421 };

  test('client-owned keys route local even while a daemon is running', () => {
    const route = resolveConfigWriteRoute('display.theme', {
      hostsDaemon: false,
      daemonHomeDir: '/tmp/does-not-matter',
      readRuntimeRecord: () => runningDaemon,
    });
    expect(route.mode).toBe('local');
    expect(route.scope).toBe('client');
  });

  test('daemon-owned keys route to the running daemon', () => {
    const route = resolveConfigWriteRoute('surfaces.telegram.botUsername', {
      hostsDaemon: false,
      daemonHomeDir: '/tmp/does-not-matter',
      readRuntimeRecord: () => runningDaemon,
    });
    expect(route.mode).toBe('daemon');
    if (route.mode !== 'daemon') throw new Error('unreachable');
    expect(route.endpoint.baseUrl).toBe('http://127.0.0.1:3421');
  });

  test('the daemon process itself writes locally — it IS the owning runtime', () => {
    const route = resolveConfigWriteRoute('surfaces.telegram.botUsername', {
      hostsDaemon: true,
      daemonHomeDir: '/tmp/does-not-matter',
      readRuntimeRecord: () => runningDaemon,
    });
    expect(route.mode).toBe('local');
  });

  test('with no daemon running, the daemon store is written directly', () => {
    const route = resolveConfigWriteRoute('surfaces.telegram.botUsername', {
      hostsDaemon: false,
      daemonHomeDir: '/tmp/does-not-matter',
      readRuntimeRecord: () => null,
    });
    expect(route.mode).toBe('local');
    expect(route.reason).toContain('no daemon is running');
  });

  test('a reachable daemon applies the write and reports the daemon store path', async () => {
    const h = home();
    const local = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const seen: { key?: string; value?: unknown; auth?: string | null } = {};
    const outcome = await applyConfigWrite(
      'surfaces.telegram.botUsername',
      'goodvibes_agent_bot',
      local,
      {
        hostsDaemon: false,
        daemonHomeDir: h,
        token: 'operator-token',
        readRuntimeRecord: () => runningDaemon,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          seen.key = body['key'] as string;
          seen.value = body['value'];
          seen.auth = (init.headers as Record<string, string>)['authorization'] ?? null;
          return new Response(
            JSON.stringify({ success: true, key: body['key'], value: body['value'], persistedTo: '/daemon/settings.json' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as unknown as typeof fetch,
      },
    );

    expect(seen.key).toBe('surfaces.telegram.botUsername');
    expect(seen.value).toBe('goodvibes_agent_bot');
    expect(seen.auth).toBe('Bearer operator-token');
    expect(outcome.appliedBy).toBe('daemon');
    expect(outcome.persistedTo).toBe('/daemon/settings.json');
    // Nothing was written locally: the daemon holds the value.
    expect(existsSync(daemonSettings(h))).toBe(false);
  });

  test('an UNREACHABLE daemon fails loudly and writes nothing locally', async () => {
    const h = home();
    const local = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });

    const attempt = applyConfigWrite('surfaces.telegram.botUsername', 'goodvibes_agent_bot', local, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3421');
      }) as unknown as typeof fetch,
    });

    await expect(attempt).rejects.toBeInstanceOf(DaemonConfigUnreachableError);
    await attempt.catch((error: unknown) => {
      const message = (error as Error).message;
      expect(message).toContain('was NOT applied');
      expect(message).toContain('ECONNREFUSED');
    });

    // The critical part: no consolation write. Reporting "saved" for a value
    // the daemon never received is the failure mode being removed.
    expect(existsSync(daemonSettings(h))).toBe(false);
    expect(existsSync(surfaceSettings(h, 'agent'))).toBe(false);
  });

  test('a daemon that refuses the write is a failure, not a success', async () => {
    const h = home();
    const local = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const attempt = applyConfigWrite('surfaces.telegram.botUsername', 'x', local, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => new Response('{"error":"Unauthorized"}', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(attempt).rejects.toBeInstanceOf(DaemonConfigRejectedError);
    expect(existsSync(daemonSettings(h))).toBe(false);
  });

  test('a client-owned write still succeeds while the daemon is down', async () => {
    const h = home();
    const local = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const outcome = await applyConfigWrite('display.theme', 'nord', local, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => {
        throw new Error('should never be called for a client-owned key');
      }) as unknown as typeof fetch,
    });
    expect(outcome.appliedBy).toBe('local');
    expect(outcome.scope).toBe('client');
    expect(readJson(surfaceSettings(h, 'agent'))['display']).toEqual({ theme: 'nord' });
  });
});

describe('a daemon KNOWN to be there vs an address merely derived from config', () => {
  const binding = { hostMode: 'local', host: '127.0.0.1', port: 3599, tlsMode: 'off' };
  const down = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;

  test('a derived address is probed, and nothing answering means no daemon is running', async () => {
    const h = home();
    const local = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const outcome = await applyConfigWrite('surfaces.telegram.defaultChatId', '999', local, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => null,
      readDaemonBinding: () => binding,
      fetchImpl: down,
    });
    // Writing the store the daemon reads at startup is CORRECT here: there is
    // no runtime to be unreachable. The reason says exactly that.
    expect(outcome.appliedBy).toBe('local');
    expect(outcome.reason).toContain('no daemon answered at http://127.0.0.1:3599');
    expect(readJson(daemonSettings(h))).toEqual({ surfaces: { telegram: { defaultChatId: '999' } } });
  });

  test('a KNOWN daemon that does not answer is a failure, never a local write', async () => {
    const h = home();
    const local = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    await expect(applyConfigWrite('surfaces.telegram.defaultChatId', '999', local, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => ({ host: '127.0.0.1', port: 3599 }),
      readDaemonBinding: () => binding,
      fetchImpl: down,
    })).rejects.toBeInstanceOf(DaemonConfigUnreachableError);
    expect(existsSync(daemonSettings(h))).toBe(false);
  });

  test('a live daemon with no runtime record is still found through its binding', async () => {
    const h = home();
    const local = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const outcome = await applyConfigWrite('surfaces.telegram.defaultChatId', '999', local, {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => null,
      readDaemonBinding: () => binding,
      fetchImpl: (async (_url: string, init?: RequestInit) => new Response(
        JSON.stringify({ success: true, key: 'surfaces.telegram.defaultChatId', value: '999', persistedTo: '/d/settings.json' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    });
    // A foreground daemon writes no detached-daemon record. Before the binding
    // fallback existed it looked absent, and daemon-owned writes went to the
    // local file while it was live, the exact divergence this change removes.
    expect(outcome.appliedBy).toBe('daemon');
    expect(existsSync(daemonSettings(h))).toBe(false);
  });
});

describe('the control-plane base URL is derived, never a stored mirror', () => {
  test('a wildcard network bind dials loopback, and TLS selects https', () => {
    expect(deriveControlPlaneBaseUrl({ hostMode: 'network', host: '0.0.0.0', port: 3421, tlsMode: 'off' }))
      .toBe('http://127.0.0.1:3421');
    expect(deriveControlPlaneBaseUrl({ hostMode: 'network', host: '0.0.0.0', port: 8443, tlsMode: 'on' }))
      .toBe('https://127.0.0.1:8443');
    expect(deriveControlPlaneBaseUrl({ hostMode: 'custom', host: 'box.lan', port: 3421, tlsMode: 'off' }))
      .toBe('http://box.lan:3421');
  });

  test('a declared external address is honored only for the external audience', () => {
    const binding = { hostMode: 'local', host: '127.0.0.1', port: 3421, tlsMode: 'off', publicBaseUrl: 'https://tunnel.example' };
    expect(deriveControlPlaneBaseUrl(binding, 'external')).toBe('https://tunnel.example');
    expect(deriveControlPlaneBaseUrl(binding, 'loopback')).toBe('http://127.0.0.1:3421');
  });

  test('drift against a stored URL is reported, not tolerated', () => {
    // The owner's exact broken state: bind values changed, stored URL did not.
    const drift = describeBaseUrlDrift('http://127.0.0.1:3421', {
      hostMode: 'network', host: '0.0.0.0', port: 8443, tlsMode: 'on',
    });
    expect(drift).toContain('https://127.0.0.1:8443');
    expect(describeBaseUrlDrift('http://127.0.0.1:3421', {
      hostMode: 'local', host: '127.0.0.1', port: 3421, tlsMode: 'off',
    })).toBeNull();
  });
});

describe('one answer about who owns a path', () => {
  test('every non-schema daemon path is daemon-owned by the predicate too', () => {
    // These two answers used to be able to disagree, and when they did the key
    // was stored NOWHERE: the manager routes daemon-owned keys to the daemon
    // tier and everything else to the surface tier, so a path the walk called
    // daemon-owned and the predicate called client-owned was accepted, reported
    // as saved, and written to neither file. It reached a password reference
    // before anything caught it.
    for (const path of DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS) {
      expect(isDaemonOwnedConfigKey(path)).toBe(true);
      expect(isClientOwnedConfigKey(path)).toBe(false);
      expect(configKeyScope(path)).toBe('daemon');
    }
  });

  test('the owned-path walk and the predicate describe the same set', () => {
    for (const path of listDaemonOwnedConfigPaths()) {
      expect(isDaemonOwnedConfigKey(path)).toBe(true);
    }
  });
});
