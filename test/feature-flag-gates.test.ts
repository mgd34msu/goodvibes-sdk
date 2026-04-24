import { describe, expect, test } from 'bun:test';
import { registerToolWithContractGate } from '../packages/sdk/src/_internal/platform/tools/index.js';
import { ToolRegistry } from '../packages/sdk/src/_internal/platform/tools/registry.js';
import { executeFetchInput } from '../packages/sdk/src/_internal/platform/tools/fetch/index.js';
import { guardExecCommand } from '../packages/sdk/src/_internal/platform/tools/exec/ast-guard.js';
import { createPhasedExecutor } from '../packages/sdk/src/_internal/platform/runtime/tools/index.js';
import { DeliveryQueue } from '../packages/sdk/src/_internal/platform/integrations/delivery.js';
import { Notifier } from '../packages/sdk/src/_internal/platform/integrations/notifier.js';
import { RouteBindingManager } from '../packages/sdk/src/_internal/platform/channels/route-manager.js';
import { bindProviderOptimizerFeatureFlag } from '../packages/sdk/src/_internal/platform/runtime/services.js';
import { createPermissionEvaluator } from '../packages/sdk/src/_internal/platform/runtime/permissions/index.js';
import { PermissionManager } from '../packages/sdk/src/_internal/platform/permissions/manager.js';
import { createPluginLifecycleManager } from '../packages/sdk/src/_internal/platform/runtime/plugins/index.js';
import { createMcpLifecycleManager } from '../packages/sdk/src/_internal/platform/runtime/mcp/index.js';
import { createShellPlanRuntime } from '../packages/sdk/src/_internal/platform/runtime/shell-command-ops.js';
import { AdaptivePlanner } from '../packages/sdk/src/_internal/platform/core/adaptive-planner.js';
import { createTelemetryProvider } from '../packages/sdk/src/_internal/platform/runtime/telemetry/index.js';
import { AgentOrchestrator } from '../packages/sdk/src/_internal/platform/agents/orchestrator.js';
import { AgentMessageBus } from '../packages/sdk/src/_internal/platform/agents/message-bus.js';
import type { Tool, ToolResult } from '../packages/sdk/src/_internal/platform/types/tools.js';
import type { ToolRuntimeContext } from '../packages/sdk/src/_internal/platform/runtime/tools/index.js';
import type { AutomationRouteStore } from '../packages/sdk/src/_internal/platform/automation/store/routes.js';
import type { AutomationRouteBinding } from '../packages/sdk/src/_internal/platform/automation/routes.js';
import type { LLMProvider } from '../packages/sdk/src/_internal/platform/providers/interface.js';
import type { AgentRecord } from '../packages/sdk/src/_internal/platform/tools/agent/manager.js';

const flags = (enabledIds: readonly string[]) => ({
  isEnabled(id: string): boolean {
    return enabledIds.includes(id);
  },
});

function mutableFlags(initial: readonly string[]) {
  const enabled = new Set(initial);
  const subscribers = new Set<(flagId: string, state: 'enabled' | 'disabled' | 'killed', previous: 'enabled' | 'disabled' | 'killed') => void>();
  return {
    isEnabled(id: string): boolean {
      return enabled.has(id);
    },
    subscribe(callback: (flagId: string, state: 'enabled' | 'disabled' | 'killed', previous: 'enabled' | 'disabled' | 'killed') => void): () => void {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    set(id: string, state: 'enabled' | 'disabled' | 'killed'): void {
      const previous = enabled.has(id) ? 'enabled' : 'disabled';
      if (state === 'enabled') enabled.add(id);
      else enabled.delete(id);
      for (const subscriber of subscribers) {
        subscriber(id, state, previous);
      }
    },
  };
}

function invalidContractTool(): Tool {
  return {
    definition: {
      name: 'invalid_contract_tool',
      description: 'Invalid contract test tool',
      parameters: {},
    },
    async execute() {
      return { success: true, output: 'ok' };
    },
  };
}

function tokenBudgetTool(tokenCount: number): Tool {
  return {
    definition: {
      name: 'token_budget_tool',
      description: 'Tool that annotates token usage for budget tests',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return {
        success: true,
        output: 'ok',
        tokenCount,
      } as Omit<ToolResult, 'callId'> & { tokenCount: number };
    },
  };
}

function runtimeContextWithBudget(budget: ToolRuntimeContext['budget']): ToolRuntimeContext {
  return {
    runtime: {
      getState: () => ({}),
      subscribe: () => () => undefined,
    },
    ids: {
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      traceId: 'trace-1',
    },
    tasks: {},
    resources: {},
    provider: {
      providerId: 'test',
      modelId: 'test-model',
      contextWindow: 128_000,
    },
    budget,
    cancellation: {
      signal: new AbortController().signal,
    },
    executionMode: 'background',
  } as unknown as ToolRuntimeContext;
}

function makeMemoryRouteStore(): AutomationRouteStore {
  let routes: AutomationRouteBinding[] = [];
  return {
    load: async () => ({ version: 1 as const, routes }),
    save: async (next: readonly AutomationRouteBinding[]) => {
      routes = [...next];
    },
  } as unknown as AutomationRouteStore;
}

function makePolicyRuntimeState() {
  const policy = {
    rules: [{
      id: 'deny-read',
      type: 'prefix' as const,
      origin: 'user' as const,
      effect: 'deny' as const,
      toolPattern: 'read',
    }],
  };
  return {
    recordPermissionRequest() {},
    recordPermissionDecision() {},
    getRegistry() {
      return {
        getCurrent: () => policy,
      };
    },
  };
}

function makePermissionConfigReader() {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/goodvibes-test',
    getSnapshot: () => ({
      permissions: {
        mode: 'prompt' as const,
        tools: {},
      },
    }),
  };
}

function makeAgentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-1',
    task: 'test task',
    template: 'general',
    tools: ['read'],
    status: 'pending',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

describe('feature flag safe-default gates', () => {
  test('tool-contract-verification rejects invalid tools when enabled', () => {
    const registry = new ToolRegistry();

    expect(() => {
      registerToolWithContractGate(
        registry,
        invalidContractTool(),
        flags(['tool-contract-verification']),
      );
    }).toThrow(/failed contract verification/);
    expect(registry.has('invalid_contract_tool')).toBe(false);
  });

  test('tool-contract-verification defaults on when no flag manager is supplied', () => {
    const registry = new ToolRegistry();

    expect(() => {
      registerToolWithContractGate(registry, invalidContractTool());
    }).toThrow(/failed contract verification/);
  });

  test('tool-contract-verification can be explicitly disabled by host policy', () => {
    const registry = new ToolRegistry();

    registerToolWithContractGate(registry, invalidContractTool(), flags([]));

    expect(registry.has('invalid_contract_tool')).toBe(true);
  });

  test('fetch-sanitization blocks SSRF-risk hosts before fetching when enabled', async () => {
    const output = await executeFetchInput(
      {
        urls: [{ url: 'http://127.0.0.1:1/private' }],
        sanitize_mode: 'none',
      },
      { featureFlags: flags(['fetch-sanitization']) },
    );

    const result = output.results?.[0];
    expect(output.summary.failed).toBe(1);
    expect(result?.host_trust_tier).toBe('blocked');
    expect(result?.sanitization_tier).toBe('none');
    expect(result?.error).toMatch(/blocked/i);
  });

  test('fetch-sanitization forces safe-text for unknown hosts requesting none', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<script>ignore me</script><p>visible</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

    try {
      const output = await executeFetchInput(
        {
          urls: [{ url: 'https://example.test/page' }],
          sanitize_mode: 'none',
        },
        { featureFlags: flags(['fetch-sanitization']) },
      );

      const result = output.results?.[0];
      expect(output.summary.succeeded).toBe(1);
      expect(result?.host_trust_tier).toBe('unknown');
      expect(result?.sanitization_tier).toBe('safe-text');
      expect(result?.content).toContain('<p>visible</p>');
      expect(result?.content).not.toContain('<script>');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetch-sanitization disabled preserves legacy fetch behavior', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('<script>legacy</script><p>raw</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    try {
      const output = await executeFetchInput(
        {
          urls: [{ url: 'http://127.0.0.1:1/private' }],
          sanitize_mode: 'none',
        },
        { featureFlags: flags([]) },
      );

      const result = output.results?.[0];
      expect(called).toBe(true);
      expect(output.summary.succeeded).toBe(1);
      expect(result?.host_trust_tier).toBe('blocked');
      expect(result?.sanitization_tier).toBe('none');
      expect(result?.content).toContain('<script>legacy</script>');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shell-ast-normalization denies command substitution that baseline allows', async () => {
    const command = 'echo $(whoami)';

    const baseline = await guardExecCommand(command, undefined, flags([]));
    const ast = await guardExecCommand(command, undefined, flags(['shell-ast-normalization']));

    expect(baseline.astModeActive).toBe(false);
    expect(baseline.allowed).toBe(true);
    expect(ast.astModeActive).toBe(true);
    expect(ast.allowed).toBe(false);
    expect(ast.verdict?.hasObfuscation).toBe(true);
    expect(ast.denialMessage).toMatch(/command substitution/i);
  });

  test('runtime-tools-budget-enforcement enables phased executor budget checks', async () => {
    const executor = createPhasedExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
      featureFlags: flags(['runtime-tools-budget-enforcement']),
    });

    const result = await executor.execute(
      { id: 'call-1', name: 'token_budget_tool', arguments: {} },
      tokenBudgetTool(10),
      runtimeContextWithBudget({ maxTokens: 1 }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/BUDGET_EXCEEDED_TOKENS/);
  });

  test('runtime-tools-budget-enforcement disabled preserves unlimited execution', async () => {
    const executor = createPhasedExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
      featureFlags: flags([]),
    });

    const result = await executor.execute(
      { id: 'call-1', name: 'token_budget_tool', arguments: {} },
      tokenBudgetTool(10),
      runtimeContextWithBudget({ maxTokens: 1 }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('ok');
  });

  test('integration-delivery-slo derives SLO enforcement from feature flag', () => {
    const enabledQueue = new DeliveryQueue({
      featureFlags: flags(['integration-delivery-slo']),
    });
    const disabledQueue = new DeliveryQueue({
      featureFlags: flags([]),
    });
    const explicitOverrideQueue = new DeliveryQueue({
      featureFlags: flags(['integration-delivery-slo']),
      sloEnforced: false,
    });

    expect(enabledQueue.sloEnforced).toBe(true);
    expect(disabledQueue.sloEnforced).toBe(false);
    expect(explicitOverrideQueue.sloEnforced).toBe(false);
  });

  test('integration-delivery-slo flows through notifier factory configuration', async () => {
    const notifier = await Notifier.fromConfig({
      resolveSecret: async (service: string, name: string) =>
        service === 'slack' && name === 'webhookUrl' ? 'https://hooks.slack.test/test' : undefined,
    }, { featureFlags: flags(['integration-delivery-slo']) });

    expect(notifier.getQueueStatus()).toEqual([
      expect.objectContaining({
        channel: 'slack',
        sloEnforced: true,
      }),
    ]);
  });

  test('route-binding blocks durable route writes when feature flag is disabled', async () => {
    const manager = new RouteBindingManager({
      store: makeMemoryRouteStore(),
      featureFlags: flags([]),
    });

    expect(manager.listBindings()).toEqual([]);
    await expect(manager.upsertBinding({
      kind: 'session',
      surfaceKind: 'slack',
      surfaceId: 'T-test',
      externalId: 'U-test',
    })).rejects.toThrow(/route-binding feature flag is disabled/);
  });

  test('route-binding allows durable route writes when feature flag is enabled', async () => {
    const manager = new RouteBindingManager({
      store: makeMemoryRouteStore(),
      featureFlags: flags(['route-binding']),
    });

    const binding = await manager.upsertBinding({
      kind: 'session',
      surfaceKind: 'slack',
      surfaceId: 'T-test',
      externalId: 'U-test',
    });

    expect(manager.listBindings()).toHaveLength(1);
    expect(manager.getBinding(binding.id)?.externalId).toBe('U-test');
  });

  test('provider-optimizer follows runtime feature flag transitions', () => {
    const featureFlags = mutableFlags([]);
    const states: boolean[] = [];
    const unsubscribe = bindProviderOptimizerFeatureFlag(featureFlags, {
      setEnabled(enabled: boolean) {
        states.push(enabled);
      },
    });

    featureFlags.set('provider-optimizer', 'enabled');
    featureFlags.set('provider-optimizer', 'killed');
    unsubscribe();
    featureFlags.set('provider-optimizer', 'enabled');

    expect(states).toEqual([false, true, false]);
  });

  test('provider-optimizer can select agent routes when optimizer mode is active', () => {
    const selectedProvider: LLMProvider = {
      name: 'openai',
      async chat() {
        return { content: 'ok' };
      },
    };
    const fallbackProvider: LLMProvider = {
      name: 'anthropic',
      async chat() {
        return { content: 'fallback' };
      },
    };
    const optimizer = {
      enabled: true,
      mode: 'auto',
      selectRoute() {
        return {
          providerId: 'openai',
          modelId: 'gpt-test',
          explanation: { accepted: true },
        };
      },
    };
    const providerRegistry = {
      getForModel(modelId: string, providerId?: string): LLMProvider {
        return providerId === 'openai' && modelId === 'gpt-test'
          ? selectedProvider
          : fallbackProvider;
      },
      listModels() {
        return [{
          id: 'gpt-test',
          provider: 'openai',
          registryKey: 'openai:gpt-test',
          displayName: 'GPT Test',
          description: 'Test model',
          capabilities: {
            toolCalling: true,
            codeEditing: true,
            reasoning: false,
            multimodal: false,
          },
          contextWindow: 128_000,
          selectable: true,
        }];
      },
    };
    const orchestrator = new AgentOrchestrator({ messageBus: new AgentMessageBus() });
    (orchestrator as unknown as { toolDeps: { providerOptimizer: typeof optimizer } }).toolDeps = { providerOptimizer: optimizer };
    const route = (orchestrator as unknown as {
      resolveProviderForRecord(
        providerRegistry: typeof providerRegistry,
        record: AgentRecord,
        currentModel: { id: string; provider: string },
      ): { provider: LLMProvider; modelId: string; requestedModelId: string };
    }).resolveProviderForRecord(providerRegistry, makeAgentRecord(), {
      id: 'claude-test',
      provider: 'anthropic',
    });

    expect(route.provider).toBe(selectedProvider);
    expect(route.modelId).toBe('gpt-test');
    expect(route.requestedModelId).toBe('openai:gpt-test');
  });

  test('permissions-policy-engine gates permission evaluator factory when supplied', () => {
    expect(() => {
      createPermissionEvaluator({}, undefined, flags([]));
    }).toThrow(/permissions-policy-engine/);

    expect(() => {
      createPermissionEvaluator({}, undefined, flags(['permissions-policy-engine']));
    }).not.toThrow();
  });

  test('permissions-policy-engine controls PermissionManager runtime policy evaluation', async () => {
    const disabled = new PermissionManager(
      async () => ({ approved: false, remember: false }),
      makePermissionConfigReader(),
      makePolicyRuntimeState(),
      null,
      flags([]),
    );
    const enabled = new PermissionManager(
      async () => ({ approved: false, remember: false }),
      makePermissionConfigReader(),
      makePolicyRuntimeState(),
      null,
      flags(['permissions-policy-engine']),
    );

    expect((await disabled.checkDetailed('read', { path: 'README.md' })).approved).toBe(true);
    const enabledDecision = await enabled.checkDetailed('read', { path: 'README.md' });
    expect(enabledDecision.approved).toBe(false);
    expect(enabledDecision.sourceLayer).toBe('managed_policy');
  });

  test('plugin-lifecycle and mcp-lifecycle gate lifecycle factories when supplied', () => {
    expect(() => {
      createPluginLifecycleManager({}, flags([]));
    }).toThrow(/plugin-lifecycle/);
    expect(() => {
      createMcpLifecycleManager({}, flags([]));
    }).toThrow(/mcp-lifecycle/);

    expect(() => {
      createPluginLifecycleManager({}, flags(['plugin-lifecycle']));
    }).not.toThrow();
    expect(() => {
      createMcpLifecycleManager({}, flags(['mcp-lifecycle']));
    }).not.toThrow();
  });

  test('adaptive-execution-planner controls plan command runtime exposure', () => {
    const planner = new AdaptivePlanner();

    expect(createShellPlanRuntime({
      adaptivePlanner: planner,
      featureFlags: flags([]),
    })).toBeUndefined();
    expect(typeof createShellPlanRuntime({
      adaptivePlanner: planner,
      featureFlags: flags(['adaptive-execution-planner']),
    })).toBe('function');
  });

  test('otel-foundation controls default telemetry tracing', () => {
    const disabled = createTelemetryProvider(undefined, { featureFlags: flags([]) });
    const enabled = createTelemetryProvider(undefined, { featureFlags: flags(['otel-foundation']) });

    expect(disabled.tracer.startSpan('disabled').spanContext.isValid).toBe(false);
    expect(enabled.tracer.startSpan('enabled').spanContext.isValid).toBe(true);
  });
});
