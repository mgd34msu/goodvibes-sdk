/**
 * config-credentials-share.test.ts
 *
 * Config-sharing bootDaemon proof over real HTTP on an EPHEMERAL port
 * (never 3421/4444). Proves the new admin-scoped `credentials.get` wire method:
 *
 *   1. cross-surface provider visibility — config.get carries provider.* config.
 *   2. admin scoping — no token → 401; a valid admin token → 200.
 *   3. secret-free by construction — NO raw key bytes in any response path, and
 *      CONFIG_SNAPSHOT_SCHEMA still carries no secrets/apiKeys field.
 *   4. external refs — an env:// ref resolves through the read method (usable),
 *      reported as status only (refSource='env'), never the resolved plaintext.
 *   5. no env dump — enumeration is over STORED keys only, never process.env.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';
import { CONFIG_SNAPSHOT_SCHEMA } from '../packages/sdk/src/platform/control-plane/operator-contract-schemas-admin.ts';

const TOKEN = 'w6c1-credentials-token';
const STORED_PLAINTEXT = 'super-secret-plaintext-value-do-not-leak';
const ENV_REF_PLAINTEXT = 'resolved-through-env-ref-do-not-leak';
const ENV_REF_VAR = 'W6C1_TEST_ENV_SECRET';

let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'w6c1-home-'));
  work = mkdtempSync(join(tmpdir(), 'w6c1-work-'));

  // Pre-seed the daemon's shared store (surfaceRoot 'goodvibes', deterministic
  // host+user encryption key) so credentials.get has real status to report.
  const seed = new SecretsManager({
    projectRoot: work,
    globalHome: home,
    surfaceRoot: 'goodvibes',
    policy: 'preferred_secure',
  });
  await seed.set('SHARED_CHANNEL_TOKEN', STORED_PLAINTEXT, { scope: 'user', medium: 'secure' });
  await seed.set('REF_BACKED_TOKEN', `goodvibes://secrets/env/${ENV_REF_VAR}`, { scope: 'user', medium: 'secure' });
  process.env[ENV_REF_VAR] = ENV_REF_PLAINTEXT;

  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
  });
});

afterAll(async () => {
  await daemon?.stop();
  delete process.env[ENV_REF_VAR];
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('W6-C1 — credentials.get admin-scoped secret-free read', () => {
  test('cross-surface provider visibility: config.get carries provider config', async () => {
    const res = await fetch(`${daemon.url}/config`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // The shared config snapshot exposes provider/model config cross-surface…
    expect(body.provider ?? body.providers).toBeDefined();
    // …and NEVER a secrets / apiKeys field (deliberately secret-free).
    expect('secrets' in body).toBe(false);
    expect('apiKeys' in body).toBe(false);
  });

  test('CONFIG_SNAPSHOT_SCHEMA carries no secrets/apiKeys field (regression)', () => {
    const props = (CONFIG_SNAPSHOT_SCHEMA as { properties?: Record<string, unknown> }).properties ?? {};
    expect('providers' in props).toBe(true);
    expect('secrets' in props).toBe(false);
    expect('apiKeys' in props).toBe(false);
  });

  test('admin scoping: no token → 401', async () => {
    const res = await fetch(`${daemon.url}/config/credentials`);
    expect(res.status).toBe(401);
  });

  test('admin token → 200 with secret-free credential status', async () => {
    const res = await fetch(`${daemon.url}/config/credentials`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      available: boolean;
      credentials: Array<Record<string, unknown>>;
    };
    expect(body.available).toBe(true);
    const stored = body.credentials.find((c) => c.key === 'SHARED_CHANNEL_TOKEN');
    expect(stored).toBeDefined();
    expect(stored!.configured).toBe(true);
    expect(stored!.usable).toBe(true);
    expect(stored!.secure).toBe(true);
    // Status only — no raw-value field on any record.
    expect('value' in stored!).toBe(false);
  });

  test('external env:// ref resolves through the read method as status only', async () => {
    const res = await fetch(`${daemon.url}/config/credentials`, { headers: auth() });
    const body = await res.json() as { credentials: Array<Record<string, unknown>> };
    const ref = body.credentials.find((c) => c.key === 'REF_BACKED_TOKEN');
    expect(ref).toBeDefined();
    expect(ref!.configured).toBe(true);
    expect(ref!.usable).toBe(true);          // the env:// ref resolved in-process
    expect(ref!.refSource).toBe('env');
  });

  test('NEVER returns raw secret bytes on any path (list or single-key probe)', async () => {
    const listRes = await fetch(`${daemon.url}/config/credentials`, { headers: auth() });
    const listText = await listRes.text();
    expect(listText.includes(STORED_PLAINTEXT)).toBe(false);
    expect(listText.includes(ENV_REF_PLAINTEXT)).toBe(false);

    const probeRes = await fetch(
      `${daemon.url}/config/credentials?key=SHARED_CHANNEL_TOKEN`,
      { headers: auth() },
    );
    expect(probeRes.status).toBe(200);
    const probeText = await probeRes.text();
    expect(probeText.includes(STORED_PLAINTEXT)).toBe(false);
    const probe = JSON.parse(probeText) as { credentials: Array<Record<string, unknown>> };
    expect(probe.credentials).toHaveLength(1);
    expect(probe.credentials[0]!.key).toBe('SHARED_CHANNEL_TOKEN');
  });

  test('enumeration is over stored keys only — no process.env dump', async () => {
    const res = await fetch(`${daemon.url}/config/credentials`, { headers: auth() });
    const body = await res.json() as { credentials: Array<Record<string, unknown>> };
    const keys = body.credentials.map((c) => c.key);
    // A real env var name that is NOT a stored key must never appear.
    expect(keys.includes('PATH')).toBe(false);
    expect(keys.includes(ENV_REF_VAR)).toBe(false);
  });
});
