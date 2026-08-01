/**
 * device-capabilities.test.ts — the paired-device capability contract.
 *
 * Covers the owner rulings of 2026-07-25 as behaviour rather than as comments:
 * every capability confirms by default, "always allow" is offered on every one
 * of them and produces a durable per-capability per-node grant, a revoked grant
 * is refused, captures expire at 24h and are reaped with disclosure, and a
 * second node type resolves through the same path with no special case.
 */
import { describe, expect, test, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { deviceConfigSettings } from '../packages/sdk/src/platform/config/schema-domain-device.ts';
import {
  DEVICE_POSTURE_CONFIG_KEYS,
  readDeviceArtifactPolicy,
  readDeviceCapabilityPolicy,
  readDeviceGrantPolicy,
  readDeviceSweepIntervalMs,
} from '../packages/sdk/src/platform/devices/device-posture-config.ts';
import type {
  DevicePostureConfigKey,
  DevicePostureConfigReader,
} from '../packages/sdk/src/platform/devices/device-posture-config.ts';
import {
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  createDevicePostureRuntime,
} from '../packages/sdk/src/platform/devices/device-posture-runtime.ts';
import type {
  DevicePeerView,
  DevicePostureRuntime,
  DeviceWorkView,
} from '../packages/sdk/src/platform/devices/device-posture-runtime.ts';
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
  resolveDeviceRequestTimeoutMs,
  DEFAULT_DEVICE_CAPABILITY_POLICY,
} from '../packages/sdk/src/platform/devices/device-capability-service.ts';
import type {
  DeviceCapabilityDispatcher,
  DeviceCapabilityOutcome,
  DeviceConfirmationRequest,
  DeviceConfirmationDecision,
} from '../packages/sdk/src/platform/devices/device-capability-service.ts';
import {
  validateDeviceCapabilityInput,
  parseDeviceCapabilityWorkRequest,
  parseDeviceCapabilityWorkResult,
  decodeDeviceCapabilityMedia,
} from '../packages/sdk/src/platform/devices/device-peer-work.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerDevicesGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/devices.ts';
import {
  GatewayVerbError,
  isGatewayVerbError,
} from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';

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

// ---------------------------------------------------------------------------
// The `device.*` settings → policy mapping, and the runtime a host composes
// from it. These tests hold the mapping itself: each key, at two values,
// changing the policy a store or the capability service actually applies.
// ---------------------------------------------------------------------------

/** A reader over a plain map, so a value the schema would reject can be tested. */
function reader(values: Partial<Record<DevicePostureConfigKey, unknown>>): DevicePostureConfigReader {
  return { get: (key) => values[key] };
}

/** A real ConfigManager over a fresh temp home, the way a surface builds it. */
let configSeq = 0;
function freshConfig(): ConfigManager {
  configSeq += 1;
  const home = join(root, `home-${configSeq}`);
  mkdirSync(home, { recursive: true });
  return new ConfigManager({ homeDir: home, configDir: join(home, 'cfg'), workingDir: home, surfaceRoot: 'goodvibes' });
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe('device.* settings mapping', () => {
  test('the wired key list is exactly the device schema minus the pairing cap', () => {
    const schemaKeys = deviceConfigSettings.map((setting) => setting.key).filter((key) => key !== 'device.nodes.maxPaired');
    expect(DEVICE_POSTURE_CONFIG_KEYS.map((key) => key as string)).toEqual(schemaKeys);
  });

  test('every posture key changes the policy it governs when moved off its stock value', () => {
    const stock = reader({});
    expect(readDeviceCapabilityPolicy(stock)).toEqual(DEFAULT_DEVICE_CAPABILITY_POLICY);

    expect(readDeviceCapabilityPolicy(reader({ 'device.capabilities.mode': 'off' })).mode).toBe('off');
    expect(readDeviceCapabilityPolicy(reader({ 'device.capabilities.allowAlwaysOffer': 'never' })).allowAlwaysOffer).toBe('never');
    expect(readDeviceCapabilityPolicy(reader({ 'device.location.precision': 'coarse-only' })).locationPrecision).toBe('coarse-only');
    expect(readDeviceCapabilityPolicy(reader({ 'device.clipboard.readMode': 'ask-only' })).clipboardReadMode).toBe('ask-only');
    expect(readDeviceCapabilityPolicy(reader({ 'device.capabilities.requestTimeoutSeconds': 5 })).requestTimeoutMs).toBe(5_000);
    expect(readDeviceCapabilityPolicy(reader({ 'device.capture.retentionHours': 1 })).captureRetentionMs).toBe(HOUR_MS);

    expect(readDeviceArtifactPolicy(reader({ 'device.capture.retentionHours': 72 })).retentionMs).toBe(72 * HOUR_MS);
    expect(readDeviceArtifactPolicy(reader({ 'device.capture.maxArtifacts': 2 })).maxArtifacts).toBe(2);
    expect(readDeviceArtifactPolicy(stock)).toEqual({ retentionMs: 24 * HOUR_MS, maxArtifacts: 200 });

    expect(readDeviceGrantPolicy(reader({ 'device.grants.expiryDays': 1 })).grantTtlMs).toBe(DAY_MS);
    expect(readDeviceGrantPolicy(reader({ 'device.grants.maxPerNode': 3 })).maxGrantsPerNode).toBe(3);
    expect(readDeviceGrantPolicy(reader({ 'device.grants.auditRetentionDays': 2 })).auditRetentionMs).toBe(2 * DAY_MS);
    // The two bounds with no settings key keep their absolute safety values.
    expect(readDeviceGrantPolicy(reader({ 'device.grants.maxPerNode': 3 })).maxGrantsTotal).toBe(512);

    expect(readDeviceSweepIntervalMs(stock)).toBe(30 * MINUTE_MS);
    expect(readDeviceSweepIntervalMs(reader({ 'device.capture.sweepIntervalMinutes': 5 }))).toBe(5 * MINUTE_MS);
  });

  test('a broken value reads as the stock posture rather than a wider one', () => {
    const broken = reader({
      'device.capabilities.mode': 'sometimes',
      'device.capabilities.allowAlwaysOffer': true,
      'device.location.precision': '',
      'device.clipboard.readMode': 'yes',
      'device.capabilities.requestTimeoutSeconds': Number.NaN,
      'device.capture.retentionHours': -4,
      'device.capture.maxArtifacts': 'lots',
      'device.capture.sweepIntervalMinutes': 0,
      'device.grants.expiryDays': Number.POSITIVE_INFINITY,
      'device.grants.maxPerNode': null,
      'device.grants.auditRetentionDays': -1,
    });
    expect(readDeviceCapabilityPolicy(broken)).toEqual(DEFAULT_DEVICE_CAPABILITY_POLICY);
    expect(readDeviceArtifactPolicy(broken)).toEqual({ retentionMs: 24 * HOUR_MS, maxArtifacts: 200 });
    expect(readDeviceGrantPolicy(broken).grantTtlMs).toBe(90 * DAY_MS);
    expect(readDeviceGrantPolicy(broken).maxGrantsPerNode).toBe(64);
    expect(readDeviceGrantPolicy(broken).auditRetentionMs).toBe(30 * DAY_MS);
    expect(readDeviceSweepIntervalMs(broken)).toBe(30 * MINUTE_MS);
  });

  test('a real ConfigManager is a posture reader: stock values in, stock policy out', () => {
    const configManager = freshConfig();
    expect(readDeviceCapabilityPolicy(configManager)).toEqual(DEFAULT_DEVICE_CAPABILITY_POLICY);
    configManager.set('device.capabilities.mode', 'ask-every-time');
    configManager.set('device.capture.retentionHours', 2);
    expect(readDeviceCapabilityPolicy(configManager).mode).toBe('ask-every-time');
    expect(readDeviceArtifactPolicy(configManager).retentionMs).toBe(2 * HOUR_MS);
  });
});

describe('device posture runtime', () => {
  interface RuntimeHarness {
    readonly runtime: DevicePostureRuntime;
    readonly dispatches: Array<{ command: string; timeoutMs: number | undefined; payload: unknown }>;
    readonly asks: Array<{ timeoutMs: number | undefined }>;
    answer(next: 'once' | 'always' | 'deny'): void;
    withBytes(enabled: boolean): void;
    run(capabilityId: string): Promise<DeviceCapabilityOutcome>;
  }

  function peer(overrides: Partial<DevicePeerView> = {}): DevicePeerView {
    return {
      id: 'phone-1',
      kind: 'device',
      label: 'Test phone',
      platform: 'android',
      version: '1.0.0',
      status: 'connected',
      capabilities: [...DEVICE_CAPABILITY_IDS],
      metadata: {
        [DEVICE_NODE_ANNOUNCEMENT_KEY]: {
          nodeKind: 'web-pwa',
          contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
          capabilities: [...DEVICE_CAPABILITY_IDS],
          secureContext: true,
        },
      },
      ...overrides,
    };
  }

  function runtimeHarness(configManager: ConfigManager, stateDirectory: string, peers: readonly DevicePeerView[] = [peer()]): RuntimeHarness {
    const dispatches: Array<{ command: string; timeoutMs: number | undefined; payload: unknown }> = [];
    const asks: Array<{ timeoutMs: number | undefined }> = [];
    let answer: 'once' | 'always' | 'deny' = 'once';
    let bytes = false;

    const runtime = createDevicePostureRuntime({
      transport: {
        listPeers: (kind) => peers.filter((entry) => kind === undefined || entry.kind === kind),
        invokePeer: async (input): Promise<{ work: DeviceWorkView; completed: boolean }> => {
          dispatches.push({ command: input.command, timeoutMs: input.timeoutMs, payload: input.payload });
          return {
            completed: true,
            work: {
              id: `work-${dispatches.length}`,
              status: 'completed',
              result: {
                contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
                capabilityId: input.command,
                ok: true,
                data: { served: input.command },
                ...(bytes ? { mediaBase64: Buffer.from([1, 2, 3, 4]).toString('base64'), mediaType: 'image/png' } : {}),
              },
            },
          };
        },
      },
      approvals: {
        requestApproval: async (input) => {
          asks.push({ timeoutMs: input.timeoutMs });
          if (answer === 'deny') return { approved: false, reason: 'not now' };
          if (answer === 'always') return { approved: true, rememberTier: 'tool' };
          return { approved: true };
        },
      },
      config: configManager,
      stateDirectory,
      actor: 'test:phone-tool',
    });

    return {
      runtime,
      dispatches,
      asks,
      answer(next) { answer = next; },
      withBytes(enabled) { bytes = enabled; },
      run(capabilityId) {
        return runtime.capabilities.request({ nodeId: 'phone-1', capabilityId, reason: 'runtime test' });
      },
    };
  }

  afterEach(() => {
    setSystemTime();
  });

  test('a peer carrying a device announcement is a node; an ordinary peer is not', () => {
    const h = runtimeHarness(freshConfig(), join(root, 'nodes'), [
      peer(),
      peer({ id: 'laptop-1', kind: 'node', metadata: {} }),
      peer({ id: 'phone-2', metadata: {} }),
      peer({ id: 'phone-3', status: 'revoked' }),
    ]);
    expect(h.runtime.listNodes().map((node) => node.nodeId)).toEqual(['phone-1']);
  });

  test('one request becomes one work item carrying the contract payload and the configured deadline', async () => {
    const configManager = freshConfig();
    configManager.set('device.capabilities.requestTimeoutSeconds', 5);
    const h = runtimeHarness(configManager, join(root, 'dispatch'));
    const outcome = await h.run('device.command.vibrate');
    expect(outcome.ok).toBe(true);
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]?.command).toBe('device.command.vibrate');
    expect(h.dispatches[0]?.timeoutMs).toBe(5_000);
    expect((h.dispatches[0]?.payload as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(5_000);
    // The prompt inherits the same deadline: the question must not outlive it.
    expect(h.asks[0]?.timeoutMs).toBe(5_000);
  });

  test('a posture change governs the NEXT request — no restart, no rebuild', async () => {
    const configManager = freshConfig();
    const h = runtimeHarness(configManager, join(root, 'live-mode'));
    expect((await h.run('device.camera.rear.capture')).ok).toBe(true);

    configManager.set('device.capabilities.mode', 'off');
    const refused = await h.run('device.camera.rear.capture');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe('disabled-by-config');
    // Nothing reached the phone and nobody was asked the second time.
    expect(h.dispatches).toHaveLength(1);
    expect(h.asks).toHaveLength(1);

    configManager.set('device.capabilities.mode', 'honor-grants');
    expect((await h.run('device.camera.rear.capture')).ok).toBe(true);
    expect(h.dispatches).toHaveLength(2);
  });

  test('a live grant-expiry change applies to the next grant, and a retention change to the next capture', async () => {
    const configManager = freshConfig();
    const h = runtimeHarness(configManager, join(root, 'live-stores'));
    h.answer('always');
    h.withBytes(true);

    const first = await h.run('device.camera.rear.capture');
    expect(first.ok).toBe(true);
    const stockGrant = (await h.runtime.grants.list())[0];
    expect(stockGrant && stockGrant.expiresAt - stockGrant.grantedAt).toBe(90 * DAY_MS);
    if (first.ok && first.artifact) expect(first.artifact.expiresAt - first.artifact.capturedAt).toBe(24 * HOUR_MS);

    configManager.set('device.grants.expiryDays', 1);
    configManager.set('device.capture.retentionHours', 1);
    await h.runtime.grants.revoke({ nodeId: 'phone-1', actor: 'test' });
    const second = await h.run('device.camera.rear.capture');
    expect(second.ok).toBe(true);
    const shortGrant = (await h.runtime.grants.list())[0];
    expect(shortGrant && shortGrant.expiresAt - shortGrant.grantedAt).toBe(DAY_MS);
    if (second.ok && second.artifact) expect(second.artifact.expiresAt - second.artifact.capturedAt).toBe(HOUR_MS);

    // And the reduced cap is what the next sweep applies.
    configManager.set('device.capture.maxArtifacts', 1);
    expect(h.runtime.artifacts.getPolicy().maxArtifacts).toBe(1);
    const sweep = await h.runtime.housekeeper.sweep('manual');
    expect(sweep.artifacts.retained).toBe(1);
    expect(sweep.artifacts.removed.map((removal) => removal.reason)).toEqual(['count-cap']);
  });

  test('shortening the sweep cadence re-arms the periodic timer without a restart', async () => {
    const configManager = freshConfig();
    const h = runtimeHarness(configManager, join(root, 'cadence'));
    const realSetInterval = globalThis.setInterval;
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const spawned: Array<ReturnType<typeof setInterval>> = [];
    globalThis.setInterval = ((handler: () => void, timeout?: number) => {
      delays.push(timeout ?? 0);
      callbacks.push(handler);
      const timer = realSetInterval(() => undefined, HOUR_MS);
      spawned.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setInterval;

    try {
      await h.runtime.startHousekeeping();
      expect(delays).toEqual([30 * MINUTE_MS]);
      expect(h.runtime.housekeeper.getArmedIntervalMs()).toBe(30 * MINUTE_MS);

      configManager.set('device.capture.sweepIntervalMinutes', 5);
      // The running timer re-reads the cadence after its own sweep.
      callbacks[callbacks.length - 1]?.();
      for (let attempt = 0; attempt < 200 && delays.length < 2; attempt += 1) {
        await new Promise((resolveTick) => { setTimeout(resolveTick, 5); });
      }
      expect(delays[delays.length - 1]).toBe(5 * MINUTE_MS);
      expect(h.runtime.housekeeper.getArmedIntervalMs()).toBe(5 * MINUTE_MS);
      h.runtime.stopHousekeeping();
      expect(h.runtime.housekeeper.getArmedIntervalMs()).toBeNull();
    } finally {
      for (const timer of spawned) clearInterval(timer);
      globalThis.setInterval = realSetInterval;
    }
  });
});

// ---------------------------------------------------------------------------
// The control-plane verbs — the path a surface that does NOT host the device
// posture runtime reaches a paired phone through. Exercised over a real
// GatewayMethodCatalog with the handlers attached the way a daemon attaches
// them, so the descriptors, the required-field arrays and the handler wiring
// are all in the assertion path rather than assumed.
// ---------------------------------------------------------------------------

function verbHarness(options: Parameters<typeof harness>[0] = {}): {
  readonly catalog: GatewayMethodCatalog;
  readonly service: DeviceCapabilityService;
  readonly artifacts: DeviceCaptureArtifactStore;
  readonly prompts: DeviceConfirmationRequest[];
  setDecision(decision: DeviceConfirmationDecision): void;
  setBytes(bytes: Uint8Array | null): void;
} {
  const h = harness(options);
  const catalog = new GatewayMethodCatalog();
  registerDevicesGatewayMethods(catalog, {
    capabilities: h.service,
    grants: h.grants,
    artifacts: h.artifacts,
    housekeeper: new DeviceHousekeeper({
      grants: h.grants,
      artifacts: h.artifacts,
      disclosurePath: join(root, 'verb-housekeeping.json'),
    }),
  });
  return {
    catalog,
    service: h.service,
    artifacts: h.artifacts,
    prompts: h.prompts,
    setDecision: h.setDecision,
    setBytes: h.setBytes,
  };
}

const VERB_CONTEXT = { context: { admin: true } } as const;

describe('device capability verbs', () => {
  test('every device verb is cataloged, handled, and carries one device-family scope', () => {
    const { catalog } = verbHarness();
    const expected: Readonly<Record<string, string>> = {
      'devices.nodes.list': 'read:remote',
      'devices.capability.request': 'write:remote',
      'devices.artifacts.list': 'read:remote',
      'devices.artifacts.read': 'read:remote',
      'devices.grants.list': 'read:remote',
      'devices.grants.revoke': 'write:config',
      'devices.housekeeping.run': 'write:config',
    };
    for (const [id, scope] of Object.entries(expected)) {
      const descriptor = catalog.get(id);
      expect(descriptor, `${id} is not cataloged`).not.toBeNull();
      expect(catalog.hasHandler(id), `${id} has no handler`).toBe(true);
      expect(descriptor?.scopes).toEqual([scope]);
      // Authenticated, never public: reaching somebody's phone is not anonymous.
      expect(descriptor?.access).toBe('authenticated');
    }
  });

  test('a request runs the same gate the in-process tool runs: the person is asked, verbatim', async () => {
    const h = verbHarness();
    const result = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: {
        nodeId: 'node-a',
        capabilityId: 'device.command.vibrate',
        reason: 'confirming the phone is the one on the desk',
      },
    }) as { ok: boolean; authority: string; capabilityTitle: string };
    expect(result.ok).toBe(true);
    expect(result.authority).toBe('confirmed-once');
    expect(h.prompts).toHaveLength(1);
    // The caller's stated reason reaches the prompt unaltered — the verb adds
    // nothing to it and takes nothing away.
    expect(h.prompts[0]?.reason).toBe('confirming the phone is the one on the desk');
  });

  test('a declined request is an ok:false answer with the reason, not a server error', async () => {
    const h = verbHarness();
    h.setDecision('deny');
    const result = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.camera.rear.capture', reason: 'no thanks' },
    }) as { ok: boolean; refusal: string; detail: string; authority: string };
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('denied-by-person');
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.authority).toBe('');
  });

  test('an unknown node and an unknown capability are refused as answers, before any prompt', async () => {
    const h = verbHarness();
    const node = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'not-paired', capabilityId: 'device.command.vibrate', reason: 'x' },
    }) as { ok: boolean; refusal: string };
    const capability = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.telepathy', reason: 'x' },
    }) as { ok: boolean; refusal: string };
    expect(node.refusal).toBe('node-unknown');
    expect(capability.refusal).toBe('capability-unknown');
    expect(h.prompts).toHaveLength(0);
  });

  test('a request missing a required capability input is refused before the person is asked', async () => {
    const h = verbHarness();
    const result = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.clipboard.write', reason: 'paste it over' },
    }) as { ok: boolean; refusal: string; detail: string };
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('invalid-input');
    expect(result.detail).toContain('text');
    // Nobody was asked to approve a request that could never have run.
    expect(h.prompts).toHaveLength(0);
  });

  test('nodeId, capabilityId and reason are refused by name when missing', async () => {
    const h = verbHarness();
    for (const [field, body] of [
      ['nodeId', { capabilityId: 'device.command.vibrate', reason: 'x' }],
      ['capabilityId', { nodeId: 'node-a', reason: 'x' }],
      ['reason', { nodeId: 'node-a', capabilityId: 'device.command.vibrate' }],
    ] as const) {
      let caught: unknown;
      try {
        await h.catalog.invoke('devices.capability.request', { ...VERB_CONTEXT, body });
      } catch (error) {
        caught = error;
      }
      expect(isGatewayVerbError(caught), `${field} was not refused`).toBe(true);
      expect((caught as GatewayVerbError).field).toBe(field);
      expect((caught as GatewayVerbError).status).toBe(400);
    }
    // Every one of those fields is declared required, so a consumer gets a
    // compile error rather than a runtime 400.
    expect(h.catalog.get('devices.capability.request')?.inputSchema?.required)
      .toEqual(['nodeId', 'capabilityId', 'reason']);
  });

  test('a caller may shorten the device deadline but can never extend it past the posture', async () => {
    const policy = { ...DEFAULT_DEVICE_CAPABILITY_POLICY, requestTimeoutMs: 30_000 };
    expect(resolveDeviceRequestTimeoutMs(policy, 5_000)).toBe(5_000);
    expect(resolveDeviceRequestTimeoutMs(policy, 900_000)).toBe(30_000);
    expect(resolveDeviceRequestTimeoutMs(policy, undefined)).toBe(30_000);
    expect(resolveDeviceRequestTimeoutMs(policy, 0)).toBe(30_000);
    expect(resolveDeviceRequestTimeoutMs(policy, Number.NaN)).toBe(30_000);

    const seen: number[] = [];
    const grants = new DeviceGrantStore(join(root, 'deadline-grants.json'));
    const artifacts = new DeviceCaptureArtifactStore(join(root, 'deadline-captures'));
    const service = new DeviceCapabilityService({
      grants,
      artifacts,
      dispatcher: { async dispatch(input) { seen.push(input.timeoutMs); return { ok: true }; } },
      confirm: async () => ({ decision: 'once', actor: 'operator' }),
      listNodes: () => [profile()],
      policy,
    });
    const catalog = new GatewayMethodCatalog();
    registerDevicesGatewayMethods(catalog, {
      capabilities: service,
      grants,
      artifacts,
      housekeeper: new DeviceHousekeeper({ grants, artifacts, disclosurePath: join(root, 'deadline-hk.json') }),
    });
    await catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.command.vibrate', reason: 'x', timeoutMs: 4_000 },
    });
    await catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.command.vibrate', reason: 'x', timeoutMs: 600_000 },
    });
    expect(seen).toEqual([4_000, 30_000]);
  });

  test('a capture comes back as a reference, and its bytes are fetched by id', async () => {
    const h = verbHarness();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    h.setBytes(bytes);
    const requested = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.screen.capture', reason: 'read my screen' },
    }) as { ok: boolean; artifact: { artifactId: string; mediaType: string; byteLength: number } | null };
    expect(requested.ok).toBe(true);
    expect(requested.artifact).not.toBeNull();
    expect(requested.artifact?.mediaType).toBe('image/png');
    expect(requested.artifact?.byteLength).toBe(bytes.byteLength);

    const listed = await h.catalog.invoke('devices.artifacts.list', { ...VERB_CONTEXT, body: {} }) as {
      artifacts: readonly { artifactId: string; daemonPath: string }[];
      retained: number;
      retentionHours: number;
    };
    expect(listed.retained).toBe(1);
    expect(listed.retentionHours).toBe(24);
    expect(listed.artifacts[0]?.artifactId).toBe(requested.artifact?.artifactId);
    expect(listed.artifacts[0]?.daemonPath).toContain(requested.artifact?.artifactId ?? '');

    const read = await h.catalog.invoke('devices.artifacts.read', {
      ...VERB_CONTEXT,
      body: { artifactId: requested.artifact?.artifactId },
    }) as { dataBase64: string; artifact: { byteLength: number } };
    expect(read.artifact.byteLength).toBe(bytes.byteLength);
    // The bytes that come back over the wire are the bytes that were captured.
    expect([...(decodeDeviceCapabilityMedia({
      contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
      capabilityId: 'device.screen.capture',
      ok: true,
      mediaBase64: read.dataBase64,
    }) ?? new Uint8Array())]).toEqual([...bytes]);
  });

  test('a capture whose bytes were corrupted is a 404 naming the mismatch, never served', async () => {
    const h = verbHarness();
    h.setBytes(new Uint8Array([1, 2, 3, 4]));
    const requested = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.screen.capture', reason: 'x' },
    }) as { artifact: { artifactId: string } | null };
    const artifactId = requested.artifact?.artifactId ?? '';
    const stored = (await h.artifacts.list()).find((entry) => entry.id === artifactId);
    if (!stored) throw new Error('the capture was not retained');
    writeFileSync(h.artifacts.pathFor(stored), Buffer.from([9, 9, 9, 9]));

    let caught: unknown;
    try {
      await h.catalog.invoke('devices.artifacts.read', { ...VERB_CONTEXT, body: { artifactId } });
    } catch (error) {
      caught = error;
    }
    expect(isGatewayVerbError(caught)).toBe(true);
    expect((caught as GatewayVerbError).status).toBe(404);
    expect((caught as GatewayVerbError).field).toBe('artifactId');
    expect((caught as GatewayVerbError).message).toContain('digest');
  });

  test('an unknown capture id is a 404 attributed to artifactId', async () => {
    const h = verbHarness();
    let caught: unknown;
    try {
      await h.catalog.invoke('devices.artifacts.read', { ...VERB_CONTEXT, body: { artifactId: 'nope' } });
    } catch (error) {
      caught = error;
    }
    expect(isGatewayVerbError(caught)).toBe(true);
    expect((caught as GatewayVerbError).status).toBe(404);
    expect((caught as GatewayVerbError).field).toBe('artifactId');
  });

  test('a durable grant already given is honoured by the verb without asking again', async () => {
    const h = verbHarness();
    h.setDecision('always');
    const first = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.location.coarse', reason: 'first' },
    }) as { authority: string; grantId: string | null };
    expect(first.authority).toBe('confirmed-always');
    expect(first.grantId).not.toBeNull();

    const second = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.location.coarse', reason: 'second' },
    }) as { authority: string };
    expect(second.authority).toBe('existing-grant');
    expect(h.prompts).toHaveLength(1);

    // And revoking it through the same surface makes the next request ask again.
    await h.catalog.invoke('devices.grants.revoke', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.location.coarse' },
    });
    const third = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.location.coarse', reason: 'third' },
    }) as { authority: string };
    expect(third.authority).toBe('confirmed-always');
    expect(h.prompts).toHaveLength(2);
  });

  test('a capability turned off by configuration is refused by the verb with the key that turned it off', async () => {
    const h = verbHarness({ policy: { clipboardReadMode: 'off' } });
    const result = await h.catalog.invoke('devices.capability.request', {
      ...VERB_CONTEXT,
      body: { nodeId: 'node-a', capabilityId: 'device.clipboard.read', reason: 'x' },
    }) as { ok: boolean; refusal: string; detail: string };
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('disabled-by-config');
    expect(result.detail).toContain('device.clipboard.readMode');
    expect(h.prompts).toHaveLength(0);
  });
});
