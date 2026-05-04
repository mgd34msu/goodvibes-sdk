import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { resetMetrics } from '../packages/sdk/src/platform/runtime/metrics.js';

/**
 * OBS-02: Auth events — verifies that auth-related metric counters exist and
 * that the RuntimeMeter Counter instruments use the correct API.
 * Includes integration test driving the login path to assert counter wiring.
 */
describe('obs-02 auth events', () => {
  afterEach(() => {
    // MAJ-13: reset singleton meter state so tests do not bleed into each other.
    resetMetrics();
  });

  test('authSuccessTotal and authFailureTotal counters are exported from metrics', async () => {
    const mod = await import('../packages/sdk/src/platform/runtime/metrics.js');
    expect(mod.authSuccessTotal).not.toBeNull(); // presence-only: counter exported
    expect(mod.authFailureTotal).not.toBeNull(); // presence-only: counter exported
  });

  test('authSuccessTotal counter supports add()', async () => {
    const { authSuccessTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const before = authSuccessTotal.value();
    authSuccessTotal.add(1);
    expect(authSuccessTotal.value()).toBe(before + 1);
  });

  test('authFailureTotal counter supports add()', async () => {
    const { authFailureTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const before = authFailureTotal.value();
    authFailureTotal.add(1);
    expect(authFailureTotal.value()).toBe(before + 1);
  });

  test('counter value() returns 0 for unknown labels', async () => {
    const { authSuccessTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    // An unlabeled key that was never set returns 0
    expect(authSuccessTotal.value({ auth_method: 'never-used-label-xyz' })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: auth counter wiring through the HTTP login path (MAJ-03)
// ---------------------------------------------------------------------------
describe('obs-02 auth counter wiring — login path', () => {
  const tmpRoots: string[] = [];
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    // MAJ-13: reset singleton meter state so tests do not bleed into each other.
    resetMetrics();
  });

  test('bad login credentials increment authFailureTotal', async () => {
    const { authFailureTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const { HttpListener } = await import('../packages/sdk/src/platform/daemon/http-listener.js');
    const { UserAuthManager } = await import('../packages/sdk/src/platform/security/user-auth.js');
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');

    const dir = mkdtempSync(join(tmpdir(), 'obs-02-auth-'));
    tmpRoots.push(dir);

    const userAuth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'auth-users.json'),
      bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
    });
    const configManager = new ConfigManager({ configDir: dir });
    // NOTE (MIN-02): `as unknown as` is used here to access the internal handleRequest
    // method without a public test hook. Any future signature change will surface at
    // runtime rather than compile time — acceptable trade-off for this integration test.
    const listener = new HttpListener({ port: 0, userAuth, configManager }) as unknown as {
      handleRequest: (req: Request) => Promise<Response>;
    };

    const before = authFailureTotal.value();
    const req = new Request('http://127.0.0.1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bad-user', password: 'bad-pass' }),
    });
    const res = await listener.handleRequest(req);
    expect(res.status).toBe(401);
    expect(authFailureTotal.value()).toBe(before + 1);
  });

  test('successful login increments authSuccessTotal', async () => {
    const { authSuccessTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const { HttpListener } = await import('../packages/sdk/src/platform/daemon/http-listener.js');
    const { UserAuthManager } = await import('../packages/sdk/src/platform/security/user-auth.js');
    const { ConfigManager } = await import('../packages/sdk/src/platform/config/manager.js');

    const dir = mkdtempSync(join(tmpdir(), 'obs-02-auth-'));
    tmpRoots.push(dir);

    const userAuth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'auth-users.json'),
      bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
    });
    // Add a known user for this test
    userAuth.addUser('test-admin', 'correct-password', ['admin']);
    const configManager = new ConfigManager({ configDir: dir });
    const listener = new HttpListener({ port: 0, userAuth, configManager }) as unknown as {
      handleRequest: (req: Request) => Promise<Response>;
    };

    const before = authSuccessTotal.value();
    const req = new Request('http://127.0.0.1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'correct-password' }),
    });
    const res = await listener.handleRequest(req);
    expect(res.status).toBe(200);
    expect(authSuccessTotal.value()).toBe(before + 1);
  });
});
