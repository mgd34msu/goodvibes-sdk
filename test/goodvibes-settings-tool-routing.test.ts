/**
 * goodvibes-settings-tool-routing.test.ts
 *
 * The night this covers: the owner said "telegram bot id is goodvibes_agent_bot".
 * Nothing was written. When he later asked the agent to confirm the value, the
 * agent read its own store, found nothing, and told him it was not set.
 *
 * Two halves, and both have to hold or the system still reports fiction:
 *   - a stated value results in a WRITE that lands in the store the consuming
 *     runtime reads, and the report names that store (`persistedTo`);
 *   - a READ of that same key comes back from the runtime that owns it, labelled
 *     with where it came from — and when the owner runtime cannot be reached,
 *     that is said out loud rather than answered with a local default.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import {
  createGoodVibesSettingsTool,
  GOODVIBES_RUNTIME_AWARENESS_PROMPT,
} from '../packages/sdk/src/platform/tools/goodvibes-runtime/index.js';
import {
  readRoutedConfigValue,
  readRoutedConfigValues,
} from '../packages/sdk/src/platform/tools/goodvibes-runtime/config-routing.js';

const roots: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-settings-routing-'));
  roots.push(dir);
  return dir;
}
function daemonSettings(h: string): string {
  return join(h, '.goodvibes', 'daemon', 'settings.json');
}
function surfaceSettings(h: string, surface: string): string {
  return join(h, '.goodvibes', surface, 'settings.json');
}
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}
function parseOutput(result: { output?: string | undefined }): Record<string, unknown> {
  return JSON.parse(result.output ?? '{}') as Record<string, unknown>;
}

const runningDaemon = { host: '127.0.0.1', port: 3421 };

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('a stated configuration value results in a write plus a read-back report', () => {
  test('setting the Telegram bot username lands in the DAEMON store and says so', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const tool = createGoodVibesSettingsTool({
      configManager,
      configRouting: { hostsDaemon: false, daemonHomeDir: h, readRuntimeRecord: () => null },
    });

    const result = await tool.execute({
      mode: 'set',
      key: 'surfaces.telegram.botUsername',
      value: 'goodvibes_agent_bot',
      confirm: true,
    });

    expect(result.success).toBe(true);
    const output = parseOutput(result);
    expect(output['current']).toBe('goodvibes_agent_bot');
    expect(output['owner']).toBe('daemon');
    // The whole point: the path named back to the user is the daemon's store,
    // which is what Telegram actually reads — not the agent's surface silo.
    expect(output['persistedTo']).toBe(daemonSettings(h));
    expect(output['verifiedInOwningStore']).toBe(true);
    expect(String(output['ownership'])).toContain('daemon-owned');

    // And it is genuinely there, not merely reported.
    const stored = readJson(daemonSettings(h))['surfaces'] as Record<string, unknown>;
    expect((stored['telegram'] as Record<string, unknown>)['botUsername']).toBe('goodvibes_agent_bot');
    expect(existsSync(surfaceSettings(h, 'agent'))).toBe(false);
  });

  test('reading it back through the agent returns the daemon value, labelled with the daemon store', async () => {
    const h = home();
    const writer = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    await createGoodVibesSettingsTool({
      configManager: writer,
      configRouting: { hostsDaemon: false, daemonHomeDir: h, readRuntimeRecord: () => null },
    }).execute({ mode: 'set', key: 'surfaces.telegram.botUsername', value: 'goodvibes_agent_bot', confirm: true });

    // A DIFFERENT surface, as if the agent restarted or another client asked.
    const reader = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const read = await readRoutedConfigValue(reader, 'surfaces.telegram.botUsername', {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => null,
    });

    expect(read.available).toBe(true);
    if (!read.available) throw new Error('unreachable');
    expect(read.value).toBe('goodvibes_agent_bot');
    expect(read.scope).toBe('daemon');
    expect(read.source).toBe(daemonSettings(h));
  });

  test('an agent-owned key still writes and reads locally', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const routing = { hostsDaemon: false, daemonHomeDir: h, readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => { throw new Error('a client-owned key must never call the daemon'); }) as unknown as typeof fetch };

    const result = await createGoodVibesSettingsTool({ configManager, configRouting: routing })
      .execute({ mode: 'set', key: 'display.theme', value: 'nord', confirm: true });

    expect(result.success).toBe(true);
    const output = parseOutput(result);
    expect(output['owner']).toBe('client');
    expect(output['persistedTo']).toBe(surfaceSettings(h, 'agent'));

    const read = await readRoutedConfigValue(configManager, 'display.theme', routing);
    expect(read.available).toBe(true);
    if (!read.available) throw new Error('unreachable');
    expect(read.value).toBe('nord');
    expect(read.scope).toBe('client');
    expect(read.source).toBe(surfaceSettings(h, 'agent'));
  });
});

describe('a running daemon owns its keys in both directions', () => {
  test('the write goes to the daemon and the report names the daemon, not a local file', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    let posted: Record<string, unknown> | null = null;

    const result = await createGoodVibesSettingsTool({
      configManager,
      configRouting: {
        hostsDaemon: false,
        daemonHomeDir: h,
        readRuntimeRecord: () => runningDaemon,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          posted = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ value: posted['value'], persistedTo: '/daemon/settings.json' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as unknown as typeof fetch,
      },
    }).execute({ mode: 'set', key: 'surfaces.telegram.defaultChatId', value: '12345', confirm: true });

    expect(result.success).toBe(true);
    // `posted` is reassigned inside the `fetchImpl` closure above, which TS's
    // control-flow analysis can't see across the `await` — its narrowed type
    // here is stuck at the initializer (`null`). Assert non-null, then read it
    // through its declared type rather than the falsely-narrowed one.
    expect(posted).not.toBeNull();
    expect(posted as unknown as Record<string, unknown>).toEqual({ key: 'surfaces.telegram.defaultChatId', value: '12345' });
    const output = parseOutput(result);
    expect(output['appliedBy']).toBe('daemon');
    expect(output['persistedTo']).toBe('/daemon/settings.json');
    expect(existsSync(daemonSettings(h))).toBe(false);
  });

  test('the read comes back live from the daemon', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const read = await readRoutedConfigValue(configManager, 'surfaces.telegram.botUsername', {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => new Response(
        JSON.stringify({ surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    });

    expect(read.available).toBe(true);
    if (!read.available) throw new Error('unreachable');
    expect(read.value).toBe('goodvibes_agent_bot');
    expect(read.readFrom).toBe('daemon');
    expect(read.source).toBe('http://127.0.0.1:3421');
  });

  test('an unreachable daemon is reported as unavailable, never as a default', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const read = await readRoutedConfigValue(configManager, 'surfaces.telegram.botUsername', {
      hostsDaemon: false,
      daemonHomeDir: h,
      readRuntimeRecord: () => runningDaemon,
      fetchImpl: (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3421'); }) as unknown as typeof fetch,
    });

    expect(read.available).toBe(false);
    if (read.available) throw new Error('unreachable');
    expect(read.reason).toContain('could not be read');
    expect(read.reason).toContain('ECONNREFUSED');
    // The failure this replaces: answering "" and letting the caller say "not set".
    expect(read).not.toHaveProperty('value');
  });

  test('the merged list keeps daemon rows and client rows apart and labels both', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    configManager.setDynamic('display.theme', 'nord');

    const reads = await readRoutedConfigValues(
      configManager,
      ['surfaces.telegram.botUsername', 'display.theme'],
      {
        hostsDaemon: false,
        daemonHomeDir: h,
        readRuntimeRecord: () => runningDaemon,
        fetchImpl: (async () => new Response(
          JSON.stringify({ surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
      },
    );

    const [telegram, theme] = reads;
    expect(telegram!.available).toBe(true);
    expect(telegram!.scope).toBe('daemon');
    expect(telegram!.source).toBe('http://127.0.0.1:3421');
    expect(theme!.available).toBe(true);
    expect(theme!.scope).toBe('client');
    expect(theme!.source).toBe(surfaceSettings(h, 'agent'));
    if (theme!.available) expect(theme!.value).toBe('nord');
  });
});

describe('a write that did not land is a failure, not a success', () => {
  test('a daemon that echoes a different value is refused rather than reported as set', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const result = await createGoodVibesSettingsTool({
      configManager,
      configRouting: {
        hostsDaemon: false,
        daemonHomeDir: h,
        readRuntimeRecord: () => runningDaemon,
        fetchImpl: (async () => new Response(
          JSON.stringify({ value: 'something_else' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
      },
    }).execute({ mode: 'set', key: 'surfaces.telegram.botUsername', value: 'goodvibes_agent_bot', confirm: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('is NOT applied');
  });

  test('an unreachable daemon fails the write loudly and writes nothing locally', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const result = await createGoodVibesSettingsTool({
      configManager,
      configRouting: {
        hostsDaemon: false,
        daemonHomeDir: h,
        readRuntimeRecord: () => runningDaemon,
        fetchImpl: (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3421'); }) as unknown as typeof fetch,
      },
    }).execute({ mode: 'set', key: 'surfaces.telegram.botUsername', value: 'goodvibes_agent_bot', confirm: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('was NOT applied');
    expect(existsSync(daemonSettings(h))).toBe(false);
    expect(existsSync(surfaceSettings(h, 'agent'))).toBe(false);
  });

  test('a raw credential is still refused, and names the reference that would work', async () => {
    const h = home();
    const configManager = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    const result = await createGoodVibesSettingsTool({
      configManager,
      configRouting: { hostsDaemon: false, daemonHomeDir: h, readRuntimeRecord: () => null },
    }).execute({ mode: 'set', key: 'surfaces.telegram.botToken', value: '123456:AAH-raw-token', confirm: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('goodvibes://');
  });
});

describe('the instruction that made a stated value read as trivia is gone', () => {
  test('the awareness prompt tells the model to apply a supplied value and report where it landed', () => {
    expect(GOODVIBES_RUNTIME_AWARENESS_PROMPT).not.toContain('only when the user explicitly asks you to change a setting');
    expect(GOODVIBES_RUNTIME_AWARENESS_PROMPT).toContain('is a request to set it');
    expect(GOODVIBES_RUNTIME_AWARENESS_PROMPT).toContain('persistedTo');
    expect(GOODVIBES_RUNTIME_AWARENESS_PROMPT).toContain('only repeated back in prose is not set');
    // The other half: no over-correction into writing config nobody asked for.
    expect(GOODVIBES_RUNTIME_AWARENESS_PROMPT).toContain('ask one short question');
    expect(GOODVIBES_RUNTIME_AWARENESS_PROMPT).toContain('never write config the user did not ask for');
    // And the read side: unreachable is not the same as unset.
    expect(GOODVIBES_RUNTIME_AWARENESS_PROMPT).toContain('unavailable, not unset');
  });

  test('the tool description says a value only mentioned in prose has not been set', () => {
    const tool = createGoodVibesSettingsTool({ configManager: new ConfigManager({ homeDir: home(), surfaceRoot: 'agent' }) });
    expect(tool.definition.description).toContain('has not been set');
    expect(tool.definition.description).toContain('persistedTo');
  });
});
