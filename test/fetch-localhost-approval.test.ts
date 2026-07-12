/**
 * fetch-localhost-approval.test.ts
 *
 * The localhost dev-server fetch flow: a fetch to localhost/127.0.0.1 asks
 * once through the approval seam with one-tap "allow for this project"
 * semantics, persists fetch.allowLocalhost in the project settings, never
 * re-asks (including across a restart), while private-IP / cloud-metadata
 * blocking stays silent and absolute — an honest tool-result reason for the
 * model, no ask, no other surface.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeFetchInput } from '../packages/sdk/src/platform/tools/fetch/index.js';
import { classifyHostTrustTier } from '../packages/sdk/src/platform/tools/fetch/trust-tiers.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { buildLocalhostFetchApproval } from '../packages/sdk/src/platform/runtime/permissions/localhost-fetch-approval.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';

const tmpRoots: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.stop(true);
});

function makeProjectConfig(): { configManager: ConfigManager; projectSettingsPath: string; makeFresh: () => ConfigManager } {
  const root = mkdtempSync(join(tmpdir(), 'gv-fetch-localhost-'));
  tmpRoots.push(root);
  const workingDir = join(root, 'workspace');
  const homeDir = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const make = () => new ConfigManager({ homeDir, workingDir, surfaceRoot: 'goodvibes-test' });
  const configManager = make();
  return {
    configManager,
    projectSettingsPath: join(workingDir, '.goodvibes', 'goodvibes-test', 'settings.json'),
    makeFresh: make,
  };
}

function startDevServer(): { url: string } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('hello from the dev server', { headers: { 'content-type': 'text/plain' } }),
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}/` };
}

describe('localhost dev-server fetch — ask once, allow for this project', () => {
  test('one approval persists per project, the fetch succeeds, and a restart never re-asks', async () => {
    const { configManager, projectSettingsPath, makeFresh } = makeProjectConfig();
    const { url } = startDevServer();

    const asks: PermissionPromptRequest[] = [];
    const approval = buildLocalhostFetchApproval({
      requestApproval: async ({ request }) => {
        asks.push(request);
        return { approved: true } satisfies PermissionPromptDecision;
      },
      configManager,
    });

    const deps = {
      isLocalhostAllowed: () => configManager.get('fetch.allowLocalhost'),
      approveLocalhostFetch: approval,
    };

    const first = await executeFetchInput({ urls: [{ url }] }, deps);
    expect(first.results[0]?.error).toBeUndefined();
    expect(first.results[0]?.content).toContain('hello from the dev server');
    expect(first.results[0]?.host_trust_tier).toBe('localhost');

    // Exactly one ask, attributed as the one-tap localhost approval.
    expect(asks.length).toBe(1);
    expect(asks[0]?.attribution).toMatchObject({ kind: 'fetch-localhost', host: 'localhost' });
    expect(asks[0]?.analysis.reasons.join(' ')).toContain('fetch.allowLocalhost');

    // The approval persisted to the PROJECT settings file.
    const onDisk = JSON.parse(readFileSync(projectSettingsPath, 'utf-8')) as { fetch?: { allowLocalhost?: boolean } };
    expect(onDisk.fetch?.allowLocalhost).toBe(true);

    // Same runtime: a second fetch never re-asks.
    const second = await executeFetchInput({ urls: [{ url }] }, deps);
    expect(second.results[0]?.error).toBeUndefined();
    expect(asks.length).toBe(1);

    // "Restart": a fresh ConfigManager reloads the persisted approval; an
    // approval seam that would fail the test proves it is never consulted.
    const reloaded = makeFresh();
    expect(reloaded.get('fetch.allowLocalhost')).toBe(true);
    const afterRestart = await executeFetchInput({ urls: [{ url }] }, {
      isLocalhostAllowed: () => reloaded.get('fetch.allowLocalhost'),
      approveLocalhostFetch: async () => {
        throw new Error('must not re-ask after the persisted approval');
      },
    });
    expect(afterRestart.results[0]?.error).toBeUndefined();
    expect(afterRestart.results[0]?.content).toContain('hello from the dev server');
  });

  test('a denied ask refuses the fetch with the setting named and persists nothing', async () => {
    const { configManager, projectSettingsPath } = makeProjectConfig();
    const { url } = startDevServer();

    let askCount = 0;
    const approval = buildLocalhostFetchApproval({
      requestApproval: async () => {
        askCount += 1;
        return { approved: false } satisfies PermissionPromptDecision;
      },
      configManager,
    });

    const result = await executeFetchInput({ urls: [{ url }] }, {
      isLocalhostAllowed: () => configManager.get('fetch.allowLocalhost'),
      approveLocalhostFetch: approval,
    });
    expect(askCount).toBe(1);
    expect(result.results[0]?.error).toContain('fetch.allowLocalhost');
    expect(result.results[0]?.host_trust_tier).toBe('localhost');
    expect(configManager.get('fetch.allowLocalhost')).toBe(false);
    expect(() => readFileSync(projectSettingsPath, 'utf-8')).toThrow();
  });

  test('without an approval seam, an unapproved localhost fetch is refused with an honest reason', async () => {
    const { url } = startDevServer();
    const result = await executeFetchInput({ urls: [{ url }] }, {});
    expect(result.results[0]?.error).toContain('not approved for this project');
    expect(result.results[0]?.error).toContain('fetch.allowLocalhost');
  });
});

describe('private-IP / metadata blocking — silent and absolute', () => {
  test('a metadata-endpoint fetch fails to the model with an honest reason and never asks', async () => {
    let asked = false;
    const result = await executeFetchInput({ urls: [{ url: 'http://169.254.169.254/latest/meta-data/' }] }, {
      isLocalhostAllowed: () => true,
      approveLocalhostFetch: async () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
    expect(result.results[0]?.host_trust_tier).toBe('blocked');
    expect(result.results[0]?.error).toMatch(/Request blocked: .*metadata endpoint/i);
    expect(result.summary.failed).toBe(1);
  });

  test('private IPs stay blocked even with localhost approved', async () => {
    for (const url of ['http://10.0.0.5:1/', 'http://192.168.1.1:1/', 'http://172.16.0.9:1/']) {
      const result = await executeFetchInput({ urls: [{ url }] }, { isLocalhostAllowed: () => true });
      expect(result.results[0]?.host_trust_tier).toBe('blocked');
      expect(result.results[0]?.error).toMatch(/Request blocked/);
    }
  });

  test('encoded loopback URLs normalize to 127.0.0.1 and follow the localhost approval flow', async () => {
    // WHATWG URL parsing de-obfuscates decimal/hex hosts, so these reach the
    // classifier as plain loopback: unapproved, they are refused like any
    // other localhost target (never silently fetched).
    for (const url of ['http://2130706433:1/', 'http://0x7f000001:1/']) {
      const result = await executeFetchInput({ urls: [{ url }] }, {});
      expect(result.results[0]?.host_trust_tier).toBe('localhost');
      expect(result.results[0]?.error).toContain('not approved for this project');
    }
  });

  test('blocking applies regardless of the sanitization kill switch', async () => {
    const result = await executeFetchInput({ urls: [{ url: 'http://169.254.169.254/' }] }, {
      featureFlags: { isEnabled: () => false },
    });
    expect(result.results[0]?.host_trust_tier).toBe('blocked');
    expect(result.results[0]?.error).toMatch(/metadata endpoint/i);
  });
});

describe('trust-tier classification of loopback vs private targets', () => {
  test('plain loopback forms classify as localhost, never SSRF', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'ip6-localhost']) {
      const result = classifyHostTrustTier(host);
      expect(`${host}:${result.tier}`).toBe(`${host}:localhost`);
      expect(result.isSsrf).toBe(false);
    }
  });

  test('private, metadata, and obfuscated forms stay blocked', () => {
    for (const host of ['10.1.2.3', '172.16.9.9', '192.168.0.10', '169.254.169.254', 'metadata.google.internal', '0x7f000001', '0177.0.0.1', '2130706433', 'fe80::1', '0.0.0.0']) {
      const result = classifyHostTrustTier(host);
      expect(`${host}:${result.tier}`).toBe(`${host}:blocked`);
    }
  });

  test('an explicit blocklist entry beats the localhost tier', () => {
    const result = classifyHostTrustTier('localhost', { blockedHosts: ['localhost'] });
    expect(result.tier).toBe('blocked');
    expect(result.isSsrf).toBe(false);
  });
});
