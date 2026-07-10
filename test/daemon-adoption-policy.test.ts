import { describe, expect, test } from 'bun:test';
import {
  classifyDaemonProbe,
  decideDaemonAdoption,
  startHostServices,
  type DaemonIdentityProbeResult,
  type HostServicesConfig,
} from '../packages/sdk/src/platform/runtime/bootstrap.ts';

/**
 * The shared adopt-or-spawn decision policy. Asserts the pure ruling and the two
 * hoist properties: the version band-check is ALWAYS applied before adopting
 * (the agent's stub skipped it), and adopt-only is a config flag that adopts a
 * compatible daemon but never spawns one.
 */

const compatible = (_local: string, remote: string | undefined): boolean => remote === '1.0.0';
const goodvibes = (version: string): DaemonIdentityProbeResult => ({ kind: 'goodvibes', status: 'running', version });

describe('classifyDaemonProbe', () => {
  test('goodvibes + compatible band → adopt', () => {
    expect(classifyDaemonProbe({ identity: goodvibes('1.0.0'), localVersion: '1.0.0', versionCompatible: compatible })).toBe('adopt');
  });
  test('goodvibes + incompatible band → incompatible', () => {
    expect(classifyDaemonProbe({ identity: goodvibes('2.0.0'), localVersion: '1.0.0', versionCompatible: compatible })).toBe('incompatible');
  });
  test('unverified occupant → blocked', () => {
    expect(classifyDaemonProbe({ identity: { kind: 'unauthorized' }, localVersion: '1.0.0', versionCompatible: compatible })).toBe('blocked');
    expect(classifyDaemonProbe({ identity: { kind: 'unknown' }, localVersion: '1.0.0', versionCompatible: compatible })).toBe('blocked');
  });
});

describe('decideDaemonAdoption', () => {
  const base = { localVersion: '1.0.0', versionCompatible: compatible, embedInProcess: false, adoptOnly: false };

  test('disabled when not enabled', () => {
    expect(decideDaemonAdoption({ ...base, enabled: false, portInUse: false, identity: null }).action).toBe('disabled');
  });
  test('port free → spawn by default', () => {
    expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: false, identity: null }).action).toBe('spawn');
  });
  test('port free + embedInProcess → embed', () => {
    expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: false, identity: null, embedInProcess: true }).action).toBe('embed');
  });
  test('port in use + compatible → adopt', () => {
    expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: true, identity: goodvibes('1.0.0') }).action).toBe('adopt');
  });
  test('port in use + incompatible → incompatible', () => {
    expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: true, identity: goodvibes('2.0.0') }).action).toBe('incompatible');
  });
  test('port in use + unverified → blocked', () => {
    expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: true, identity: { kind: 'unknown', reason: 'HTTP 404' } }).action).toBe('blocked');
  });

  describe('adopt-only policy', () => {
    test('port free → adopt-only-idle (never spawns)', () => {
      expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: false, identity: null, adoptOnly: true }).action).toBe('adopt-only-idle');
    });
    test('port free + embedInProcess is still adopt-only-idle (never embeds either)', () => {
      expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: false, identity: null, embedInProcess: true, adoptOnly: true }).action).toBe('adopt-only-idle');
    });
    test('compatible daemon present → adopt', () => {
      expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: true, identity: goodvibes('1.0.0'), adoptOnly: true }).action).toBe('adopt');
    });
    test('ALWAYS version-checks: an incompatible daemon is refused even under adopt-only', () => {
      // This is the agent-stub gap the hoist closes — it would have adopted blindly.
      expect(decideDaemonAdoption({ ...base, enabled: true, portInUse: true, identity: goodvibes('9.9.9'), adoptOnly: true }).action).toBe('incompatible');
    });
  });
});

// ── Integration: adopt-only flows through startHostServices ────────────────────

function baseConfig(values: Record<string, boolean | number | string> = {}): HostServicesConfig {
  const merged: Record<string, boolean | number | string> = {
    'daemon.enabled': true,
    'danger.httpListener': false,
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'httpListener.host': '127.0.0.1',
    'httpListener.port': 3422,
    ...values,
  };
  return { get: (key) => merged[key] ?? false };
}

const runtimeBus = {} as never;
const hookDispatcher = {} as never;
const runtimeServices = { localUserAuthManager: {}, configManager: {} } as never;

describe('startHostServices — adopt-only policy', () => {
  test('port free + adoptOnly: never spawns, reports unavailable', async () => {
    let spawnCalled = false;
    const handle = await startHostServices(baseConfig(), runtimeBus, hookDispatcher, runtimeServices, {
      adoptOnly: true,
      probeDaemonPortInUse: async () => false,
      spawnDetachedDaemon: () => { spawnCalled = true; return { pid: 1, unref() {} }; },
      createDaemonServer: () => { throw new Error('must not embed under adopt-only'); },
    });
    expect(spawnCalled).toBe(false);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('unavailable');
    expect(handle.daemonStatus.reason).toContain('adopt-only');
  });

  test('compatible daemon present + adoptOnly: adopts as external', async () => {
    const handle = await startHostServices(baseConfig(), runtimeBus, hookDispatcher, runtimeServices, {
      adoptOnly: true,
      isDaemonVersionCompatible: () => true,
      probeDaemonPortInUse: async () => true,
      probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '1.2.3' }),
    });
    expect(handle.daemonStatus.mode).toBe('external');
    expect(handle.daemonStatus.version).toBe('1.2.3');
  });
});
