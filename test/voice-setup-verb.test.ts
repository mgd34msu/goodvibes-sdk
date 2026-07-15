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
