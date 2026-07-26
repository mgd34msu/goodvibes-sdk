/**
 * web-push-vapid-chain.test.ts
 *
 * The VAPID signing chain and the fleet-driven push triggers, proven over a REAL
 * bootDaemon (isolated home, ephemeral port, token auth) against a LOCAL sink
 * that behaves like a push service. Nothing here talks to a browser vendor, and
 * no key is supplied from outside — the daemon mints and keeps its own.
 *
 * What is proven end to end, beyond web-push-daemon-wire.test.ts:
 *  - Keypair lifecycle: first need generates and persists; every later need —
 *    including a SECOND DAEMON booted over the same home — reuses the same pair
 *    rather than regenerating (a regenerated key silently invalidates every
 *    live browser subscription, so this is load-bearing).
 *  - The public key `push.vapid.get` returns is a real P-256 point that imports
 *    as a public key, and is byte-identical to the one the pairing hand-off
 *    offer set advertises.
 *  - The `Authorization: vapid t=…, k=…` header on a REAL delivery carries a JWT
 *    whose ES256 signature VERIFIES against that public key, whose `aud` is the
 *    sink's origin, and whose `sub` is the configured contact.
 *  - A fleet node blocking on the operator and a fleet node finishing each reach
 *    dispatch and arrive at the sink as decryptable 'needs-input' / 'completion'
 *    pushes — driven through the production emit-bridge on the daemon's own
 *    runtime bus, not by calling PushService directly.
 *  - A 5xx keeps the subscription (only 404/410, or exhausted bounded retries,
 *    remove it).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { VapidManager, VAPID_SECRET_KEY } from '../packages/sdk/src/platform/push/index.ts';
import { attachFleetEmitBridge } from '../packages/sdk/src/platform/runtime/fleet/index.ts';
import type {
  FleetSnapshot,
  ProcessAttentionReason,
  ProcessNode,
  ProcessState,
} from '../packages/sdk/src/platform/runtime/fleet/index.ts';

const TOKEN = 'vapid-chain-token';
let home: string;
let work: string;
let daemon: BootedDaemon;
let detachBridge: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Local sink standing in for a push service. Records every delivery verbatim.
// ---------------------------------------------------------------------------
interface CapturedPush {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}
const captured: CapturedPush[] = [];
let sink: ReturnType<typeof Bun.serve>;
let sinkOrigin: string;

// A stable receiver keypair so the test can decrypt what the daemon sends.
const client = createECDH('prime256v1');
client.generateKeys();
const clientPublic = client.getPublicKey();
const authSecret = randomBytes(16);
const p256dh = clientPublic.toString('base64url');
const auth = authSecret.toString('base64url');

interface InvokeResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function invokeOn(url: string, methodId: string, body: unknown = {}): Promise<InvokeResult> {
  const res = await fetch(`${url}/api/control-plane/methods/${methodId}/invoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  return { status: res.status, json: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
}

function invokeVerb(methodId: string, body: unknown = {}): Promise<InvokeResult> {
  return invokeOn(daemon.url, methodId, body);
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
  return JSON.parse(plaintext.subarray(0, plaintext.length - 1).toString('utf8')) as {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
}

async function waitForPush(predicate: (p: CapturedPush) => boolean, timeoutMs = 5000): Promise<CapturedPush> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = captured.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for a matching push delivery');
}

// ---------------------------------------------------------------------------
// VAPID header / JWT verification helpers (the receiving push service's job).
// ---------------------------------------------------------------------------
interface VapidAuth {
  readonly jwt: string;
  /** The `k=` parameter — the application-server public key, base64url. */
  readonly k: string;
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Buffer;
}

function parseVapidAuthorization(value: string): VapidAuth {
  const match = /^vapid\s+t=([^,\s]+),\s*k=(\S+)$/.exec(value);
  if (!match) throw new Error(`not a VAPID authorization header: ${value}`);
  const jwt = match[1] as string;
  const k = match[2] as string;
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('VAPID JWT is not three dot-separated parts');
  const [h, p, s] = parts as [string, string, string];
  return {
    jwt,
    k,
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>,
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

/** Rebuild a P-256 public KeyObject from the raw uncompressed point the daemon publishes. */
function publicKeyFromRawPoint(raw: string): KeyObject {
  const point = Buffer.from(raw, 'base64url');
  if (point.length !== 65 || point.readUInt8(0) !== 0x04) {
    throw new Error(`not a 65-byte uncompressed P-256 point (len=${point.length})`);
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

function verifyVapidSignature(vapid: VapidAuth, publicKey: string): boolean {
  return cryptoVerify(
    'sha256',
    Buffer.from(vapid.signingInput, 'utf8'),
    { key: publicKeyFromRawPoint(publicKey), dsaEncoding: 'ieee-p1363' },
    vapid.signature,
  );
}

// ---------------------------------------------------------------------------
// Disk helpers.
// ---------------------------------------------------------------------------
interface DiskFile { readonly path: string; readonly text: string; }
function collectFiles(roots: readonly string[]): DiskFile[] {
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
      if (s.isDirectory()) walk(full);
      else if (s.isFile() && s.size < 2_000_000) {
        try {
          out.push({ path: full, text: readFileSync(full, 'utf8') });
        } catch {
          // Binary/unreadable files are irrelevant to a text search.
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

function readStoredKeypair(): Promise<string | null> {
  const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes' });
  const secrets = new SecretsManager({
    projectRoot: work,
    globalHome: home,
    surfaceRoot: 'goodvibes',
    configManager,
  });
  return secrets.get(VAPID_SECRET_KEY);
}

// ---------------------------------------------------------------------------
// Fleet snapshot source — the production emit-bridge is attached to the DAEMON'S
// OWN runtime bus, so a node transition travels the real path:
// snapshot -> emit-bridge -> bus 'fleet' domain -> the push wiring in
// register-gateway-verb-groups -> PushService -> VAPID-signed HTTP delivery.
// ---------------------------------------------------------------------------
const snapshotListeners = new Set<(s: FleetSnapshot) => void>();
function emitSnapshot(nodes: readonly ProcessNode[]): void {
  const snapshot: FleetSnapshot = { capturedAt: Date.now(), nodes };
  for (const listener of snapshotListeners) listener(snapshot);
}
function fleetNode(id: string, state: ProcessState, extra: Partial<ProcessNode> = {}): ProcessNode {
  return {
    id,
    kind: 'agent',
    label: `run ${id}`,
    state,
    elapsedMs: 1000,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
    ...extra,
  };
}
function attention(reason: ProcessAttentionReason): Pick<ProcessNode, 'needsAttention'> {
  return { needsAttention: { reason } };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'vapidchain-home-'));
  work = mkdtempSync(join(tmpdir(), 'vapidchain-work-'));
  sink = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = Buffer.from(await req.arrayBuffer());
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => { headers[key] = value; });
      captured.push({ path: url.pathname, headers, body });
      const status = url.pathname.startsWith('/gone') ? 410 : url.pathname.startsWith('/fail') ? 500 : 201;
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
  detachBridge = attachFleetEmitBridge({
    registry: {
      subscribe: (listener) => {
        snapshotListeners.add(listener);
        return () => snapshotListeners.delete(listener);
      },
    },
    bus: daemon.server.eventBus,
  });
});

afterAll(async () => {
  detachBridge?.();
  await daemon?.stop();
  sink?.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('web push — VAPID keypair lifecycle (generate once, reuse forever)', () => {
  test('the first need mints and persists the pair into the secrets store', async () => {
    // Nothing has asked for a key yet, so nothing should exist.
    expect(await readStoredKeypair()).toBeNull();

    const first = await invokeVerb('push.vapid.get');
    expect(first.status).toBe(200);
    const publicKey = first.json.publicKey as string;
    expect(typeof publicKey).toBe('string');

    const storedRaw = await readStoredKeypair();
    expect(storedRaw).not.toBeNull();
    const stored = JSON.parse(storedRaw as string) as { publicKey: string; privateJwk: { d?: string; crv?: string } };
    expect(stored.publicKey).toBe(publicKey);
    expect(stored.privateJwk.crv).toBe('P-256');
    expect(typeof stored.privateJwk.d).toBe('string');
  });

  test('later needs reuse the SAME pair — no silent regeneration', async () => {
    const storedBefore = await readStoredKeypair();
    const first = (await invokeVerb('push.vapid.get')).json.publicKey as string;

    // Repeated reads, a subscribe, and a real delivery all force the key path.
    const second = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    const created = await invokeVerb('push.subscriptions.create', {
      endpoint: `${sinkOrigin}/push/reuse-check`,
      keys: { p256dh, auth },
    });
    const id = (created.json.subscription as { id: string }).id;
    await invokeVerb('push.subscriptions.verify', { subscriptionId: id });
    const third = (await invokeVerb('push.vapid.get')).json.publicKey as string;

    expect(second).toBe(first);
    expect(third).toBe(first);
    // Byte-identical stored secret: the pair was loaded, never re-minted.
    expect(await readStoredKeypair()).toBe(storedBefore);

    // A fresh VapidManager over the same secrets store (a cold second consumer)
    // loads the persisted pair instead of generating a new one.
    const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes' });
    const secrets = new SecretsManager({ projectRoot: work, globalHome: home, surfaceRoot: 'goodvibes', configManager });
    const coldManager = new VapidManager(secrets);
    expect(await coldManager.getPublicKey()).toBe(first);
    expect(await readStoredKeypair()).toBe(storedBefore);

    await invokeVerb('push.subscriptions.delete', { subscriptionId: id });
  });

  test('a SECOND daemon booted over the same home serves the same key', async () => {
    const first = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    const storedBefore = await readStoredKeypair();

    const second = await bootDaemon({
      homeDirectory: home,
      workingDir: work,
      daemonHomeDir: join(home, 'daemon'),
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    try {
      const fromRestart = await invokeOn(second.url, 'push.vapid.get');
      expect(fromRestart.status).toBe(200);
      expect(fromRestart.json.publicKey).toBe(first);
    } finally {
      await second.stop();
    }
    expect(await readStoredKeypair()).toBe(storedBefore);
  });

  test('the private component is in no verb response and in no config file', async () => {
    const stored = JSON.parse((await readStoredKeypair()) as string) as { privateJwk: { d: string } };
    const privateD = stored.privateJwk.d;
    expect(privateD.length).toBeGreaterThan(0);

    const responses = [
      await invokeVerb('push.vapid.get'),
      await invokeVerb('push.subscriptions.list'),
      await invokeVerb('pairing.handoff.create', { name: 'custody-probe', offers: ['notifications'] }),
    ];
    for (const response of responses) {
      const serialized = JSON.stringify(response.json);
      expect(serialized).not.toContain(privateD);
      expect(serialized).not.toContain('privateJwk');
    }

    // Stronger than "not in the config": the private component appears in NO
    // file under either root in plaintext. It reaches disk only through the
    // SecretsManager, which writes it encrypted at rest.
    const onDisk = collectFiles([home, work]);
    expect(onDisk.length).toBeGreaterThan(0);
    const leaks = onDisk.filter((f) => f.text.includes(privateD)).map((f) => f.path);
    expect(leaks).toEqual([]);
    // And the config snapshot in particular carries neither half of the pair.
    const configFiles = onDisk.filter((f) => /settings\.json$|goodvibes\.json$|config\.json$/.test(f.path));
    for (const cfg of configFiles) {
      expect(cfg.text).not.toContain(privateD);
      expect(cfg.text).not.toContain('vapid');
    }
  });
});

describe('web push — the published application-server key', () => {
  test('push.vapid.get returns an importable 65-byte P-256 point', async () => {
    const publicKey = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    const point = Buffer.from(publicKey, 'base64url');
    expect(point.length).toBe(65);
    expect(point.readUInt8(0)).toBe(0x04);
    // base64url, not base64: a browser passes this straight to applicationServerKey.
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // It imports as a real public key (throws if the point is not on the curve).
    expect(publicKeyFromRawPoint(publicKey).asymmetricKeyType).toBe('ec');
  });

  test('the pairing hand-off offer set advertises the SAME key', async () => {
    const publicKey = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    const handoff = await invokeVerb('pairing.handoff.create', { name: 'offer-set-probe', offers: ['notifications'] });
    expect(handoff.status).toBe(200);
    const offers = handoff.json.offers as ReadonlyArray<{ kind: string; available: boolean; vapidPublicKey?: string }>;
    const notifications = offers.find((offer) => offer.kind === 'notifications');
    expect(notifications).toBeDefined();
    expect(notifications?.available).toBe(true);
    expect(notifications?.vapidPublicKey).toBe(publicKey);
  });
});

describe('web push — the VAPID Authorization JWT on a real delivery', () => {
  test('the signature verifies against the published key, with the right aud and sub', async () => {
    const created = await invokeVerb('push.subscriptions.create', {
      endpoint: `${sinkOrigin}/push/jwt-probe`,
      keys: { p256dh, auth },
    });
    const id = (created.json.subscription as { id: string }).id;
    const before = captured.length;
    const receipt = await invokeVerb('push.subscriptions.verify', { subscriptionId: id });
    expect((receipt.json.receipt as { outcome: string }).outcome).toBe('delivered');

    const delivery = captured[before] as CapturedPush;
    expect(delivery.path).toBe('/push/jwt-probe');
    const vapid = parseVapidAuthorization(delivery.headers.authorization as string);

    // Header: ES256 over a JWT, exactly what RFC 8292 requires.
    expect(vapid.header.typ).toBe('JWT');
    expect(vapid.header.alg).toBe('ES256');
    // Raw r||s JOSE signature, not DER.
    expect(vapid.signature.length).toBe(64);

    // Claims: audience is THIS endpoint's origin; subject is a reachable contact;
    // expiry is in the future and inside RFC 8292's 24h cap.
    expect(vapid.claims.aud).toBe(sinkOrigin);
    expect(typeof vapid.claims.sub).toBe('string');
    expect(String(vapid.claims.sub)).toMatch(/^(mailto|https):/);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(vapid.claims.exp as number).toBeGreaterThan(nowSeconds);
    expect(vapid.claims.exp as number).toBeLessThanOrEqual(nowSeconds + 24 * 60 * 60);

    // The `k=` parameter is the daemon's published key…
    const publicKey = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    expect(vapid.k).toBe(publicKey);
    // …and the JWT actually verifies under it — the daemon signed with the
    // private half of the pair it publishes.
    expect(verifyVapidSignature(vapid, publicKey)).toBe(true);

    // A tampered payload must NOT verify (the check above is not vacuous).
    const tampered: VapidAuth = { ...vapid, signingInput: `${vapid.signingInput}x` };
    expect(verifyVapidSignature(tampered, publicKey)).toBe(false);

    await invokeVerb('push.subscriptions.delete', { subscriptionId: id });
  });

  test('a configured subject becomes the JWT `sub`', async () => {
    // The signing path itself, over the real secrets store, with an explicit
    // contact — proving `sub` is the configured subject and not a constant.
    const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes' });
    const secrets = new SecretsManager({ projectRoot: work, globalHome: home, surfaceRoot: 'goodvibes', configManager });
    const manager = new VapidManager(secrets, { subject: 'mailto:ops@example.test' });
    const header = await manager.buildAuthorizationHeader(`${sinkOrigin}/push/subject-probe`);
    const vapid = parseVapidAuthorization(header);
    expect(vapid.claims.sub).toBe('mailto:ops@example.test');
    expect(vapid.claims.aud).toBe(sinkOrigin);
    const publicKey = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    expect(verifyVapidSignature(vapid, publicKey)).toBe(true);
  });
});

describe('web push — subscription storage survives a restart', () => {
  test('a registered subscription is persisted on disk and served after a reboot', async () => {
    const created = await invokeVerb('push.subscriptions.create', {
      endpoint: `${sinkOrigin}/push/persisted`,
      keys: { p256dh, auth },
      deviceId: 'device-persisted',
    });
    const id = (created.json.subscription as { id: string }).id;

    // It reached the daemon's own state file, endpoint and keys included (this
    // file is the capability store — it never goes on the wire).
    const stateFiles = collectFiles([home, work]).filter((f) => f.path.endsWith('push-subscriptions.json'));
    expect(stateFiles.length).toBe(1);
    const snapshot = JSON.parse((stateFiles[0] as DiskFile).text) as {
      subscriptions: ReadonlyArray<{ id: string; endpoint: string; keys: { p256dh: string; auth: string } }>;
    };
    const persisted = snapshot.subscriptions.find((s) => s.id === id);
    expect(persisted?.endpoint).toBe(`${sinkOrigin}/push/persisted`);
    expect(persisted?.keys.p256dh).toBe(p256dh);

    // A second daemon over the same home serves it back and can deliver to it.
    const second = await bootDaemon({
      homeDirectory: home,
      workingDir: work,
      daemonHomeDir: join(home, 'daemon'),
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    try {
      const list = await invokeOn(second.url, 'push.subscriptions.list');
      const ids = (list.json.subscriptions as ReadonlyArray<{ id: string }>).map((s) => s.id);
      expect(ids).toContain(id);
      const before = captured.length;
      const verify = await invokeOn(second.url, 'push.subscriptions.verify', { subscriptionId: id });
      expect((verify.json.receipt as { outcome: string }).outcome).toBe('delivered');
      expect(captured[before]?.path).toBe('/push/persisted');
    } finally {
      await second.stop();
    }
    await invokeVerb('push.subscriptions.delete', { subscriptionId: id });
  });
});

describe('web push — failure handling distinguishes gone from broken', () => {
  test('a 5xx keeps the subscription; only gone (or exhausted retries) removes it', async () => {
    const created = await invokeVerb('push.subscriptions.create', {
      endpoint: `${sinkOrigin}/fail/keeps-record`,
      keys: { p256dh, auth },
      deviceId: 'device-5xx',
    });
    const id = (created.json.subscription as { id: string }).id;

    const verify = await invokeVerb('push.subscriptions.verify', { subscriptionId: id });
    const receipt = verify.json.receipt as { outcome: string; httpStatus?: number };
    expect(receipt.outcome).toBe('failed');
    expect(receipt.httpStatus).toBe(500);

    // Still there, with an honest failure counter — not deleted, not retried away.
    const list = await invokeVerb('push.subscriptions.list');
    const mine = (list.json.subscriptions as ReadonlyArray<{ id: string; consecutiveFailures?: number; lastOutcome?: string }>)
      .find((s) => s.id === id);
    expect(mine).toBeDefined();
    expect(mine?.lastOutcome).toBe('failed');
    expect(mine?.consecutiveFailures).toBe(1);

    await invokeVerb('push.subscriptions.delete', { subscriptionId: id });
  });

  test('a 404 gone prunes the subscription', async () => {
    const created = await invokeVerb('push.subscriptions.create', {
      endpoint: `${sinkOrigin}/gone/404-probe`,
      keys: { p256dh, auth },
    });
    const id = (created.json.subscription as { id: string }).id;
    const verify = await invokeVerb('push.subscriptions.verify', { subscriptionId: id });
    const receipt = verify.json.receipt as { outcome: string; httpStatus?: number };
    expect(receipt.outcome).toBe('pruned');
    expect(receipt.httpStatus).toBe(410);
    const list = await invokeVerb('push.subscriptions.list');
    expect((list.json.subscriptions as ReadonlyArray<{ id: string }>).some((s) => s.id === id)).toBe(false);
  });
});

describe('web push — the fleet triggers reach dispatch', () => {
  test('a node blocked on the operator arrives as a needs-input push', async () => {
    const created = await invokeVerb('push.subscriptions.create', {
      endpoint: `${sinkOrigin}/push/needs-input`,
      keys: { p256dh, auth },
      deviceId: 'device-needs-input',
    });
    const subscriptionId = (created.json.subscription as { id: string }).id;

    // Seed the bridge (a first snapshot emits nothing by design), then transition
    // the node INTO the block — the observed transition the bridge reports.
    emitSnapshot([fleetNode('node-block-1', 'thinking', { sessionRef: { sessionId: 'session-block-1' } })]);
    emitSnapshot([
      fleetNode('node-block-1', 'thinking', {
        sessionRef: { sessionId: 'session-block-1' },
        ...attention('input'),
      }),
    ]);

    const push = await waitForPush((p) => p.path === '/push/needs-input');
    expect(push.headers.urgency).toBe('high');
    expect(push.headers['content-encoding']).toBe('aes128gcm');
    // The delivery is VAPID-signed by the same key the daemon publishes.
    const vapid = parseVapidAuthorization(push.headers.authorization as string);
    const publicKey = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    expect(vapid.claims.aud).toBe(sinkOrigin);
    expect(verifyVapidSignature(vapid, publicKey)).toBe(true);

    const decrypted = decryptPush(push.body);
    expect(decrypted.title).toBe('Input needed');
    expect(decrypted.body).toContain('run node-block-1');
    expect(decrypted.data?.kind).toBe('needs-input');
    expect(decrypted.data?.nodeId).toBe('node-block-1');
    expect(decrypted.data?.sessionId).toBe('session-block-1');

    await invokeVerb('push.subscriptions.delete', { subscriptionId });
  });

  test('a node reaching a terminal state arrives as a completion push', async () => {
    const created = await invokeVerb('push.subscriptions.create', {
      endpoint: `${sinkOrigin}/push/completion`,
      keys: { p256dh, auth },
      deviceId: 'device-completion',
    });
    const subscriptionId = (created.json.subscription as { id: string }).id;

    emitSnapshot([fleetNode('node-run-1', 'thinking', { sessionRef: { sessionId: 'session-run-1' } })]);
    emitSnapshot([fleetNode('node-run-1', 'done', { sessionRef: { sessionId: 'session-run-1' } })]);

    const push = await waitForPush((p) => p.path === '/push/completion');
    const vapid = parseVapidAuthorization(push.headers.authorization as string);
    const publicKey = (await invokeVerb('push.vapid.get')).json.publicKey as string;
    expect(verifyVapidSignature(vapid, publicKey)).toBe(true);

    const decrypted = decryptPush(push.body);
    expect(decrypted.title).toBe('Run completed');
    expect(decrypted.body).toContain('run node-run-1');
    expect(decrypted.body).toContain('completed');
    expect(decrypted.data?.kind).toBe('completion');
    expect(decrypted.data?.nodeId).toBe('node-run-1');
    expect(decrypted.data?.sessionId).toBe('session-run-1');

    await invokeVerb('push.subscriptions.delete', { subscriptionId });
  });
});
