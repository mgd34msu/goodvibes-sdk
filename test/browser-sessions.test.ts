import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { BrowserSessionError, BrowserSessionManager, cdpEndpointCandidates } from '../packages/sdk/src/platform/browser/browser-sessions.js';
import type { BrowserProvisionIo } from '../packages/sdk/src/platform/browser/browser-types.js';

// BrowserSessionManager.launch() does a real `mkdirSync(profileDirectory, ...)`
// even with a fully mocked driver (see browser-sessions.ts) — a fixed literal
// '/tmp/...' string here would create that directory in the real host /tmp,
// bypassing the TMPDIR redirection scripts/test.ts sets up for the whole
// suite. Routing it through tmpdir() keeps it inside this run's sandboxed
// temp root like everything else.
const PROFILE_ROOT = join(tmpdir(), 'goodvibes-test-profiles');

interface FakeContext {
  readonly closes: string[];
  readonly context: BrowserContext;
}

function fakeContext(label: string, closes: string[]): FakeContext {
  const page = {
    url: () => 'about:blank',
    title: async () => 'blank',
    on: () => undefined,
    close: async () => undefined,
  } as unknown as Page;
  const context = {
    pages: () => [page],
    on: () => undefined,
    newPage: async () => page,
    close: async () => {
      closes.push(label);
    },
  } as unknown as BrowserContext;
  return { closes, context };
}

function readyProvisionIo(): BrowserProvisionIo {
  return {
    resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: '1.62.0', error: null }),
    expectedExecutablePath: () => '/cache/chromium-1234/chrome',
    browsersPath: () => '/cache',
    pathExists: () => true,
    isExecutableFile: () => true,
    directoryWritable: () => true,
    removePath: () => undefined,
    runCommand: async () => ({ code: 0, stdout: 'Chromium 151', stderr: '', timedOut: false, spawnError: null }),
    systemBrowserCandidates: () => [],
    now: () => 0,
  };
}

function createManager(closes: string[]): BrowserSessionManager {
  return new BrowserSessionManager({
    profileRoot: PROFILE_ROOT,
    surfaceRoot: 'test-surface',
    io: readyProvisionIo(),
    loadDriver: () => ({
      chromium: {
        launchPersistentContext: async () => fakeContext('launched', closes).context,
        connectOverCDP: async () => ({
          contexts: () => [fakeContext('attached', closes).context],
        } as unknown as Browser),
      },
    }),
    probeEndpoint: async () => ({ endpoint: 'http://127.0.0.1:9222', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x' }),
  });
}

describe('browser session ownership', () => {
  test('a launched session is marked closable by the agent', async () => {
    const manager = createManager([]);
    const session = await manager.launch({ profileName: 'test-profile' });
    expect(session.origin).toBe('launched');
    expect(session.closableByAgent).toBe(true);
  });

  test('an attached session is permanently marked not closable', async () => {
    const manager = createManager([]);
    const session = await manager.attach({ cdpEndpoint: '9222' });
    expect(session.origin).toBe('attached');
    expect(session.closableByAgent).toBe(false);
  });

  test('closing a browser the agent did not start is refused', async () => {
    const closes: string[] = [];
    const manager = createManager(closes);
    const session = await manager.attach({ cdpEndpoint: '9222' });

    await expect(manager.closeSession(session.sessionId)).rejects.toThrow(BrowserSessionError);
    expect(closes).toEqual([]);
    // The session is still usable: a refusal must not quietly drop it.
    expect(manager.info(session.sessionId).origin).toBe('attached');
  });

  test('the refusal names the way out instead of just saying no', async () => {
    const manager = createManager([]);
    const session = await manager.attach({ cdpEndpoint: '9222' });
    try {
      await manager.closeSession(session.sessionId);
      throw new Error('closing an attached browser should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserSessionError);
      expect((error as BrowserSessionError).fix).toContain('release');
    }
  });

  test('releasing an attached session drops the connection without closing the browser', async () => {
    const closes: string[] = [];
    const manager = createManager(closes);
    const session = await manager.attach({ cdpEndpoint: '9222' });

    const released = manager.release(session.sessionId);

    expect(released.sessionId).toBe(session.sessionId);
    expect(closes).toEqual([]);
    expect(manager.list()).toHaveLength(0);
  });

  test('shutdown closes launched browsers and leaves attached ones running', async () => {
    const closes: string[] = [];
    const manager = createManager(closes);
    await manager.launch({});
    await manager.attach({ cdpEndpoint: '9222' });

    await manager.shutdown();

    expect(closes).toEqual(['launched']);
    expect(manager.list()).toHaveLength(0);
  });

  test('closing a launched session closes exactly that browser', async () => {
    const closes: string[] = [];
    const manager = createManager(closes);
    const launched = await manager.launch({});
    await manager.attach({ cdpEndpoint: '9222' });

    await manager.closeSession(launched.sessionId);

    expect(closes).toEqual(['launched']);
    expect(manager.list().map((session) => session.origin)).toEqual(['attached']);
  });

  test('a launch failure explains a profile that is already open', async () => {
    const manager = new BrowserSessionManager({
      profileRoot: PROFILE_ROOT,
      surfaceRoot: 'test-surface',
      io: readyProvisionIo(),
      loadDriver: () => ({
        chromium: {
          launchPersistentContext: async () => {
            throw new Error('Failed to create a ProcessSingleton for your profile directory');
          },
          connectOverCDP: async () => ({ contexts: () => [] } as unknown as Browser),
        },
      }),
    });

    try {
      await manager.launch({ profileName: 'busy' });
      throw new Error('expected the launch to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserSessionError);
      expect((error as Error).message).toContain('already open');
      expect((error as BrowserSessionError).fix).toContain('attach');
    }
  });

  test('an unreachable endpoint is reported as no browser listening, with the fix', async () => {
    const manager = new BrowserSessionManager({
      profileRoot: PROFILE_ROOT,
      surfaceRoot: 'test-surface',
      io: readyProvisionIo(),
      loadDriver: () => ({
        chromium: {
          launchPersistentContext: async () => fakeContext('launched', []).context,
          connectOverCDP: async () => ({ contexts: () => [] } as unknown as Browser),
        },
      }),
      probeEndpoint: async () => null,
    });

    try {
      await manager.attach({ cdpEndpoint: '9999' });
      throw new Error('expected the attach to fail');
    } catch (error) {
      expect((error as Error).message).toContain('No browser is listening');
      expect((error as BrowserSessionError).fix).toContain('launch');
    }
  });
});

describe('cdp endpoint candidates', () => {
  test('a bare port is tried on both loopback families', () => {
    expect(cdpEndpointCandidates('9222')).toEqual(['http://127.0.0.1:9222', 'http://[::1]:9222']);
  });

  test('a localhost url also tries the IPv6 loopback', () => {
    expect(cdpEndpointCandidates('http://localhost:9222')).toContain('http://[::1]:9222');
  });

  test('a websocket endpoint is used exactly as given', () => {
    expect(cdpEndpointCandidates('ws://127.0.0.1:9222/devtools/browser/abc')).toEqual(['ws://127.0.0.1:9222/devtools/browser/abc']);
  });

  test('a remote host is not rewritten to loopback', () => {
    expect(cdpEndpointCandidates('http://192.168.1.5:9222')).toEqual(['http://192.168.1.5:9222']);
  });
});
