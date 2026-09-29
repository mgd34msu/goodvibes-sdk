/**
 * An unknown context window is reported as unknown, never as a guessed number.
 *
 * Live incident (abacusai route-llm, a router): the provider file written by
 * `/provider add` stated `contextWindow: 8192` for every model because the
 * endpoint said nothing. The meter then read `29.9k / 8.2k`, the model was
 * given small-model guidance, and small-window auto-compaction fired every
 * turn on a six-message conversation (`6 -> 6 messages, saved ~0`), because
 * the 29.9k of real input was the system prompt and tool schemas.
 *
 * Pins:
 * 1. a provider file model with no contextWindow loads, with an unknown window;
 * 2. a successful request larger than the stated window disproves it
 *    (provenance accepted_floor), persisted, and a user override is exempt;
 * 3. getKnownContextWindowForModel returns null for a guessed or disproven window;
 * 4. neither compaction trigger acts on an unknown window;
 * 5. small-window compaction never runs when it has nothing past the kept messages;
 * 6. an unknown window does not select the small-model tier.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import { loadCustomProviders } from '../packages/sdk/src/platform/providers/custom-loader.js';
import { getContextWindowOverridesPath } from '../packages/sdk/src/platform/providers/context-window-overrides.js';
import { getTierForContextWindow } from '../packages/sdk/src/platform/providers/tier-prompts.js';
import type { DiscoveredServer } from '../packages/sdk/src/platform/discovery/scanner.js';
import {
  checkContextWindowPreflight,
  handlePostTurnContextMaintenance,
  type PreflightDeps,
  type PostTurnContextDeps,
} from '../packages/sdk/src/platform/core/orchestrator-context-runtime.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistry(root: string): ProviderRegistry {
  return new ProviderRegistry({
    configManager: { get: () => undefined, getCategory: () => ({}), getControlPlaneConfigDir: () => root } as unknown as RegistryOptions['configManager'],
    subscriptionManager: { get: () => null, getPending: () => null, saveSubscription: async () => {}, resolveAccessToken: async () => null } as unknown as RegistryOptions['subscriptionManager'],
    capabilityRegistry: { getCapability: () => ({}), getRouteExplanation: () => ({ accepted: true }), invalidate: () => {} } as unknown as RegistryOptions['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as RegistryOptions['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as unknown as RegistryOptions['favoritesStore'],
    benchmarkStore: { getBenchmarks: () => undefined, getTopBenchmarkModelIds: () => [] } as unknown as RegistryOptions['benchmarkStore'],
    secretsManager: {} as unknown as RegistryOptions['secretsManager'],
    serviceRegistry: {} as unknown as RegistryOptions['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

const SERVER: DiscoveredServer = {
  name: 'ollama',
  host: '127.0.0.1',
  port: 11434,
  baseURL: 'http://127.0.0.1:11434/v1',
  models: ['qwen3-local'],
  serverType: 'ollama',
  modelContextWindows: { 'qwen3-local': 8192 },
};
const KEY = 'ollama:qwen3-local';

function withTempRoot(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gv-ctxwin-unknown-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('custom provider files: a model with no stated window', () => {
  test('loads with an unknown (fallback) window instead of failing validation', async () => {
    await withTempRoot(async (root) => {
      writeFileSync(join(root, 'router.json'), JSON.stringify({
        name: 'router',
        displayName: 'router',
        type: 'openai-compat',
        baseURL: 'https://router.example/v1',
        models: [{ id: 'route-llm', displayName: 'route-llm', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
      }));
      const result = await loadCustomProviders({ providersDir: root });
      expect(result.warnings.filter((w) => w.includes('contextWindow'))).toEqual([]);
      const model = result.models.find((m) => m.id === 'route-llm');
      expect(model?.contextWindowProvenance).toBe('fallback');
    });
  });

  test('a stated window that is not a positive number is still rejected', async () => {
    await withTempRoot(async (root) => {
      writeFileSync(join(root, 'bad.json'), JSON.stringify({
        name: 'bad',
        displayName: 'bad',
        type: 'openai-compat',
        baseURL: 'https://bad.example/v1',
        models: [{ id: 'm', displayName: 'm', contextWindow: 0, capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
      }));
      const result = await loadCustomProviders({ providersDir: root });
      expect(result.models).toHaveLength(0);
      expect(result.warnings.some((w) => w.includes('"contextWindow", when given, must be a positive number'))).toBe(true);
    });
  });
});

describe('a larger accepted request disproves the stated window', () => {
  test('the window becomes unknown with the accepted input as its floor', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]); // states 8192
      registry.reconcileObservedContextWindow(KEY, 29_871);

      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('accepted_floor');
      expect(model.contextWindow).toBe(29_871);
      expect(registry.getKnownContextWindowForModel(model)).toBeNull();
      // Budget math still gets a number, and never the disproven 8192.
      expect(registry.getContextWindowForModel(model)).toBe(29_871);
    });
  });

  test('the floor persists across a restart and only rises', async () => {
    await withTempRoot((root) => {
      const first = makeRegistry(root);
      first.registerDiscoveredProviders([SERVER]);
      first.reconcileObservedContextWindow(KEY, 20_000);
      first.reconcileObservedContextWindow(KEY, 15_000); // smaller, ignored
      const file = JSON.parse(readFileSync(getContextWindowOverridesPath(root), 'utf-8')) as { version: number; accepted?: Record<string, number> };
      expect(file.version).toBe(2);
      expect(file.accepted).toEqual({ [KEY]: 20_000 });

      const second = makeRegistry(root);
      second.registerDiscoveredProviders([SERVER]);
      const model = second.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('accepted_floor');
      expect(model.contextWindow).toBe(20_000);
    });
  });

  test('input within the stated window changes nothing', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]);
      registry.reconcileObservedContextWindow(KEY, 6_000);
      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('provider_api');
      expect(registry.getKnownContextWindowForModel(model)).toBe(8192);
    });
  });

  test('a user override is a deliberate budget and is never disproven', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]);
      registry.setModelContextCap(KEY, 8_000);
      registry.reconcileObservedContextWindow(KEY, 29_871);
      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('configured_cap');
      expect(registry.getKnownContextWindowForModel(model)).toBe(8_000);
    });
  });

  test('clearing the model returns it to its stated window', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]);
      registry.reconcileObservedContextWindow(KEY, 29_871);
      expect(registry.clearModelContextCap(KEY)).toBe(true);
      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindow).toBe(8192);
      expect(model.contextWindowProvenance).toBe('provider_api');
    });
  });
});

// ---------------------------------------------------------------------------
// Compaction triggers
// ---------------------------------------------------------------------------

function routerModel(): ModelDefinition {
  return {
    id: 'route-llm',
    provider: 'abacusai',
    registryKey: 'abacusai:route-llm',
    displayName: 'route-llm',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
  };
}

function makeHarness(opts: { known: number | null; messageCount: number }) {
  const model = routerModel();
  const systemMessages: string[] = [];
  const state = { compactCalls: 0, replaced: 0 };
  const messages = Array.from({ length: opts.messageCount }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` }));
  const conversation = {
    getMessagesForLLM: () => messages,
    addSystemMessage: (msg: string) => { systemMessages.push(msg); },
    replaceMessagesForLLM: () => { state.replaced += 1; },
    compact: async () => { state.compactCalls += 1; },
  } as unknown as ConversationManager;
  // The registry as it stood in the incident: budget math returns the stated
  // 8192; the known window is what this round adds.
  const providerRegistry = {
    getCurrentModel: () => model,
    getContextWindowForModel: () => 8192,
    getKnownContextWindowForModel: () => opts.known,
    listModels: () => [model],
  } as unknown as PreflightDeps['providerRegistry'];
  const config: Record<string, unknown> = { 'behavior.autoCompactThreshold': 80, 'behavior.staleContextWarnings': true };
  const shared = {
    conversation,
    requestRender: () => {},
    hookDispatcher: null,
    configManager: { get: (key: string) => config[key] } as unknown as Pick<ConfigManager, 'get'>,
    providerRegistry,
    sessionLineageTracker: { getEntries: () => [], getCompactionCount: () => 0, getOriginalTask: () => null },
    sessionId: 'test-session',
    agentManager: { list: () => [] },
    wrfcController: { listChains: () => [] },
    planManager: null,
    sessionMemoryStore: null,
    runtimeBus: null,
    emitterContext: () => ({ sessionId: 'test-session', turnId: 'turn-1' }) as unknown as ReturnType<PreflightDeps['emitterContext']>,
    isCompacting: false,
    setIsCompacting: () => {},
  };
  const postTurn: PostTurnContextDeps = { ...shared, lastWarningBracket: 0, setLastWarningBracket: () => {} };
  const preflight: PreflightDeps = shared;
  return { model, systemMessages, state, postTurn, preflight };
}

describe('compaction on an unknown window', () => {
  test('post-turn: 29.9k of real input on an unknown window neither warns nor compacts', async () => {
    const h = makeHarness({ known: null, messageCount: 30 });
    await handlePostTurnContextMaintenance(h.postTurn, 'turn-1', 29_871);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.systemMessages).toEqual([]);
    expect(h.state.replaced).toBe(0);
    expect(h.state.compactCalls).toBe(0);
  });

  test('preflight: an unknown window is never an overflow', async () => {
    const h = makeHarness({ known: null, messageCount: 30 });
    expect(await checkContextWindowPreflight(h.preflight, 'turn-1', h.model)).toBe('ok');
    expect(h.systemMessages).toEqual([]);
  });
});

describe('small-window compaction with nothing to remove', () => {
  test('a known 8k window over threshold with six messages announces and commits nothing', async () => {
    const h = makeHarness({ known: 8192, messageCount: 6 });
    await handlePostTurnContextMaintenance(h.postTurn, 'turn-1', 29_871);
    expect(h.systemMessages).toEqual([]);
    expect(h.state.replaced).toBe(0);
  });

  test('control: with more than the kept messages it still compacts', async () => {
    const h = makeHarness({ known: 8192, messageCount: 14 });
    await handlePostTurnContextMaintenance(h.postTurn, 'turn-1', 29_871);
    expect(h.state.replaced).toBe(1);
    expect(h.systemMessages.some((m) => m.includes('Kept last 10 messages'))).toBe(true);
  });
});

describe('tier for an unknown window', () => {
  test('null gives standard, not the small-model free tier', () => {
    expect(getTierForContextWindow(null)).toBe('standard');
    expect(getTierForContextWindow(8192)).toBe('free');
  });
});
