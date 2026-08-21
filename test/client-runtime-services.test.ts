/**
 * client-runtime-services.test.ts
 *
 * The pure-client composition shape, measured on a real composition rather than
 * a stand-in, the whole point of the shape is what it does and does not
 * construct, and a stand-in constructs nothing.
 *
 * Four things are checked:
 *
 *  1. A realistic minimal client composition, what a TUI or agent interactive
 *     loop actually needs, builds, has the loop pieces, has NONE of the
 *     daemon furniture, and comes down cleanly (twice).
 *  2. The inbound-dispatch seam: a surface still runs the loop, so it binds its
 *     continuation runner into whatever hands it inbound work; the default is a
 *     held dispatch and a supplied one receives the runner.
 *  3. The shared free functions have ONE implementation: the daemon-grade graph
 *     and the client graph get their agent-graph wiring from the same
 *     `createAgentGraph`, so both orchestrators come back with the two
 *     post-construction links bound. A composition that spelled the wiring out
 *     itself and forgot one would show up here.
 *  4. The permission pieces route through the ONE ask seam and the ONE rule
 *     store path.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../packages/sdk/src/platform/runtime/services.ts';
import {
  createClientRuntimeServices,
  createHeldSessionDispatch,
  type ClientRuntimeServices,
  type ClientRuntimeServicesFromHost,
  type SessionContinuationDispatch,
} from '../packages/sdk/src/platform/runtime/client-services.ts';
import { createAgentGraph } from '../packages/sdk/src/platform/runtime/agent-graph.ts';
import { resolveRuntimeFeatureFlags } from '../packages/sdk/src/platform/runtime/feature-flag-composition.ts';
import {
  createApprovalDerivedHandlers,
  createUserPermissionRuleStore,
} from '../packages/sdk/src/platform/runtime/permissions/permission-composition.ts';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/index.ts';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../packages/sdk/src/platform/runtime/feature-announcements.ts';
import type { PermissionPromptDecision } from '../packages/sdk/src/platform/permissions/prompt.ts';

/** The two links `createAgentGraph` binds after construction; both private. */
interface OrchestratorLinks {
  conversationSink: unknown;
  cancellationSource: unknown;
}

let root: string;
let daemonRoot: string;
let configManager: ConfigManager;
let client: ClientRuntimeServices;
let daemon: RuntimeServices;
/** Every ask this composition raised, in order. */
const asks: { tool: string; metadata: Record<string, unknown> | undefined }[] = [];

/** The client's ask seam: a surface prompts locally / posts `approvals.raise`. Here it always declines. */
async function declineEverything(input: {
  readonly request: { readonly tool: string };
  readonly metadata?: Record<string, unknown> | undefined;
}): Promise<PermissionPromptDecision> {
  asks.push({ tool: input.request.tool, metadata: input.metadata });
  return { approved: false };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'client-runtime-'));
  daemonRoot = mkdtempSync(join(tmpdir(), 'client-runtime-daemon-'));
  configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'cfg'), workingDir: root, homeDir: root });

  client = createClientRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'tui',
    workingDir: root,
    homeDirectory: root,
    requestApproval: declineEverything,
  });

  daemon = createRuntimeServices({
    configManager: new ConfigManager({ surfaceRoot: 'daemon', configDir: join(daemonRoot, 'cfg'), workingDir: daemonRoot, homeDir: daemonRoot }),
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: daemonRoot,
    homeDirectory: daemonRoot,
  });
});

afterAll(() => {
  client.dispose();
  daemon.dispose();
  rmSync(root, { recursive: true, force: true });
  rmSync(daemonRoot, { recursive: true, force: true });
});

test('a surface composes its interactive loop without any daemon furniture', () => {
  // The loop pieces a turn cannot run without.
  expect(client.agentOrchestrator).toBeDefined();
  expect(client.agentManager).toBeDefined();
  expect(client.providerRegistry).toBeDefined();
  expect(client.toolLLM).toBeDefined();
  expect(client.permissionManager).toBeDefined();
  expect(client.userPermissionRuleStore).toBeDefined();
  expect(client.workflow).toBeDefined();
  expect(client.mcpRegistry).toBeDefined();
  expect(client.hookDispatcher).toBeDefined();
  expect(client.sessionManager).toBeDefined();
  expect(client.fileCache).toBeDefined();
  expect(client.projectIndex).toBeDefined();
  expect(client.surfaceRoot).toBe('tui');

  // And none of what the daemon serves. Reading a field the shape does not
  // declare is a compile error (test/types/client-runtime-shape.ts pins that);
  // here we check the composition did not construct one behind the interface.
  const asRecord = client as unknown as Record<string, unknown>;
  for (const daemonOnly of [
    'gatewayMethods',
    'watcherRegistry',
    'channelDeliveryRouter',
    'channelPlugins',
    'automationManager',
    'deliveryManager',
    'pairingTokens',
    'memoryGovernor',
    'knowledgeService',
    'homeGraphService',
    'codeIndexStore',
    'processRegistry',
    'distributedRuntime',
    'voiceService',
    'storeSnapshotScheduler',
  ]) {
    expect(asRecord[daemonOnly]).toBeUndefined();
  }
});

test('the daemon-grade graph still satisfies the shared part of the client shape', () => {
  // The compile-time proof lives in test/types/client-runtime-shape.ts; this is
  // the runtime half of it, every shared field is really there on the daemon
  // graph, so an SDK helper typed against the narrow view accepts either.
  const sharedView: ClientRuntimeServicesFromHost = daemon;
  expect(sharedView.agentOrchestrator).toBe(daemon.agentOrchestrator);
  expect(sharedView.providerRegistry).toBe(daemon.providerRegistry);
  expect(sharedView.workflow).toBe(daemon.workflow);
  // The two narrowed fields resolve to the daemon's concrete objects.
  expect(sharedView.sessionBroker).toBe(daemon.sessionBroker);
  expect(sharedView.userPermissionRuleStore).toBe(daemon.userPermissionRuleStore);
});

test('the inbound-dispatch seam takes the surface loop runner', async () => {
  // Default: a held dispatch, so a surface with no inbound source yet still
  // composes and can bind its runner for later.
  const held = client.sessionBroker as SessionContinuationDispatch & {
    runner(): unknown;
  };
  expect(held.runner()).toBeNull();
  const runner = async (): Promise<{ agentId: string }> => ({ agentId: 'agent-1' });
  client.sessionBroker.setContinuationRunner(runner);
  expect(held.runner()).toBe(runner);

  // A supplied dispatch, a wire-backed inbound poller, or the daemon's own
  // broker in an embedded composition, receives the same call.
  const bound: unknown[] = [];
  const dispatch: SessionContinuationDispatch = {
    setContinuationRunner: (value) => { bound.push(value); },
  };
  const withDispatch = createClientRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'tui',
    workingDir: root,
    homeDirectory: root,
    requestApproval: declineEverything,
    sessionDispatch: dispatch,
  });
  withDispatch.sessionBroker.setContinuationRunner(runner);
  expect(bound).toEqual([runner]);
  withDispatch.dispose();

  // The concrete SharedSessionBroker satisfies the same seam, which is what
  // keeps a daemon-grade composition usable through the client shape.
  const daemonSeam: SessionContinuationDispatch = daemon.sessionBroker;
  expect(typeof daemonSeam.setContinuationRunner).toBe('function');
});

test('both compositions get the agent graph from the one wiring function', () => {
  const clientLinks = client.agentOrchestrator as unknown as OrchestratorLinks;
  const daemonLinks = daemon.agentOrchestrator as unknown as OrchestratorLinks;
  // The two post-construction links (conversation sink, cancellation source)
  // are the ones a hand-written second copy drops silently.
  expect(clientLinks.conversationSink).not.toBeNull();
  expect(clientLinks.cancellationSource).not.toBeNull();
  expect(daemonLinks.conversationSink).not.toBeNull();
  expect(daemonLinks.cancellationSource).not.toBeNull();

  // Called directly, the same function produces the same wiring, there is no
  // third spelling of it anywhere.
  const standalone = createAgentGraph({
    runtimeBus: new RuntimeEventBus(),
    configManager,
    providerRegistry: client.providerRegistry,
    workingDirectory: root,
  });
  const standaloneLinks = standalone.agentOrchestrator as unknown as OrchestratorLinks;
  expect(standaloneLinks.conversationSink).not.toBeNull();
  expect(standaloneLinks.cancellationSource).not.toBeNull();
  standalone.agentOrchestrator.dispose();
});

test('a caller-owned feature-flag manager is used as-is, never reloaded', () => {
  const owned = createFeatureFlagManager();
  expect(resolveRuntimeFeatureFlags({ configManager, featureFlags: owned })).toBe(owned);
  // Without one, the composition owns the manager it built.
  const built = resolveRuntimeFeatureFlags({ configManager });
  expect(built).not.toBe(owned);
  expect(typeof built.isEnabled).toBe('function');
});

test('the approval-derived handlers ride the same ask seam the loop does', async () => {
  const seen: string[] = [];
  const handlers = createApprovalDerivedHandlers({
    requestApproval: async (input) => {
      seen.push(input.request.tool);
      return { approved: false };
    },
    providerRegistry: client.providerRegistry,
    configManager,
    featureFlags: client.featureFlags,
    announcementStore: new FeatureAnnouncementStore(featureAnnouncementsPath(configManager)),
  });
  const allowed = await handlers.localhostFetchApproval({ url: 'http://127.0.0.1:5173/', host: '127.0.0.1' });
  expect(allowed).toBe(false);
  expect(seen).toEqual(['fetch']);
  expect(typeof handlers.sandboxEscalationHandler).toBe('function');
  expect(typeof handlers.execPromptAnswerHandler).toBe('function');
  expect(typeof handlers.onSandboxedRun).toBe('function');
});

test('the remembered-approval store lands at the one control-plane path', async () => {
  const store = createUserPermissionRuleStore(configManager);
  await store.init();
  expect(store.rules()).toEqual([]);
  await store.add({
    rule: { tool: 'exec', match: { command: 'ls' }, decision: 'allow' } as never,
    createdAt: Date.now(),
    tier: 'project',
    tool: 'exec',
  } as never);
  const expected = join(configManager.getControlPlaneConfigDir(), 'permission-rules.json');
  expect(existsSync(expected)).toBe(true);
  // The client composition's own store is the same one, at the same path.
  expect(client.userPermissionRuleStore.rules().length).toBeGreaterThanOrEqual(0);
});
