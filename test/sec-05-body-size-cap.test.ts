/**
 * sec-05-body-size-cap.test.ts
 *
 * SEC-05: JSON body-size cap on all HTTP routes.
 * Verifies that parseJsonBody (and parseOptionalJsonBody in router) returns
 * HTTP 413 for requests exceeding 1 MiB, and passes requests at or below 1 MiB.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../packages/sdk/src/_internal/platform/security/user-auth.ts';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.ts';
import { HttpListener } from '../packages/sdk/src/_internal/platform/daemon/http-listener.ts';

const MAX_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-sec05-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeHttpListener(dir: string): HttpListener {
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
  });
  const configManager = new ConfigManager({ configDir: dir });
  return new HttpListener({
    port: 0,
    userAuth,
    configManager,
    rateLimit: 1000,
  });
}

/**
 * Access the private parseJsonBody method via reflection.
 */
function getParseJsonBody(listener: HttpListener): (req: Request) => Promise<Record<string, unknown> | Response> {
  return (listener as unknown as {
    parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  }).parseJsonBody.bind(listener);
}

describe('SEC-05: HttpListener parseJsonBody body-size cap', () => {
  test('Content-Length header > 1 MiB returns 413', async () => {
    const dir = tempDir('a');
    try {
      const listener = makeHttpListener(dir);
      const parseJsonBody = getParseJsonBody(listener);

      const req = new Request('http://localhost/', {
        method: 'POST',
        body: '{"x":1}',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_JSON_BYTES + 1),
        },
      });

      const result = await parseJsonBody(req);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(413);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('body > 1 MiB without Content-Length header returns 413', async () => {
    const dir = tempDir('b');
    try {
      const listener = makeHttpListener(dir);
      const parseJsonBody = getParseJsonBody(listener);

      // Build a body just over 1 MiB
      const bigBody = 'a'.repeat(MAX_JSON_BYTES + 1);
      const req = new Request('http://localhost/', {
        method: 'POST',
        body: bigBody,
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await parseJsonBody(req);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(413);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('valid JSON body within 1 MiB is parsed', async () => {
    const dir = tempDir('c');
    try {
      const listener = makeHttpListener(dir);
      const parseJsonBody = getParseJsonBody(listener);

      const req = new Request('http://localhost/', {
        method: 'POST',
        body: '{"ok":true}',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await parseJsonBody(req);
      expect(result).not.toBeInstanceOf(Response);
      expect((result as Record<string, unknown>).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// DaemonHttpRouter parseJsonBody / parseOptionalJsonBody
// ---------------------------------------------------------------------------

import { DaemonHttpRouter } from '../packages/sdk/src/_internal/platform/daemon/http/router.ts';

function makeRouter(): DaemonHttpRouter {
  const ctx = new Proxy({} as Parameters<typeof DaemonHttpRouter>[0], {
    get: (_target, key) => {
      if (key === 'configManager') return new ConfigManager({});
      if (key === 'telemetryApi') return null;
      return undefined;
    },
  });
  return new (DaemonHttpRouter as unknown as new (ctx: unknown) => DaemonHttpRouter)(ctx);
}

describe('SEC-05: DaemonHttpRouter parseJsonBody body-size cap', () => {
  test('Content-Length > 1 MiB returns 413', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{"x":1}',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_JSON_BYTES + 1),
      },
    });

    const result = await router.parseJsonBody(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  test('parseOptionalJsonBody: Content-Length > 1 MiB returns 413', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{"x":1}',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_JSON_BYTES + 1),
      },
    });

    const result = await router.parseOptionalJsonBody(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  test('parseOptionalJsonBody: empty body returns null', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await router.parseOptionalJsonBody(req);
    expect(result).toBeNull();
  });

  test('parseJsonBody: valid JSON within 1 MiB is parsed', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{"hello":"world"}',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await router.parseJsonBody(req);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as Record<string, unknown>).hello).toBe('world');
  });
});
