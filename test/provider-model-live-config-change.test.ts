/**
 * provider-model-live-config-change.test.ts — a `provider.model` write reaches
 * the NEXT agent, with no restart.
 *
 * MEASURED DEFECT this locks down: `provider.model` was written through the
 * daemon's `POST /config`. It persisted to disk and the daemon's in-memory
 * ConfigManager reported the new value — yet agents spawned a minute later
 * still ran the OLD model. ProviderRegistry read `provider.model` exactly once,
 * in its constructor, and stored the resolved registryKey in
 * `currentModelRegistryKey` forever. Every later read — including
 * `getCurrentModel()`, the first thing `runAgentTask()` calls to pick an
 * agent's route (agents/orchestrator-runner.ts) — returned the boot value.
 *
 * The three tests below cover the three ways the value moves:
 *   1. an in-process write (what `POST /config` does: `setDynamic`),
 *   2. the agent SPAWN seam (the route an agent record actually resolves to),
 *   3. an external file edit (another process, or a hand edit, plus the
 *      config file watcher).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.ts';
import { AgentOrchestrator } from '../packages/sdk/src/platform/agents/orchestrator.ts';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.ts';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.ts';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.ts';

const OLD_PROVIDER = 'live-config-old';
const NEW_PROVIDER = 'live-config-new';
const OLD_KEY = `${OLD_PROVIDER}:model-old`;
const NEW_KEY = `${NEW_PROVIDER}:model-new`;

const dirs: string[] = [];

function tempConfigDir(label: string): string {
  const dir = join(tmpdir(), `gv-${label}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeProvider(name: string, models: readonly string[]): LLMProvider {
  return {
    name,
    models: [...models],
    modelSource: { kind: 'live-discovery' },
    credentialAuthority: 'anonymous',
    chat: async () => { throw new Error('not implemented'); },
    stream: async function* () { /* empty */ },
  } as unknown as LLMProvider;
}

function makeModelDefinition(provider: string, id: string): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: id,
    description: `${id} test model`,
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128_000,
    selectable: true,
    tier: 'standard',
  };
}

/** A ProviderRegistry wired to a REAL ConfigManager — the daemon's shape. */
function makeRegistry(configManager: ConfigManager, emitted?: unknown[]): ProviderRegistry {
  type Options = ConstructorParameters<typeof ProviderRegistry>[0];
  const registry = new ProviderRegistry({
    configManager,
    subscriptionManager: {
      get: () => null,
      getPending: () => null,
      saveSubscription: async () => {},
      resolveAccessToken: async () => null,
    } as unknown as Options['subscriptionManager'],
    // No bare `as unknown as` on this double any more. The cast was hiding that
    // it does not implement setModelFactsSource, which the registry CALLS on
    // every catalog update — the omission surfaced only as a runtime TypeError
    // once a test reached that path. The `satisfies` clause makes the next
    // missing method a compile error instead.
    capabilityRegistry: {
      getCapability: () => ({}),
      getRouteExplanation: () => ({ accepted: true }),
      invalidate: () => {},
      setModelFactsSource: () => {},
      canHandle: () => true,
    } satisfies Record<keyof Options['capabilityRegistry'], unknown> as unknown as Options['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as Options['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as unknown as Options['favoritesStore'],
    benchmarkStore: {
      getBenchmarks: () => undefined,
      getTopBenchmarkModelIds: () => [],
    } as unknown as Options['benchmarkStore'],
    secretsManager: {} as unknown as Options['secretsManager'],
    serviceRegistry: {} as unknown as Options['serviceRegistry'],
    featureFlags: null,
    runtimeBus: emitted
      ? ({ emit: (_channel: string, envelope: unknown) => { emitted.push(envelope); } } as unknown as Options['runtimeBus'])
      : null,
  });
  // Both models must be resolvable through listModels() — that is what the
  // agent spawn path routes against.
  registry.registerRuntimeProvider({
    provider: makeProvider(OLD_PROVIDER, ['model-old']),
    models: [makeModelDefinition(OLD_PROVIDER, 'model-old')],
  });
  registry.registerRuntimeProvider({
    provider: makeProvider(NEW_PROVIDER, ['model-new']),
    models: [makeModelDefinition(NEW_PROVIDER, 'model-new')],
  });
  return registry;
}

/** Seed the boot value the way a running daemon has it: already on disk. */
function seededConfig(label: string): { configManager: ConfigManager; configDir: string } {
  const configDir = tempConfigDir(label);
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({ provider: { model: OLD_KEY } }, null, 2) + '\n',
    'utf-8',
  );
  return { configManager: new ConfigManager({ configDir }), configDir };
}

describe('provider.model changes reach the next agent without a restart', () => {
  test('an in-process write (the POST /config path) is picked up by the next model resolution', () => {
    const { configManager } = seededConfig('model-live-set');
    const registry = makeRegistry(configManager);

    // Boot state: the registry resolved the configured model at construction.
    expect(registry.getCurrentModel().registryKey).toBe(OLD_KEY);

    // Exactly what daemon-sdk/src/system-routes.ts postConfig does.
    configManager.setDynamic('provider.model', NEW_KEY);
    expect(configManager.get('provider.model')).toBe(NEW_KEY);

    // ...and the value the runtime ACTS on must follow the value it REPORTS.
    expect(registry.getCurrentModel().registryKey).toBe(NEW_KEY);
    expect(registry.getCurrentModel().id).toBe('model-new');
  });

  test('an in-process /model switch is not undone by a later read', () => {
    const { configManager } = seededConfig('model-live-switch');
    const registry = makeRegistry(configManager);

    // A UI model switch that does NOT write config (bootstrap-helpers.ts and
    // the fallback path in bootstrap-background.ts both do this).
    registry.setCurrentModel(NEW_KEY);
    expect(registry.getCurrentModel().registryKey).toBe(NEW_KEY);
    // Re-reading must not snap back to the unchanged config value.
    expect(registry.getCurrentModel().registryKey).toBe(NEW_KEY);
  });

  test('an agent spawned after the write routes to the new model', () => {
    const { configManager } = seededConfig('model-live-spawn');
    const registry = makeRegistry(configManager);
    const orchestrator = new AgentOrchestrator({ messageBus: new AgentMessageBus() });

    const record = {
      id: 'agent-live-model',
      task: 'anything',
      tools: [],
      status: 'queued',
    } as unknown as AgentRecord;

    // The exact seam runAgentTask() uses (agents/orchestrator-runner.ts):
    // getCurrentModel() -> resolveProviderForRecord() -> the agent's route.
    const resolveRoute = (): { provider: LLMProvider; modelId: string; requestedModelId: string } => {
      const currentModel = registry.getCurrentModel();
      return (orchestrator as unknown as {
        resolveProviderForRecord: (
          registry: ProviderRegistry,
          record: AgentRecord,
          currentModel: { id: string; provider: string; registryKey: string },
        ) => { provider: LLMProvider; modelId: string; requestedModelId: string };
      }).resolveProviderForRecord(registry, record, currentModel);
    };

    expect(resolveRoute().requestedModelId).toBe(OLD_KEY);

    configManager.setDynamic('provider.model', NEW_KEY);

    const route = resolveRoute();
    expect(route.requestedModelId).toBe(NEW_KEY);
    expect(route.modelId).toBe('model-new');
    expect(route.provider.name).toBe(NEW_PROVIDER);
  });

  test('adopting a config change announces MODEL_CHANGED on the runtime bus', () => {
    const { configManager } = seededConfig('model-live-event');
    const emitted: unknown[] = [];
    const registry = makeRegistry(configManager, emitted);
    expect(registry.getCurrentModel().registryKey).toBe(OLD_KEY);

    configManager.setDynamic('provider.model', NEW_KEY);
    expect(registry.getCurrentModel().registryKey).toBe(NEW_KEY);

    // Surfaces that render the active model follow the event, not a poll.
    const modelChanged = emitted
      .filter((envelope) => (envelope as { type?: string }).type === 'MODEL_CHANGED')
      .map((envelope) => (envelope as { payload: { registryKey: string; previous?: { registryKey: string } } }).payload);
    expect(modelChanged.length).toBe(1);
    expect(modelChanged[0]?.registryKey).toBe(NEW_KEY);
    expect(modelChanged[0]?.previous?.registryKey).toBe(OLD_KEY);
  });

  test('an external file edit to provider.model is picked up too', async () => {
    const { configManager, configDir } = seededConfig('model-live-file');
    const registry = makeRegistry(configManager);
    expect(registry.getCurrentModel().registryKey).toBe(OLD_KEY);

    const stop = configManager.watchConfigFiles({ intervalMs: 50 });
    try {
      // Another process (or a hand edit) rewrites the settings file. Once.
      writeFileSync(
        join(configDir, 'settings.json'),
        JSON.stringify({ provider: { model: NEW_KEY } }, null, 2) + '\n',
        'utf-8',
      );
      const startedAt = Date.now();
      while (configManager.get('provider.model') !== NEW_KEY) {
        if (Date.now() - startedAt > 60_000) {
          throw new Error('the external settings edit never reached the live config');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      stop();
    }

    expect(registry.getCurrentModel().registryKey).toBe(NEW_KEY);
  }, 90_000);
});
