/**
 * device-capabilities.test.ts — the paired-device capability contract.
 *
 * Covers the owner rulings of 2026-07-25 as behaviour rather than as comments:
 * every capability confirms by default, "always allow" is offered on every one
 * of them and produces a durable per-capability per-node grant, a revoked grant
 * is refused, captures expire at 24h and are reaped with disclosure, and a
 * second node type resolves through the same path with no special case.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_CAPABILITY_CATALOG,
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  getDeviceCapability,
  isDeviceNodeKind,
  resolveDeviceNodeProfile,
} from '../packages/sdk/src/platform/devices/device-capability-contract.ts';
import type { DeviceNodeProfile } from '../packages/sdk/src/platform/devices/device-capability-contract.ts';
import { DeviceGrantStore } from '../packages/sdk/src/platform/devices/device-grants.ts';
import { DeviceCaptureArtifactStore } from '../packages/sdk/src/platform/devices/device-capture-artifacts.ts';
import { DeviceHousekeeper } from '../packages/sdk/src/platform/devices/device-housekeeping.ts';
import {
  DeviceCapabilityService,
  isAllowAlwaysOffered,
  DEFAULT_DEVICE_CAPABILITY_POLICY,
} from '../packages/sdk/src/platform/devices/device-capability-service.ts';
import type {
  DeviceCapabilityDispatcher,
  DeviceConfirmationRequest,
  DeviceConfirmationDecision,
} from '../packages/sdk/src/platform/devices/device-capability-service.ts';
import {
  validateDeviceCapabilityInput,
  parseDeviceCapabilityWorkRequest,
  parseDeviceCapabilityWorkResult,
} from '../packages/sdk/src/platform/devices/device-peer-work.ts';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-device-caps-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function profile(overrides: Partial<DeviceNodeProfile> = {}): DeviceNodeProfile {
  const resolved = resolveDeviceNodeProfile({
    nodeId: 'node-a',
    nodeKind: 'web-pwa',
    label: 'Pixel',
    contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
    capabilities: [...DEVICE_CAPABILITY_IDS],
  });
  if (!resolved.ok) throw new Error('fixture node failed to resolve');
  return { ...resolved.profile, ...overrides };
}

interface Harness {
  readonly service: DeviceCapabilityService;
  readonly grants: DeviceGrantStore;
  readonly artifacts: DeviceCaptureArtifactStore;
  readonly prompts: DeviceConfirmationRequest[];
  readonly dispatches: string[];
  setDecision(decision: DeviceConfirmationDecision): void;
  setBytes(bytes: Uint8Array | null): void;
}

function harness(options: {
  readonly nodes?: readonly DeviceNodeProfile[] | undefined;
  readonly policy?: Partial<typeof DEFAULT_DEVICE_CAPABILITY_POLICY> | undefined;
  readonly now?: (() => number) | undefined;
} = {}): Harness {
  const prompts: DeviceConfirmationRequest[] = [];
  const dispatches: string[] = [];
  let decision: DeviceConfirmationDecision = 'once';
  let bytes: Uint8Array | null = null;

  const grants = new DeviceGrantStore(join(root, 'grants.json'), {
    ...(options.now ? { now: options.now } : {}),
  });
  const artifacts = new DeviceCaptureArtifactStore(join(root, 'captures'), {
    ...(options.now ? { now: options.now } : {}),
  });
  const dispatcher: DeviceCapabilityDispatcher = {
    async dispatch(input) {
      dispatches.push(input.capabilityId);
      return {
        ok: true,
        data: { echoed: input.capabilityId },
        ...(bytes ? { bytes, mediaType: 'image/png' } : {}),
      };
    },
  };
  const service = new DeviceCapabilityService({
    grants,
    artifacts,
    dispatcher,
    confirm: async (request) => {
      prompts.push(request);
      return { decision, actor: 'operator' };
    },
    listNodes: () => options.nodes ?? [profile()],
    ...(options.policy ? { policy: options.policy } : {}),
  });

  return {
    service,
    grants,
    artifacts,
    prompts,
    dispatches,
    setDecision(next) { decision = next; },
    setBytes(next) { bytes = next; },
  };
}

describe('device capability catalog', () => {
  test('every capability defaults to ask-every-time and offers "always allow"', () => {
    expect(DEVICE_CAPABILITY_CATALOG.length).toBeGreaterThan(0);
    for (const descriptor of DEVICE_CAPABILITY_CATALOG) {
      expect(descriptor.defaultDecision).toBe('ask-every-time');
      expect(descriptor.allowAlwaysOffered).toBe(true);
      expect(descriptor.purpose.trim().length).toBeGreaterThan(20);
    }
  });

  test('the capabilities the ruling names explicitly are all present and grantable under stock policy', () => {
    for (const id of ['device.camera.front.capture', 'device.screen.capture', 'device.location.precise', 'device.clipboard.read'] as const) {
      const descriptor = getDeviceCapability(id);
      expect(descriptor).not.toBeNull();
      expect(isAllowAlwaysOffered(descriptor!, DEFAULT_DEVICE_CAPABILITY_POLICY)).toBe(true);
    }
  });

  test('capture capabilities retain an artifact; reads and effects do not', () => {
    expect(getDeviceCapability('device.camera.rear.capture')?.producesArtifact).toBe(true);
    expect(getDeviceCapability('device.screen.capture')?.producesArtifact).toBe(true);
    expect(getDeviceCapability('device.location.precise')?.producesArtifact).toBe(false);
    expect(getDeviceCapability('device.command.notify')?.producesArtifact).toBe(false);
  });
});

describe('node contract accepts a second node type without special-casing', () => {
  test('a native node resolves through the same path as the web node', () => {
    const web = resolveDeviceNodeProfile({
      nodeId: 'web-1', nodeKind: 'web-pwa', label: 'Phone browser',
      contractVersion: 1, capabilities: ['device.camera.rear.capture', 'device.location.coarse'],
    });
    const native = resolveDeviceNodeProfile({
      nodeId: 'native-1', nodeKind: 'android-native', label: 'Phone app',
      contractVersion: 1, capabilities: ['device.camera.rear.capture', 'device.location.coarse'],
    });
    expect(web.ok).toBe(true);
    expect(native.ok).toBe(true);
    if (!web.ok || !native.ok) return;
    expect(native.profile.supported).toEqual(web.profile.supported);
    expect(native.profile.undeclared).toEqual(web.profile.undeclared);
  });

  test('a node kind nobody has shipped yet is accepted as a peer', () => {
    expect(isDeviceNodeKind('watch-native')).toBe(true);
    const resolved = resolveDeviceNodeProfile({
      nodeId: 'watch-1', nodeKind: 'watch-native', label: 'Watch',
      contractVersion: 1, capabilities: ['device.command.vibrate'],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.profile.supported).toEqual(['device.command.vibrate']);
  });

  test('a node declaring a capability this host does not know reports it rather than failing', () => {
    const resolved = resolveDeviceNodeProfile({
      nodeId: 'native-2', nodeKind: 'android-native', label: 'Newer app',
      contractVersion: 1, capabilities: ['device.camera.rear.capture', 'device.nfc.read'],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.profile.unknownDeclared).toEqual(['device.nfc.read']);
      expect(resolved.profile.supported).toContain('device.camera.rear.capture');
    }
  });

  test('a malformed node kind is refused with a stated reason', () => {
    const resolved = resolveDeviceNodeProfile({
      nodeId: 'x', nodeKind: 'Not A Slug', label: 'x', contractVersion: 1, capabilities: [],
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('invalid-node-kind');
  });

  test('a capability announced from a non-secure context is reported as gated, not as unsupported', () => {
    const resolved = resolveDeviceNodeProfile({
      nodeId: 'web-2', nodeKind: 'web-pwa', label: 'Phone on plain http',
      contractVersion: 1, capabilities: ['device.camera.rear.capture', 'device.command.open_url'],
      secureContext: false,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.profile.gatedBySecureContext).toContain('device.camera.rear.capture');
      expect(resolved.profile.supported).toContain('device.command.open_url');
    }
  });
});

describe('confirmation gate', () => {
  test('every capability is confirmed by default, with "always allow" offered', async () => {
    for (const descriptor of DEVICE_CAPABILITY_CATALOG) {
      const h = harness();
      const outcome = await h.service.request({
        nodeId: 'node-a',
        capabilityId: descriptor.id,
        reason: 'testing the gate',
        input: descriptor.id === 'device.clipboard.write' ? { text: 'x' }
          : descriptor.id === 'device.command.notify' ? { title: 'x' }
            : descriptor.id === 'device.command.open_url' ? { url: 'https://example.test' } : {},
      });
      expect(h.prompts.length).toBe(1);
      expect(h.prompts[0]?.capabilityId).toBe(descriptor.id);
      expect(h.prompts[0]?.allowAlwaysOffered).toBe(true);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.authority).toBe('confirmed-once');
    }
  });

  test('a "once" answer never writes a grant — the next request asks again', async () => {
    const h = harness();
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.location.coarse', reason: 'first' });
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.location.coarse', reason: 'second' });
    expect(h.prompts.length).toBe(2);
    expect((await h.grants.list()).length).toBe(0);
  });

  test('a denial refuses the request and never dispatches to the device', async () => {
    const h = harness();
    h.setDecision('deny');
    const outcome = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.camera.front.capture', reason: 'nope' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('denied-by-person');
    expect(h.dispatches.length).toBe(0);
  });

  test('mode ask-every-time never consults or offers a durable grant', async () => {
    const h = harness({ policy: { mode: 'ask-every-time' } });
    h.setDecision('always');
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.clipboard.read', reason: 'x' });
    expect(h.prompts[0]?.allowAlwaysOffered).toBe(false);
    expect((await h.grants.list()).length).toBe(0);
  });
});

describe('durable grants', () => {
  test('"always allow" writes one durable per-capability per-node grant that suppresses the next prompt', async () => {
    const h = harness();
    h.setDecision('always');
    const first = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.screen.capture', reason: 'read my screen' });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.authority).toBe('confirmed-always');

    const grants = await h.grants.list();
    expect(grants.length).toBe(1);
    expect(grants[0]?.capabilityId).toBe('device.screen.capture');
    expect(grants[0]?.nodeId).toBe('node-a');
    expect(grants[0]?.scope).toBe('always');
    expect(grants[0]?.expiresAt).toBeGreaterThan(grants[0]!.grantedAt);

    const second = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.screen.capture', reason: 'again' });
    expect(h.prompts.length).toBe(1);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.authority).toBe('existing-grant');
  });

  test('a grant is scoped to its own capability and its own node', async () => {
    const h = harness({
      nodes: [profile(), profile({ nodeId: 'node-b', label: 'Second phone' })],
    });
    h.setDecision('always');
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.screen.capture', reason: 'x' });
    h.setDecision('once');
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.camera.rear.capture', reason: 'other capability' });
    await h.service.request({ nodeId: 'node-b', capabilityId: 'device.screen.capture', reason: 'other node' });
    expect(h.prompts.length).toBe(3);
  });

  test('a revoked grant is refused: the next request asks again', async () => {
    const h = harness();
    h.setDecision('always');
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.clipboard.read', reason: 'x' });
    expect((await h.grants.list()).length).toBe(1);

    const removals = await h.grants.revoke({ nodeId: 'node-a', capabilityId: 'device.clipboard.read', actor: 'operator' });
    expect(removals.length).toBe(1);
    expect(removals[0]?.reason).toBe('revoked');
    expect((await h.grants.list()).length).toBe(0);
    expect(await h.grants.find({ nodeId: 'node-a', capabilityId: 'device.clipboard.read' })).toBeNull();

    h.setDecision('once');
    const after = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.clipboard.read', reason: 'after revoke' });
    expect(h.prompts.length).toBe(2);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.authority).toBe('confirmed-once');
  });

  test('an expired grant is never honoured, even before a sweep runs', async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    h.setDecision('always');
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.location.precise', reason: 'x' });
    const [grant] = await h.grants.list();
    expect(grant).toBeDefined();

    now = (grant?.expiresAt ?? 0) + 1;
    expect(await h.grants.find({ nodeId: 'node-a', capabilityId: 'device.location.precise' })).toBeNull();
    h.setDecision('once');
    await h.service.request({ nodeId: 'node-a', capabilityId: 'device.location.precise', reason: 'after expiry' });
    expect(h.prompts.length).toBe(2);
  });

  test('a grant whose node is gone is reaped on the recovery sweep and disclosed', async () => {
    const store = new DeviceGrantStore(join(root, 'grants.json'), {
      ownership: { isKnownNode: (nodeId) => nodeId === 'still-paired' },
    });
    await store.record({ nodeId: 'still-paired', nodeKind: 'web-pwa', capabilityId: 'device.command.notify', scope: 'always', grantedBy: 'operator' });
    await store.record({ nodeId: 'unpaired', nodeKind: 'android-native', capabilityId: 'device.command.notify', scope: 'always', grantedBy: 'operator' });

    const report = await store.sweep();
    expect(report.removed.map((entry) => entry.reason)).toEqual(['node-gone']);
    expect(report.removed[0]?.nodeId).toBe('unpaired');
    expect(report.retained).toBe(1);
  });

  test('a torn grant record is dropped by content validation, not honoured', async () => {
    const path = join(root, 'grants.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      grants: [
        { id: 'good', nodeId: 'node-a', nodeKind: 'web-pwa', capabilityId: 'device.command.vibrate', scope: 'always', grantedAt: 1, expiresAt: Date.now() + 100000, useCount: 0, grantedBy: 'operator' },
        { id: 'torn', nodeId: 'node-a', capabilityId: 'device.command.vibrate' },
        { id: 'unknown-capability', nodeId: 'node-a', nodeKind: 'web-pwa', capabilityId: 'device.telepathy', scope: 'always', grantedAt: 1, expiresAt: Date.now() + 100000, useCount: 0, grantedBy: 'operator' },
      ],
      audit: [],
    }, null, 2));
    const store = new DeviceGrantStore(path);
    expect((await store.list()).length).toBe(1);
    const report = await store.sweep();
    expect(report.removed.some((entry) => entry.reason === 'malformed')).toBe(true);
  });

  test('the per-node count cap reaps the oldest grants', async () => {
    const store = new DeviceGrantStore(join(root, 'grants.json'), { policy: { maxGrantsPerNode: 2 } });
    for (const id of ['device.command.notify', 'device.command.vibrate', 'device.command.open_url'] as const) {
      await store.record({ nodeId: 'node-a', nodeKind: 'web-pwa', capabilityId: id, scope: 'always', grantedBy: 'operator' });
    }
    const report = await store.sweep();
    expect(report.retained).toBe(2);
    expect(report.removed.some((entry) => entry.reason === 'per-node-cap')).toBe(true);
  });

  test('sweeping twice removes nothing extra', async () => {
    const store = new DeviceGrantStore(join(root, 'grants.json'), {
      ownership: { isKnownNode: () => false },
    });
    await store.record({ nodeId: 'gone', nodeKind: 'web-pwa', capabilityId: 'device.command.notify', scope: 'always', grantedBy: 'operator' });
    const first = await store.sweep();
    const second = await store.sweep();
    expect(first.removed.length).toBe(1);
    expect(second.removed.length).toBe(0);
  });
});

describe('capture artifacts', () => {
  test('a capture is retained with the 24h stock TTL and reaped at expiry with disclosure', async () => {
    let now = 1_000_000_000;
    const store = new DeviceCaptureArtifactStore(join(root, 'captures'), { now: () => now });
    expect(store.getPolicy().retentionMs).toBe(24 * 60 * 60 * 1000);

    const artifact = await store.retain({
      nodeId: 'node-a',
      capabilityId: 'device.camera.rear.capture',
      kind: 'image',
      mediaType: 'image/png',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(artifact.expiresAt - artifact.capturedAt).toBe(24 * 60 * 60 * 1000);
    expect(existsSync(store.pathFor(artifact))).toBe(true);

    now += 24 * 60 * 60 * 1000 - 1;
    expect((await store.list()).length).toBe(1);

    now += 2;
    const report = await store.sweep();
    expect(report.removed.map((entry) => entry.reason)).toContain('expired');
    expect(report.retained).toBe(0);
    expect(report.bytesReclaimed).toBe(4);
    expect(existsSync(store.pathFor(artifact))).toBe(false);
  });

  test('a capture whose bytes were corrupted is reaped rather than served', async () => {
    const store = new DeviceCaptureArtifactStore(join(root, 'captures'));
    const artifact = await store.retain({
      nodeId: 'node-a', capabilityId: 'device.screen.capture', kind: 'image',
      mediaType: 'image/png', bytes: new Uint8Array([9, 9, 9]),
    });
    writeFileSync(store.pathFor(artifact), Buffer.alloc(3));

    const read = await store.read(artifact.id);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('content-mismatch');
    expect((await store.list()).length).toBe(0);
  });

  test('a file with no index record is reaped as an orphan', async () => {
    const store = new DeviceCaptureArtifactStore(join(root, 'captures'));
    await store.retain({
      nodeId: 'node-a', capabilityId: 'device.screen.capture', kind: 'image',
      mediaType: 'image/png', bytes: new Uint8Array([1]),
    });
    writeFileSync(join(store.getDirectory(), 'orphan.png'), Buffer.from([7, 7]));
    const report = await store.sweep();
    expect(report.removed.map((entry) => entry.reason)).toContain('orphan-file');
    expect(existsSync(join(store.getDirectory(), 'orphan.png'))).toBe(false);
  });

  test('a capture from a request is retained under the configured retention window', async () => {
    const h = harness({ policy: { captureRetentionMs: 2 * 60 * 60 * 1000 } });
    h.setBytes(new Uint8Array([5, 6, 7]));
    const outcome = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.camera.rear.capture', reason: 'read the label' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.artifact).toBeDefined();
      expect((outcome.artifact?.expiresAt ?? 0) - (outcome.artifact?.capturedAt ?? 0)).toBe(2 * 60 * 60 * 1000);
    }
  });
});

describe('housekeeping disclosure', () => {
  test('a sweep writes what it removed and why, and keeps the log bounded', async () => {
    const grants = new DeviceGrantStore(join(root, 'grants.json'), { ownership: { isKnownNode: () => false } });
    await grants.record({ nodeId: 'gone', nodeKind: 'web-pwa', capabilityId: 'device.command.notify', scope: 'always', grantedBy: 'operator' });
    const artifacts = new DeviceCaptureArtifactStore(join(root, 'captures'));
    const disclosurePath = join(root, 'device-housekeeping.json');
    const housekeeper = new DeviceHousekeeper({ grants, artifacts, disclosurePath });

    const report = await housekeeper.runRecoverySweep();
    expect(report.trigger).toBe('recovery');
    expect(report.summary).toContain('1 grant(s) removed');
    expect(report.summary).toContain('node-gone');
    expect(existsSync(disclosurePath)).toBe(true);
    const written = JSON.parse(readFileSync(disclosurePath, 'utf8')) as { reports: unknown[] };
    expect(written.reports.length).toBe(1);

    for (let index = 0; index < 25; index += 1) await housekeeper.sweep('periodic');
    const disclosures = await housekeeper.listDisclosures();
    expect(disclosures.length).toBeLessThanOrEqual(20);
  });
});

describe('configuration postures', () => {
  test('mode off refuses every capability with a stated reason', async () => {
    const h = harness({ policy: { mode: 'off' } });
    const outcome = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.command.vibrate', reason: 'x' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('disabled-by-config');
    expect(h.prompts.length).toBe(0);
  });

  test('clipboard read off refuses only the read, never the write', async () => {
    const h = harness({ policy: { clipboardReadMode: 'off' } });
    const read = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.clipboard.read', reason: 'x' });
    expect(read.ok).toBe(false);
    const write = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.clipboard.write', reason: 'x', input: { text: 'hello' } });
    expect(write.ok).toBe(true);
  });

  test('coarse-only location refuses precise and still serves approximate', async () => {
    const h = harness({ policy: { locationPrecision: 'coarse-only' } });
    const precise = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.location.precise', reason: 'x' });
    expect(precise.ok).toBe(false);
    const coarse = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.location.coarse', reason: 'x' });
    expect(coarse.ok).toBe(true);
  });

  test('an unpaired node and an unknown capability are refused before any prompt', async () => {
    const h = harness();
    const node = await h.service.request({ nodeId: 'missing', capabilityId: 'device.command.vibrate', reason: 'x' });
    expect(node.ok).toBe(false);
    if (!node.ok) expect(node.refusal).toBe('node-unknown');
    const capability = await h.service.request({ nodeId: 'node-a', capabilityId: 'device.telepathy', reason: 'x' });
    expect(capability.ok).toBe(false);
    if (!capability.ok) expect(capability.refusal).toBe('capability-unknown');
    expect(h.prompts.length).toBe(0);
  });
});

describe('peer work payloads', () => {
  test('required inputs are validated on both sides of the wire', () => {
    expect(validateDeviceCapabilityInput('device.command.open_url', { url: 'https://x.test', reason: 'go' })).toEqual([]);
    const problems = validateDeviceCapabilityInput('device.command.open_url', { reason: 'go' });
    expect(problems.map((problem) => problem.field)).toEqual(['url']);
  });

  test('a payload for a capability this contract does not define is rejected', () => {
    expect(parseDeviceCapabilityWorkRequest({ capabilityId: 'device.telepathy' })).toBeNull();
    expect(parseDeviceCapabilityWorkResult({ capabilityId: 'device.telepathy', ok: true })).toBeNull();
  });

  test('a well-formed request round-trips with its defaults filled in', () => {
    const parsed = parseDeviceCapabilityWorkRequest({ capabilityId: 'device.location.coarse', reason: 'near me' });
    expect(parsed?.capabilityId).toBe('device.location.coarse');
    expect(parsed?.timeoutMs).toBeGreaterThan(0);
    expect(parsed?.input).toEqual({});
  });
});
