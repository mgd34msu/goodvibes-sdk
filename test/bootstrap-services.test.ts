import { describe, expect, test } from 'bun:test';
import {
  startHostServices,
  type HostServicesConfig,
} from '../packages/sdk/src/_internal/platform/runtime/bootstrap-services.ts';

function config(values: Record<string, boolean | number | string>): HostServicesConfig {
  return {
    get: (key) => values[key] ?? false,
  };
}

function baseConfig(values: Record<string, boolean | number | string> = {}): HostServicesConfig {
  return config({
    'danger.daemon': true,
    'danger.httpListener': false,
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'httpListener.host': '127.0.0.1',
    'httpListener.port': 3422,
    ...values,
  });
}

function createFakeService(events: string[]) {
  return {
    enable: () => {
      events.push('enable');
      return true;
    },
    start: async () => {
      events.push('start');
    },
    stop: async () => {
      events.push('stop');
    },
    listRecentControlPlaneEvents: () => [],
  };
}

const runtimeBus = {} as never;
const hookDispatcher = {} as never;
const runtimeServices = {
  localUserAuthManager: {},
  configManager: {},
} as never;

describe('startHostServices daemon lifecycle', () => {
  test('reports verified external daemon instead of starting an embedded daemon', async () => {
    let createDaemonCalled = false;
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      {
        sharedDaemonToken: 'shared-token',
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity: async (host, port, token) => {
          expect(host).toBe('127.0.0.1');
          expect(port).toBe(3421);
          expect(token).toBe('shared-token');
          return { kind: 'goodvibes' as const, status: 'running', version: '0.26.4' };
        },
        createDaemonServer: () => {
          createDaemonCalled = true;
          return createFakeService([]);
        },
      },
      runtimeServices,
    );

    expect(createDaemonCalled).toBe(false);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus).toMatchObject({
      mode: 'external',
      host: '127.0.0.1',
      port: 3421,
      baseUrl: 'http://127.0.0.1:3421',
      status: 'running',
      version: '0.26.4',
      authenticated: true,
    });
  });

  test('reports blocked daemon status when an occupied port is not verified as GoodVibes', async () => {
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      {
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity: async () => ({
          kind: 'unknown' as const,
          reason: 'Identity probe returned HTTP 404',
        }),
      },
      runtimeServices,
    );

    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('blocked');
    expect(handle.daemonStatus.reason).toBe('Identity probe returned HTTP 404');
  });

  test('reports embedded daemon status when the SDK starts the daemon', async () => {
    const events: string[] = [];
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      {
        probeDaemonPortInUse: async () => false,
        createDaemonServer: () => createFakeService(events),
      },
      runtimeServices,
    );

    expect(events).toEqual(['enable', 'start']);
    expect(handle.daemonServer).not.toBeNull();
    expect(handle.daemonStatus.mode).toBe('embedded');
  });

  test('reports HTTP listener blocked status using the listener host and port', async () => {
    const handle = await startHostServices(
      baseConfig({
        'danger.daemon': false,
        'danger.httpListener': true,
        'controlPlane.port': 3450,
        'httpListener.port': 3451,
      }),
      runtimeBus,
      hookDispatcher,
      {
        probeHttpListenerPortInUse: async () => true,
      },
      runtimeServices,
    );

    expect(handle.httpListener).toBeNull();
    expect(handle.httpListenerStatus).toMatchObject({
      mode: 'blocked',
      host: '127.0.0.1',
      port: 3451,
      baseUrl: 'http://127.0.0.1:3451',
    });
  });
});
