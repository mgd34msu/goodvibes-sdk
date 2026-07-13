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

function lifecycleWith(updateArtifact?: DaemonLifecycleRuntimeOptions['updateArtifact']): DaemonLifecycleRuntime {
  const scratch = mkdtempSync(join(tmpdir(), 'update-artifact-'));
  scratchDirs.push(scratch);
  const config = new Map<string, unknown>([
    ['update.auto', true],
    ['update.releasesUrl', 'https://releases.invalid/latest'],
    ['update.intervalMinutes', 60],
    ['service.serviceName', 'goodvibes-test'],
  ]);
  const configManager = {
    get: (key: string) => config.get(key),
    getControlPlaneConfigDir: () => scratch,
  } as unknown as DaemonLifecycleRuntimeOptions['configManager'];
  const platformServiceManager = {
    status: () => ({ installed: false, running: false }),
    install: () => ({}),
  } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'];
  return new DaemonLifecycleRuntime({
    configManager,
    platformServiceManager,
    isIdle: () => true,
    ...(updateArtifact !== undefined ? { updateArtifact } : {}),
  });
}

function updaterOf(runtime: DaemonLifecycleRuntime): { readonly options: { currentVersion: string; execPath: string } } | null {
  return (runtime as unknown as { autoUpdater: { readonly options: { currentVersion: string; execPath: string } } | null }).autoUpdater;
}

describe('daemon update artifact identity', () => {
  test('embedded default: update.auto=true but no artifact identity — no loop starts', () => {
    const runtime = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)).toBeNull();
    } finally {
      runtime.onStopping(false);
    }
  });

  test('a host artifact identity drives the comparison — never the SDK package version', () => {
    const runtime = lifecycleWith({ version: '999.0.0-host-artifact', execPath: '/opt/host/bin/host-app' });
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
    const runtime = lifecycleWith({ version: '999.0.0-host-artifact' });
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)!.options.execPath).toBe(process.execPath);
    } finally {
      runtime.onStopping(false);
    }
  });
});
