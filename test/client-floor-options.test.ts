/**
 * client-floor-options.test.ts — the three postures the floor would otherwise
 * silently reverse.
 *
 * ── Why these are options and not preferences ─────────────────────────────
 *
 * A surface product adopting `createClientRuntimeServices` was, until these
 * existed, forced to give up three things it had chosen deliberately:
 *
 *  1. LAUNCH TOLERANCE. The floor built the registry with `new
 *     ProviderRegistry`. A product that boots against broken or absent provider
 *     credentials needs `createLaunchTolerantProviderRegistry` instead, or a
 *     misconfigured key becomes a crash before the first frame rather than a
 *     degraded provider.
 *  2. DISCOVERY TIMING. The floor always ran model discovery, whose write is
 *     async and unawaited. A composition that will not outlive that write — a
 *     suite against a temp workspace, a one-shot subcommand — needs to skip it,
 *     or the write lands in a directory that has been removed.
 *  3. THE HOOK CAPABILITY BOUNDARY. The floor always handed the hook dispatcher
 *     the agent manager. At least one product withholds it on purpose: a hook
 *     that cannot reach the agent manager cannot spawn an agent, and that
 *     refusal is pinned as a feature.
 *
 * Each was a real blocker measured against a real consumer, so each is checked
 * here in both directions: the option changes what happens, AND omitting it
 * changes nothing. The second half is the one that matters for every existing
 * caller — a default that quietly shifted would be a behaviour change delivered
 * as a refactor.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderStack } from '../packages/sdk/src/platform/runtime/provider-stack.ts';
import type { ProviderRegistryConstructionOptions } from '../packages/sdk/src/platform/runtime/provider-stack.ts';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { ServiceRegistry } from '../packages/sdk/src/platform/config/service-registry.ts';
import { SubscriptionManager } from '../packages/sdk/src/platform/config/subscriptions.ts';
import { createRuntimeSecretsManager } from '../packages/sdk/src/platform/runtime/secrets-composition.ts';
import { createShellPathService } from '../packages/sdk/src/platform/runtime/shell-paths.ts';
import { resolveRuntimeFeatureFlags } from '../packages/sdk/src/platform/runtime/feature-flag-composition.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createClientRuntimeServices } from '../packages/sdk/src/platform/runtime/client-services.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function stackOptions() {
  const root = mkdtempSync(join(tmpdir(), 'gv-floor-options-'));
  roots.push(root);
  const workingDirectory = join(root, 'work');
  const surfaceRoot = 'tui';
  const configManager = new ConfigManager({ workingDir: workingDirectory, homeDir: root, surfaceRoot });
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory: root });
  const secretsManager = createRuntimeSecretsManager({
    projectRoot: workingDirectory, globalHome: root, surfaceRoot, configManager,
  });
  const subscriptionManager = new SubscriptionManager(shellPaths.resolveUserPath(surfaceRoot, 'subscriptions.json'));
  return {
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry: new ServiceRegistry(shellPaths.resolveProjectPath(surfaceRoot, 'services.json'), {
      secretsManager, subscriptionManager,
    }),
    featureFlags: resolveRuntimeFeatureFlags({ configManager }),
    runtimeBus: new RuntimeEventBus(),
    shellPaths,
    surfaceRoot,
  };
}

describe('how the registry is built', () => {
  test('the default is a plain ProviderRegistry — omitting the option changes nothing', () => {
    const stack = createProviderStack(stackOptions());
    expect(stack.providerRegistry).toBeInstanceOf(ProviderRegistry);
  });

  test('an injected factory is what actually constructs it', () => {
    const seen: ProviderRegistryConstructionOptions[] = [];
    const stack = createProviderStack({
      ...stackOptions(),
      providerRegistryFactory: (options) => { seen.push(options); return new ProviderRegistry(options); },
    });
    // The factory receives the fully-assembled option bag, which is what lets a
    // product pass createLaunchTolerantProviderRegistry without restating any of it.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.configManager).toBeTruthy();
    expect(seen[0]?.capabilityRegistry).toBe(stack.providerCapabilityRegistry);
    expect(stack.providerRegistry).toBeInstanceOf(ProviderRegistry);
  });

  test('a factory returning a subclass is respected, not replaced', () => {
    class TolerantEnough extends ProviderRegistry {}
    const stack = createProviderStack({
      ...stackOptions(),
      providerRegistryFactory: (options) => new TolerantEnough(options),
    });
    // The point of the injection: what the product built is what the stack holds.
    expect(stack.providerRegistry).toBeInstanceOf(TolerantEnough);
  });
});

describe('whether model discovery runs at construction', () => {
  function discoveryProbe() {
    const calls: string[] = [];
    class Recording extends ProviderRegistry {
      public override initProviderModelDiscovery(): void { calls.push('discovery'); }
    }
    return { calls, factory: (options: ProviderRegistryConstructionOptions) => new Recording(options) };
  }

  test('the default runs it — an omitted option is the pre-option behaviour', () => {
    const probe = discoveryProbe();
    createProviderStack({ ...stackOptions(), providerRegistryFactory: probe.factory });
    expect(probe.calls).toEqual(['discovery']);
  });

  test("'run' is the default spelled out", () => {
    const probe = discoveryProbe();
    createProviderStack({ ...stackOptions(), providerRegistryFactory: probe.factory, modelDiscovery: 'run' });
    expect(probe.calls).toEqual(['discovery']);
  });

  test("'skip' does not start the write a short-lived composition would outlive", () => {
    const probe = discoveryProbe();
    createProviderStack({ ...stackOptions(), providerRegistryFactory: probe.factory, modelDiscovery: 'skip' });
    // Skipping is a statement about this composition's lifetime, never a claim
    // that discovery is unwanted — so custom providers are still initialised.
    expect(probe.calls).toEqual([]);
  });
});

describe('whether a hook can reach the agent manager', () => {
  function compose(hookAgentManager?: 'attach' | 'withhold') {
    const root = mkdtempSync(join(tmpdir(), 'gv-floor-hooks-'));
    roots.push(root);
    const services = createClientRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'tui',
      workingDir: root,
      homeDirectory: root,
      requestApproval: async () => ({ approved: false, remember: false }),
      // Short-lived composition: do not start a write it will not outlive.
      modelDiscovery: 'skip',
      ...(hookAgentManager === undefined ? {} : { hookAgentManager }),
    });
    return services;
  }

  /** Register an agent hook and fire its event; the dispatcher's own public path. */
  async function fireAgentHook(services: ReturnType<typeof compose>): Promise<string> {
    services.hookDispatcher.register('Pre:tool:*', {
      name: 'floor-option-probe', type: 'agent', prompt: 'do a thing',
    } as never);
    await services.hookDispatcher.fire({
      path: 'Pre:tool:bash', phase: 'Pre', category: 'tool', specific: 'bash',
      sessionId: 'floor-options', timestamp: Date.now(), payload: {},
    } as never);
    // `fire` aggregates and does not surface a single hook's refusal, so the
    // per-hook result is read off the activity tracker — the same record a
    // hooks-activity view renders.
    return JSON.stringify(services.hookActivityTracker.listRecent(10));
  }

  test('the default attaches it — an agent hook is not refused for want of a runner', async () => {
    const services = compose();
    const rendered = await fireAgentHook(services);
    // The hook must actually have RUN, or the absence below proves nothing.
    expect(rendered).toContain('floor-option-probe');
    // Not asserting the hook SUCCEEDS (it would try to spawn); asserting only
    // that it is not refused for want of a runner.
    expect(rendered).not.toContain('agent hook runner is not configured');
    services.dispose();
  });

  test("'withhold' makes an agent hook refuse, by name", async () => {
    const services = compose('withhold');
    const rendered = await fireAgentHook(services);
    expect(rendered).toContain('floor-option-probe');
    // The capability boundary, observable: a hook that cannot reach the agent
    // manager cannot spawn an agent. One product pins this refusal as a feature.
    expect(rendered).toContain('agent hook runner is not configured');
    services.dispose();
  });
});
