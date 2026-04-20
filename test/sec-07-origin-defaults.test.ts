/**
 * SEC-07: Origin default safety — refuse-to-start + request-time deny.
 *
 * Tests:
 *   SG-1: Startup guard — hostMode=network + allowedOrigins=[] throws SECURITY_UNSAFE_ORIGIN_CONFIG
 *   SG-2: Startup guard — hostMode=network + allowedOrigins non-empty constructs OK
 *   RT-1: Request-time — loopback + empty allowedOrigins + no Origin header → 200/pass
 *   RT-2: Request-time — loopback + empty allowedOrigins + Origin header → 403 CORS_NOT_CONFIGURED
 *   RT-3: Request-time — network + allowedOrigins set + wrong Origin → 403 ORIGIN_NOT_ALLOWED
 *   RT-4: Request-time — network + allowedOrigins set + correct Origin → 200/pass
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../packages/sdk/src/_internal/platform/security/user-auth.js';
import { HttpListener } from '../packages/sdk/src/_internal/platform/daemon/http-listener.js';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-sec07-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Build a ConfigManager with optional hostMode override.
 */
function makeConfigManager(dir: string, hostMode?: string): ConfigManager {
  const cm = new ConfigManager({ configDir: dir });
  if (hostMode !== undefined) {
    cm.set('httpListener.hostMode', hostMode as 'local' | 'network' | 'custom');
  }
  // Use a high port to avoid collisions with any running daemon
  cm.set('httpListener.port', 59700);
  return cm;
}

/**
 * Build a minimal UserAuthManager backed by a temp dir.
 * Passes explicit empty users to bypass filesystem bootstrap.
 */
function makeUserAuth(dir: string): UserAuthManager {
  return new UserAuthManager({
    users: [],
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
  });
}

/**
 * Build an HttpListener wired with a mock Bun.serve so no port is actually bound.
 * Returns the listener and a dispatch function that invokes the captured fetch handler.
 */
function makeListener(opts: {
  configManager: ConfigManager;
  userAuth: UserAuthManager;
  allowedOrigins?: string[];
}): { listener: HttpListener; dispatch: (req: Request) => Promise<Response> } {
  let capturedFetch: ((req: Request) => Promise<Response>) | null = null;
  const mockServe = (options: { fetch: (req: Request) => Promise<Response> }) => {
    capturedFetch = options.fetch;
    return { stop: () => {} } as ReturnType<typeof Bun.serve>;
  };

  const listener = new HttpListener({
    configManager: opts.configManager,
    userAuth: opts.userAuth,
    allowedOrigins: opts.allowedOrigins ?? [],
    serveFactory: mockServe as unknown as typeof Bun.serve,
  });

  listener.enable({ httpListener: true }, 'test-token');

  return {
    listener,
    dispatch: (req) => {
      if (!capturedFetch) throw new Error('listener not started — call listener.start() first');
      return capturedFetch(req);
    },
  };
}

// ---------------------------------------------------------------------------
// SG: Startup guard (constructor-level)
// ---------------------------------------------------------------------------

describe('SEC-07 SG: startup guard — network mode with empty allowedOrigins', () => {
  test('SG-1: throws SECURITY_UNSAFE_ORIGIN_CONFIG when hostMode=network and allowedOrigins is empty', () => {
    const dir = tempDir('sg1');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        new HttpListener({
          configManager,
          userAuth,
          allowedOrigins: [],
          serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
        });
      }).toThrow('SECURITY_UNSAFE_ORIGIN_CONFIG');
    } finally {
      cleanup(dir);
    }
  });

  test('SG-2: constructs successfully when hostMode=network and allowedOrigins is non-empty', () => {
    const dir = tempDir('sg2');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        new HttpListener({
          configManager,
          userAuth,
          allowedOrigins: ['https://good.example'],
          serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
        });
      }).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// RT: Request-time origin enforcement
// ---------------------------------------------------------------------------

describe('SEC-07 RT: request-time origin enforcement', () => {
  test('RT-1: loopback + empty allowedOrigins + no Origin header → request passes', async () => {
    const dir = tempDir('rt1');
    try {
      const configManager = makeConfigManager(dir, 'local');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [] });
      await listener.start();

      // No Origin header — same-origin / non-browser request; should not be blocked
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token' },
      }));
      // Health returns 200 (authenticated)
      expect(res.status).toBe(200);

      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('RT-2: loopback + empty allowedOrigins + Origin header → 403 CORS_NOT_CONFIGURED', async () => {
    const dir = tempDir('rt2');
    try {
      const configManager = makeConfigManager(dir, 'local');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [] });
      await listener.start();

      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: {
          Authorization: 'Bearer test-token',
          Origin: 'http://evil.example',
        },
      }));
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('CORS_NOT_CONFIGURED');

      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('RT-3: network + allowedOrigins set + wrong Origin → 403 ORIGIN_NOT_ALLOWED', async () => {
    const dir = tempDir('rt3');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({
        configManager,
        userAuth,
        allowedOrigins: ['https://good.example'],
      });
      await listener.start();

      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: {
          Authorization: 'Bearer test-token',
          Origin: 'http://evil.example',
        },
      }));
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('ORIGIN_NOT_ALLOWED');

      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('RT-4: network + allowedOrigins set + correct Origin → request passes', async () => {
    const dir = tempDir('rt4');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({
        configManager,
        userAuth,
        allowedOrigins: ['https://good.example'],
      });
      await listener.start();

      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: {
          Authorization: 'Bearer test-token',
          Origin: 'https://good.example',
        },
      }));
      expect(res.status).toBe(200);

      listener.stop();
    } finally {
      cleanup(dir);
    }
  });
});
