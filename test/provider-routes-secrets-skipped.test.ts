/**
 * provider-routes-secrets-skipped.test.ts
 *
 * Tests for F-PROV-009 — secretsResolutionSkipped observability field.
 *
 * - With secretsManager: null → GET /api/providers response body includes secretsResolutionSkipped: true
 * - With secretsManager present → response does NOT include secretsResolutionSkipped (or is falsy)
 */

import { describe, expect, test } from 'bun:test';
import { dispatchProviderRoutes } from '../packages/sdk/src/_internal/platform/daemon/http/provider-routes.js';
import type { ProviderRouteContext } from '../packages/sdk/src/_internal/platform/daemon/http/provider-routes.js';
import { RuntimeEventBus } from '../packages/sdk/src/_internal/platform/runtime/events/index.js';
import type { ProviderRegistry } from '../packages/sdk/src/_internal/platform/providers/registry.js';
import type { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import type { ModelDefinition } from '../packages/sdk/src/_internal/platform/providers/registry-types.js';

// ---------------------------------------------------------------------------
// Stubs (minimal — mirrors provider-routes.test.ts pattern)
// ---------------------------------------------------------------------------

function makeModel(provider: string, id: string): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: `${provider} ${id}`,
    description: '',
    selectable: true,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    tier: 'standard',
  } as ModelDefinition;
}

function makeRegistry(models: ModelDefinition[], configuredIds: string[] = []): ProviderRegistry {
  return {
    listModels: () => models,
    getCurrentModel: () => {
      if (!models[0]) throw new Error('No current model');
      return models[0];
    },
    getConfiguredProviderIds: () => configuredIds,
    setCurrentModel: () => {},
  } as unknown as ProviderRegistry;
}

function makeConfigManager(): ConfigManager {
  return { set: () => {} } as unknown as ConfigManager;
}

function makeContext(
  registry: ProviderRegistry,
  secretsManager?: ProviderRouteContext['secretsManager'],
): ProviderRouteContext {
  const bus = new RuntimeEventBus();
  return {
    providerRegistry: registry,
    configManager: makeConfigManager(),
    runtimeBus: bus,
    parseJsonBody: async (req) => {
      try { return await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    secretsManager,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F-PROV-009 — GET /api/providers: secretsResolutionSkipped observability', () => {
  test('secretsManager: null → response includes secretsResolutionSkipped: true', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const ctx = makeContext(makeRegistry([m1], ['inception']), null);
    const req = new Request('http://localhost/api/providers', { method: 'GET' });
    const res = await dispatchProviderRoutes(req, ctx);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    expect(body['secretsResolutionSkipped']).toBe(true);
  });

  test('secretsManager: undefined → response includes secretsResolutionSkipped: true', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const ctx = makeContext(makeRegistry([m1], ['inception']), undefined);
    const req = new Request('http://localhost/api/providers', { method: 'GET' });
    const res = await dispatchProviderRoutes(req, ctx);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    expect(body['secretsResolutionSkipped']).toBe(true);
  });

  test('secretsManager present → response does NOT include secretsResolutionSkipped', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const secretsManager = {
      get: async (_key: string): Promise<string | null> => null,
    };
    const ctx = makeContext(makeRegistry([m1], ['inception']), secretsManager);
    const req = new Request('http://localhost/api/providers', { method: 'GET' });
    const res = await dispatchProviderRoutes(req, ctx);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    // When secretsManager is present, the field should be absent or falsy
    expect(body['secretsResolutionSkipped']).toBeFalsy();
  });
});
