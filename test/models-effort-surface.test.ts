/**
 * The reasoning-effort surface over the model routes.
 *
 * models.list reports, per model, the reasoning levels the model actually
 * offers and which source resolved them (the same resolution the turn path
 * uses). models.current.set accepts an optional `effort`, validates it against
 * the known severity ladder, and persists it beside the model selection under
 * `provider.reasoningEffort`, the key the turn loop already reads and snaps
 * down per model. models.current.get reports the persisted level, and null
 * when nothing was ever set, which the config default ('medium') would
 * otherwise mask.
 */

import { describe, expect, test } from 'bun:test';

import { dispatchModelRoutes } from '../packages/sdk/src/platform/daemon/http/model-routes.ts';
import type { ModelRouteContext } from '../packages/sdk/src/platform/daemon/http/model-routes.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.ts';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.ts';
import type { ReasoningEffortSpec } from '../packages/sdk/src/platform/providers/reasoning-effort.ts';

function makeModel(
  provider: string,
  id: string,
  reasoning?: ReasoningEffortSpec,
): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: `${provider} ${id}`,
    description: '',
    selectable: true,
    capabilities: {
      toolCalling: false,
      codeEditing: false,
      reasoning: reasoning !== undefined,
      multimodal: false,
    },
    contextWindow: 8192,
    tier: 'standard',
    ...(reasoning ? { reasoningEffort: reasoning } : {}),
  } as ModelDefinition;
}

function makeRegistry(models: ModelDefinition[], configuredIds: string[]): ProviderRegistry {
  let current = models[0];
  return {
    listModels: () => models,
    getCurrentModel: () => {
      if (!current) throw new Error('No current model');
      return current;
    },
    getConfiguredProviderIds: () => configuredIds,
    describeRuntime: async () => null,
    setCurrentModel: (registryKey: string) => {
      const next = models.find((model) => model.registryKey === registryKey);
      if (next) current = next;
    },
  } as unknown as ProviderRegistry;
}

/**
 * A config double with the two behaviors the effort read path depends on:
 * `get` resolves the schema default when nothing was set, and
 * `describeConfigKeySource` reports tier 'default' for exactly that case.
 */
function makeConfigStore(): { manager: ConfigManager; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const manager = {
    set: (key: string, value: unknown) => { store.set(key, value); },
    get: (key: string) => store.get(key) ?? (key === 'provider.reasoningEffort' ? 'medium' : undefined),
    reset: (key: string) => { store.delete(key); },
    describeConfigKeySource: (key: string) => ({ tier: store.has(key) ? 'global' : 'default' }),
  } as unknown as ConfigManager;
  return { manager, store };
}

function makeContext(
  models: ModelDefinition[],
  configuredIds: string[],
): { context: ModelRouteContext; store: Map<string, unknown> } {
  const { manager, store } = makeConfigStore();
  const context: ModelRouteContext = {
    providerRegistry: makeRegistry(models, configuredIds),
    configManager: manager,
    runtimeBus: new RuntimeEventBus(),
    parseJsonBody: async (req) => {
      try { return await req.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }
    },
  };
  return { context, store };
}

function makeRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const DECLARED_SPEC: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['low', 'medium', 'high'],
  source: 'declared',
};

describe('models.list reasoningOptions', () => {
  test('a reasoning model reports its resolved levels and source; a non-reasoning model reports nothing', async () => {
    const reasoner = makeModel('inception', 'mercury-think', DECLARED_SPEC);
    const plain = makeModel('inception', 'mercury-2');
    const { context } = makeContext([reasoner, plain], ['inception']);

    const res = await dispatchModelRoutes(makeRequest('GET', 'http://localhost/api/models'), context);
    expect(res!.status).toBe(200);
    const body = await res!.json() as { providers: Array<{ id: string; models: Array<Record<string, unknown>> }> };
    const models = body.providers.find((provider) => provider.id === 'inception')!.models;

    const thinkEntry = models.find((model) => model['id'] === 'mercury-think')!;
    expect(thinkEntry['reasoningOptions']).toEqual({ levels: ['low', 'medium', 'high'], source: 'declared' });

    const plainEntry = models.find((model) => model['id'] === 'mercury-2')!;
    expect(plainEntry['reasoningOptions']).toBeUndefined();
  });
});

describe('models.current.set effort', () => {
  test('an unknown level is refused with 400 and nothing is persisted', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context, store } = makeContext([m1], ['inception']);

    const res = await dispatchModelRoutes(
      makeRequest('PATCH', 'http://localhost/api/models/current', { registryKey: 'inception:mercury-2', effort: 'ultra' }),
      context,
    );
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.error as string).toContain('ultra');
    expect(body.error as string).toContain('xhigh');
    expect(store.has('provider.reasoningEffort')).toBe(false);
    expect(store.has('provider.model')).toBe(false);
  });

  test('a valid level persists beside the model selection and echoes in the response', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const m2 = makeModel('inception', 'mercury-edit');
    const { context, store } = makeContext([m1, m2], ['inception']);

    const res = await dispatchModelRoutes(
      makeRequest('PATCH', 'http://localhost/api/models/current', { registryKey: 'inception:mercury-edit', effort: 'high' }),
      context,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.persisted).toBe(true);
    expect(body.effort).toBe('high');
    expect(store.get('provider.model')).toBe('inception:mercury-edit');
    expect(store.get('provider.reasoningEffort')).toBe('high');
  });

  test('omitting effort leaves the persisted level untouched', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const m2 = makeModel('inception', 'mercury-edit');
    const { context, store } = makeContext([m1, m2], ['inception']);
    store.set('provider.reasoningEffort', 'low');

    const res = await dispatchModelRoutes(
      makeRequest('PATCH', 'http://localhost/api/models/current', { registryKey: 'inception:mercury-edit' }),
      context,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.effort).toBe('low');
    expect(store.get('provider.reasoningEffort')).toBe('low');
  });

  test('an explicit null clears the persisted level back to the provider default', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context, store } = makeContext([m1], ['inception']);
    store.set('provider.reasoningEffort', 'high');

    const res = await dispatchModelRoutes(
      makeRequest('PATCH', 'http://localhost/api/models/current', { registryKey: 'inception:mercury-2', effort: null }),
      context,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.persisted).toBe(true);
    expect(body.effort).toBeNull();
    expect(store.has('provider.reasoningEffort')).toBe(false);
  });
});

describe('models.current.get effort round-trip', () => {
  test('reports null before any set, and the persisted level after', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext([m1], ['inception']);

    const before = await dispatchModelRoutes(makeRequest('GET', 'http://localhost/api/models/current'), context);
    expect(((await before!.json()) as Record<string, unknown>).effort).toBeNull();

    const set = await dispatchModelRoutes(
      makeRequest('PATCH', 'http://localhost/api/models/current', { registryKey: 'inception:mercury-2', effort: 'xhigh' }),
      context,
    );
    expect(set!.status).toBe(200);

    const after = await dispatchModelRoutes(makeRequest('GET', 'http://localhost/api/models/current'), context);
    expect(((await after!.json()) as Record<string, unknown>).effort).toBe('xhigh');
  });
});
