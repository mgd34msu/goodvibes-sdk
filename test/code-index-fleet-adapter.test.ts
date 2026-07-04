/**
 * Wave-5 (wo802, W5.3 Stage A) — adaptCodeIndex fleet adapter + registry
 * integration: a 'code-index' ProcessNode surfaces progress while building
 * and a terminal state ('done'/'idle') when caught up; an absent
 * codeIndexService dep yields zero code-index nodes (degrade-to-today),
 * mirroring the Wave-4 orchestrationEngine-dep precedent
 * (test/orchestration-fleet-adapters.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import {
  adaptCodeIndex,
  codeIndexNodeId,
  type CodeIndexProcessSource,
} from '../packages/sdk/src/platform/runtime/fleet/adapters/code-index.js';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps, RegistryTimers } from '../packages/sdk/src/platform/runtime/fleet/registry.js';
import type { AgentManager, AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import type { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import type { WatcherRegistry } from '../packages/sdk/src/platform/watchers/registry.js';
import type {
  ScheduleManager,
  TriggerManager,
  WorkflowManager,
} from '../packages/sdk/src/platform/tools/workflow/index.js';
import type { CodeIndexBuildStats, CodeIndexStats } from '../packages/sdk/src/platform/state/code-index-store.js';

const T0 = 1_750_000_000_000;

function makeStats(overrides: Partial<CodeIndexStats> = {}): CodeIndexStats {
  return {
    backend: 'sqlite-vec',
    enabled: true,
    available: true,
    path: ':memory:',
    dimensions: 384,
    indexedFiles: 0,
    indexedChunks: 0,
    embeddingProviderId: 'hashed-local',
    embeddingProviderLabel: 'Hashed Local Embeddings',
    semanticRetrievalAvailable: false,
    building: false,
    lastBuild: null,
    ...overrides,
  };
}

function makeBuildStats(overrides: Partial<CodeIndexBuildStats> = {}): CodeIndexBuildStats {
  return {
    filesScanned: 10,
    filesIndexed: 10,
    filesUnchanged: 0,
    chunksIndexed: 30,
    chunksUnchanged: 0,
    filesRemoved: 0,
    skip: { tooLarge: 0, overFileCap: 0, overTotalBytes: 0, binary: 0, ignoredByGitignore: 0, readErrors: 0, chunkedByWindow: 0 },
    startedAt: T0,
    completedAt: T0 + 500,
    durationMs: 500,
    ...overrides,
  };
}

describe('adapters/code-index — node id + shape', () => {
  test('codeIndexNodeId is a single well-known id', () => {
    expect(codeIndexNodeId()).toBe('code-index:main');
  });

  test('idle: never built yet', () => {
    const source: CodeIndexProcessSource = {
      isBuilding: () => false,
      buildProgress: () => null,
      buildStartedAt: () => null,
      stats: () => makeStats(),
    };
    const node = adaptCodeIndex(source, T0);
    expect(node.id).toBe('code-index:main');
    expect(node.kind).toBe('code-index');
    expect(node.state).toBe('idle');
    expect(node.capabilities).toEqual({ interruptible: false, killable: false, pausable: false, resumable: false, steerable: false });
  });

  test('building: progress surfaces in the label and currentActivity', () => {
    const source: CodeIndexProcessSource = {
      isBuilding: () => true,
      buildProgress: () => ({ scanned: 42, total: 100 }),
      buildStartedAt: () => T0 - 1000,
      stats: () => makeStats({ building: true }),
    };
    const node = adaptCodeIndex(source, T0);
    expect(node.state).toBe('executing-tool');
    expect(node.label).toContain('42/100');
    expect(node.currentActivity?.kind).toBe('phase');
    expect(node.currentActivity?.text).toContain('42/100');
    expect(node.elapsedMs).toBe(1000);
  });

  test('done: a completed build reports a terminal state with counts in the label', () => {
    const lastBuild = makeBuildStats();
    const source: CodeIndexProcessSource = {
      isBuilding: () => false,
      buildProgress: () => null,
      buildStartedAt: () => null,
      stats: () => makeStats({ indexedFiles: 10, indexedChunks: 30, lastBuild }),
    };
    const node = adaptCodeIndex(source, T0 + 1000);
    expect(node.state).toBe('done');
    expect(node.label).toContain('10 files');
    expect(node.label).toContain('30 chunks');
    expect(node.completedAt).toBe(lastBuild.completedAt);
  });
});

describe('adapters/code-index — registry integration (degrade-to-today)', () => {
  function makeDeps(overrides: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
    const timers: RegistryTimers = { setInterval: () => 0, clearInterval: () => {} };
    return {
      agentManager: { list: (): AgentRecord[] => [], cancel: () => false } as unknown as Pick<AgentManager, 'list' | 'cancel'>,
      wrfcController: { listChains: () => [] } as unknown as Pick<WrfcController, 'listChains'>,
      processManager: { list: () => [], stop: () => false, getStatus: () => null } as unknown as Pick<ProcessManager, 'list' | 'stop' | 'getStatus'>,
      watcherRegistry: { list: () => [], stopWatcher: () => null } as unknown as Pick<WatcherRegistry, 'list' | 'stopWatcher'>,
      workflow: {
        workflowManager: { list: () => [], cancel: () => false } as unknown as Pick<WorkflowManager, 'list' | 'cancel'>,
        triggerManager: { list: () => [], remove: () => false, disable: () => false } as unknown as Pick<TriggerManager, 'list' | 'remove' | 'disable'>,
        scheduleManager: { list: () => [], remove: () => false, disable: () => false } as unknown as Pick<ScheduleManager, 'list' | 'remove' | 'disable'>,
      },
      timers,
      now: () => T0,
      ...overrides,
    };
  }

  test('absent codeIndexService dep yields zero code-index nodes', () => {
    const registry = createProcessRegistry(makeDeps());
    const snapshot = registry.query();
    expect(snapshot.nodes.filter((node) => node.kind === 'code-index')).toHaveLength(0);
    registry.dispose();
  });

  test('present codeIndexService dep surfaces exactly one code-index node', () => {
    const source: CodeIndexProcessSource = {
      isBuilding: () => true,
      buildProgress: () => ({ scanned: 5, total: 20 }),
      buildStartedAt: () => T0 - 200,
      stats: () => makeStats({ building: true }),
    };
    const registry = createProcessRegistry(makeDeps({ codeIndexService: source }));
    const snapshot = registry.query();
    const codeIndexNodes = snapshot.nodes.filter((node) => node.kind === 'code-index');
    expect(codeIndexNodes).toHaveLength(1);
    expect(codeIndexNodes[0]!.id).toBe('code-index:main');
    expect(codeIndexNodes[0]!.state).toBe('executing-tool');
    registry.dispose();
  });

  test('kill/interrupt/steer safely refuse a code-index node (not killable, not steerable)', () => {
    const source: CodeIndexProcessSource = {
      isBuilding: () => false,
      buildProgress: () => null,
      buildStartedAt: () => null,
      stats: () => makeStats(),
    };
    const registry = createProcessRegistry(makeDeps({ codeIndexService: source }));
    expect(registry.kill('code-index:main')).toEqual([]);
    expect(registry.interrupt('code-index:main')).toBe(false);
    const steerResult = registry.steer('code-index:main', 'hello');
    expect(steerResult.queued).toBe(false);
    registry.dispose();
  });
});
