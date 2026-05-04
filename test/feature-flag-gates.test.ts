import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerToolWithContractGate } from '../packages/sdk/src/platform/tools/index.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import { executeFetchInput } from '../packages/sdk/src/platform/tools/fetch/index.js';
import { guardExecCommand } from '../packages/sdk/src/platform/tools/exec/ast-guard.js';
import { createPhasedExecutor } from '../packages/sdk/src/platform/runtime/tools/index.js';
import { DeliveryQueue } from '../packages/sdk/src/platform/integrations/delivery.js';
import { Notifier } from '../packages/sdk/src/platform/integrations/notifier.js';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.js';
import { ChannelPluginRegistry, SurfaceRegistry } from '../packages/sdk/src/platform/channels/index.js';
import { bindProviderOptimizerFeatureFlag } from '../packages/sdk/src/platform/runtime/services.js';
import {
  createDivergenceDashboard,
  createPermissionEvaluator,
  createPolicyRegistry,
  loadPolicyBundle,
  PermissionSimulator,
  signBundle,
} from '../packages/sdk/src/platform/runtime/permissions/index.js';
import { PermissionManager } from '../packages/sdk/src/platform/permissions/manager.js';
import { createPluginLifecycleManager } from '../packages/sdk/src/platform/runtime/plugins/index.js';
import { createMcpLifecycleManager } from '../packages/sdk/src/platform/runtime/mcp/index.js';
import { createShellPlanRuntime } from '../packages/sdk/src/platform/runtime/shell-command-ops.js';
import { AdaptivePlanner } from '../packages/sdk/src/platform/core/adaptive-planner.js';
import { createTelemetryProvider } from '../packages/sdk/src/platform/runtime/telemetry/index.js';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createTaskManager } from '../packages/sdk/src/platform/runtime/tasks/index.js';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/index.js';
import { getSecuritySettingsReport } from '../packages/sdk/src/platform/runtime/security-settings.js';
import { AgentOrchestrator } from '../packages/sdk/src/platform/agents/orchestrator.js';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { WatcherRegistry } from '../packages/sdk/src/platform/watchers/index.js';
import { PlatformServiceManager } from '../packages/sdk/src/platform/daemon/service-manager.js';
import { AutomationDeliveryManager, AutomationManager } from '../packages/sdk/src/platform/automation/index.js';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/index.js';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.js';
import { ApiTokenAuditor } from '../packages/sdk/src/platform/security/token-audit.js';
import { ModeManager } from '../packages/sdk/src/platform/state/mode-manager.js';
import type { Tool, ToolResult } from '../packages/sdk/src/platform/types/tools.js';
import type { ToolRuntimeContext } from '../packages/sdk/src/platform/runtime/tools/index.js';
import type { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.js';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.js';
import type { AutomationJob } from '../packages/sdk/src/platform/automation/jobs.js';
import type { AutomationRun } from '../packages/sdk/src/platform/automation/runs.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';

const flags = (enabledIds: readonly string[]) => ({
  isEnabled(id: string): boolean {
    return enabledIds.includes(id);
  },
});

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-flags-'));
  try {
    const result = fn(dir);
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      return (result as Promise<unknown>).finally(() => {
        rmSync(dir, { recursive: true, force: true });
      }) as T;
    }
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function testConfigManager(dir: string): ConfigManager {
  return new ConfigManager({ configDir: dir });
}

function automationSource(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'source-1',
    kind: 'manual',
    label: 'Test source',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

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

function makeAutomationJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  const now = Date.now();
  const source = automationSource() as AutomationJob['source'];
  return {
    id: 'job-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    name: 'Test job',
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'at', at: now },
    execution: { target: { kind: 'background' }, prompt: 'run test' },
    delivery: {
      mode: 'surface',
      targets: [{ kind: 'surface', surfaceKind: 'webhook', address: 'https://example.test/hook' }],
      fallbackTargets: [],
      includeSummary: false,
      includeTranscript: false,
      includeLinks: false,
    },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 1,
      cooldownMs: 0,
      retryPolicy: {
        maxAttempts: 1,
        delayMs: 0,
        strategy: 'fixed',
      },
    },
    source,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
    ...overrides,
  };
}

function makeAutomationRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = Date.now();
  const source = automationSource() as AutomationRun['triggeredBy'];
  return {
    id: 'run-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    jobId: 'job-1',
    status: 'completed',
    triggeredBy: source,
    target: { kind: 'background' },
    execution: { target: { kind: 'background' }, prompt: 'run test' },
    queuedAt: now,
    forceRun: false,
    dueRun: false,
    attempt: 1,
    deliveryIds: [],
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

  test('fetch-sanitization validates redirect targets before following', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }) as typeof fetch;

    try {
      const output = await executeFetchInput(
        {
          urls: [{ url: 'https://example.test/redirect' }],
        },
        { featureFlags: flags(['fetch-sanitization']) },
      );

      const result = output.results?.[0];
      expect(calls).toBe(1);
      expect(output.summary.failed).toBe(1);
      expect(result?.error).toMatch(/redirect blocked/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test('fetch-sanitization disabled leaves raw fetch content unsanitized', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('<script>unsanitized</script><p>raw</p>', {
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
      expect(result?.content).toContain('<script>unsanitized</script>');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('security settings report explains security-relevant disabled flags', () => {
    const manager = createFeatureFlagManager();
    const report = getSecuritySettingsReport(manager);
    const fetchSetting = report.find((entry) => entry.key === 'featureFlags.fetch-sanitization');

    expect(fetchSetting?.key).toBe('featureFlags.fetch-sanitization');
    expect(fetchSetting?.currentState).toBe('disabled');
    expect(fetchSetting?.insecureWhen).toMatch(/SSRF-risk hosts/i);
    expect(fetchSetting?.enablementRequirements).toEqual([
      'Enable featureFlags.fetch-sanitization in SDK/TUI configuration.',
      'Add trusted_hosts only for hosts whose raw content is safe to expose to the model.',
      'Keep sanitize_mode at safe-text or strict unless the target host is explicitly trusted.',
    ]);
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

  test('otel-remote-export wires OTLP export only when both telemetry flags are enabled', () => {
    const disabled = createTelemetryProvider(undefined, {
      featureFlags: flags(['otel-foundation']),
      otlp: { endpoint: 'http://127.0.0.1:4318/v1/traces', batchSize: 1, timeoutMs: 10 },
    });
    const enabled = createTelemetryProvider(undefined, {
      featureFlags: flags(['otel-foundation', 'otel-remote-export']),
      otlp: { endpoint: 'http://127.0.0.1:4318/v1/traces', batchSize: 1, timeoutMs: 10 },
    });

    const disabledExporters = (disabled.tracer as unknown as { config: { exporters: Array<{ name: string }> } }).config.exporters;
    const enabledExporters = (enabled.tracer as unknown as { config: { exporters: Array<{ name: string }> } }).config.exporters;

    expect(disabledExporters).toHaveLength(0);
    expect(enabledExporters.map((exporter) => exporter.name)).toEqual(['otlp']);
  });

  test('overflow-spill-backends forces file backend until alternate backends are enabled', () => withTempDir((dir) => {
    const disabled = new OverflowHandler({ baseDir: dir, spillBackend: 'ledger', featureFlags: flags([]) });
    const enabled = new OverflowHandler({ baseDir: dir, spillBackend: 'ledger', featureFlags: flags(['overflow-spill-backends']) });

    expect(disabled.backendType).toBe('file');
    expect(enabled.backendType).toBe('ledger');
  }));

  test('watcher-framework gates watcher registry operations', () => withTempDir((dir) => {
    const disabled = new WatcherRegistry({
      storePath: join(dir, 'disabled-watchers.json'),
      featureFlags: flags([]),
    });
    expect(disabled.list()).toEqual([]);
    expect(() => disabled.registerPollingWatcher({
      id: 'watcher-1',
      label: 'Watcher 1',
      source: automationSource({ kind: 'watcher' }) as never,
      intervalMs: 1000,
      run: () => 'ok',
    })).toThrow(/watcher-framework feature flag is disabled/);

    const enabled = new WatcherRegistry({
      storePath: join(dir, 'enabled-watchers.json'),
      featureFlags: flags(['watcher-framework']),
    });
    enabled.registerPollingWatcher({
      id: 'watcher-1',
      label: 'Watcher 1',
      source: automationSource({ kind: 'watcher' }) as never,
      intervalMs: 1000,
      run: () => 'ok',
    });
    expect(enabled.list()).toHaveLength(1);
    enabled.stopWatcher('watcher-1');
  }));

  test('service-management gates daemon service mutations', () => withTempDir((dir) => {
    const configManager = testConfigManager(join(dir, 'config'));
    const disabled = new PlatformServiceManager(configManager, {
      workingDirectory: dir,
      homeDirectory: dir,
      featureFlags: flags([]),
    });
    const enabled = new PlatformServiceManager(configManager, {
      workingDirectory: dir,
      homeDirectory: dir,
      featureFlags: flags(['service-management']),
    });

    expect(disabled.status().actionError).toMatch(/service-management feature flag is disabled/);
    expect(() => disabled.install()).toThrow(/service-management feature flag is disabled/);
    expect(enabled.status().actionError).toBeUndefined();
  }));

  test('surface flags gate configured surfaces and channel plugins', () => withTempDir((dir) => {
    const configManager = testConfigManager(join(dir, 'config'));
    configManager.set('surfaces.slack.enabled', true);

    const disabledSurfaces = new SurfaceRegistry(configManager, undefined, flags([]));
    const enabledSurfaces = new SurfaceRegistry(configManager, undefined, flags(['slack-surface']));
    expect(disabledSurfaces.syncConfiguredSurfaces().find((surface) => surface.kind === 'slack')?.enabled).toBe(false);
    expect(enabledSurfaces.syncConfiguredSurfaces().find((surface) => surface.kind === 'slack')?.enabled).toBe(true);

    const disabledPlugins = new ChannelPluginRegistry({ featureFlags: flags([]) });
    const enabledPlugins = new ChannelPluginRegistry({ featureFlags: flags(['slack-surface']) });
    const plugin = {
      id: 'slack',
      surface: 'slack' as const,
      displayName: 'Slack',
      capabilities: ['egress' as const],
    };
    disabledPlugins.register(plugin);
    enabledPlugins.register(plugin);

    expect(disabledPlugins.list()).toEqual([]);
    expect(disabledPlugins.getBySurface('slack')).toBeNull();
    expect(enabledPlugins.getBySurface('slack')?.id).toBe('slack');
  }));

  test('web-surface enables the web surface gate', () => withTempDir((dir) => {
    const configManager = testConfigManager(join(dir, 'config'));
    configManager.set('web.enabled', true);
    const registry = new SurfaceRegistry(configManager, undefined, flags(['web-surface']));

    expect(registry.syncConfiguredSurfaces().find((surface) => surface.kind === 'web')?.enabled).toBe(true);
  }));

  test('control-plane-gateway gates gateway traffic', () => {
    const disabled = new ControlPlaneGateway({ featureFlags: flags([]) });
    const enabled = new ControlPlaneGateway({ featureFlags: flags(['control-plane-gateway']) });

    expect(disabled.getSnapshot()).toEqual(expect.objectContaining({ disabled: true, featureFlag: 'control-plane-gateway' }));
    expect(disabled.createEventStream(new Request('http://localhost/events')).status).toBe(503);
    expect(enabled.getSnapshot()).not.toEqual(expect.objectContaining({ disabled: true }));
  });

  test('delivery-engine gates automation deliveries and surface-specific targets', async () => {
    let delivered = 0;
    const routeBindings = {
      start: async () => undefined,
      getBinding: () => undefined,
      captureReplyTarget: async () => undefined,
    } as unknown as RouteBindingManager;
    const deliveryRouter = {
      setControlPlaneGateway() {},
      deliver: async () => {
        delivered += 1;
        return 'delivered';
      },
    };
    const job = makeAutomationJob();
    const run = makeAutomationRun();

    const disabled = new AutomationDeliveryManager({
      routeBindings,
      deliveryRouter: deliveryRouter as never,
      featureFlags: flags([]),
    });
    expect(await disabled.deliverJobRun(job, run)).toEqual([]);

    const engineOnly = new AutomationDeliveryManager({
      routeBindings,
      deliveryRouter: deliveryRouter as never,
      featureFlags: flags(['delivery-engine']),
    });
    expect(await engineOnly.deliverJobRun(job, run)).toEqual([]);

    const enabled = new AutomationDeliveryManager({
      routeBindings,
      deliveryRouter: deliveryRouter as never,
      featureFlags: flags(['delivery-engine', 'webhook-surface']),
    });
    const attempts = await enabled.deliverJobRun(job, run);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('sent');
    expect(delivered).toBe(1);
  });

  test('automation-domain gates automation manager operations', async () => withTempDir(async (dir) => {
    const disabled = new AutomationManager({
      configManager: testConfigManager(join(dir, 'config-disabled')),
      routeBindings: {} as RouteBindingManager,
      sessionBroker: {} as never,
      featureFlags: flags([]),
    });
    const enabled = new AutomationManager({
      configManager: testConfigManager(join(dir, 'config-enabled')),
      routeBindings: {} as RouteBindingManager,
      sessionBroker: {} as never,
      featureFlags: flags(['automation-domain']),
    });

    expect(disabled.listJobs()).toEqual([]);
    await expect(disabled.createJob({} as never)).rejects.toThrow(/automation-domain feature flag is disabled/);
    expect(enabled.listJobs()).toEqual([]);
  }));

  test('unified-runtime-task gates task manager creation and mutation', () => {
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const disabled = createTaskManager(store, bus, 'session-1', flags([]));
    const enabled = createTaskManager(store, bus, 'session-1', flags(['unified-runtime-task']));

    expect(() => disabled.createTask({ kind: 'exec', title: 'blocked', owner: 'test' })).toThrow(/unified-runtime-task/);
    expect(enabled.createTask({ kind: 'exec', title: 'allowed', owner: 'test' }).status).toBe('queued');
  });

  test('permission-divergence-dashboard and policy-as-code gate factories', () => {
    const simulator = new PermissionSimulator({}, {}, 'warn-on-divergence');

    expect(() => createDivergenceDashboard(simulator, 'warn-on-divergence', {}, flags([]))).toThrow(/permission-divergence-dashboard/);
    expect(() => createDivergenceDashboard(simulator, 'warn-on-divergence', {}, flags(['permission-divergence-dashboard']))).not.toThrow();
    expect(() => createPolicyRegistry({}, flags([]))).toThrow(/policy-as-code/);
    expect(() => createPolicyRegistry({}, flags(['policy-as-code']))).not.toThrow();
  });

  test('policy-signing gates managed signature enforcement when supplied', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef');
    const signed = signBundle('bundle-1', { version: 1, rules: [] }, key);
    const tampered = {
      ...signed,
      payload: {
        version: 1,
        rules: [{
          id: 'allow-read',
          type: 'prefix' as const,
          origin: 'user' as const,
          effect: 'allow' as const,
          toolPattern: 'read',
        }],
      },
    };

    const disabled = loadPolicyBundle(tampered, {
      signingKey: key,
      managed: true,
      featureFlags: flags([]),
    });
    const enabled = loadPolicyBundle(tampered, {
      signingKey: key,
      managed: true,
      featureFlags: flags(['policy-signing']),
    });

    expect(disabled.ok).toBe(true);
    expect(disabled.provenance.signatureStatus).toBe('skipped');
    expect(enabled.ok).toBe(false);
    expect(enabled.provenance.signatureStatus).toBe('invalid');
  });

  test('token-scope-rotation-audit gates managed blocking while preserving audit findings', () => {
    const oldIssuedAt = Date.now() - 10_000;
    const disabled = new ApiTokenAuditor({ managed: true, featureFlags: flags([]) });
    const enabled = new ApiTokenAuditor({ managed: true, featureFlags: flags(['token-scope-rotation-audit']) });
    for (const auditor of [disabled, enabled]) {
      auditor.registerPolicy({
        id: 'test-policy',
        name: 'Test policy',
        allowedScopes: ['read'],
        rotationCadenceMs: 1,
      });
      auditor.registerToken({
        id: 'token-1',
        label: 'TEST_TOKEN',
        issuedAt: oldIssuedAt,
        grantedScopes: ['read', 'write'],
        policyId: 'test-policy',
      });
    }

    expect(disabled.auditAll().scopeViolations).toEqual(['token-1']);
    expect(disabled.auditAll().blocked).toEqual([]);
    expect(enabled.auditAll().blocked).toEqual(['token-1']);
  });

  test('hitl-ux-modes gates HITL mode application', () => {
    const disabled = new ModeManager({ featureFlags: flags([]) });
    const enabled = new ModeManager({ featureFlags: flags(['hitl-ux-modes']) });

    expect(disabled.listHITLPresets()).toEqual([]);
    expect(() => disabled.setHITLMode('operator')).toThrow(/hitl-ux-modes/);
    enabled.setHITLMode('operator');
    expect(enabled.getHITLMode()).toBe('operator');
  });
});
