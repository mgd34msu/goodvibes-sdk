/**
 * voice-setup-verb.test.ts (item 8b)
 *
 * The managed local-voice provisioning verbs are wired: voice.local.status and
 * voice.local.install are in the live catalog with REST bindings that reconcile
 * against the real daemon dispatch chain, and their handlers return the
 * provisioner service's output. No real provisioning runs, the service is a stub.
 *
 * The three wake-word verbs attach through the same already-registered group, so
 * they are covered here too: their catalog bindings, and the chunked model read a
 * browser tab depends on (it cannot fetch the pinned asset itself, that asset
 * answers with no CORS header).
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  createVoiceInstallHandler,
  createVoiceStatusHandler,
  createWakeModelHandler,
  createWakeProvisionHandler,
  createWakeStatusHandler,
  registerVoiceSetupGatewayMethods,
  type VoiceSetupGatewayService,
} from '../packages/sdk/src/platform/control-plane/routes/voice-setup.ts';
import { createWakeSetupService, WAKE_MODEL_CHUNK_MAX_BYTES } from '../packages/sdk/src/platform/runtime/wake-setup.ts';
import { createDaemonSdkRouteProbe, reconcileHttpDescriptor } from '../packages/sdk/src/platform/control-plane/method-catalog-route-reconcile.ts';

const stubStatus = { platform: 'linux-x64', state: 'not-provisioned', tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '/m/piper', modelPath: '/m/voice.onnx' }, stt: { engine: 'whisper-cpp', supported: false, reason: 'no prebuilt' }, offerBytes: 89666641 };
const stubInstall = { provisioned: true, platform: 'linux-x64', tts: { engine: 'piper', state: 'provisioned', binaryPath: '/m/piper', modelPath: '/m/voice.onnx' }, stt: { engine: 'whisper-cpp', state: 'unsupported-platform', reason: 'no prebuilt' }, components: [], configured: { set: [{ key: 'voice.local.ttsEngine', value: 'piper' }], skipped: [] } };

const stubArtifact = { path: '/m/wake/x', verified: true, corrupt: false, bytes: 10 };
const stubWakeStatus = { ready: true, reason: null, classifier: stubArtifact, mobileClassifier: stubArtifact, notice: stubArtifact, embedding: stubArtifact, embeddingNotice: stubArtifact, vad: stubArtifact, vadNotice: stubArtifact, vadReady: true, downloadBytes: 0, modelVersion: '1.0.0', recallIsSyntheticOnly: true };
const stubWakeProvision = { ready: true, mobileFormatReady: true, vadReady: true, modelVersion: '1.0.0', noticePath: '/m/wake/models/NOTICE.txt', embeddingNoticePath: '/m/wake/front-end/NOTICE.txt', recallIsSyntheticOnly: true, outcomes: [] };
const stubChunk = { component: 'classifier', offset: 0, bytes: 4, totalBytes: 4, sha256: 'abc', dataBase64: 'AAEC', complete: true };

const service: VoiceSetupGatewayService = {
  status: () => stubStatus,
  install: async () => stubInstall,
  wakeStatus: () => stubWakeStatus,
  wakeProvision: async () => stubWakeProvision,
  wakeModelChunk: () => stubChunk,
};

describe('voice.local provisioning verbs are wired', () => {
  test('handlers return the provisioner service output', async () => {
    expect(createVoiceStatusHandler(service)({} as never)).toEqual(stubStatus);
    expect(await createVoiceInstallHandler(service)({} as never)).toEqual(stubInstall);
  });

  test('both verbs are in the live catalog with the expected REST bindings', () => {
    const descriptors = new GatewayMethodCatalog().list();
    const status = descriptors.find((d) => d.id === 'voice.local.status');
    const install = descriptors.find((d) => d.id === 'voice.local.install');
    expect(status?.http).toEqual({ method: 'GET', path: '/api/voice/local/status' });
    expect(install?.http).toEqual({ method: 'POST', path: '/api/voice/local/install' });
  });

  test('both verbs reconcile as live against the real daemon dispatch chain', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = new GatewayMethodCatalog().list();
    for (const id of ['voice.local.status', 'voice.local.install']) {
      const descriptor = descriptors.find((d) => d.id === id)!;
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${id} must reconcile live`).toBe('live');
    }
  });

  test('registering the handlers does not throw and leaves the descriptors registered', () => {
    const catalog = new GatewayMethodCatalog();
    expect(() => registerVoiceSetupGatewayMethods(catalog, service)).not.toThrow();
    expect(catalog.get('voice.local.status')).toBeDefined();
    expect(catalog.get('voice.local.install')).toBeDefined();
  });
});

describe('install single-flight + admission (fix-round 2)', () => {
  test('concurrent install calls collapse into ONE run; callers share the result; next call starts fresh', async () => {
    const { singleFlight } = await import('../packages/sdk/src/platform/utils/single-flight.ts');
    let runs = 0;
    const gates: Array<(v: string) => void> = [];
    const run = singleFlight(() => {
      runs += 1;
      return new Promise<string>((r) => { gates.push(r); });
    });
    const a = run();
    const b = run();
    const c = run();
    expect(runs).toBe(1); // one in-flight execution for three concurrent callers
    gates[0]!('done');
    expect(await a).toBe('done');
    expect(await b).toBe('done');
    expect(await c).toBe('done');
    // After settlement a new call starts a FRESH run.
    const d = run();
    expect(runs).toBe(2);
    gates[1]!('again');
    expect(await d).toBe('again');
  });

  test('failures release the flight (a later call retries instead of joining a dead promise)', async () => {
    const { singleFlight } = await import('../packages/sdk/src/platform/utils/single-flight.ts');
    let runs = 0;
    const run = singleFlight(async () => {
      runs += 1;
      if (runs === 1) throw new Error('first fails');
      return 'second-succeeds';
    });
    await expect(run()).rejects.toThrow('first fails');
    expect(await run()).toBe('second-succeeds');
    expect(runs).toBe(2);
  });
});

describe('the wake-word verbs ride the same registered group', () => {
  test('handlers return the wake service output', async () => {
    expect(createWakeStatusHandler(service)({} as never)).toEqual(stubWakeStatus);
    expect(await createWakeProvisionHandler(service)({} as never)).toEqual(stubWakeProvision);
    expect(createWakeModelHandler(service)({ component: 'classifier' } as never)).toEqual(stubChunk);
  });

  test('a GET verb\'s numbers arrive as strings, and the handler must not read them as 0', () => {
    // The control plane states outright that GET params arrive as query strings
    // and are not type-checked, so this is exactly what the daemon delivers. A
    // handler that required a number would silently reset offset to 0, and a
    // chunked client would re-fetch the first chunk forever.
    const seen: Array<{ offset?: number | undefined; maxBytes?: number | undefined }> = [];
    const capturing: VoiceSetupGatewayService = {
      ...service,
      wakeModelChunk: (request) => {
        seen.push({ offset: request.offset, maxBytes: request.maxBytes });
        return stubChunk;
      },
    };
    createWakeModelHandler(capturing)({ component: 'classifier', offset: '524288', maxBytes: '1024' } as never);
    expect(seen[0]).toEqual({ offset: 524288, maxBytes: 1024 });
    // Absent stays absent rather than becoming 0-with-intent.
    createWakeModelHandler(capturing)({ component: 'classifier' } as never);
    expect(seen[1]).toEqual({ offset: undefined, maxBytes: undefined });
  });

  test('a nonsense offset is refused loudly instead of read as the start of the file', () => {
    expect(() => createWakeModelHandler(service)({ component: 'classifier', offset: 'abc' } as never))
      .toThrow(/offset must be a non-negative number/);
    expect(() => createWakeModelHandler(service)({ component: 'classifier', offset: '-5' } as never))
      .toThrow(/offset must be a non-negative number/);
  });

  test('an unrecognised component is refused with a written reason, not turned into a path', () => {
    expect(() => createWakeModelHandler(service)({ component: '../../etc/passwd' } as never))
      .toThrow(/component must be one of classifier, tflite, embedding, notice, embedding-notice, vad, vad-notice/);
    expect(() => createWakeModelHandler(service)({} as never))
      .toThrow(/component must be one of classifier, tflite, embedding, notice, embedding-notice, vad, vad-notice/);
  });

  test('every provisioned artifact is servable, including all three attribution NOTICEs', () => {
    // A runtime that cannot load onnx has the same claim on the model as one that
    // can, and no more ability to fetch the release asset itself. A browser tab
    // reads the speech gate from here for the same reason it reads the classifier
    // from here. And a client that can fetch the bytes but not the NOTICE cannot
    // satisfy the terms it received them under, so the front end's and the gate's
    // NOTICEs are components here too, not just the classifier's.
    for (const component of ['classifier', 'tflite', 'embedding', 'notice', 'embedding-notice', 'vad', 'vad-notice']) {
      expect(() => createWakeModelHandler(service)({ component } as never)).not.toThrow();
    }
    expect(createWakeModelHandler(service)({ component: 'vad' } as never)).toEqual(stubChunk);
  });

  test('all three verbs are in the live catalog with REST bindings, and register without throwing', () => {
    const catalog = new GatewayMethodCatalog();
    const descriptors = catalog.list();
    expect(descriptors.find((d) => d.id === 'voice.wake.status')?.http).toEqual({ method: 'GET', path: '/api/voice/wake/status' });
    expect(descriptors.find((d) => d.id === 'voice.wake.provision')?.http).toEqual({ method: 'POST', path: '/api/voice/wake/provision' });
    expect(descriptors.find((d) => d.id === 'voice.wake.model.get')?.http).toEqual({ method: 'GET', path: '/api/voice/wake/model' });
    expect(() => registerVoiceSetupGatewayMethods(catalog, service)).not.toThrow();
    expect(catalog.get('voice.wake.model.get')).toBeDefined();
  });
});

describe('the chunked model read a browser tab reassembles', () => {
  // A fake artifact of 300 bytes read 128 at a time: three chunks, the last
  // short, every one restating the total and the PINNED checksum so the client
  // can verify the file it rebuilt rather than trusting the transfer.
  const bytes = new Uint8Array(300);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  const wake = createWakeSetupService({
    managedVoiceRoot: '/managed/voice',
    artifactSize: () => bytes.length,
    readArtifact: (_path, offset, length) => bytes.subarray(offset, offset + length),
  });

  test('chunks tile the artifact exactly, and only the last is complete', () => {
    const rebuilt: number[] = [];
    let offset = 0;
    let chunks = 0;
    for (;;) {
      const chunk = wake.modelChunk({ component: 'classifier', offset, maxBytes: 128 });
      chunks += 1;
      expect(chunk.totalBytes).toBe(bytes.length);
      expect(chunk.sha256.length).toBeGreaterThan(0);
      const decoded = Uint8Array.from(atob(chunk.dataBase64), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(chunk.bytes);
      rebuilt.push(...decoded);
      offset += chunk.bytes;
      if (chunk.complete) break;
      expect(chunks).toBeLessThan(10);
    }
    expect(chunks).toBe(3);
    expect(rebuilt.length).toBe(bytes.length);
    expect(Uint8Array.from(rebuilt)).toEqual(bytes);
  });

  test('the chunk size is capped however much a caller asks for', () => {
    const big = new Uint8Array(WAKE_MODEL_CHUNK_MAX_BYTES * 3);
    const capped = createWakeSetupService({
      managedVoiceRoot: '/managed/voice',
      artifactSize: () => big.length,
      readArtifact: (_p, o, l) => big.subarray(o, o + l),
    });
    const chunk = capped.modelChunk({ component: 'embedding', offset: 0, maxBytes: big.length });
    expect(chunk.bytes).toBe(WAKE_MODEL_CHUNK_MAX_BYTES);
    expect(chunk.complete).toBe(false);
  });

  test('every component is served from its own path, under its own pin', () => {
    // Different artifacts, so different pinned checksums, a client verifying the
    // file it rebuilt against the wrong pin would reject a perfectly good model.
    const components = ['classifier', 'tflite', 'embedding', 'notice', 'embedding-notice'] as const;
    const pins = components.map((component) => wake.modelChunk({ component, offset: 0, maxBytes: 16 }).sha256);
    expect(new Set(pins).size).toBe(components.length);
    for (const pin of pins) expect(pin.length).toBe(64);
  });

  test('the two NOTICEs are distinct artifacts, not one file served twice', () => {
    const classifierNotice = wake.modelChunk({ component: 'notice', offset: 0, maxBytes: 16 });
    const frontEndNotice = wake.modelChunk({ component: 'embedding-notice', offset: 0, maxBytes: 16 });
    expect(frontEndNotice.sha256).not.toBe(classifierNotice.sha256);
  });

  test('an offset past the end is an error, not an empty success', () => {
    expect(() => wake.modelChunk({ component: 'classifier', offset: 5000 })).toThrow(/past the end/);
  });

  test('provisioning is single-flight: two surfaces asking at once join one download', async () => {
    let runs = 0;
    let release: (() => void) | null = null;
    const svc = createWakeSetupService({
      managedVoiceRoot: '/managed/voice',
      provision: async () => {
        runs += 1;
        await new Promise<void>((r) => { release = r; });
        return { ready: true, mobileFormatReady: true, vadReady: true, modelVersion: '1.0.0', outcomes: [], noticePath: null, embeddingNoticePath: null, recallIsSyntheticOnly: true };
      },
    });
    const a = svc.provision();
    const b = svc.provision();
    expect(runs).toBe(1);
    release!();
    expect((await a).ready).toBe(true);
    expect((await b).ready).toBe(true);
  });

  test('status never downloads: it reports what the reader says is on disk', () => {
    let downloads = 0;
    const svc = createWakeSetupService({
      managedVoiceRoot: '/managed/voice',
      readStatus: () => stubWakeStatus,
      provision: async () => { downloads += 1; return stubWakeProvision; },
    });
    expect(svc.status()).toEqual(stubWakeStatus);
    expect(downloads).toBe(0);
  });
});


describe('the install/boot provisioning path on the setup service', () => {
  test('a boot attempt and a user-triggered setup join ONE download', async () => {
    let runs = 0;
    let release: (() => void) | null = null;
    const svc = createWakeSetupService({
      managedVoiceRoot: '/managed/voice',
      readStatus: () => ({ ...stubWakeStatus, ready: false, reason: 'not-provisioned' }),
      provision: async () => {
        runs += 1;
        await new Promise<void>((r) => { release = r; });
        return { ready: true, mobileFormatReady: true, vadReady: true, modelVersion: '1.0.0', outcomes: [], noticePath: null, embeddingNoticePath: null, recallIsSyntheticOnly: true };
      },
    });
    const boot = svc.ensureProvisioned({ recoveryHint: '/voice wake setup' });
    const user = svc.provision();
    // The whole reason ensureProvisioned lives on the service rather than being
    // called directly: two 6 MB downloads for the same files is the alternative.
    expect(runs).toBe(1);
    release!();
    await user;
    await boot;
    expect(runs).toBe(1);
  });

  test('ensureProvisioned reports the recovery hint it was given, and never throws', async () => {
    const svc = createWakeSetupService({
      managedVoiceRoot: '/managed/voice',
      readStatus: () => ({ ...stubWakeStatus, ready: false, reason: 'not-provisioned' }),
      provision: async () => { throw new Error('no route to host'); },
    });
    const outcome = await svc.ensureProvisioned({ recoveryHint: '/voice wake setup' });
    expect(outcome.state).toBe('degraded');
    expect(outcome.message).toContain('/voice wake setup');
    expect(outcome.message).toContain('no route to host');
  });

  test('an already-provisioned host is not asked to download anything at boot', async () => {
    let runs = 0;
    const svc = createWakeSetupService({
      managedVoiceRoot: '/managed/voice',
      readStatus: () => stubWakeStatus,
      provision: async () => { runs += 1; return stubWakeProvision; },
    });
    const outcome = await svc.ensureProvisioned();
    expect(outcome.state).toBe('already-provisioned');
    expect(runs).toBe(0);
  });
});
