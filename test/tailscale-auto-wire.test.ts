/**
 * tailscale-auto-wire.test.ts
 *
 * The tailscale auto-wire affordance: read-only detection (never a
 * state-changing command), the one-action serve verb (honest receipt either
 * way, web.publicBaseUrl updated from the same resolution on success), and the
 * quiet no-nag posture where tailscale is absent. All over a fake runner —
 * no real tailscale is ever touched.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectTailscale,
  enableTailscaleServe,
  TailscaleServeReceiptStore,
  type TailscaleCommandRunner,
} from '../packages/sdk/src/platform/remote-access/tailscale.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerTailscaleGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/tailscale.ts';

interface Call { command: string; args: readonly string[]; }

function fakeRunner(state: 'missing' | 'logged-out' | 'ready', calls: Call[] = []): TailscaleCommandRunner {
  return {
    run(command, args) {
      calls.push({ command, args });
      if (state === 'missing') return { status: null, stdout: '', stderr: 'not found' };
      if (args[0] === 'status') {
        const body = state === 'ready'
          ? { BackendState: 'Running', Self: { DNSName: 'mybox.my-tailnet.ts.net.' } }
          : { BackendState: 'NeedsLogin' };
        return { status: 0, stdout: JSON.stringify(body), stderr: '' };
      }
      if (args[0] === 'serve') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    },
  };
}

describe('detectTailscale — strictly read-only', () => {
  test('missing binary: quietly unavailable, nothing nags', () => {
    const detection = detectTailscale(fakeRunner('missing'));
    expect(detection).toMatchObject({ available: false, loggedIn: false });
    expect(detection.httpsUrl).toBeUndefined();
  });

  test('installed but logged out: honest state, no URL', () => {
    const detection = detectTailscale(fakeRunner('logged-out'));
    expect(detection).toMatchObject({ available: true, loggedIn: false });
    expect(detection.detail).toContain('NeedsLogin');
  });

  test('ready: MagicDNS name (trailing dot stripped) and the https URL', () => {
    const detection = detectTailscale(fakeRunner('ready'));
    expect(detection).toMatchObject({
      available: true,
      loggedIn: true,
      magicDnsName: 'mybox.my-tailnet.ts.net',
      httpsUrl: 'https://mybox.my-tailnet.ts.net',
    });
  });

  test('detection only ever runs `tailscale status --json` — no state-changing command', () => {
    const calls: Call[] = [];
    detectTailscale(fakeRunner('ready', calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ command: 'tailscale', args: ['status', '--json'] });
  });
});

describe('enableTailscaleServe — the one state-changing action, honestly receipted', () => {
  test('success yields the https URL and the exact serve command', () => {
    const calls: Call[] = [];
    const receipt = enableTailscaleServe(3423, fakeRunner('ready', calls));
    expect(receipt.ok).toBe(true);
    expect(receipt.url).toBe('https://mybox.my-tailnet.ts.net');
    expect(receipt.command).toBe('tailscale serve --bg 3423');
    expect(calls.some((c) => c.args[0] === 'serve' && c.args.includes('3423'))).toBe(true);
  });

  test('an unusable environment yields an honest failed receipt without running serve', () => {
    const calls: Call[] = [];
    const receipt = enableTailscaleServe(3423, fakeRunner('logged-out', calls));
    expect(receipt.ok).toBe(false);
    expect(calls.every((c) => c.args[0] !== 'serve')).toBe(true);
  });
});

describe('tailscale.* verbs over the catalog', () => {
  const ctx = { context: { principalId: 'pairing:p1', admin: true } } as const;

  function makeHarness(state: 'missing' | 'ready'): {
    catalog: GatewayMethodCatalog;
    calls: Call[];
    baseUrls: string[];
    dir: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'ts-wire-'));
    const calls: Call[] = [];
    const baseUrls: string[] = [];
    const catalog = new GatewayMethodCatalog();
    registerTailscaleGatewayMethods(catalog, {
      runner: fakeRunner(state, calls),
      receipts: new TailscaleServeReceiptStore(join(dir, 'receipts.json')),
      resolveWebPort: () => 3423,
      setPublicBaseUrl: (url) => { baseUrls.push(url); },
    });
    return { catalog, calls, baseUrls, dir };
  }

  test('tailscale.get reports the environment read-only', async () => {
    const h = makeHarness('ready');
    try {
      const got = await h.catalog.invoke('tailscale.get', { ...ctx, body: {} }) as { available: boolean; httpsUrl?: string };
      expect(got.available).toBe(true);
      expect(got.httpsUrl).toBe('https://mybox.my-tailnet.ts.net');
      expect(h.calls.every((c) => c.args[0] === 'status')).toBe(true);
      expect(h.baseUrls).toHaveLength(0);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test('tailscale.serve.run records a receipt and updates web.publicBaseUrl from the same resolution', async () => {
    const h = makeHarness('ready');
    try {
      const run = await h.catalog.invoke('tailscale.serve.run', { ...ctx, body: {} }) as {
        receipt: { ok: boolean; url?: string };
        publicBaseUrlUpdated: boolean;
      };
      expect(run.receipt.ok).toBe(true);
      expect(run.publicBaseUrlUpdated).toBe(true);
      expect(h.baseUrls).toEqual(['https://mybox.my-tailnet.ts.net']);

      // The receipt is persisted and surfaces on the next read.
      const got = await h.catalog.invoke('tailscale.get', { ...ctx, body: {} }) as { lastServe?: { ok: boolean; url?: string } };
      expect(got.lastServe?.ok).toBe(true);
      expect(got.lastServe?.url).toBe('https://mybox.my-tailnet.ts.net');
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test('where tailscale is absent: get is quiet, serve.run is an honest failed receipt, no config touch', async () => {
    const h = makeHarness('missing');
    try {
      const got = await h.catalog.invoke('tailscale.get', { ...ctx, body: {} }) as { available: boolean };
      expect(got.available).toBe(false);
      const run = await h.catalog.invoke('tailscale.serve.run', { ...ctx, body: {} }) as { receipt: { ok: boolean }; publicBaseUrlUpdated: boolean };
      expect(run.receipt.ok).toBe(false);
      expect(run.publicBaseUrlUpdated).toBe(false);
      expect(h.baseUrls).toHaveLength(0);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
