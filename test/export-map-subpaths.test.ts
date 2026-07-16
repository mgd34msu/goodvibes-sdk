/**
 * Export-map subpath resolution: consumer imports of the public subpaths are
 * proven against the COMMITTED package.json exports manifest, not just
 * compilation. Every import here goes through the package NAME (the workspace
 * link into packages/sdk), so Bun applies the real exports map exactly as a
 * consumer install would — a subpath missing from the manifest fails here
 * even though the dist file exists on disk.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = '@pellux/goodvibes-sdk';

/** subpath -> the export names a consumer composes with. */
const SUBPATH_SURFACE: Record<string, readonly string[]> = {
  './platform/state/store-snapshots': ['StoreSnapshotScheduler', 'RetentionPolicy', 'SnapshotPruner', 'defaultStoreSnapshotRetention', 'snapshotStoreFile', 'restoreStoreSnapshot', 'listStoreSnapshots'],
  './platform/runtime/permissions/exec-prompt-wiring': ['buildExecPromptAnswerHandler'],
  './platform/runtime/self-update': ['compareVersions', 'normalizeVersion', 'resolveLatestReleaseTag', 'resolveArtifactNames', 'verifyChecksum'],
  './platform/daemon/auto-updater': ['DaemonAutoUpdater', 'defaultDownloadBaseUrl'],
  './platform/daemon/receipts': ['DaemonReceiptStore', 'formatReceiptTime', 'realReceiptStoreIo'],
  // Single-file module: the SDK's own version constant (cli/acp/mcp compose it).
  './platform/version': ['VERSION'],
};

/**
 * Directory-barrel subpaths (dist targets are <dir>/index.*, unlike the
 * file-shaped table above). Same manifest-proven contract: each module a
 * consumer composition root needs (the SDK's own cli.ts/services.ts imports
 * are the reference set) must be declared AND resolve through the package
 * name. platform/power and platform/relay were the phantom-export finds of
 * the 2026-07-14 consumer re-link (dist-built, composed in-process by
 * services.ts, absent from the map).
 */
const DIR_SUBPATH_SURFACE: Record<string, readonly string[]> = {
  './platform/power': ['PowerManager', 'wireRuntimePower', 'createLinuxLogindSeam', 'bindPowerWorkSignals', 'createUnavailablePowerSeam'],
  './platform/relay': ['StepUpService', 'createRelayReachability', 'buildDaemonRelayReachability', 'evaluateStepUp', 'isMutatingMethod'],
  // The consolidation driver rides the existing ./platform/state barrel — a
  // consumer constructs it the way runtime/services.ts does.
  './platform/state': ['MemoryConsolidationScheduler', 'runMemoryConsolidation', 'resolveMemoryConsolidationConfig'],
  // The memory-governance layer: fork-composing consumers (agent, TUI) build
  // their own runtime services and must construct the governor the way
  // runtime/services.ts does — this was the 2026-07-16 phantom-export find
  // (dist-built, composed in-process, absent from the map).
  './platform/runtime/memory': [
    'CacheRegistry', 'PauseController', 'MemoryGovernor',
    'createMemoryGovernance', 'wireDaemonMemoryGovernance',
    'KNOWN_MEMORY_CACHES', 'isMemoryCacheRegistered', 'assertMemoryCacheRegistered',
    'resolveEffectiveSystemRamMb',
  ],
  // singleFlight is composition machinery the SDK's own voice-install path
  // uses — consumers must not have to duplicate it.
  './platform/utils': ['singleFlight', 'logger'],
};

describe('export-map subpath resolution (committed manifest)', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'packages', 'sdk', 'package.json'), 'utf8'),
  ) as { exports: Record<string, { types?: string; import?: string }> };

  for (const [subpath, expectedExports] of Object.entries(SUBPATH_SURFACE)) {
    test(`${subpath} is declared in the exports map with types + import targets`, () => {
      const entry = manifest.exports[subpath];
      expect(entry).toBeDefined();
      expect(entry!.types).toBe(`./dist${subpath.slice(1)}.d.ts`);
      expect(entry!.import).toBe(`./dist${subpath.slice(1)}.js`);
    });

    test(`${subpath} resolves and serves its composition surface through the package name`, async () => {
      const mod = await import(`${PACKAGE}${subpath.slice(1)}`) as Record<string, unknown>;
      for (const name of expectedExports) {
        expect(mod[name], `${subpath} must export ${name}`).toBeDefined();
      }
    });
  }

  for (const [subpath, expectedExports] of Object.entries(DIR_SUBPATH_SURFACE)) {
    test(`${subpath} is declared in the exports map with index-shaped types + import targets`, () => {
      const entry = manifest.exports[subpath];
      expect(entry).toBeDefined();
      expect(entry!.types).toBe(`./dist${subpath.slice(1)}/index.d.ts`);
      expect(entry!.import).toBe(`./dist${subpath.slice(1)}/index.js`);
    });

    test(`${subpath} resolves and serves its composition surface through the package name`, async () => {
      const mod = await import(`${PACKAGE}${subpath.slice(1)}`) as Record<string, unknown>;
      for (const name of expectedExports) {
        expect(mod[name], `${subpath} must export ${name}`).toBeDefined();
      }
    });
  }

  test('./platform/runtime/memory entrypoint COMPOSES: a consumer builds a working governor through the package name', async () => {
    // The way a fork-composed runtime (agent, TUI) constructs it — real
    // registry + controller, injected sampler/clock, no interval started.
    const memory = await import('@pellux/goodvibes-sdk/platform/runtime/memory');
    let rss = 10 * 1024 * 1024;
    const { cacheRegistry, pauseController, memoryGovernor } = memory.createMemoryGovernance({
      config: { budgetMb: 100, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 },
      caches: [{ id: 'knowledge-store', cache: { name: 'k', entryCount: () => 1, trim: () => {} } }],
      jobIds: ['knowledge-self-improvement'],
      start: false,
      deps: {
        sampler: () => ({ rssBytes: rss, heapUsedBytes: rss / 2 }),
        now: () => 0,
        gc: () => {},
        exit: () => {},
        resolveSystemRamMb: () => 8 * 1024,
      },
    });
    expect(cacheRegistry.registeredIds()).toEqual(['knowledge-store']);
    rss = 85 * 1024 * 1024; // above highPct of the 100MB budget
    memoryGovernor.sampleOnce();
    expect(memoryGovernor.currentTier()).toBe('high');
    expect(pauseController.isPaused('knowledge-self-improvement')).toBe(true);
    expect(memoryGovernor.snapshot().budgetMb).toBe(100);
    memoryGovernor.stop();
  });

  test('./platform/utils entrypoint serves a WORKING singleFlight through the package name', async () => {
    const { singleFlight } = await import('@pellux/goodvibes-sdk/platform/utils');
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = singleFlight(async () => { runs += 1; await gate; return runs; });
    const [a, b] = [run(), run()]; // concurrent callers join ONE in-flight run
    release!();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(runs).toBe(1);
    expect(await run()).toBe(2); // after settlement a fresh run starts
  });
});
