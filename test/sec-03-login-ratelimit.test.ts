/**
 * SEC-03: POST /login must be subject to:
 *   1. The CORS origin check (applied before /login dispatch)
 *   2. A dedicated tight rate-limit budget (default 5/min per IP)
 *
 * Tests:
 *   - 5 rapid POST /login attempts succeed (within budget)
 *   - 6th attempt returns 429
 *   - 10 rapid attempts all return 429 after the 5th
 *   - Origin check fires before /login (blocked origin returns 403, not processed)
 *   - General-API rate limiter does NOT consume the login budget (they are independent)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../packages/sdk/src/_internal/platform/security/user-auth.js';
import { HttpListener } from '../packages/sdk/src/_internal/platform/daemon/http-listener.js';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-sec03-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Build a minimal HttpListener that uses mock Bun.serve (no actual port binding)
 * with a tight loginRateLimit for testing.
 */
function makeListener(opts: {
  dir: string;
  loginRateLimit?: number;
  rateLimit?: number;
  allowedOrigins?: string[];
  trustProxy?: boolean;
}): { listener: HttpListener; dispatch: (req: Request) => Promise<Response> } {
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(opts.dir, 'auth-users.json'),
    bootstrapCredentialPath: join(opts.dir, 'auth-bootstrap.txt'),
  });

  const configManager = new ConfigManager({ configDir: opts.dir });

  let capturedFetch: ((req: Request) => Promise<Response>) | null = null;
  const mockServe = (options: { fetch: (req: Request) => Promise<Response> }) => {
    capturedFetch = options.fetch;
    return { stop: () => {} } as ReturnType<typeof Bun.serve>;
  };

  const listener = new HttpListener({
    configManager,
    userAuth,
    rateLimit: opts.rateLimit ?? 60,
    loginRateLimit: opts.loginRateLimit ?? 5,
    allowedOrigins: opts.allowedOrigins ?? [],
    trustProxy: opts.trustProxy ?? false,
    serveFactory: mockServe as unknown as typeof Bun.serve,
  });

  listener.enable({ httpListener: true }, 'test-shared-token');

  return {
    listener,
    dispatch: (req) => {
      if (!capturedFetch) throw new Error('listener not started');
      return capturedFetch(req);
    },
  };
}

function loginRequest(ip?: string): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (ip) headers['x-forwarded-for'] = ip;
  return new Request('http://127.0.0.1/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'admin', password: 'wrongpass' }),
  });
}

describe('SEC-03: /login rate limiter — tight budget enforced', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir('login-rl'); });
  afterEach(() => { cleanup(dir); });

  test('first 5 attempts are allowed (budget = 5)', async () => {
    const { listener, dispatch } = makeListener({ dir, loginRateLimit: 5 });
    await listener.start();

    for (let i = 0; i < 5; i++) {
      const res = await dispatch(loginRequest('10.0.0.1'));
      // Credentials are wrong so we expect 401, NOT 429
      expect(res.status).toBe(401);
    }

    listener.stop();
  });

  test('6th attempt returns 429', async () => {
    const { listener, dispatch } = makeListener({ dir, loginRateLimit: 5 });
    await listener.start();

    // Exhaust budget
    for (let i = 0; i < 5; i++) {
      await dispatch(loginRequest('10.0.0.2'));
    }
    // 6th must be rate-limited
    const res = await dispatch(loginRequest('10.0.0.2'));
    expect(res.status).toBe(429);

    listener.stop();
  });

  test('10 rapid POST /login attempts: first 5 return 401, rest return 429', async () => {
    const { listener, dispatch } = makeListener({ dir, loginRateLimit: 5 });
    await listener.start();

    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await dispatch(loginRequest('10.0.0.3'));
      results.push(res.status);
    }

    expect(results.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(results.slice(5).every((s) => s === 429)).toBe(true);

    listener.stop();
  });

  test('IPs are tracked independently — different IPs each get their own budget', async () => {
    const { listener, dispatch } = makeListener({ dir, loginRateLimit: 2, trustProxy: true });
    await listener.start();

    // IP A exhausts budget
    await dispatch(loginRequest('10.1.0.1'));
    await dispatch(loginRequest('10.1.0.1'));
    const rateLimited = await dispatch(loginRequest('10.1.0.1'));
    expect(rateLimited.status).toBe(429);

    // IP B still has full budget
    const ipBRes = await dispatch(loginRequest('10.1.0.2'));
    expect(ipBRes.status).toBe(401); // Not 429

    listener.stop();
  });

  test('general-API rate limiter does not consume login budget (independent limiters)', async () => {
    // Exhaust the GENERAL rate limiter with health requests, then confirm login still has budget.
    const { listener, dispatch } = makeListener({ dir, loginRateLimit: 5, rateLimit: 3 });
    await listener.start();

    // Exhaust general limiter with /health (requires auth bearer)
    for (let i = 0; i < 3; i++) {
      await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-shared-token', 'x-forwarded-for': '10.2.0.1' },
      }));
    }
    // General-API limiter is now exhausted for this IP; next health = 429
    const healthRes = await dispatch(new Request('http://127.0.0.1/health', {
      headers: { Authorization: 'Bearer test-shared-token', 'x-forwarded-for': '10.2.0.1' },
    }));
    expect(healthRes.status).toBe(429);

    // But login budget is completely independent — should still get 401 (wrong creds)
    const loginRes = await dispatch(loginRequest('10.2.0.1'));
    expect(loginRes.status).toBe(401);

    listener.stop();
  });
});

describe('SEC-03 + SEC-07: origin check applies before /login dispatch', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir('login-origin'); });
  afterEach(() => { cleanup(dir); });

  test('blocked origin returns 403 before /login is processed', async () => {
    const { listener, dispatch } = makeListener({
      dir,
      allowedOrigins: ['http://allowed.example.com'],
    });
    await listener.start();

    const req = new Request('http://127.0.0.1/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://evil.attacker.com',
      },
      body: JSON.stringify({ username: 'admin', password: 'any' }),
    });
    const res = await dispatch(req);
    // Must be blocked by origin check, not reach login handler
    expect(res.status).toBe(403);

    listener.stop();
  });

  test('allowed origin passes to /login handler', async () => {
    const { listener, dispatch } = makeListener({
      dir,
      allowedOrigins: ['http://allowed.example.com'],
    });
    await listener.start();

    const req = new Request('http://127.0.0.1/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://allowed.example.com',
      },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    const res = await dispatch(req);
    // Reaches login handler; bad creds = 401
    expect(res.status).toBe(401);

    listener.stop();
  });
});
