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

function fakeContext(label: string, closes: string[], options: { readonly alive?: boolean } = {}): FakeContext {
  const page = {
    url: () => 'about:blank',
    title: async () => 'blank',
    on: () => undefined,
    close: async () => undefined,
  } as unknown as Page;
  let closed = false;
  const context = {
    pages: () => [page],
    on: () => undefined,
    newPage: async () => page,
    close: async () => {
      closed = true;
      closes.push(label);
    },
    // Explicit rather than absent: a fixture that says nothing about liveness
    // is treated as alive by the manager (see isSessionAlive), so a fixture
    // that wants to model a dead browser has to say so.
    isClosed: () => (options.alive === false ? true : closed),
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

/**
 * A manager whose `launchPersistentContext` is the caller's own function, so
 * tests can count calls, fail on demand, or hand back a context that reports
 * itself dead — the three shapes the single-instance and retry-cap rules
 * have to tell apart.
 */
function createControllableManager(
  launchPersistentContext: () => Promise<BrowserContext>,
): BrowserSessionManager {
  return new BrowserSessionManager({
    profileRoot: PROFILE_ROOT,
    surfaceRoot: 'test-surface',
    io: readyProvisionIo(),
    loadDriver: () => ({
      chromium: {
        launchPersistentContext,
        connectOverCDP: async () => ({ contexts: () => [] } as unknown as Browser),
      },
    }),
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

describe('managed profile isolation', () => {
  test('a launched profile directory lives under the surface storage root, never a user default profile', async () => {
    const manager = createManager([]);
    const session = await manager.launch({ profileName: 'google-oauth-refresh' });
    expect(session.profileDirectory).not.toBeNull();
    expect(session.profileDirectory).toStartWith(PROFILE_ROOT);
    // Never a path shaped like a real browser's own default profile store.
    expect(session.profileDirectory ?? '').not.toMatch(/\.config\/(google-chrome|chromium)(?!\/)/);
    expect(session.profileDirectory ?? '').not.toMatch(/Library\/Application Support\/Google\/Chrome/);
  });

  test('two different profile names land in two different directories, both under the surface root', async () => {
    const manager = createManager([]);
    const a = await manager.launch({ profileName: 'work' });
    await manager.closeSession(a.sessionId);
    const b = await manager.launch({ profileName: 'personal' });
    expect(a.profileDirectory).not.toBe(b.profileDirectory);
    expect(a.profileDirectory).toStartWith(PROFILE_ROOT);
    expect(b.profileDirectory).toStartWith(PROFILE_ROOT);
  });

  test('a profile name of slashes cannot escape the profiles directory via a multi-segment path', async () => {
    const manager = createManager([]);
    const session = await manager.launch({ profileName: '../../../../etc/passwd' });
    expect(session.profileDirectory).toStartWith(PROFILE_ROOT);
  });

  test('a profile name that sanitizes down to only dots cannot walk up to the profiles directory\'s parent', async () => {
    const manager = createManager([]);
    // Every character survives sanitizing (dots are allowed), so this is the
    // one shape a slash-strip alone does not stop: `path.join(root, '..')`
    // resolves to root's PARENT, not a literal folder named "..".
    const session = await manager.launch({ profileName: '..' });
    expect(session.profileDirectory).toStartWith(PROFILE_ROOT);
    expect(session.profileDirectory).not.toBe(PROFILE_ROOT);
  });

  test('a single-dot profile name does not collapse onto the profiles directory itself', async () => {
    const manager = createManager([]);
    const session = await manager.launch({ profileName: '.' });
    expect(session.profileDirectory).not.toBe(PROFILE_ROOT);
    expect(session.profileDirectory).toStartWith(PROFILE_ROOT);
  });
});

describe('single managed session, bounded retries', () => {
  test('launch() reuses the already-open session instead of opening a second one', async () => {
    let launchCount = 0;
    const closes: string[] = [];
    const manager = createControllableManager(async () => {
      launchCount += 1;
      return fakeContext('launched', closes).context;
    });

    const first = await manager.launch({ profileName: 'default' });
    const second = await manager.launch({ profileName: 'default' });

    expect(launchCount).toBe(1);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(manager.list()).toHaveLength(1);
  });

  test('concurrent launch() calls made before the first resolves do not open two browsers', async () => {
    let launchCount = 0;
    const closes: string[] = [];
    const manager = createControllableManager(async () => {
      launchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fakeContext('launched', closes).context;
    });

    const [first, second] = await Promise.all([manager.launch({}), manager.launch({})]);

    expect(launchCount).toBe(1);
    expect(first.sessionId).toBe(second.sessionId);
    expect(manager.list()).toHaveLength(1);
  });

  test('a genuinely dead session is dropped and relaunch opens a fresh one', async () => {
    let launchCount = 0;
    const closes: string[] = [];
    const manager = createControllableManager(async () => {
      launchCount += 1;
      // The first context reports itself dead, as if the browser process
      // had already exited without going through closeSession().
      return fakeContext('launched', closes, { alive: launchCount !== 1 }).context;
    });

    const first = await manager.launch({});
    const second = await manager.launch({});

    expect(launchCount).toBe(2);
    expect(second.reused).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test('after two consecutive launch failures, launch refuses to try again on its own', async () => {
    const manager = createControllableManager(async () => {
      throw new Error('boom: browser refused to start');
    });

    await expect(manager.launch({})).rejects.toThrow(/boom/);
    await expect(manager.launch({})).rejects.toThrow(/boom/);
    // The third attempt is refused in plain words before it ever touches the
    // driver again — no third window opens.
    await expect(manager.launch({})).rejects.toThrow(/stopped retrying/);
  });

  test('a success after failures resets the count, so the cap is not permanent', async () => {
    let attempt = 0;
    const closes: string[] = [];
    const manager = createControllableManager(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first attempt fails');
      return fakeContext('launched', closes).context;
    });

    await expect(manager.launch({})).rejects.toThrow(/first attempt fails/);
    const recovered = await manager.launch({});
    expect(recovered.reused).toBe(false);

    // Closing and launching again after a clean success is not affected by
    // the earlier failure: the cap only bites on consecutive failures.
    await manager.closeSession(recovered.sessionId);
    await expect(manager.launch({})).resolves.toBeDefined();
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
