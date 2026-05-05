/**
 * Origin enforcement is opt-in via the enforceCors config flag.
 *
 * Default behavior (home / single-user / local deployments): permissive.
 * No constructor guard, no request-time Origin check.
 *
 * Opt-in (enforceCors: true — enterprise / multi-user / internet-exposed):
 *   SG-1: Startup guard — hostMode=network + enforceCors=true + allowedOrigins=[] throws SECURITY_UNSAFE_ORIGIN_CONFIG
 *   SG-2: Startup guard — hostMode=network + enforceCors=true + allowedOrigins non-empty constructs OK
 *   RT-1: Request-time — enforceCors=true + loopback + empty allowedOrigins + no Origin header → 200/pass
 *   RT-2: Request-time — enforceCors=true + loopback + empty allowedOrigins + Origin header → 403 CORS_NOT_CONFIGURED
 *   RT-3: Request-time — enforceCors=true + network + allowedOrigins set + wrong Origin → 403 ORIGIN_NOT_ALLOWED
 *   RT-4: Request-time — enforceCors=true + network + allowedOrigins set + correct Origin → 200/pass
 *
 * Permissive default (enforceCors unset / false):
 *   PD-1: Default config + network mode + empty allowedOrigins constructs OK (no startup guard)
 *   PD-2: Default config + evil Origin header passes through (no request-time check)
 *   PD-3: enforceCors=false explicit + network + empty allowedOrigins constructs OK
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../packages/sdk/src/platform/security/user-auth.js';
import { HttpListener } from '../packages/sdk/src/platform/daemon/http-listener.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

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

function makeConfigManager(dir: string, hostMode?: string): ConfigManager {
  const cm = new ConfigManager({ configDir: dir });
  if (hostMode !== undefined) {
    cm.set('httpListener.hostMode', hostMode as 'local' | 'network' | 'custom');
  }
  cm.set('httpListener.port', 59700);
  return cm;
}

function makeUserAuth(dir: string): UserAuthManager {
  return new UserAuthManager({
    users: [],
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
  });
}

function makeListener(opts: {
  configManager: ConfigManager;
  userAuth: UserAuthManager;
  allowedOrigins?: string[];
  enforceCors?: boolean;
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
    enforceCors: opts.enforceCors,
    serveFactory: mockServe as unknown as typeof Bun.serve,
  });

  listener.enable({ httpListener: true }, 'test-token');

  return {
    listener,
    dispatch: (req) => {
      if (!capturedFetch) throw new Error('listener not started');
      return capturedFetch(req);
    },
  };
}

describe('startup guard (opt-in via enforceCors)', () => {
  test('SG-1: enforceCors=true + hostMode=network + allowedOrigins=[] throws SECURITY_UNSAFE_ORIGIN_CONFIG', () => {
    const dir = tempDir('sg1');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        new HttpListener({
          configManager,
          userAuth,
          allowedOrigins: [],
          enforceCors: true,
          serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
        });
      }).toThrow('SECURITY_UNSAFE_ORIGIN_CONFIG');
    } finally {
      cleanup(dir);
    }
  });

  test('SG-2: enforceCors=true + hostMode=network + allowedOrigins non-empty constructs OK', () => {
    const dir = tempDir('sg2');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        new HttpListener({
          configManager,
          userAuth,
          allowedOrigins: ['https://good.example'],
          enforceCors: true,
          serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
        });
      }).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });
});

describe('request-time origin enforcement (enforceCors=true)', () => {
  test('RT-1: loopback + empty allowedOrigins + no Origin header → request passes', async () => {
    const dir = tempDir('rt1');
    try {
      const configManager = makeConfigManager(dir, 'local');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [], enforceCors: true });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token' },
      }));
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
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [], enforceCors: true });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'http://evil.example' },
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
        configManager, userAuth, allowedOrigins: ['https://good.example'], enforceCors: true,
      });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'http://evil.example' },
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
        configManager, userAuth, allowedOrigins: ['https://good.example'], enforceCors: true,
      });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'https://good.example' },
      }));
      expect(res.status).toBe(200);
      listener.stop();
    } finally {
      cleanup(dir);
    }
  });
});

describe('permissive default (enforceCors unset)', () => {
  test('PD-1: default config + hostMode=network + allowedOrigins=[] constructs without throwing', () => {
    const dir = tempDir('pd1');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        new HttpListener({
          configManager, userAuth, allowedOrigins: [],
          serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
        });
      }).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });

  test('PD-2: default config + evil Origin header passes through (no request-time check)', async () => {
    const dir = tempDir('pd2');
    try {
      const configManager = makeConfigManager(dir, 'local');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [] });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'http://evil.example' },
      }));
      expect(res.status).toBe(200);
      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('PD-3: enforceCors=false explicit + hostMode=network + allowedOrigins=[] constructs without throwing', () => {
    const dir = tempDir('pd3');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        new HttpListener({
          configManager, userAuth, allowedOrigins: [], enforceCors: false,
          serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
        });
      }).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });
});
