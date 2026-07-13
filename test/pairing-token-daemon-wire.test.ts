/**
 * pairing-token-daemon-wire.test.ts
 *
 * Per-pairing tokens proven over a REAL bootDaemon (isolated home, ephemeral
 * port). The daemon boots with a legacy shared token; each device mints its own
 * named, individually-revocable token over the operator contract.
 *
 * Acceptance proven end to end:
 *  - two devices paired (each its own token), revoke one -> the other still works.
 *  - the revoked token gets 401 on its very next request.
 *  - legacy migration: a client on the shared token mints its own per-device
 *    token (one receipt) and it works.
 *  - the shared token can be revoked, after which it 401s but per-device tokens
 *    keep working.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const SHARED = 'legacy-shared-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

interface InvokeResult { readonly status: number; readonly json: Record<string, unknown>; }

async function invoke(token: string, methodId: string, body: unknown = {}): Promise<InvokeResult> {
  const res = await fetch(`${daemon.url}/api/control-plane/methods/${methodId}/invoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  return { status: res.status, json: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'pairing-home-'));
  work = mkdtempSync(join(tmpdir(), 'pairing-work-'));
  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: SHARED,
  });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('per-pairing tokens over the operator contract', () => {
  test('two devices, revoke one — the other still works; revoked gets 401', async () => {
    // Mint two per-device tokens (via the shared token, which is admin).
    const a = await invoke(SHARED, 'pairing.tokens.create', { name: 'Phone' });
    const b = await invoke(SHARED, 'pairing.tokens.create', { name: 'Laptop' });
    expect(a.status).toBe(200);
    const tokenA = (a.json.token as { token: string; id: string });
    const tokenB = (b.json.token as { token: string; id: string });
    expect(tokenA.token).toStartWith('gvp_');

    // Both device tokens authenticate.
    expect((await invoke(tokenA.token, 'pairing.tokens.list')).status).toBe(200);
    expect((await invoke(tokenB.token, 'pairing.tokens.list')).status).toBe(200);

    // The list is redacted — no secret is ever returned.
    const list = await invoke(tokenA.token, 'pairing.tokens.list');
    const names = (list.json.tokens as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(['Laptop', 'Phone']);
    expect(JSON.stringify(list.json)).not.toContain(tokenA.token);

    // Revoke device A.
    const revoke = await invoke(SHARED, 'pairing.tokens.delete', { id: tokenA.id });
    expect(revoke.status).toBe(200);
    expect((revoke.json as { revoked: boolean }).revoked).toBe(true);

    // A gets 401 on its very next request; B still works.
    expect((await invoke(tokenA.token, 'pairing.tokens.list')).status).toBe(401);
    expect((await invoke(tokenB.token, 'pairing.tokens.list')).status).toBe(200);

    // A second revoke of the same id is an honest 404.
    expect((await invoke(SHARED, 'pairing.tokens.delete', { id: tokenA.id })).status).toBe(404);
  });

  test('legacy migration mints a per-device token that works', async () => {
    const migrated = await invoke(SHARED, 'pairing.tokens.migrate', { name: 'Migrated desktop' });
    expect(migrated.status).toBe(200);
    const token = (migrated.json.token as { token: string }).token;
    expect(token).toStartWith('gvp_');
    // The migrated per-device token authenticates.
    expect((await invoke(token, 'pairing.tokens.list')).status).toBe(200);
  });

  test('revoking the shared token 401s it while per-device tokens keep working', async () => {
    const device = await invoke(SHARED, 'pairing.tokens.create', { name: 'Survivor' });
    const deviceToken = (device.json.token as { token: string }).token;

    const off = await invoke(SHARED, 'pairing.tokens.revokeShared');
    expect(off.status).toBe(200);
    expect((off.json as { legacySharedRevoked: boolean }).legacySharedRevoked).toBe(true);

    // The shared token no longer authenticates...
    expect((await invoke(SHARED, 'pairing.tokens.list')).status).toBe(401);
    // ...but a per-device token still does.
    const stillWorks = await invoke(deviceToken, 'pairing.tokens.list');
    expect(stillWorks.status).toBe(200);
    expect((stillWorks.json as { legacySharedRevoked: boolean }).legacySharedRevoked).toBe(true);
  });
});
