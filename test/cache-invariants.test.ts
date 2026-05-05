/**
 * cache-invariants.test.ts
 *
 * Unit tests covering the 5 cache correctness invariants introduced in 0.18.38
 * and fixed/hardened in 0.18.39.
 *
 * I2(a) setModelContextCap invalidation — both customModels and discoveredModels paths
 * I2(b) registerRuntimeProvider unregister callback invalidates cache
 * I2(c) recentEvents ring buffer ordering — count < cap and count >= cap
 * I2(d) _syncScheduled coalesces burst of rememberEvent calls into 1 dispatch per tick
 * I2(e) getMessagesForLLM reference identity — same ref on cache hit, fresh ref after mutation
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.js';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.js';

// ---------------------------------------------------------------------------
// I2(a) + I2(b): ProviderRegistry cache invalidation
// ---------------------------------------------------------------------------
// ProviderRegistry has a heavy constructor; we test the invariants by importing
// the class directly from source and constructing a minimal stub.
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import { ProviderCapabilityRegistry } from '../packages/sdk/src/platform/providers/capabilities.js';

function makeMinimalRegistry(): ProviderRegistry {
  const noop = () => {};
  const noopPromise = async () => ({});
  const capabilityRegistry = new ProviderCapabilityRegistry();

  const stub = {
    // ConfigManager
    configManager: {
      get: () => null,
      getCategory: () => ({}),
      getControlPlaneConfigDir: () => '/tmp/gv-test',
    },
    // SubscriptionManager
    subscriptionManager: {
      get: () => null,
      getPending: () => [],
      saveSubscription: async () => {},
      resolveAccessToken: async () => null,
    },
    // SecretsManager
    secretsManager: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    },
    // ServiceRegistry
    serviceRegistry: {
      get: () => null,
      register: () => {},
    },
    capabilityRegistry,
    cacheHitTracker: {
      record: () => {},
    },
    favoritesStore: {
      load: async () => ({ pinned: [], history: [] }),
    },
    benchmarkStore: {
      getBenchmarks: () => [],
      getTopBenchmarkModelIds: () => [],
    },
    modelLimitsService: undefined,
    featureFlags: null,
    runtimeBus: null,
  } as unknown as ProviderRegistryOptions;

  return new ProviderRegistry(stub);
}

function makeCustomModel(id: string, registryKey: string) {
  return {
    id,
    provider: 'custom-test',
    registryKey,
    displayName: id,
    description: 'test model',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 4096,
    selectable: true,
    tier: 'standard' as const,
  };
}

describe('I2(a): setModelContextCap invalidation reflected in listModels()', () => {
  test('customModels path: cap change is reflected in listModels() after setModelContextCap', () => {
    const registry = makeMinimalRegistry();

    // Directly inject into customModels (loaded by loadCustomProviders in production;
    // we bypass the filesystem here to keep the test self-contained).
    const model = makeCustomModel('custom-model-a', 'custom-test:custom-model-a');
    (registry as unknown as { customModels: ReturnType<typeof makeCustomModel>[] }).customModels = [model];
    // Invalidate so the injected model is picked up in the next listModels() call
    (registry as unknown as { _invalidateModelRegistry(): void })._invalidateModelRegistry();

    // Prime the cache
    const before = registry.listModels();
    const found = before.find((m) => m.registryKey === 'custom-test:custom-model-a');
    expect(found?.registryKey).toBe('custom-test:custom-model-a');
    expect(found!.contextWindow).toBe(4096);

    // Mutate via setModelContextCap (customModels path)
    registry.setModelContextCap('custom-test:custom-model-a', 8192);

    // Must reflect the new cap — cache must be invalidated
    const after = registry.listModels();
    const updated = after.find((m) => m.registryKey === 'custom-test:custom-model-a');
    expect(updated?.registryKey).toBe('custom-test:custom-model-a');
    expect(updated!.contextWindow).toBe(8192);
  });

  test('discoveredModels path: cap change is reflected in listModels() after setModelContextCap', () => {
    const registry = makeMinimalRegistry();

    // Populate discoveredModels via registerDiscoveredProviders
    registry.registerDiscoveredProviders([
      {
        name: 'discovered-test',
        host: '127.0.0.1',
        port: 11434,
        baseURL: 'http://localhost:11434',
        serverType: 'ollama',
        models: ['llama3'],
        modelContextWindows: { llama3: 4096 },
        modelOutputLimits: {},
      } satisfies DiscoveredServer,
    ]);

    // Prime the cache
    const before = registry.listModels();
    const found = before.find((m) => m.id === 'llama3');
    expect(found?.id).toBe('llama3');
    expect(found!.contextWindow).toBe(4096);

    // Mutate via setModelContextCap (discoveredModels path)
    registry.setModelContextCap('discovered-test:llama3', 16384);

    // Must reflect the new cap
    const after = registry.listModels();
    const updated = after.find((m) => m.id === 'llama3');
    expect(updated?.id).toBe('llama3');
    expect(updated!.contextWindow).toBe(16384);
  });
});

describe('I2(b): registerRuntimeProvider unregister callback invalidates cache', () => {
  test('unregister callback removes provider models from listModels()', () => {
    const registry = makeMinimalRegistry();

    const provider = {
      name: 'plugin-provider',
      complete: async () => { throw new Error('not implemented'); },
    } as unknown as import('../packages/sdk/src/platform/providers/interface.js').LLMProvider;
    const model = makeCustomModel('plugin-model', 'plugin-provider:plugin-model');

    const unregister = registry.registerRuntimeProvider({ provider, models: [model] });

    // Confirm model is present
    const before = registry.listModels();
    expect(before.some((m) => m.registryKey === 'plugin-provider:plugin-model')).toBe(true);

    // Invoke unregister callback
    unregister();

    // Cache must be invalidated — model must be gone
    const after = registry.listModels();
    expect(after.some((m) => m.registryKey === 'plugin-provider:plugin-model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I2(c): ring buffer ordering
// ---------------------------------------------------------------------------

describe('I2(c): recentEvents ring buffer ordering', () => {
  // ControlPlaneGateway.rememberEvent is private, so we access it via a
  // public method that calls it indirectly. We drive events through
  // trackRequest which calls rememberEvent internally.
  // Instead, we call the public handleSseEvent path via a no-op runtimeBus.
  // The simplest unit-testable surface is getSnapshot().totals.recentEvents
  // and listRecentEvents().

  function driveEvents(gw: ControlPlaneGateway, n: number): void {
    // handleEvent is not public — use the public `handleControlEvent` if available,
    // or drive via the `handleRequest` path. Since ControlPlaneGateway exposes
    // `getSnapshot` which reports ring state, we drive events through
    // `trackRequest` public method if available, else call the private method
    // via type-casting.
    const gw_any = gw as unknown as { rememberEvent(event: string, data: Record<string, unknown>): void; _syncScheduled: boolean; };
    for (let i = 0; i < n; i++) {
      gw_any.rememberEvent(`test-event-${i}`, { seq: i });
    }
  }

  test('count < cap (3 events in 500-slot ring) — newest-first ordering', () => {
    const gw = new ControlPlaneGateway({});
    driveEvents(gw, 3);

    const events = (gw as unknown as { recentEvents: Array<{ event: string }> }).recentEvents;
    expect(events.length).toBe(3);
    // newest first: event-2, event-1, event-0
    expect(events[0].event).toBe('test-event-2');
    expect(events[1].event).toBe('test-event-1');
    expect(events[2].event).toBe('test-event-0');
  });

  test('count >= cap (600 events in 500-slot ring) — newest-first, length capped at 500', () => {
    const gw = new ControlPlaneGateway({});
    driveEvents(gw, 600);

    const events = (gw as unknown as { recentEvents: Array<{ event: string }> }).recentEvents;
    expect(events.length).toBe(500);
    // newest first: event-599, event-598, ...
    expect(events[0].event).toBe('test-event-599');
    expect(events[499].event).toBe('test-event-100');
  });

  test('getSnapshot totals.recentEvents uses _recentEventsCount (O(1), no array alloc)', () => {
    const gw = new ControlPlaneGateway({});
    driveEvents(gw, 7);
    const snap = gw.getSnapshot() as Record<string, unknown> & { totals?: Record<string, unknown> };
    expect((snap.totals as Record<string, unknown>).recentEvents).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// I2(d): _syncScheduled coalesces burst
// ---------------------------------------------------------------------------

describe('I2(d): _syncScheduled coalesces burst of rememberEvent calls', () => {
  test('N synchronous rememberEvent calls produce exactly 1 syncControlPlaneState dispatch per microtask', async () => {
    let dispatchCount = 0;
    const mockDispatch = {
      syncControlPlaneState: (..._args: Parameters<DomainDispatch['syncControlPlaneState']>) => { dispatchCount++; },
      syncControlPlaneClient: () => {},
      syncControlPlaneServer: () => {},
    };

    // Build a gateway with a mock store that creates the dispatch
    const mockStore = {
      getState: () => ({}),
      dispatch: (fn: (slice: Partial<DomainDispatch>) => void) => fn({ syncControlPlaneState: mockDispatch.syncControlPlaneState }),
      subscribe: () => () => {},
    } as unknown as import('../packages/sdk/src/platform/runtime/store/index.js').RuntimeStore;

    // We use the internal attach mechanism to inject dispatch
    const gw = new ControlPlaneGateway({});
    // Manually inject the dispatch mock (normally done by attachRuntime)
    (gw as unknown as { dispatch: Partial<DomainDispatch> }).dispatch = mockDispatch;

    const gw_any = gw as unknown as { rememberEvent(event: string, data: Record<string, unknown>): void; _syncScheduled: boolean; };

    // Burst: 10 synchronous rememberEvent calls
    for (let i = 0; i < 10; i++) {
      gw_any.rememberEvent(`burst-event-${i}`, { i });
    }

    // dispatchCount should be 0 synchronously (setImmediate defers)
    expect(dispatchCount).toBe(0);
    expect(gw_any._syncScheduled).toBe(true);

    // After awaiting a microtask tick, setImmediate has fired
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Exactly 1 dispatch for the whole burst
    expect(dispatchCount).toBe(1);
    expect(gw_any._syncScheduled).toBe(false);
  });

  test('lastEventAt inside setImmediate reflects most recent event, not first', async () => {
    // Deterministic version: emit both events synchronously so setImmediate
    // cannot fire between them, then verify the dispatch carries the LAST
    // event's createdAt timestamp.
    //
    // Emit both events synchronously. To distinguish which event's timestamp
    // was captured we read _lastEventAt directly from the gateway after the
    // second call and assert the dispatch payload matches it.
    // gateway's own _lastEventAt field, which is always the most recent).
    let capturedLastEventAt = -1;
    const mockDispatch = {
      syncControlPlaneState: (payload: Partial<ControlPlaneDomainState>) => { capturedLastEventAt = payload.lastEventAt ?? -1; },
    };

    const gw = new ControlPlaneGateway({});
    (gw as unknown as { dispatch: Partial<DomainDispatch> }).dispatch = mockDispatch;
    const gw_any = gw as unknown as {
      rememberEvent(event: string, data: Record<string, unknown>): void;
      _syncScheduled: boolean;
      _lastEventAt: number;
    };

    const t0 = Date.now();
    gw_any.rememberEvent('first', {});
    // Read first event timestamp before the second event overwrites _lastEventAt
    const firstEventAt = gw_any._lastEventAt;
    gw_any.rememberEvent('last', {});
    // Read second event timestamp — this is what the dispatch MUST carry
    const secondEventAt = gw_any._lastEventAt;

    // Both events scheduled a single setImmediate (coalesced). The dispatch
    // hasn't fired yet (still synchronous).
    expect(capturedLastEventAt).toBe(-1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    // The dispatch must carry the SECOND event's timestamp.
    // We assert equality against secondEventAt (the gateway's own field at
    // the time of the second rememberEvent), which is always the most recent.
    expect(capturedLastEventAt).toBe(secondEventAt);
    // Sanity: second event's timestamp is >= first's (even if same ms)
    expect(secondEventAt).toBeGreaterThanOrEqual(firstEventAt);
    // Sanity: captured value is within the wall-clock range of this test
    expect(capturedLastEventAt).toBeGreaterThanOrEqual(t0);
    expect(capturedLastEventAt).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// I2(e): getMessagesForLLM reference identity
// ---------------------------------------------------------------------------

describe('I2(e): getMessagesForLLM reference identity', () => {
  let conv: ConversationManager;

  beforeEach(() => {
    conv = new ConversationManager();
    conv.addUserMessage('hello');
  });

  test('returns same reference (===) on consecutive calls without mutation', () => {
    const ref1 = conv.getMessagesForLLM();
    const ref2 = conv.getMessagesForLLM();
    expect(ref1).toBe(ref2);
  });

  const mutatingMethods: Array<[string, (c: ConversationManager) => void]> = [
    ['addUserMessage', (c) => c.addUserMessage('another')],
    ['addAssistantMessage', (c) => c.addAssistantMessage('reply')],
    ['addSystemMessage', (c) => c.addSystemMessage('sys')],
    ['addToolResults', (c) => c.addToolResults([{ callId: 'x', success: true, output: 'ok' }])],
    ['removeMessagesAfter', (c) => c.removeMessagesAfter(0)],
    ['startStreamingBlock+finalizeStreamingBlock', (c) => { c.startStreamingBlock(); c.finalizeStreamingBlock(); }],
    ['startStreamingBlock+updateStreamingBlock', (c) => { c.startStreamingBlock(); c.updateStreamingBlock('partial'); }],
    ['replaceMessagesForLLM', (c) => c.replaceMessagesForLLM([{ role: 'user', content: 'replaced' }])],
    ['resetAll', (c) => c.resetAll()],
    ['switchBranch', (c) => { c.forkBranch('other'); c.switchBranch('other'); }],
    ['mergeBranch', (c) => {
      // Fork current state, then add a message to the branch so merge actually appends
      c.forkBranch('merge-src');
      const branchMsgs = (c as unknown as { branches: Map<string, import('../packages/sdk/src/platform/core/conversation.js').ConversationMessageSnapshot[]> }).branches.get('merge-src')!;
      branchMsgs.push({ role: 'assistant', content: 'merged-reply' });
      c.mergeBranch('merge-src');
    }],
    ['fromJSON', (c) => c.fromJSON({ messages: [{ role: 'user', content: 'from-json' }] as import('../packages/sdk/src/platform/core/conversation.js').ConversationMessageSnapshot[] })],
    ['undo', (c) => { c.addUserMessage('extra'); c.undo(); }],
    ['redo', (c) => { c.addUserMessage('extra'); c.undo(); c.redo(); }],
    ['markLastUserMessageCancelled', (c) => c.markLastUserMessageCancelled()],
  ];

  for (const [name, mutate] of mutatingMethods) {
    test(`fresh reference after ${name}`, () => {
      // Prime the cache
      const before = conv.getMessagesForLLM();

      // Apply mutation
      mutate(conv);

      // Must return a fresh array (different reference)
      const after = conv.getMessagesForLLM();
      expect(after).not.toBe(before);

      // And the new result must be stable on the next call
      const again = conv.getMessagesForLLM();
      expect(again).toBe(after);
    });
  }
});
