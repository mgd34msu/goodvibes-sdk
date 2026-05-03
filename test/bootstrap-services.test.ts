import { describe, expect, test } from 'bun:test';
import {
  startHostServices,
  type HostServicesConfig,
} from '../packages/sdk/src/platform/runtime/bootstrap-services.ts';

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
      runtimeServices,
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
      runtimeServices,
      {
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity: async () => ({
          kind: 'unknown' as const,
          reason: 'Identity probe returned HTTP 404',
        }),
      },
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
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        createDaemonServer: () => createFakeService(events),
      },
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
      runtimeServices,
      {
        probeHttpListenerPortInUse: async () => true,
      },
    );

    expect(handle.httpListener).toBeNull();
    expect(handle.httpListenerStatus).toMatchObject({
      mode: 'blocked',
      host: '127.0.0.1',
      port: 3451,
      baseUrl: 'http://127.0.0.1:3451',
    });
  });

  test('stops an enabled daemon service after a bind conflict during start', async () => {
    const events: string[] = [];
    const service = createFakeService(events);
    service.start = async () => {
      events.push('start');
      throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:3421');
    };
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        probeDaemonIdentity: async () => ({ kind: 'unknown' as const, reason: 'port occupied' }),
        createDaemonServer: () => service,
      },
    );

    expect(events).toEqual(['enable', 'start', 'stop']);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('blocked');
  });

  test('rejects invalid host service ports before starting services', async () => {
    await expect(startHostServices(
      baseConfig({ 'controlPlane.port': { nested: true } as never }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        createDaemonServer: () => createFakeService([]),
      },
    )).rejects.toThrow('Expected controlPlane.port to be an integer TCP port');
  });
});
