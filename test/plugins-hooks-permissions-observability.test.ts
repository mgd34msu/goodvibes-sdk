import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher } from '../packages/sdk/src/platform/hooks/dispatcher.js';
import type { PluginLoaderDeps } from '../packages/sdk/src/platform/plugins/loader.js';
import { PermissionManager, type PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.js';
import { PluginLifecycleManager } from '../packages/sdk/src/platform/runtime/plugins/manager.js';
import type { PluginManifestV2 } from '../packages/sdk/src/platform/runtime/plugins/types.js';
import type { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function warningMessages(warnSpy: Mock<typeof logger.warn>): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

function makePluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-observability-plugin-'));
  tmpRoots.push(dir);
  writeFileSync(
    join(dir, 'index.js'),
    'export function init() {}\nexport function activate() {}\n',
    'utf-8',
  );
  return dir;
}

function makeRuntimeBus(events: Array<{ type: string; payload: Record<string, unknown> }>): RuntimeEventBus {
  return {
    emit(_domain: string, envelope: { type?: string; payload?: Record<string, unknown> }) {
      events.push({
        type: String(envelope.type),
        payload: envelope.payload ?? {},
      });
    },
  } as unknown as RuntimeEventBus;
}

function makePluginLoaderDeps(runtimeBus: RuntimeEventBus): PluginLoaderDeps {
  return {
    runtimeBus,
    commandRegistry: {},
    providerRegistry: {},
    toolRegistry: {},
    gatewayMethods: {},
    channelRegistry: {},
    channelDeliveryRouter: {},
    memoryEmbeddingRegistry: {},
    voiceProviderRegistry: {},
    mediaProviderRegistry: {},
    webSearchProviderRegistry: {},
    getPluginConfig: () => ({}),
    isEnabled: () => true,
  } as unknown as PluginLoaderDeps;
}

function makePermissionConfigReader(): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => true,
    getWorkingDirectory: () => '/tmp/goodvibes-observability',
    getSnapshot: () => ({
      permissions: {
        mode: 'prompt' as const,
        tools: {},
      },
    }),
  };
}

function makePolicyRuntimeState(): {
  runtime: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>;
  requests: unknown[];
  decisions: unknown[];
} {
  const requests: unknown[] = [];
  const decisions: unknown[] = [];
  return {
    requests,
    decisions,
    runtime: {
      recordPermissionRequest(params: unknown) {
        requests.push(params);
      },
      recordPermissionDecision(params: unknown) {
        decisions.push(params);
      },
      getRegistry() {
        return {
          getCurrent: () => ({ rules: [] }),
        } as unknown as ReturnType<PolicyRuntimeState['getRegistry']>;
      },
    },
  };
}

function hookEvent() {
  return {
    path: 'Pre:tool:read' as const,
    phase: 'Pre' as const,
    category: 'tool' as const,
    specific: 'read',
    sessionId: 'session-1',
    timestamp: Date.now(),
    payload: {},
  };
}

describe('plugins/hooks/permissions observability', () => {
  test('quarantine moves active plugins to degraded while keeping them operational and recording reason', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runtimeBus = makeRuntimeBus(events);
    const manager = new PluginLifecycleManager({
      runtimeBus,
      trustTierResolver: () => 'trusted',
    });
    const manifest: PluginManifestV2 = {
      name: 'observed-plugin',
      version: '1.0.0',
      description: 'observability test plugin',
      capabilities: ['filesystem.write'],
    };

    expect(await manager.loadPlugin(manifest, makePluginDir(), makePluginLoaderDeps(runtimeBus))).toBe(true);
    expect(manager.quarantinePlugin(manifest.name, 'suspicious behavior')).toBe(true);

    const record = manager.getRecord(manifest.name);
    expect(record?.state).toBe('degraded');
    expect(record?.quarantined).toBe(true);
    expect(record?.lastError).toBe('quarantined: suspicious behavior');
    expect(record?.errorAt).toBeGreaterThan(0);
    expect(record?.capabilities.granted).not.toContain('filesystem.write');
    expect(manager.getOperationalPlugins()).toContain(manifest.name);
    expect(events.some((event) => event.type === 'PLUGIN_DEGRADED')).toBe(true);
  });

  test('permission hook dispatch failures are logged without changing the permission decision', async () => {
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const policyRuntime = makePolicyRuntimeState();
      const manager = new PermissionManager(
        async () => {
          throw new Error('prompt should not run for auto-approved permissions');
        },
        makePermissionConfigReader(),
        policyRuntime.runtime,
        {
          async fire() {
            throw new Error('hook dispatch unavailable');
          },
        },
      );

      const result = await manager.checkDetailed('write', { path: 'README.md' });

      expect(result.approved).toBe(true);
      expect(policyRuntime.requests.length).toBe(1);
      expect(policyRuntime.decisions.length).toBe(1);
      expect(warningMessages(warnSpy).some((message) => message.includes('permission hook dispatch failed'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('trigger dispatch failures are logged without changing hook results', async () => {
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const dispatcher = new HookDispatcher({
        toolLLM: {
          chat: async () => '{"ok":true}',
        },
      });
      dispatcher.register('Pre:tool:*', {
        type: 'prompt',
        match: 'Pre:tool:*',
        prompt: '$ARGUMENTS',
        name: 'observability-hook',
      });
      dispatcher.setTriggerManager({
        list() {
          throw new Error('trigger registry unavailable');
        },
      });

      const result = await dispatcher.fire(hookEvent());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(result).toEqual({ ok: true });
      expect(warningMessages(warnSpy).some((message) => message.includes('trigger dispatch failed'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
