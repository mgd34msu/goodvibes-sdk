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
  // The daemon's managed local-voice setup composer: fork-composing consumers
  // (TUI) build their own runtime services and must construct the voice-setup
  // service the way runtime/services.ts does, rather than rebuilding it from the
  // voice/provisioning primitives.
  './platform/runtime/voice-setup': ['createVoiceSetupService'],
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

  test('./platform/runtime/voice-setup entrypoint COMPOSES: a consumer builds a working setup service through the package name', async () => {
    // The way a fork-composed runtime (TUI) constructs it — the provisioner and
    // status-read are injected seams, so the entrypoint runs with no network,
    // no download, and no real voice runtime on the host.
    const { createVoiceSetupService } = await import('@pellux/goodvibes-sdk/platform/runtime/voice-setup');

    const config = new Map<string, string>();
    let resetCalls = 0;
    const managedVoiceRoot = join(import.meta.dir, '.test-tmp', `voice-setup-${process.pid}-${Date.now()}`);

    const service = createVoiceSetupService({
      managedVoiceRoot,
      getConfig: (key) => config.get(key) ?? '',
      setConfig: (key, value) => void config.set(key, value),
      resetLocalEngineFailureState: () => { resetCalls += 1; },
      admitExpensiveWork: () => ({ allowed: true }),
      // Injected provisioner: a fully provisioned TTS + STT, no I/O.
      provision: async () => ({
        platform: 'linux-x64',
        tts: { engine: 'piper', state: 'provisioned', binaryPath: '/managed/piper', modelPath: '/managed/voice.onnx' },
        stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: '/managed/whisper', modelPath: '/managed/model.bin' },
        components: [{ id: 'piper', state: 'installed', bytes: 1024 }],
      }),
      // Injected status-read: a deterministic snapshot, no filesystem probe.
      readStatus: () => ({
        platform: 'linux-x64',
        state: 'provisioned',
        tts: { engine: 'piper', binaryPresent: true, voicePresent: true, binaryPath: '/managed/piper', modelPath: '/managed/voice.onnx' },
        stt: { engine: 'whisper-cpp', supported: true, state: 'provisioned', binaryPresent: true, modelPresent: true, binaryPath: '/managed/whisper', modelPath: '/managed/model.bin' },
        offerBytes: null,
      }),
    });

    // status() serves the injected snapshot (idle: no installInProgress).
    const status = service.status();
    expect(status.state).toBe('provisioned');
    expect(status.installInProgress).toBeUndefined();

    // install() drives the composed happy path: the provisioner result becomes
    // the wire receipt, the managed keys are preconfigured (getConfig was
    // unset), and a successful install clears the local-engine failure state.
    const receipt = await service.install();
    expect(receipt.provisioned).toBe(true);
    expect(receipt.tts.state).toBe('provisioned');
    expect(receipt.stt.state).toBe('provisioned');
    expect(receipt.components).toHaveLength(1);
    expect(receipt.configured.set.length).toBeGreaterThan(0);
    expect(config.size).toBeGreaterThan(0);
    expect(resetCalls).toBe(1);
  });

  test('./platform/runtime/voice-setup install() refuses honestly under critical memory pressure', async () => {
    const { createVoiceSetupService } = await import('@pellux/goodvibes-sdk/platform/runtime/voice-setup');
    let provisionCalls = 0;
    const service = createVoiceSetupService({
      managedVoiceRoot: join(import.meta.dir, '.test-tmp', `voice-setup-denied-${process.pid}-${Date.now()}`),
      getConfig: () => '',
      setConfig: () => {},
      resetLocalEngineFailureState: () => {},
      // Critical-tier admission refuses the expensive install outright.
      admitExpensiveWork: () => ({ allowed: false, reason: 'daemon is under critical memory pressure' }),
      provision: async () => { provisionCalls += 1; throw new Error('provision must not run when admission is denied'); },
      readStatus: () => ({
        platform: null,
        state: 'unsupported-platform',
        tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '', modelPath: '' },
        stt: { engine: 'whisper-cpp', supported: false, state: 'unsupported-platform', binaryPresent: false, modelPresent: false, binaryPath: '', modelPath: '' },
        offerBytes: null,
      }),
    });
    await expect(service.install()).rejects.toThrow(/critical memory pressure/);
    expect(provisionCalls).toBe(0);
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
