/**
 * web-push-daemon-wire.test.ts
 *
 * Browser-push subscription lifecycle + delivery, proven over a REAL bootDaemon
 * (isolated home, ephemeral port, token auth) against a LOCAL fake push sink —
 * never a real push service, never the external network.
 *
 * What is proven end to end:
 *  - push.vapid.get returns the public application-server key, and never the
 *    private key.
 *  - subscribe (push.subscriptions.create) stores a device and list shows it;
 *    the wire view is redacted (no capability URL, no key material).
 *  - verify (push.subscriptions.verify) sends a real encrypted delivery to the
 *    sink: correct aes128gcm body shape + TTL/Urgency/VAPID headers, and the
 *    ciphertext DECRYPTS back to the test payload (RFC 8291 round trip).
 *  - a created approval fans out as a high-urgency push to the subscription
 *    (the real event source), decrypting to the approval summary.
 *  - a 410-gone endpoint is pruned with an honest `pruned` receipt and vanishes
 *    from the list (delete means delete on prune too).
 *  - unsubscribe removes the record; a second delete is an honest 404.
 *  - the VAPID private key never appears in any read verb, and lives in the
 *    secrets store on disk — never in the config.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { VAPID_SECRET_KEY } from '../packages/sdk/src/platform/push/index.ts';

const TOKEN = 'web-push-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

// ---------------------------------------------------------------------------
// The fake push sink — a local HTTP server standing in for a browser vendor's
// push service. It records every delivery and returns whatever status the path
// asks for (default 201 accepted; `/gone/*` returns 410).
// ---------------------------------------------------------------------------
interface CapturedPush {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}
const captured: CapturedPush[] = [];
let sink: ReturnType<typeof Bun.serve>;
let sinkOrigin: string;

// A stable client (receiver) keypair so we can decrypt what the daemon sends.
const client = createECDH('prime256v1');
client.generateKeys();
const clientPublic = client.getPublicKey();
const authSecret = randomBytes(16);
const p256dh = clientPublic.toString('base64url');
const auth = authSecret.toString('base64url');

function auth401(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

interface InvokeResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function invokeVerb(methodId: string, body: unknown = {}): Promise<InvokeResult> {
  const res = await fetch(`${daemon.url}/api/control-plane/methods/${methodId}/invoke`, {
    method: 'POST',
    headers: auth401(),
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  return { status: res.status, json: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const okm = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return okm.subarray(0, length);
}

/** Decrypt an aes128gcm web-push body back to its JSON payload (RFC 8291 receiver side). */
function decryptPush(body: Buffer): { title: string; body: string; data?: Record<string, unknown> } {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const sharedSecret = client.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, senderPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const payload = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  // Strip the trailing 0x02 last-record delimiter.
  const json = plaintext.subarray(0, plaintext.length - 1).toString('utf8');
  return JSON.parse(json) as { title: string; body: string; data?: Record<string, unknown> };
}

async function waitForPush(predicate: (p: CapturedPush) => boolean, timeoutMs = 3000): Promise<CapturedPush> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = captured.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for a matching push delivery');
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'webpush-home-'));
  work = mkdtempSync(join(tmpdir(), 'webpush-work-'));
  sink = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = Buffer.from(await req.arrayBuffer());
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => { headers[key] = value; });
      captured.push({ path: url.pathname, headers, body });
      const status = url.pathname.startsWith('/gone')
        ? 410
        : url.pathname.startsWith('/fail')
          ? 500
          : 201;
      return new Response(null, { status });
    },
  });
  sinkOrigin = `http://127.0.0.1:${sink.port}`;
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
  sink?.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('web push — VAPID public key', () => {
  test('push.vapid.get returns the public key and never the private key', async () => {
    const { status, json } = await invokeVerb('push.vapid.get');
    expect(status).toBe(200);
    const publicKey = json.publicKey as string;
    expect(typeof publicKey).toBe('string');
    // 65-byte uncompressed P-256 point, base64url.
    expect(Buffer.from(publicKey, 'base64url').length).toBe(65);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('privateJwk');
    expect(serialized).not.toContain('"d"');
  });
});

describe('web push — subscription lifecycle', () => {
  let subscriptionId: string;

  test('subscribe stores a device; the wire view is redacted', async () => {
    const endpoint = `${sinkOrigin}/push/device-a`;
    const { status, json } = await invokeVerb('push.subscriptions.create', { endpoint, keys: { p256dh, auth } });
    expect(status).toBe(200);
    const sub = json.subscription as Record<string, unknown>;
    subscriptionId = sub.id as string;
    expect(subscriptionId).toStartWith('push-');
    expect(sub.endpointOrigin).toBe(sinkOrigin);
    // Redacted: the capability URL and key material are never returned.
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('/push/device-a');
    expect(serialized).not.toContain(p256dh);
    expect(serialized).not.toContain(auth);
  });

  test('list shows the subscription (still redacted)', async () => {
    const { status, json } = await invokeVerb('push.subscriptions.list');
    expect(status).toBe(200);
    const subs = json.subscriptions as Array<{ id: string; endpointOrigin: string }>;
    expect(subs.some((s) => s.id === subscriptionId)).toBe(true);
    expect(JSON.stringify(json)).not.toContain('/push/device-a');
  });

  test('verify sends a correctly-encrypted delivery with TTL/Urgency/VAPID headers', async () => {
    const before = captured.length;
    const { status, json } = await invokeVerb('push.subscriptions.verify', { subscriptionId });
    expect(status).toBe(200);
    const receipt = json.receipt as Record<string, unknown>;
    expect(receipt.outcome).toBe('delivered');
    expect(receipt.httpStatus).toBe(201);

    const push = captured[before];
    expect(push?.path).toBe('/push/device-a');
    expect(push?.headers['content-encoding']).toBe('aes128gcm');
    expect(push?.headers.ttl).toBeDefined();
    expect(Number(push?.headers.ttl)).toBeGreaterThan(0);
    expect(push?.headers.urgency).toBeDefined();
    expect(push?.headers.authorization).toStartWith('vapid t=');
    // aes128gcm header shape: salt(16) | rs(4) | idlen(1)=65 | key(65).
    expect(push!.body.readUInt8(20)).toBe(65);
    expect(push!.body.length).toBeGreaterThan(86);
    // And it actually decrypts to the test payload.
    const decrypted = decryptPush(push!.body);
    expect(decrypted.title).toContain('test');
  });

  test('unsubscribe removes the record; a second delete is an honest 404', async () => {
    const del = await invokeVerb('push.subscriptions.delete', { subscriptionId });
    expect(del.status).toBe(200);
    expect((del.json as { deleted: boolean }).deleted).toBe(true);

    const list = await invokeVerb('push.subscriptions.list');
    const subs = (list.json.subscriptions as Array<{ id: string }>);
    expect(subs.some((s) => s.id === subscriptionId)).toBe(false);

    const again = await invokeVerb('push.subscriptions.delete', { subscriptionId });
    expect(again.status).toBe(404);
  });
});

describe('web push — real event source (approval fan-out)', () => {
  test('a created approval fans out as a high-urgency push to the subscription', async () => {
    const endpoint = `${sinkOrigin}/push/device-approvals`;
    await invokeVerb('push.subscriptions.create', { endpoint, keys: { p256dh, auth } });

    const request = {
      callId: 'call-approval-1',
      tool: 'edit',
      args: { edits: [] },
      category: 'write',
      analysis: { classification: 'edit', riskLevel: 'medium', summary: 'edit the config file', reasons: ['test'] },
    } as PermissionPromptRequest;
    // Do not await — the approval stays pending; we only need its creation to fire.
    void daemon.approvals.requestApproval({ request, sessionId: 'approval-session' });

    const push = await waitForPush((p) => p.path === '/push/device-approvals');
    expect(push.headers['content-encoding']).toBe('aes128gcm');
    expect(push.headers.urgency).toBe('high');
    const decrypted = decryptPush(push.body);
    expect(decrypted.title).toBe('Approval required');
    expect(decrypted.body).toContain('edit the config file');
    expect(decrypted.data?.kind).toBe('approval');
  });
});

describe('web push — honest degrade (410 gone pruned with receipt)', () => {
  test('a 410-gone endpoint is pruned and reported, not faked', async () => {
    const endpoint = `${sinkOrigin}/gone/device-dead`;
    const created = await invokeVerb('push.subscriptions.create', { endpoint, keys: { p256dh, auth } });
    const goneId = (created.json.subscription as { id: string }).id;

    const verify = await invokeVerb('push.subscriptions.verify', { subscriptionId: goneId });
    const receipt = verify.json.receipt as Record<string, unknown>;
    expect(receipt.outcome).toBe('pruned');
    expect(receipt.httpStatus).toBe(410);

    // Pruned means gone from the list.
    const list = await invokeVerb('push.subscriptions.list');
    const subs = list.json.subscriptions as Array<{ id: string }>;
    expect(subs.some((s) => s.id === goneId)).toBe(false);
  });
});

describe('web push — self-heal on open (device-identity reconcile)', () => {
  test('a rotated endpoint heals the one record in place and reports the drift', async () => {
    const deviceId = 'device-phone-1';
    const first = `${sinkOrigin}/push/heal-old`;
    const created = await invokeVerb('push.subscriptions.reconcile', { deviceId, endpoint: first, keys: { p256dh, auth } });
    expect(created.status).toBe(200);
    expect(created.json.drift).toBe('created');
    const createdId = (created.json.subscription as { id: string; deviceId: string }).id;
    expect((created.json.subscription as { deviceId: string }).deviceId).toBe(deviceId);

    // The browser's push endpoint rotates; it re-presents the SAME deviceId.
    const rotated = `${sinkOrigin}/push/heal-new`;
    const healed = await invokeVerb('push.subscriptions.reconcile', { deviceId, endpoint: rotated, keys: { p256dh, auth } });
    expect(healed.status).toBe(200);
    expect(healed.json.drift).toBe('endpoint-updated');
    // Same record id — healed in place, not a duplicate.
    expect((healed.json.subscription as { id: string }).id).toBe(createdId);

    // Exactly one record for this device (no stale duplicate left behind).
    const list = await invokeVerb('push.subscriptions.list');
    const mine = (list.json.subscriptions as Array<{ id: string; deviceId?: string }>).filter((s) => s.deviceId === deviceId);
    expect(mine).toHaveLength(1);

    // A no-op reconcile with the same endpoint reports 'unchanged'.
    const same = await invokeVerb('push.subscriptions.reconcile', { deviceId, endpoint: rotated, keys: { p256dh, auth } });
    expect(same.json.drift).toBe('unchanged');

    // A delivery now targets the NEW endpoint, proving the heal took effect.
    const before = captured.length;
    await invokeVerb('push.subscriptions.verify', { subscriptionId: createdId });
    const push = captured[before];
    expect(push?.path).toBe('/push/heal-new');

    await invokeVerb('push.subscriptions.delete', { subscriptionId: createdId });
  });
});

describe('web push — bounded retries then prune on a dead (non-gone) endpoint', () => {
  test('repeated 500s prune the record after the bounded retries, with an honest receipt', async () => {
    const endpoint = `${sinkOrigin}/fail/device-flaky`;
    const created = await invokeVerb('push.subscriptions.create', { endpoint, keys: { p256dh, auth } });
    const failId = (created.json.subscription as { id: string }).id;

    let lastReceipt: Record<string, unknown> = {};
    // The endpoint never answers 404/410 — it just keeps 500ing. Each verify is a
    // failed delivery until the bounded-retry counter is crossed, then a prune.
    for (let i = 0; i < 10; i++) {
      const verify = await invokeVerb('push.subscriptions.verify', { subscriptionId: failId });
      lastReceipt = verify.json.receipt as Record<string, unknown>;
      if (lastReceipt.outcome === 'pruned') break;
      expect(lastReceipt.outcome).toBe('failed');
    }
    expect(lastReceipt.outcome).toBe('pruned');
    expect(String(lastReceipt.detail)).toContain('consecutive delivery failures');

    // Pruned means gone from the list.
    const list = await invokeVerb('push.subscriptions.list');
    const subs = list.json.subscriptions as Array<{ id: string }>;
    expect(subs.some((s) => s.id === failId)).toBe(false);
  });

  test('a successful delivery resets the failure counter so a flaky endpoint is not pruned', async () => {
    const deviceId = 'device-recovers';
    const failEndpoint = `${sinkOrigin}/fail/recover`;
    const created = await invokeVerb('push.subscriptions.create', { endpoint: failEndpoint, keys: { p256dh, auth }, deviceId });
    const id = (created.json.subscription as { id: string }).id;

    // A couple of failures, but below the prune threshold.
    await invokeVerb('push.subscriptions.verify', { subscriptionId: id });
    await invokeVerb('push.subscriptions.verify', { subscriptionId: id });

    // The endpoint recovers: reconcile to a healthy path — this both heals the
    // endpoint and resets the counter; a delivery then succeeds.
    const healthy = `${sinkOrigin}/push/recovered`;
    await invokeVerb('push.subscriptions.reconcile', { deviceId, endpoint: healthy, keys: { p256dh, auth } });
    const verify = await invokeVerb('push.subscriptions.verify', { subscriptionId: id });
    expect((verify.json.receipt as { outcome: string }).outcome).toBe('delivered');

    // Still present (never pruned), and its failure counter reads 0.
    const list = await invokeVerb('push.subscriptions.list');
    const mine = (list.json.subscriptions as Array<{ id: string; consecutiveFailures?: number }>).find((s) => s.id === id);
    expect(mine).toBeDefined();
    expect(mine?.consecutiveFailures ?? 0).toBe(0);

    await invokeVerb('push.subscriptions.delete', { subscriptionId: id });
  });
});

describe('web push — VAPID private key custody', () => {
  test('the private key is held by the secrets store, never returned by a read verb, never in config', async () => {
    // The private key is retrievable ONLY through the SecretsManager (the same
    // secret-store posture as any credential) — proving it was stored as a
    // secret, not written into the config. Earlier delivery tests already forced
    // the keypair to be minted.
    const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes' });
    const secrets = new SecretsManager({
      projectRoot: work,
      globalHome: home,
      surfaceRoot: 'goodvibes',
      configManager,
    });
    const storedRaw = await secrets.get(VAPID_SECRET_KEY);
    expect(storedRaw).not.toBeNull();
    const stored = JSON.parse(storedRaw as string) as { publicKey: string; privateJwk: { d?: string } };
    const privateD = stored.privateJwk.d;
    expect(typeof privateD).toBe('string');
    expect((privateD as string).length).toBeGreaterThan(0);

    // The private component must NOT appear anywhere in a config/settings file.
    const configFiles = collectFiles([home, work]).filter((f) => /settings\.json$|config\.json$/.test(f.path));
    for (const cfg of configFiles) {
      expect(cfg.text).not.toContain(privateD as string);
    }

    // And no read verb ever exposed it: re-check the public-key read surface.
    const vapid = await invokeVerb('push.vapid.get');
    expect(vapid.json.publicKey).toBe(stored.publicKey);
    expect(JSON.stringify(vapid.json)).not.toContain(privateD as string);
  });
});

interface DiskFile { readonly path: string; readonly text: string; }
function collectFiles(roots: string[]): DiskFile[] {
  const out: DiskFile[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full);
      } else if (s.isFile() && s.size < 2_000_000) {
        try {
          out.push({ path: full, text: readFileSync(full, 'utf8') });
        } catch {
          // Binary / unreadable files are irrelevant to a text-key search.
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}
