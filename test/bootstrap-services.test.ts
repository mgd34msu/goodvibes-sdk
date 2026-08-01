import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
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
    'daemon.enabled': true,
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

/**
 * The daemon is a separate product. A client host has exactly two daemon paths —
 * adopt one that is already running, or spawn the standalone `goodvibes-daemon`
 * binary as a detached child and adopt that. It never constructs one, and there
 * is no option or factory that makes it construct one: the module reaches
 * `platform/daemon` neither statically nor dynamically (asserted at the bottom of
 * this file, because a dynamic import that is never taken still drags the daemon
 * graph into a client bundle).
 */
describe('startHostServices daemon lifecycle', () => {
  test('reports verified external daemon instead of composing one in this process', async () => {
    let spawnCalled = false;
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        sharedDaemonToken: 'shared-token',
        // Decouple this adoption test from version banding: it asserts the
        // adopt-vs-spawn decision, not the compat policy (covered separately).
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => true,
        probeDaemonIdentity: async (host, port, token) => {
          expect(host).toBe('127.0.0.1');
          expect(port).toBe(3421);
          expect(token).toBe('shared-token');
          return { kind: 'goodvibes' as const, status: 'running', version: '0.26.4' };
        },
        spawnDetachedDaemon: () => {
          spawnCalled = true;
          return { pid: 1, unref() {} };
        },
      },
    );

    expect(spawnCalled).toBe(false);
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
    let spawnCalled = false;
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
        spawnDetachedDaemon: () => {
          spawnCalled = true;
          return { pid: 1, unref() {} };
        },
      },
    );

    // Never adopts and never starts a second competing daemon on the occupied port.
    expect(spawnCalled).toBe(false);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('incompatible');
    expect(handle.daemonStatus.version).toBe('2.0.0');
    expect(handle.daemonStatus.reason).toContain('2.0.0');
    expect(handle.daemonStatus.reason).toContain('1.0.0');
    expect(handle.daemonStatus.reason).toContain('3421');
  });

  test('the port-free race — someone else owns the port by the time the spawn lands — still band-checks before adopting', async () => {
    // The port probe said free, so the host spawned; by the time the identity
    // probe answered, the occupant was an incompatible daemon. It is refused,
    // and with no in-process daemon to fall back to the status is 'unavailable'
    // naming the version mismatch — never a silent adopt of a skewed wire.
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        localDaemonVersion: '0.38.0',
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: () => ({ pid: 7, unref() {} }),
        daemonRuntimeDir: tempRuntimeDir(),
        sleep: immediateSleep,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '0.35.0' }),
      },
    );

    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('unavailable');
    expect(handle.daemonStatus.reason).toContain('0.35.0');
    expect(handle.daemonStatus.reason).toContain('0.38.0');
  });

  test('the same race with a COMPATIBLE occupant is adopted as external', async () => {
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        localDaemonVersion: '0.38.1',
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: () => ({ pid: 7, unref() {} }),
        daemonRuntimeDir: tempRuntimeDir(),
        sleep: immediateSleep,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '0.38.9' }),
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

  test('the port-free path spawns the standalone binary — the handle never carries a daemon', async () => {
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: () => ({ pid: 99, unref() {} }),
        daemonRuntimeDir: tempRuntimeDir(),
        sleep: immediateSleep,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '9.9.9' }),
      },
    );

    // 'embedded' is a mode the daemon can no longer report: nothing composes one
    // here, so a started daemon is always an adopted external process.
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('external');
    expect(handle.listRecentControlPlaneEvents(10)).toEqual([]);
  });

  test('runs the daemon when daemon.enabled is true', async () => {
    // The daemon-by-default ruling: daemon.enabled (default true) governs, so the
    // host enters the port-free daemon branch and spawns the standalone binary.
    // The deprecated danger.daemon alias that used to override this was removed
    // (see config-migrations.test.ts for the migration that preserves an existing
    // explicit off-switch).
    const defaultOnConfig: HostServicesConfig = {
      get: (key) => {
        if (key === 'daemon.enabled') return true;
        if (key === 'danger.httpListener') return false;
        if (key === 'controlPlane.host' || key === 'httpListener.host') return '127.0.0.1';
        if (key === 'controlPlane.port') return 3421;
        if (key === 'httpListener.port') return 3422;
        return undefined;
      },
    };
    let spawnCalled = false;
    const handle = await startHostServices(
      defaultOnConfig,
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: () => {
          spawnCalled = true;
          return { pid: 99, unref() {} };
        },
        daemonRuntimeDir: tempRuntimeDir(),
        sleep: immediateSleep,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '9.9.9' }),
      },
    );

    expect(spawnCalled).toBe(true);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('external');
  });

  test('daemon.enabled:false leaves the daemon off', async () => {
    let spawnCalled = false;
    const handle = await startHostServices(
      baseConfig({ 'daemon.enabled': false }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: () => {
          spawnCalled = true;
          return { pid: 1, unref() {} };
        },
      },
    );

    expect(spawnCalled).toBe(false);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('disabled');
  });

  test('reports HTTP listener blocked status using the listener host and port', async () => {
    const handle = await startHostServices(
      baseConfig({
        'daemon.enabled': false,
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

  test('rejects invalid host service ports before starting services', async () => {
    await expect(startHostServices(
      baseConfig({ 'controlPlane.port': { nested: true } as never }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeDaemonPortInUse: async () => false,
      },
    )).rejects.toThrow('Expected controlPlane.port to be an integer TCP port');
  });
});

describe('startHostServices HTTP listener composition', () => {
  test('enabled with no injected factory reports unavailable naming the daemon product', async () => {
    // The HttpListener class belongs to `goodvibes-daemon`. A client host that
    // cannot build one must not report the listener as merely off, because the
    // setting says it is on — it reports why it did not start.
    const handle = await startHostServices(
      baseConfig({ 'daemon.enabled': false, 'danger.httpListener': true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeHttpListenerPortInUse: async () => false,
      },
    );

    expect(handle.httpListener).toBeNull();
    expect(handle.httpListenerStatus.mode).toBe('unavailable');
    expect(handle.httpListenerStatus.reason).toContain('goodvibes-daemon');
    expect(handle.httpListenerStatus.port).toBe(3422);
  });

  test('an injected factory is still started and reported embedded', async () => {
    const events: string[] = [];
    const handle = await startHostServices(
      baseConfig({ 'daemon.enabled': false, 'danger.httpListener': true }),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        probeHttpListenerPortInUse: async () => false,
        createHttpListener: () => createFakeService(events),
      },
    );

    expect(events).toEqual(['enable', 'start']);
    expect(handle.httpListener).not.toBeNull();
    expect(handle.httpListenerStatus.mode).toBe('embedded');

    await handle.stop();
    expect(events).toEqual(['enable', 'start', 'stop']);
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

  test('spawns a DETACHED daemon and adopts it as external with the install hint', async () => {
    const captured: CapturedSpawn = { unrefCalled: false };
    const runtimeDir = tempRuntimeDir();
    const handle = await startHostServices(
      baseConfig(),
      runtimeBus,
      hookDispatcher,
      runtimeServices,
      {
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => false,
        spawnDetachedDaemon: stubSpawn(captured),
        daemonRuntimeDir: runtimeDir,
        daemonHomeDir: '/home/tester',
        sleep: immediateSleep,
        probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '9.9.9' }),
      },
    );

    // The daemon runs in its own process; this one holds no daemon object.
    expect(handle.daemonServer).toBeNull();
    // Spawn was detached and unref()'d.
    expect(captured.options?.detached).toBe(true);
    expect(captured.unrefCalled).toBe(true);
    expect(captured.command).toBe('goodvibes-daemon');
    expect(captured.args).toContain('--daemon-home');
    // The daemon's STATE directory, not the user home above it. Every reader in
    // the SDK resolves `--daemon-home` as `~/.goodvibes/daemon` (see
    // workspace/daemon-home.ts, config/daemon-config-tier.ts,
    // owner-profile/paths.ts, config/secrets.ts); this spawner passed the user
    // home, so a spawned daemon filed its operator tokens and daemon settings a
    // level up from where all of them look. On a normal machine the config half
    // still landed right, because the user home IS the default parent — which is
    // exactly why nothing caught it.
    expect(captured.args).toContain(runtimeDir);
    expect(captured.args).not.toContain('/home/tester');
    // The env var is read by the same resolver; the two must not disagree.
    expect(captured.options?.env?.['GOODVIBES_DAEMON_HOME']).toBe(runtimeDir);
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

  test('reports unavailable honestly when the detached daemon never becomes reachable — there is no in-process fallback', async () => {
    const captured: CapturedSpawn = { unrefCalled: false };
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
      },
    );

    // Detached spawn was attempted (and unref'd); it did not come up, and the
    // host says so instead of standing a daemon up inside itself.
    expect(captured.unrefCalled).toBe(true);
    expect(handle.daemonServer).toBeNull();
    expect(handle.daemonStatus.mode).toBe('unavailable');
    expect(handle.daemonStatus.reason).toContain('never came up');
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

describe('client bootstrap cannot reach daemon composition code', () => {
  /**
   * Source-level, on purpose. A behavioural test cannot see this: an
   * `await import('../daemon/server.js')` on a branch nothing takes still makes
   * a bundler pull `platform/daemon` — and everything it imports — into a client
   * bundle, and wrap the shared platform modules in lazy initializers to do it.
   * That is what left module constants uninitialized when hoisted turn-engine
   * functions read them (`ACTION_VERBS` undefined, every turn dead). The daemon
   * product composes DaemonServer/HttpListener with direct static imports in its
   * own entrypoint; this module must have no path to them at all.
   */
  const MODULE_PATH = new URL('../packages/sdk/src/platform/runtime/bootstrap-services.ts', import.meta.url);
  const source = readFileSync(MODULE_PATH, 'utf8');

  test('no dynamic import reaches platform/daemon', () => {
    const dynamicDaemonImport = /import\s*\(\s*['"][^'"]*\/daemon\//;
    expect(dynamicDaemonImport.test(source)).toBe(false);
  });

  test('no static import reaches platform/daemon either', () => {
    const staticDaemonImport = /\bfrom\s+['"][^'"]*\/daemon\//;
    expect(staticDaemonImport.test(source)).toBe(false);
  });

  test('the daemon composition classes are neither bound nor constructed here', () => {
    // Naming them in a comment is fine — reaching them is not.
    expect(source).not.toMatch(/new\s+DaemonServer\b/);
    expect(source).not.toMatch(/new\s+HttpListener\b/);
    expect(source).not.toMatch(/\{\s*DaemonServer[\s,}]/);
    expect(source).not.toMatch(/\{\s*HttpListener[\s,}]/);
  });
});
