/**
 * push-subscription-housekeeping.test.ts
 *
 * The custody rules for `push-subscriptions.json`, proven against the real
 * store on a real temp directory (no mocks of the persistence layer):
 *
 *  - Registration validates by CONTENT: a junk p256dh, a short auth secret, an
 *    oversized endpoint, and a non-http(s) scheme are each refused with a plain
 *    reason, so a record that could never receive a push is never stored.
 *  - The per-principal figure is a WARNING, not a cap. Passing it accepts the
 *    new device anyway and discloses the crowding — nothing that still works is
 *    ever removed to make room, so nobody has to resubscribe.
 *  - Only PROVABLY dead records are reaped: unusable key material, a torn
 *    record, or an endpoint the push service refused past the bounded-failure
 *    threshold. Age alone never removes anything.
 *  - Reaping happens on recovery AND on the periodic sweep, is idempotent, and
 *    every removal is disclosed with the evidence.
 *  - The VAPID `sub` contact: a configured one is signed into the JWT and the
 *    signature still verifies; an invalid one is rejected rather than signed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import {
  createPushService,
  createPushSubscriptionStore,
} from '../packages/sdk/src/platform/control-plane/routes/push-composition.ts';
import type { ConfigKey } from '../packages/sdk/src/platform/config/schema.ts';
import {
  DEFAULT_VAPID_SUBJECT,
  PushSubscriptionStore,
  PushSubscriptionValidationError,
  VapidManager,
  isValidVapidSubject,
  type PushSubscriptionPolicy,
  type PushSubscriptionSweepReport,
  type StoredPushSubscription,
} from '../packages/sdk/src/platform/push/index.ts';

// ---------------------------------------------------------------------------
// Real key material — a genuine 65-byte uncompressed P-256 point + 16-byte auth.
// ---------------------------------------------------------------------------
function realKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

/**
 * Per-test ceiling for the tests below that do real work — real ECDH keygen,
 * real VAPID JWT signing, a real HTTP delivery to a real local socket, and real
 * file writes. A ceiling, not a target: nothing waits it out, so a fast host is
 * unaffected. bun's implicit 5 s default is an idle machine's number for that
 * mix, and this suite runs all 645 of its files in ONE process alongside
 * everything else.
 */
const REAL_WORK_BUDGET_MS = 60_000;

/**
 * A sweep interval no test run can outlive.
 *
 * `createPushService` builds its own subscription store internally and starts
 * that store's periodic sweep; the store is private, so a caller has no way to
 * stop it. In a suite that runs every file in one process, a sweeper left
 * running on a directory a later `afterEach` deletes is a cross-file hazard
 * that only shows up when the machine is slow enough for the timer to land in
 * the wrong place. Configuring the interval past any plausible run removes the
 * hazard from these tests without pretending the underlying lifecycle gap is
 * fixed.
 */
const SWEEP_NEVER_MINUTES = 24 * 60;

let dir: string;
let storePath: string;
let disclosurePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-push-housekeeping-'));
  storePath = join(dir, 'push-subscriptions.json');
  disclosurePath = join(dir, 'push-subscriptions-housekeeping.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(records: readonly unknown[]): void {
  writeFileSync(storePath, `${JSON.stringify({ subscriptions: records }, null, 2)}\n`, 'utf-8');
}

function readStored(): unknown[] {
  const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as { subscriptions: unknown[] };
  return parsed.subscriptions;
}

function readDisclosures(): PushSubscriptionSweepReport[] {
  if (!existsSync(disclosurePath)) return [];
  const parsed = JSON.parse(readFileSync(disclosurePath, 'utf-8')) as { reports: PushSubscriptionSweepReport[] };
  return parsed.reports;
}

function makeStore(policy?: Partial<PushSubscriptionPolicy>): PushSubscriptionStore {
  return new PushSubscriptionStore(storePath, {
    policy: {
      warnAbovePerPrincipal: policy?.warnAbovePerPrincipal ?? 50,
      failureThreshold: policy?.failureThreshold ?? 5,
    },
  });
}

function record(overrides: Partial<StoredPushSubscription> & { id: string }): StoredPushSubscription {
  const keys = realKeys();
  return {
    principalId: 'op-1',
    endpoint: `https://push.example/${overrides.id}`,
    keys,
    createdAt: Date.now(),
    ...overrides,
  } as StoredPushSubscription;
}

// ---------------------------------------------------------------------------
// Registration validates by content
// ---------------------------------------------------------------------------
describe('registration refuses content that could never receive a push', () => {
  test('a junk p256dh is refused with the delivery path\'s own wording', async () => {
    const store = makeStore();
    const attempt = store.register({
      principalId: 'op-1',
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'not-base64!!!!', auth: randomBytes(16).toString('base64url') },
    });
    await expect(attempt).rejects.toThrow('Push subscription p256dh key is not a 65-byte uncompressed P-256 point');
    expect(existsSync(storePath)).toBe(false);
  });

  test('a p256dh of the right length but the wrong point marker is refused', async () => {
    const store = makeStore();
    const bogus = Buffer.concat([Buffer.from([0x02]), randomBytes(64)]).toString('base64url');
    await expect(store.register({
      principalId: 'op-1',
      endpoint: 'https://push.example/a',
      keys: { p256dh: bogus, auth: randomBytes(16).toString('base64url') },
    })).rejects.toThrow('65-byte uncompressed P-256 point');
  });

  test('a short auth secret is refused', async () => {
    const store = makeStore();
    const keys = realKeys();
    await expect(store.register({
      principalId: 'op-1',
      endpoint: 'https://push.example/a',
      keys: { p256dh: keys.p256dh, auth: 'x' },
    })).rejects.toThrow('Push subscription auth secret is not 16 bytes');
  });

  test('an oversized endpoint is refused with its bound named', async () => {
    const store = makeStore();
    const huge = `https://push.example/${'p'.repeat(50_000)}`;
    const attempt = store.register({ principalId: 'op-1', endpoint: huge, keys: realKeys() });
    await expect(attempt).rejects.toThrow('longer than 2048 characters');
  });

  test('a non-http(s) endpoint is refused', async () => {
    const store = makeStore();
    await expect(store.register({
      principalId: 'op-1',
      endpoint: 'file:///etc/passwd',
      keys: realKeys(),
    })).rejects.toThrow('http(s)');
  });

  test('the refusal is a typed error naming the offending field', async () => {
    const store = makeStore();
    let caught: unknown;
    try {
      await store.register({ principalId: 'op-1', endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PushSubscriptionValidationError);
    expect((caught as PushSubscriptionValidationError).field).toBe('keys.p256dh');
  });

  test('valid key material registers and round-trips', async () => {
    const store = makeStore();
    const created = await store.register({ principalId: 'op-1', endpoint: 'https://push.example/a', keys: realKeys() });
    expect(created.id).toStartWith('push-');
    expect(await store.all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The per-principal figure is a warning, never an eviction
// ---------------------------------------------------------------------------
describe('a working subscription is never removed to make room', () => {
  test('registering past the warning threshold accepts the new device and keeps every old one', async () => {
    const store = makeStore({ warnAbovePerPrincipal: 2 });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      const created = await store.register({
        principalId: 'op-1',
        deviceId: `dev-${name}`,
        endpoint: `https://push.example/${name}`,
        keys: realKeys(),
      });
      ids.push(created.id);
    }
    const all = await store.all();
    expect(all).toHaveLength(4);
    // Every device registered is still addressable — nothing was evicted.
    expect(all.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  test('the crowding is disclosed rather than acted on', async () => {
    const store = makeStore({ warnAbovePerPrincipal: 2 });
    for (const name of ['a', 'b', 'c']) {
      await store.register({
        principalId: 'op-1',
        deviceId: `dev-${name}`,
        endpoint: `https://push.example/${name}`,
        keys: realKeys(),
      });
    }
    const reports = readDisclosures();
    expect(reports.length).toBeGreaterThan(0);
    const latest = reports[reports.length - 1] as PushSubscriptionSweepReport;
    expect(latest.removed).toHaveLength(0);
    expect(latest.crowded).toEqual([{ principalId: 'op-1', count: 3, warnAbove: 2 }]);
    expect(latest.summary).toContain('a working device is never removed to make room');
  });

  test('a sweep over a crowded principal removes nothing', async () => {
    const store = makeStore({ warnAbovePerPrincipal: 1 });
    for (const name of ['a', 'b', 'c']) {
      await store.register({
        principalId: 'op-1',
        deviceId: `dev-${name}`,
        endpoint: `https://push.example/${name}`,
        keys: realKeys(),
      });
    }
    const report = await store.sweep('manual');
    expect(report.removed).toHaveLength(0);
    expect(report.retained).toBe(3);
    expect(await store.all()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Only provably dead records are reaped
// ---------------------------------------------------------------------------
describe('reaping requires evidence the subscription is already dead', () => {
  test('age alone never removes a subscription that has never had a delivery', async () => {
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    seed([record({ id: 'push-old', createdAt: ancient })]);
    const store = makeStore();
    const report = await store.runRecoverySweep();
    expect(report.removed).toHaveLength(0);
    expect(await store.all()).toHaveLength(1);
  });

  test('age since the last successful delivery never removes one either', async () => {
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    seed([record({ id: 'push-quiet', createdAt: ancient, lastDeliveryAt: ancient, lastOutcome: 'delivered' })]);
    const store = makeStore();
    const report = await store.runRecoverySweep();
    expect(report.removed).toHaveLength(0);
    expect(await store.all()).toHaveLength(1);
  });

  test('a record past the bounded-failure threshold is reaped on recovery with its evidence', async () => {
    seed([
      record({ id: 'push-dead', consecutiveFailures: 5 }),
      record({ id: 'push-live', consecutiveFailures: 1 }),
    ]);
    const store = makeStore({ failureThreshold: 5 });
    const report = await store.runRecoverySweep();
    expect(report.trigger).toBe('recovery');
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0]?.subscriptionId).toBe('push-dead');
    expect(report.removed[0]?.reason).toBe('failure-threshold');
    expect(report.removed[0]?.evidence).toContain('5 consecutive deliveries');
    // The capability URL never appears in disclosure — origin + hash only.
    expect(report.removed[0]?.endpointOrigin).toBe('https://push.example');
    expect(JSON.stringify(report)).not.toContain('/push-dead');
    const remaining = await store.all();
    expect(remaining.map((r) => r.id)).toEqual(['push-live']);
  });

  test('legacy junk key material is reaped as unusable, with the same wording registration refuses it in', async () => {
    seed([record({ id: 'push-junk', keys: { p256dh: 'p', auth: 'a' } })]);
    const store = makeStore();
    const report = await store.runRecoverySweep();
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0]?.reason).toBe('unusable');
    expect(report.removed[0]?.evidence).toContain('65-byte uncompressed P-256 point');
    expect(readStored()).toHaveLength(0);
  });

  test('a torn record is reaped as malformed rather than served', async () => {
    seed([{ id: 'push-torn' }, record({ id: 'push-ok' })]);
    const store = makeStore();
    const report = await store.runRecoverySweep();
    expect(report.removed.map((r) => r.reason)).toEqual(['malformed']);
    expect((await store.all()).map((r) => r.id)).toEqual(['push-ok']);
  });

  test('a raising of the failure threshold keeps a record the old bound would have reaped', async () => {
    seed([record({ id: 'push-flaky', consecutiveFailures: 5 })]);
    const store = makeStore({ failureThreshold: 10 });
    const report = await store.runRecoverySweep();
    expect(report.removed).toHaveLength(0);
    expect(await store.all()).toHaveLength(1);
  });

  test('the sweep is idempotent — a second pass removes nothing', async () => {
    seed([record({ id: 'push-dead', consecutiveFailures: 7 }), record({ id: 'push-live' })]);
    const store = makeStore({ failureThreshold: 5 });
    expect((await store.sweep('manual')).removed).toHaveLength(1);
    const second = await store.sweep('manual');
    expect(second.removed).toHaveLength(0);
    expect(second.retained).toBe(1);
  });

  test('a record another process registered mid-sweep survives the sweep', async () => {
    seed([record({ id: 'push-dead', consecutiveFailures: 9 })]);
    const store = makeStore({ failureThreshold: 5 });
    const other = makeStore({ failureThreshold: 5 });
    // Two independent store instances over the same file, as two processes would be.
    const [sweepReport] = await Promise.all([
      store.sweep('manual'),
      other.register({ principalId: 'op-2', endpoint: 'https://push.example/new', keys: realKeys() }),
    ]);
    expect(sweepReport.removed.map((r) => r.subscriptionId)).toEqual(['push-dead']);
    const ids = (await store.all()).map((r) => r.principalId);
    expect(ids).toContain('op-2');
    expect((await store.all()).some((r) => r.id === 'push-dead')).toBe(false);
  });

  test('a delete of an already-absent id is honest about it', async () => {
    const store = makeStore();
    expect(await store.remove('push-nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Disclosure + periodic sweeping
// ---------------------------------------------------------------------------
describe('housekeeping discloses and repeats', () => {
  test('a removal is written to the disclosure file beside the store', async () => {
    seed([record({ id: 'push-dead', consecutiveFailures: 6 })]);
    const store = makeStore({ failureThreshold: 5 });
    await store.runRecoverySweep();
    const reports = readDisclosures();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.trigger).toBe('recovery');
    expect(reports[0]?.removed[0]?.subscriptionId).toBe('push-dead');
    expect(reports[0]?.summary).toContain('1 dead subscription(s) removed');
  });

  test('a pass that removed nothing writes no disclosure noise', async () => {
    seed([record({ id: 'push-live' })]);
    const store = makeStore();
    await store.runRecoverySweep();
    expect(readDisclosures()).toHaveLength(0);
  });

  test('the periodic sweep reaps without a restart', async () => {
    const store = makeStore({ failureThreshold: 5 });
    await store.register({ principalId: 'op-1', endpoint: 'https://push.example/live', keys: realKeys() });
    // A record goes dead AFTER the recovery sweep already ran.
    seed([...readStored(), record({ id: 'push-dead-later', consecutiveFailures: 8 })]);
    // A sweep publishes two effects, strictly in order: the store file first,
    // the disclosure record after it. Waiting on the store alone returned while
    // the disclosure write was still in flight, and the assertion below then
    // read an empty disclosure file. Unloaded that gap is microseconds, so the
    // test passed; under load it widened past the poll and the test failed for
    // a reason that had nothing to do with sweeping. Wait for BOTH effects.
    store.startPeriodicSweep(15);
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const swept = readStored().length === 1
          && readDisclosures().some((entry) => entry.trigger === 'periodic');
        if (swept) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      store.stopPeriodicSweep();
    }
    expect(readStored()).toHaveLength(1);
    const periodic = readDisclosures().filter((r) => r.trigger === 'periodic');
    expect(periodic.length).toBeGreaterThan(0);
    expect(periodic[0]?.removed[0]?.subscriptionId).toBe('push-dead-later');
  }, 60_000);

  test('a read never serves a record that is provably dead', async () => {
    seed([record({ id: 'push-junk', keys: { p256dh: 'p', auth: 'a' } }), record({ id: 'push-ok' })]);
    const store = makeStore();
    // No sweep run yet — the read still refuses to hand back the dead record.
    expect((await store.all()).map((r) => r.id)).toEqual(['push-ok']);
    expect(await store.get('push-junk')).toBeNull();
    expect(await store.listPublic('op-1')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The VAPID contact
// ---------------------------------------------------------------------------
describe('the VAPID sub contact', () => {
  function memorySecrets(): { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> } {
    const values = new Map<string, string>();
    return {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
      },
    };
  }

  async function subjectOf(manager: VapidManager): Promise<{ sub: string; verified: boolean }> {
    const header = await manager.buildAuthorizationHeader('https://push.example/endpoint');
    const jwt = /t=([^,]+)/.exec(header)?.[1] ?? '';
    const publicKey = /k=(.+)$/.exec(header)?.[1] ?? '';
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload ?? '', 'base64url').toString('utf8')) as { sub: string };
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(publicKey, 'base64url').subarray(1, 33).toString('base64url'),
        y: Buffer.from(publicKey, 'base64url').subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const verified = cryptoVerify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(encodedSignature ?? '', 'base64url'),
    );
    return { sub: payload.sub, verified };
  }

  test('a configured mailto: contact is signed into the JWT and still verifies', async () => {
    const manager = new VapidManager(memorySecrets(), { subject: 'mailto:ops@example.test' });
    expect(manager.getSubject()).toBe('mailto:ops@example.test');
    const { sub, verified } = await subjectOf(manager);
    expect(sub).toBe('mailto:ops@example.test');
    expect(verified).toBe(true);
  });

  test('a configured https: contact page works the same way', async () => {
    const manager = new VapidManager(memorySecrets(), { subject: 'https://example.test/contact' });
    const { sub, verified } = await subjectOf(manager);
    expect(sub).toBe('https://example.test/contact');
    expect(verified).toBe(true);
  });

  test('no configured contact falls back to the documented localhost subject', async () => {
    const manager = new VapidManager(memorySecrets());
    expect(manager.getSubject()).toBe(DEFAULT_VAPID_SUBJECT);
    const { sub, verified } = await subjectOf(manager);
    expect(sub).toBe('mailto:goodvibes-push@localhost');
    expect(verified).toBe(true);
  });

  test('an invalid subject is rejected rather than signed into every JWT', () => {
    for (const bad of ['ops@example.test', 'http://example.test/contact', 'not a url', 'mailto:', 'ftp://example.test']) {
      expect(isValidVapidSubject(bad)).toBe(false);
      expect(() => new VapidManager(memorySecrets(), { subject: bad })).toThrow('VAPID subject must be');
    }
  });

  test('the validity rule accepts exactly what the config key documents', () => {
    expect(isValidVapidSubject('mailto:ops@example.test')).toBe(true);
    expect(isValidVapidSubject('https://example.test/contact')).toBe(true);
    expect(isValidVapidSubject('https://example.test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The composition root: config key -> a real signed delivery
// ---------------------------------------------------------------------------
describe('push.vapidSubject reaches a real delivery', () => {
  test('the configured contact is the `sub` of the JWT a live delivery carries', async () => {
    const received: Array<{ authorization: string }> = [];
    const sink = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({ authorization: request.headers.get('authorization') ?? '' });
        await request.arrayBuffer();
        return new Response(null, { status: 201 });
      },
    });
    const sinkOrigin = `http://127.0.0.1:${sink.port}`;
    const secrets = new Map<string, string>();
    const config: Partial<Record<ConfigKey, unknown>> = {
      'push.vapidSubject': 'mailto:ops@example.test',
      // Keep the periodic sweep out of this test's way — and out of every
      // later file's way, since the service's own store is private and its
      // sweeper cannot be stopped from here.
      'push.subscriptions.sweepIntervalMinutes': SWEEP_NEVER_MINUTES,
    };
    const deps = {
      secretsManager: {
        get: async (key: string): Promise<string | null> => secrets.get(key) ?? null,
        set: async (key: string, value: string): Promise<void> => {
          secrets.set(key, value);
        },
      },
      shellPaths: { resolveUserPath: (...segments: string[]): string => join(dir, ...segments) },
      configManager: { get: ((key: ConfigKey) => config[key]) as never },
    };
    try {
      const service = createPushService(deps);
      // The store the service built is the same file this one addresses.
      const store = createPushSubscriptionStore(deps);
      store.stopPeriodicSweep();
      const registered = await store.register({
        principalId: 'op-1',
        endpoint: `${sinkOrigin}/push/device`,
        keys: realKeys(),
      });
      const receipt = await service.verify(registered.id, 'op-1');
      expect(receipt?.outcome).toBe('delivered');
      expect(received).toHaveLength(1);
      const jwt = /t=([^,]+)/.exec(received[0]?.authorization ?? '')?.[1] ?? '';
      const payload = JSON.parse(
        Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { sub: string; aud: string };
      expect(payload.sub).toBe('mailto:ops@example.test');
      expect(payload.aud).toBe(sinkOrigin);
    } finally {
      sink.stop(true);
    }
  }, REAL_WORK_BUDGET_MS);

  test('an invalid configured contact falls back rather than crashing construction', () => {
    const config: Partial<Record<ConfigKey, unknown>> = {
      'push.vapidSubject': 'ops@example.test',
      // Same reason as the test above: createPushService starts a sweeper on a
      // store it does not hand back, and this test's directory is removed by
      // afterEach. Without this the default 60-minute interval is armed against
      // a path that will not exist.
      'push.subscriptions.sweepIntervalMinutes': SWEEP_NEVER_MINUTES,
    };
    const deps = {
      secretsManager: {
        get: async (): Promise<string | null> => null,
        set: async (): Promise<void> => undefined,
      },
      shellPaths: { resolveUserPath: (...segments: string[]): string => join(dir, ...segments) },
      configManager: { get: ((key: ConfigKey) => config[key]) as never },
    };
    // Construction succeeds (a hand-edited config file must not wedge the
    // daemon) and the bad contact is dropped rather than signed into a JWT.
    const service = createPushService(deps);
    expect(service).toBeDefined();
  });
});
