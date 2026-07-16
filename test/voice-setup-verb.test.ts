/**
 * voice-setup-verb.test.ts (item 8b)
 *
 * The managed local-voice provisioning verbs are wired: voice.local.status and
 * voice.local.install are in the live catalog with REST bindings that reconcile
 * against the real daemon dispatch chain, and their handlers return the
 * provisioner service's output. No real provisioning runs — the service is a stub.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  createVoiceInstallHandler,
  createVoiceStatusHandler,
  registerVoiceSetupGatewayMethods,
  type VoiceSetupGatewayService,
} from '../packages/sdk/src/platform/control-plane/routes/voice-setup.ts';
import { createDaemonSdkRouteProbe, reconcileHttpDescriptor } from '../packages/sdk/src/platform/control-plane/method-catalog-route-reconcile.ts';

const stubStatus = { platform: 'linux-x64', state: 'not-provisioned', tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '/m/piper', modelPath: '/m/voice.onnx' }, stt: { engine: 'whisper-cpp', supported: false, reason: 'no prebuilt' }, offerBytes: 89666641 };
const stubInstall = { provisioned: true, platform: 'linux-x64', tts: { engine: 'piper', state: 'provisioned', binaryPath: '/m/piper', modelPath: '/m/voice.onnx' }, stt: { engine: 'whisper-cpp', state: 'unsupported-platform', reason: 'no prebuilt' }, components: [], configured: { set: [{ key: 'voice.local.ttsEngine', value: 'piper' }], skipped: [] } };

const service: VoiceSetupGatewayService = {
  status: () => stubStatus,
  install: async () => stubInstall,
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
