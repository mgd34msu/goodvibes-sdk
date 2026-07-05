import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startHostServices,
  DETACHED_DAEMON_INSTALL_HINT,
  type HostServicesConfig,
  type DetachedDaemonChild,
  type DetachedDaemonSpawnOptions,
} from '../packages/sdk/src/platform/runtime/bootstrap-services.ts';

/** Unique temp dir so detached-spawn tests never touch the real daemon home. */
function tempRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-d7a-'));
}

/** Immediate sleep so probe polling in tests does not wall-clock wait. */
const immediateSleep = async (): Promise<void> => {};

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
        // Decouple this adoption test from version banding: it asserts the
        // adopt-vs-embedded decision, not the compat policy (covered separately).
        isDaemonVersionCompatible: () => true,
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

  test('refuses to adopt a verified GoodVibes daemon whose version is incompatible', async () => {
    let createDaemonCalled = false;
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        // Real banding: local 1.0.0 vs remote 2.0.0 is a major-axis mismatch.
        localDaemonVersion: '1.0.0',
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '2.0.0' }),
        createDaemonServer: () => {
          createDaemonCalled = true;
          return createFakeService([]);
        },
      },
    );

    // Never adopts and never starts a second competing daemon on the occupied port.
    expect(createDaemonCalled).toBe(false);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('incompatible');
    expect(handle.daemonStatus.version).toBe('2.0.0');
    expect(handle.daemonStatus.reason).toContain('2.0.0');
    expect(handle.daemonStatus.reason).toContain('1.0.0');
    expect(handle.daemonStatus.reason).toContain('3421');
  });

  test('reports incompatible (not blocked) when a bind conflict reveals an incompatible daemon (embed opt-in)', async () => {
    const events: string[] = [];
    const service = createFakeService(events);
    service.start = async () => {
      events.push('start');
      throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:3421');
    };
    const handle = await startHostServices(
      baseConfig({ 'daemon.embedInProcess': true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        localDaemonVersion: '0.38.0',
        probeDaemonPortInUse: async () => false,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '0.35.0' }),
        createDaemonServer: () => service,
      },
    );

    // Embedded start was attempted, failed to bind, and was stopped; the
    // re-probe found an incompatible daemon, so the final status is honest.
    expect(events).toEqual(['enable', 'start', 'stop']);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('incompatible');
    expect(handle.daemonStatus.version).toBe('0.35.0');
  });

  test('adopts a bind-conflict daemon when its version is compatible (embed opt-in)', async () => {
    const events: string[] = [];
    const service = createFakeService(events);
    service.start = async () => {
      events.push('start');
      throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:3421');
    };
    const handle = await startHostServices(
      baseConfig({ 'daemon.embedInProcess': true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        localDaemonVersion: '0.38.1',
        probeDaemonPortInUse: async () => false,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '0.38.9' }),
        createDaemonServer: () => service,
      },
    );

    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('external');
    expect(handle.daemonStatus.version).toBe('0.38.9');
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

  test('reports embedded daemon status when daemon.embedInProcess opt-in is set (Layer 3)', async () => {
    const events: string[] = [];
    const handle = await startHostServices(
      baseConfig({ 'daemon.embedInProcess': true }),
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
    expect(handle.daemonStartHint).toBeUndefined();
  });

  test('runs the daemon when danger.daemon is unset (daemon.enabled default on) — embed opt-in path', async () => {
    // The daemon-by-default ruling: with the deprecated alias absent, daemon.enabled
    // (default true) governs, so the host enters the port-free daemon branch without
    // any danger.* opt-in. The reader returns undefined for the unset alias — the exact
    // sentinel resolveDaemonEnabled relies on — and true for daemon.enabled. We set
    // daemon.embedInProcess=true here to assert the branch is reached via the embedded
    // path (the detached-default path is covered separately below).
    const defaultOnConfig: HostServicesConfig = {
      get: (key) => {
        if (key === 'danger.daemon') return undefined;
        if (key === 'daemon.enabled') return true;
        if (key === 'daemon.embedInProcess') return true;
        if (key === 'danger.httpListener') return false;
        if (key === 'controlPlane.host' || key === 'httpListener.host') return '127.0.0.1';
        if (key === 'controlPlane.port') return 3421;
        if (key === 'httpListener.port') return 3422;
        return undefined;
      },
    };
    const events: string[] = [];
    const handle = await startHostServices(
      defaultOnConfig,
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

  test('deprecated danger.daemon:false forces the daemon off even though daemon.enabled defaults on', async () => {
    const legacyOffConfig: HostServicesConfig = {
      get: (key) => {
        if (key === 'danger.daemon') return false; // explicit legacy opt-out
        if (key === 'daemon.enabled') return true; // default-on
        if (key === 'danger.httpListener') return false;
        if (key === 'controlPlane.host' || key === 'httpListener.host') return '127.0.0.1';
        if (key === 'controlPlane.port') return 3421;
        if (key === 'httpListener.port') return 3422;
        return undefined;
      },
    };
    let createDaemonCalled = false;
    const handle = await startHostServices(
      legacyOffConfig,
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        createDaemonServer: () => {
          createDaemonCalled = true;
          return createFakeService([]);
        },
      },
    );

    expect(createDaemonCalled).toBe(false);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('disabled');
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

  test('stops an enabled daemon service after a bind conflict during start (embed opt-in)', async () => {
    const events: string[] = [];
    const service = createFakeService(events);
    service.start = async () => {
      events.push('start');
      throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:3421');
    };
    const handle = await startHostServices(
      baseConfig({ 'daemon.embedInProcess': true }),
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

describe('startHostServices detached daemon spawn (Layer 2 default)', () => {
  interface CapturedSpawn {
    command?: string;
    args?: readonly string[];
    options?: DetachedDaemonSpawnOptions;
    unrefCalled: boolean;
  }

  function stubSpawn(captured: CapturedSpawn, pid = 4242): (
    command: string,
    args: readonly string[],
    options: DetachedDaemonSpawnOptions,
  ) => DetachedDaemonChild {
    return (command, args, options) => {
      captured.command = command;
      captured.args = args;
      captured.options = options;
      return {
        pid,
        unref: () => { captured.unrefCalled = true; },
        once: () => {},
      };
    };
  }

  test('spawns a DETACHED daemon by default (not in-process embedded) and adopts it as external with the install hint', async () => {
    const captured: CapturedSpawn = { unrefCalled: false };
    let createDaemonCalled = false;
    const handle = await startHostServices(
      baseConfig(), // no daemon.embedInProcess → default detached path
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: stubSpawn(captured),
        daemonRuntimeDir: tempRuntimeDir(),
        daemonHomeDir: '/home/tester',
        sleep: immediateSleep,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '9.9.9' }),
        createDaemonServer: () => {
          createDaemonCalled = true;
          return createFakeService([]);
        },
      },
    );

    // In-process embedding was NOT chosen.
    expect(createDaemonCalled).toBe(false);
    expect(handle.daemonServer).toBeNull();
    // Spawn was detached and unref()'d.
    expect(captured.options?.detached).toBe(true);
    expect(captured.unrefCalled).toBe(true);
    expect(captured.command).toBe('goodvibes-daemon');
    expect(captured.args).toContain('--daemon-home');
    expect(captured.args).toContain('/home/tester');
    expect(captured.args).toContain('--port');
    expect(captured.args).toContain('3421');
    // Adopted as external with the spawned reason + one-time install hint.
    expect(handle.daemonStatus.mode).toBe('external');
    expect(handle.daemonStatus.reason).toContain('detached');
    expect(handle.daemonStartHint).toBe(DETACHED_DAEMON_INSTALL_HINT);
  });

  test('polls until the detached daemon becomes reachable, then adopts it', async () => {
    const captured: CapturedSpawn = { unrefCalled: false };
    let probes = 0;
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: stubSpawn(captured),
        daemonRuntimeDir: tempRuntimeDir(),
        sleep: immediateSleep,
        detachedSpawnProbeIntervalMs: 1,
        detachedSpawnProbeTimeoutMs: 1000,
        probeDaemonIdentity: async () => {
          probes += 1;
          if (probes < 3) return { kind: 'unknown' as const, reason: 'not up yet' };
          return { kind: 'goodvibes' as const, status: 'running', version: '9.9.9' };
        },
      },
    );

    expect(probes).toBeGreaterThanOrEqual(3);
    expect(handle.daemonStatus.mode).toBe('external');
    expect(handle.daemonStartHint).toBe(DETACHED_DAEMON_INSTALL_HINT);
  });

  test('falls back to embedded honestly when the detached daemon never becomes reachable', async () => {
    const captured: CapturedSpawn = { unrefCalled: false };
    const events: string[] = [];
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: stubSpawn(captured),
        daemonRuntimeDir: tempRuntimeDir(),
        sleep: immediateSleep,
        detachedSpawnProbeTimeoutMs: 0, // give up after one probe
        detachedSpawnProbeIntervalMs: 1,
        probeDaemonIdentity: async () => ({ kind: 'unknown' as const, reason: 'never came up' }),
        createDaemonServer: () => createFakeService(events),
      },
    );

    // Detached spawn was attempted (and unref'd) but the fallback embedded daemon started.
    expect(captured.unrefCalled).toBe(true);
    expect(events).toEqual(['enable', 'start']);
    expect(handle.daemonServer).not.toBeNull();
    expect(handle.daemonStatus.mode).toBe('embedded');
    expect(handle.daemonStartHint).toBeUndefined();
  });

  test('does not spawn when a compatible daemon already occupies the port (adopts existing)', async () => {
    const captured: CapturedSpawn = { unrefCalled: false };
    let spawnCalled = false;
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => true, // already occupied
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '9.9.9' }),
        spawnDetachedDaemon: (command, args, options) => {
          spawnCalled = true;
          return stubSpawn(captured)(command, args, options);
        },
      },
    );

    expect(spawnCalled).toBe(false);
    expect(handle.daemonStatus.mode).toBe('external');
    // Adopting a pre-existing daemon is not a "we started it" event: no hint.
    expect(handle.daemonStartHint).toBeUndefined();
  });
});
