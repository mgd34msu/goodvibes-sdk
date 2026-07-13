/**
 * The auto-update loop never assumes the SDK package is the shipped artifact.
 *
 * - Embedded default (no artifact identity): even with update.auto=true and a
 *   releases URL configured, NO auto-update loop starts — the host manages
 *   updates, and the SDK package version is never compared against the host's
 *   release tags.
 * - With a host-provided artifact identity, the loop compares the HOST's
 *   version (and swaps the host-named executable), not the SDK's VERSION.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../packages/sdk/src/platform/daemon/facade-lifecycle.ts';
import { VERSION } from '../packages/sdk/src/platform/version.ts';

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

interface LifecycleHarness {
  readonly runtime: DaemonLifecycleRuntime;
  readonly installs: number[];
  readonly exits: number[];
}

function lifecycleWith(
  updateArtifact?: DaemonLifecycleRuntimeOptions['updateArtifact'],
  overrides: {
    readonly configOverrides?: Record<string, unknown>;
    readonly status?: (() => { installed: boolean; running: boolean }) | undefined;
    readonly isIdle?: (() => boolean) | undefined;
    readonly promotionRetryMs?: number | undefined;
  } = {},
): LifecycleHarness {
  const scratch = mkdtempSync(join(tmpdir(), 'update-artifact-'));
  scratchDirs.push(scratch);
  const config = new Map<string, unknown>([
    ['update.auto', true],
    ['update.releasesUrl', 'https://releases.invalid/latest'],
    ['update.intervalMinutes', 60],
    ['service.serviceName', 'goodvibes-test'],
    ...Object.entries(overrides.configOverrides ?? {}),
  ]);
  const configManager = {
    get: (key: string) => config.get(key),
    getControlPlaneConfigDir: () => scratch,
  } as unknown as DaemonLifecycleRuntimeOptions['configManager'];
  const installs: number[] = [];
  const exits: number[] = [];
  const platformServiceManager = {
    status: overrides.status ?? (() => ({ installed: false, running: false })),
    install: () => { installs.push(Date.now()); return {}; },
  } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'];
  const runtime = new DaemonLifecycleRuntime({
    configManager,
    platformServiceManager,
    isIdle: overrides.isIdle ?? (() => true),
    // Boot promotion hands over by exiting — tests OBSERVE the exit.
    exitProcess: (code: number) => { exits.push(code); },
    ...(overrides.promotionRetryMs !== undefined ? { promotionRetryMs: overrides.promotionRetryMs } : {}),
    ...(updateArtifact !== undefined ? { updateArtifact } : {}),
  });
  return { runtime, installs, exits };
}

function updaterOf(runtime: DaemonLifecycleRuntime): { readonly options: { currentVersion: string; execPath: string } } | null {
  return (runtime as unknown as { autoUpdater: { readonly options: { currentVersion: string; execPath: string } } | null }).autoUpdater;
}

describe('daemon update artifact identity', () => {
  test('embedded default: update.auto=true but no artifact identity — no loop starts', () => {
    const { runtime } = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)).toBeNull();
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a host artifact identity drives the comparison — never the SDK package version', () => {
    const { runtime } = lifecycleWith({ version: '999.0.0-host-artifact', execPath: '/opt/host/bin/host-app' });
    runtime.onStarted();
    try {
      const updater = updaterOf(runtime);
      expect(updater).not.toBeNull();
      expect(updater!.options.currentVersion).toBe('999.0.0-host-artifact');
      // The embedder's identity is what gets compared and swapped — the SDK
      // package version must play no part when a host names its artifact.
      expect(updater!.options.currentVersion).not.toBe(VERSION);
      expect(updater!.options.execPath).toBe('/opt/host/bin/host-app');
    } finally {
      runtime.onStopping(false);
    }
  });

  test('an artifact identity without execPath swaps the running executable by default', () => {
    const { runtime } = lifecycleWith({ version: '999.0.0-host-artifact' });
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)!.options.execPath).toBe(process.execPath);
    } finally {
      runtime.onStopping(false);
    }
  });
});

describe('boot-edge service promotion (independent of updates)', () => {
  const artifact = { version: '999.0.0-host-artifact' };

  test('a standalone unsupervised idle daemon installs the unit and hands over at boot', () => {
    const { runtime, installs, exits } = lifecycleWith(artifact);
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(1);
      expect(exits).toEqual([0]);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('an embedded daemon (no artifact identity) never self-promotes — exiting would kill the host', () => {
    const { runtime, installs, exits } = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('an already-supervised daemon is left alone', () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { status: () => ({ installed: true, running: true }) });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('service.enabled=false keeps the daemon session-only (opt-out honored)', () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { configOverrides: { 'service.enabled': false } });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a platform without a service manager is left alone', () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { status: () => { throw new Error('unsupported'); } });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a busy daemon defers promotion to the same idle moment the update swap waits for', async () => {
    let idle = false;
    const { runtime, installs, exits } = lifecycleWith(artifact, { isIdle: () => idle, promotionRetryMs: 1_000 });
    runtime.onStarted();
    try {
      // Busy at boot: no install, no handover.
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
      // Idle arrives; the retry tick promotes.
      idle = true;
      await Bun.sleep(1_200);
      expect(installs).toHaveLength(1);
      expect(exits).toEqual([0]);
    } finally {
      runtime.onStopping(false);
    }
  });
});
