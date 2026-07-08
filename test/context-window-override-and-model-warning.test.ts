/**
 * Behavior pins for two context-window policies:
 *
 * 1. Persisted per-model context-window overrides — ProviderRegistry
 *    setModelContextCap/clearModelContextCap/getModelContextCap work for any
 *    model, apply as a 'configured_cap' overlay, persist under the
 *    control-plane config dir, and survive a registry restart. Clearing
 *    returns the model to its automatic window.
 *
 * 2. Model-issued compaction warning — when the model/provider itself reports
 *    context exhaustion (isContextOverflowSignal), checkContextWindowPreflight
 *    and handlePostTurnContextMaintenance compact immediately, regardless of
 *    locally estimated usage and even when the percentage threshold is
 *    disabled. Without the warning, low estimated usage compacts nothing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import { getContextWindowOverridesPath } from '../packages/sdk/src/platform/providers/context-window-overrides.js';
import type { DiscoveredServer } from '../packages/sdk/src/platform/discovery/scanner.js';
import {
  checkContextWindowPreflight,
  handlePostTurnContextMaintenance,
  type PreflightDeps,
  type PostTurnContextDeps,
  type ModelContextWarning,
} from '../packages/sdk/src/platform/core/orchestrator-context-runtime.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';

// ---------------------------------------------------------------------------
// Registry harness (test doubles, mirrors provider-registry-canonical-api.test.ts)
// ---------------------------------------------------------------------------

function makeRegistry(root: string): ProviderRegistry {
  const configManager = {
    get: () => undefined,
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => root,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['configManager'];
  const subscriptionManager = {
    get: () => null,
    getPending: () => null,
    saveSubscription: async () => {},
    resolveAccessToken: async () => null,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['subscriptionManager'];
  const capabilityRegistry = {
    getCapability: () => ({}),
    getRouteExplanation: () => ({ accepted: true }),
    invalidate: () => {},
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['capabilityRegistry'];
  const cacheHitTracker = { record: () => {} } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['cacheHitTracker'];
  const favoritesStore = { load: async () => ({ pinned: [], history: [] }) } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['favoritesStore'];
  const benchmarkStore = {
    getBenchmarks: () => undefined,
    getTopBenchmarkModelIds: () => [],
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['benchmarkStore'];

  return new ProviderRegistry({
    configManager,
    subscriptionManager,
    capabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    secretsManager: {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['secretsManager'],
    serviceRegistry: {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

const DISCOVERED_SERVER: DiscoveredServer = {
  name: 'ollama',
  host: '127.0.0.1',
  port: 11434,
  baseURL: 'http://127.0.0.1:11434/v1',
  models: ['qwen3-local'],
  serverType: 'ollama',
  modelContextWindows: { 'qwen3-local': 8192 },
};

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'gv-ctxwin-override-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Persisted context-window overrides
// ---------------------------------------------------------------------------

describe('ProviderRegistry context-window overrides', () => {
  test('setModelContextCap applies configured_cap overlay visible via listModels and getContextWindowForModel', () => {
    withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([DISCOVERED_SERVER]);

      registry.setModelContextCap('ollama:qwen3-local', 32_768);

      const model = registry.listModels().find((m) => m.registryKey === 'ollama:qwen3-local');
      expect(model?.contextWindow).toBe(32_768);
      expect(model?.contextWindowProvenance).toBe('configured_cap');
      expect(registry.getContextWindowForModel(model!)).toBe(32_768);
      expect(registry.getModelContextCap('ollama:qwen3-local')).toBe(32_768);
    });
  });

  test('override persists to disk and survives a registry restart', () => {
    withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([DISCOVERED_SERVER]);
      registry.setModelContextCap('ollama:qwen3-local', 40_000);
      expect(existsSync(getContextWindowOverridesPath(root))).toBe(true);

      const rebooted = makeRegistry(root);
      rebooted.registerDiscoveredProviders([DISCOVERED_SERVER]);
      const model = rebooted.listModels().find((m) => m.registryKey === 'ollama:qwen3-local');
      expect(model?.contextWindow).toBe(40_000);
      expect(model?.contextWindowProvenance).toBe('configured_cap');
    });
  });

  test('clearModelContextCap returns the model to its automatic window', () => {
    withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([DISCOVERED_SERVER]);
      registry.setModelContextCap('ollama:qwen3-local', 32_768);

      expect(registry.clearModelContextCap('ollama:qwen3-local')).toBe(true);
      const model = registry.listModels().find((m) => m.registryKey === 'ollama:qwen3-local');
      expect(model?.contextWindow).toBe(8192);
      expect(model?.contextWindowProvenance).toBe('provider_api');
      expect(registry.getModelContextCap('ollama:qwen3-local')).toBeNull();
      // Clearing again reports nothing to clear.
      expect(registry.clearModelContextCap('ollama:qwen3-local')).toBe(false);
    });
  });

  test('cleared override does not resurrect on restart', () => {
    withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([DISCOVERED_SERVER]);
      registry.setModelContextCap('ollama:qwen3-local', 32_768);
      registry.clearModelContextCap('ollama:qwen3-local');

      const rebooted = makeRegistry(root);
      rebooted.registerDiscoveredProviders([DISCOVERED_SERVER]);
      const model = rebooted.listModels().find((m) => m.registryKey === 'ollama:qwen3-local');
      expect(model?.contextWindow).toBe(8192);
      expect(model?.contextWindowProvenance).toBe('provider_api');
    });
  });

  test('invalid caps are rejected (zero, negative, non-integer, above ceiling)', () => {
    withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([DISCOVERED_SERVER]);
      for (const bad of [0, -5, 1.5, 10_000_001]) {
        registry.setModelContextCap('ollama:qwen3-local', bad);
      }
      const model = registry.listModels().find((m) => m.registryKey === 'ollama:qwen3-local');
      expect(model?.contextWindow).toBe(8192);
      expect(registry.getModelContextCap('ollama:qwen3-local')).toBeNull();
    });
  });

  test('override stored before the model materializes applies once discovered', () => {
    withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.setModelContextCap('ollama:qwen3-local', 24_000);
      registry.registerDiscoveredProviders([DISCOVERED_SERVER]);
      const model = registry.listModels().find((m) => m.registryKey === 'ollama:qwen3-local');
      expect(model?.contextWindow).toBe(24_000);
      expect(model?.contextWindowProvenance).toBe('configured_cap');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Model-issued compaction warning forces immediate compaction
// ---------------------------------------------------------------------------

function makeModel(): ModelDefinition {
  return {
    id: 'fable-5',
    provider: 'anthropic',
    registryKey: 'anthropic:fable-5',
    displayName: 'Fable 5',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 200_000,
    selectable: true,
    tier: 'standard',
  };
}

interface ConversationStub {
  conversation: ConversationManager;
  systemMessages: string[];
  compactCalls: number;
}

function makeConversationStub(): ConversationStub {
  const systemMessages: string[] = [];
  const state = { compactCalls: 0 };
  const conversation = {
    getMessagesForLLM: () => [{ role: 'user', content: 'short message' }],
    addSystemMessage: (msg: string) => { systemMessages.push(msg); },
    replaceMessagesForLLM: () => {},
    compact: async () => { state.compactCalls += 1; },
  } as unknown as ConversationManager;
  return {
    conversation,
    systemMessages,
    get compactCalls() { return state.compactCalls; },
  };
}

function makeRegistryStub(model: ModelDefinition) {
  return {
    getCurrentModel: () => model,
    getContextWindowForModel: () => model.contextWindow,
    listModels: () => [model],
  } as unknown as PreflightDeps['providerRegistry'];
}

function makeSharedDeps(stub: ConversationStub, model: ModelDefinition, config: Record<string, unknown>) {
  return {
    conversation: stub.conversation,
    requestRender: () => {},
    hookDispatcher: null,
    configManager: { get: (key: string) => config[key] },
    providerRegistry: makeRegistryStub(model),
    sessionLineageTracker: { getEntries: () => [], getCompactionCount: () => 0, getOriginalTask: () => null },
    sessionId: 'test-session',
    agentManager: { list: () => [] },
    wrfcController: { listChains: () => [] },
    planManager: null,
    sessionMemoryStore: null,
    runtimeBus: null,
    emitterContext: () => ({ sessionId: 'test-session', turnId: 'turn-1' }) as unknown as ReturnType<PreflightDeps['emitterContext']>,
  };
}

const MODEL_WARNING: ModelContextWarning = {
  provider: 'anthropic',
  model: 'fable-5',
  providerStopReason: 'model_context_window_exceeded',
};

describe('model-issued compaction warning — preflight', () => {
  test('low estimated usage with a pending model warning compacts immediately and clears the warning', async () => {
    const stub = makeConversationStub();
    const model = makeModel();
    let cleared = false;
    const deps: PreflightDeps = {
      ...makeSharedDeps(stub, model, { 'behavior.autoCompactThreshold': 80 }),
      isCompacting: false,
      setIsCompacting: () => {},
      modelContextWarning: MODEL_WARNING,
      clearModelContextWarning: () => { cleared = true; },
    };

    const result = await checkContextWindowPreflight(deps, 'turn-1', model);

    expect(result).toBe('compacted');
    expect(stub.compactCalls).toBe(1);
    expect(cleared).toBe(true);
    expect(stub.systemMessages.some((m) => m.includes('reported its context window is full'))).toBe(true);
    expect(stub.systemMessages.some((m) => m.includes('model_context_window_exceeded'))).toBe(true);
  });

  test('control: low estimated usage without a warning stays ok and compacts nothing', async () => {
    const stub = makeConversationStub();
    const model = makeModel();
    const deps: PreflightDeps = {
      ...makeSharedDeps(stub, model, { 'behavior.autoCompactThreshold': 80 }),
      isCompacting: false,
      setIsCompacting: () => {},
    };

    const result = await checkContextWindowPreflight(deps, 'turn-1', model);

    expect(result).toBe('ok');
    expect(stub.compactCalls).toBe(0);
  });

  test('warning forces compaction even when the auto-compact threshold is disabled (0)', async () => {
    const stub = makeConversationStub();
    const model = makeModel();
    const deps: PreflightDeps = {
      ...makeSharedDeps(stub, model, { 'behavior.autoCompactThreshold': 0 }),
      isCompacting: false,
      setIsCompacting: () => {},
      modelContextWarning: MODEL_WARNING,
      clearModelContextWarning: () => {},
    };

    const result = await checkContextWindowPreflight(deps, 'turn-1', model);

    expect(result).toBe('compacted');
    expect(stub.compactCalls).toBe(1);
  });
});

describe('model-issued compaction warning — post-turn maintenance', () => {
  function makePostTurnDeps(
    stub: ConversationStub,
    model: ModelDefinition,
    config: Record<string, unknown>,
    warning: ModelContextWarning | null,
    onClear: () => void = () => {},
  ): PostTurnContextDeps {
    return {
      ...makeSharedDeps(stub, model, config),
      isCompacting: false,
      setIsCompacting: () => {},
      lastWarningBracket: 0,
      setLastWarningBracket: () => {},
      modelContextWarning: warning,
      clearModelContextWarning: onClear,
    };
  }

  test('low reported usage with a pending model warning compacts immediately', async () => {
    const stub = makeConversationStub();
    const model = makeModel();
    let cleared = false;
    const deps = makePostTurnDeps(
      stub, model,
      { 'behavior.autoCompactThreshold': 80, 'behavior.staleContextWarnings': false },
      MODEL_WARNING,
      () => { cleared = true; },
    );

    // 10k of 200k = 5% usage — far below every threshold.
    await handlePostTurnContextMaintenance(deps, 'turn-1', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain the void compact chain

    expect(stub.compactCalls).toBe(1);
    expect(cleared).toBe(true);
    expect(stub.systemMessages.some((m) => m.includes('reported its context window is full'))).toBe(true);
  });

  test('control: low reported usage without a warning compacts nothing', async () => {
    const stub = makeConversationStub();
    const model = makeModel();
    const deps = makePostTurnDeps(
      stub, model,
      { 'behavior.autoCompactThreshold': 80, 'behavior.staleContextWarnings': false },
      null,
    );

    await handlePostTurnContextMaintenance(deps, 'turn-1', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.compactCalls).toBe(0);
    expect(stub.systemMessages).toHaveLength(0);
  });

  test('warning forces compaction even when auto-compact is disabled (threshold 0)', async () => {
    const stub = makeConversationStub();
    const model = makeModel();
    const deps = makePostTurnDeps(
      stub, model,
      { 'behavior.autoCompactThreshold': 0, 'behavior.staleContextWarnings': false },
      MODEL_WARNING,
    );

    await handlePostTurnContextMaintenance(deps, 'turn-1', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.compactCalls).toBe(1);
  });
});
