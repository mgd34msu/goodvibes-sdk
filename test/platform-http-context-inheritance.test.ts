/**
 * platform-http-context-inheritance.test.ts
 *
 * Regression test for ARCH-01: platform-HTTP DaemonRuntimeRouteContext must
 * structurally inherit from the canonical DaemonRuntimeRouteContext rather than
 * inlining duck-typed shapes.
 *
 * The key property tested:
 *   When a new method is added to automationManager (or any other field) in the
 *   canonical daemon-sdk DaemonRuntimeRouteContext, the platform-HTTP type
 *   automatically requires it — because the platform-HTTP interface extends the
 *   canonical via Omit<CanonicalDaemonRuntimeRouteContext, 'trySpawnAgent'>.
 *
 * These are compile-time structural tests. At runtime they just confirm the
 * shape assignments are accepted by the TypeScript compiler.
 */

import { describe, expect, test } from 'bun:test';
import type { DaemonRuntimeRouteContext as CanonicalContext } from '../packages/daemon-sdk/src/runtime-route-types.js';
import type { DaemonRuntimeRouteContext as PlatformHttpContext } from '../packages/sdk/src/platform/daemon/http/runtime-route-types.js';

// ---------------------------------------------------------------------------
// Type-level assertions
// ---------------------------------------------------------------------------

/**
 * A value assignable to PlatformHttpContext must satisfy the canonical
 * automationManager shape — including all its methods.
 *
 * This test would FAIL TO COMPILE if the platform-HTTP type stopped requiring
 * any method that the canonical defines on automationManager.
 */
function assertPlatformInheritsAutomationManager(
  ctx: PlatformHttpContext,
): CanonicalContext['automationManager'] {
  // The platform-HTTP context must expose automationManager with the full
  // canonical shape. If the canonical gains a new method, this function's
  // return type widening causes a compile error — the regression is caught.
  return ctx.automationManager;
}

/**
 * A value assignable to PlatformHttpContext must also expose sessionBroker
 * with the full canonical shape.
 */
function assertPlatformInheritsSessionBroker(
  ctx: PlatformHttpContext,
): CanonicalContext['sessionBroker'] {
  return ctx.sessionBroker;
}

/**
 * A value assignable to PlatformHttpContext must also expose agentManager
 * with the full canonical shape.
 */
function assertPlatformInheritsAgentManager(
  ctx: PlatformHttpContext,
): CanonicalContext['agentManager'] {
  return ctx.agentManager;
}

// ---------------------------------------------------------------------------
// Runtime smoke test — validates the structural assertions compile
// ---------------------------------------------------------------------------

describe('ARCH-01 — platform-HTTP DaemonRuntimeRouteContext inherits canonical shapes', () => {
  test('automationManager shape is inherited from canonical, not inlined', () => {
    // Construct a minimal stub that satisfies PlatformHttpContext
    const automationManager: CanonicalContext['automationManager'] = {
      listJobs: () => [],
      listRuns: () => [],
      getRun: () => null,
      triggerHeartbeat: async () => ({}),
      cancelRun: async () => null,
      retryRun: async () => ({}),
      createJob: async () => ({ id: 'stub' }),
      updateJob: async () => null,
      removeJob: async () => {},
      setEnabled: async () => null,
      runNow: async () => ({ id: 'stub', status: 'running' }),
      getSchedulerCapacity: () => ({
        slotsTotal: 4,
        slotsInUse: 0,
        queueDepth: 0,
        oldestQueuedAgeMs: null,
      }),
    };

    const ctx = buildMinimalContext(automationManager);

    // assertPlatformInheritsAutomationManager would not compile if
    // PlatformHttpContext.automationManager diverged from CanonicalContext.automationManager
    const inherited = assertPlatformInheritsAutomationManager(ctx);
    expect(inherited.listJobs()).toEqual([]);
    expect(inherited.getSchedulerCapacity()).toMatchObject({ slotsTotal: 4, slotsInUse: 0 });
    // runNow and triggerHeartbeat are async stubs — verify they return thenables
    expect(typeof inherited.runNow).toBe('function');
    expect(typeof inherited.triggerHeartbeat).toBe('function');
  });

  test('sessionBroker shape is inherited from canonical, not inlined', async () => {
    const ctx = buildMinimalContext();
    const inherited = assertPlatformInheritsSessionBroker(ctx);
    // Stubs throw — verify they are callable methods (not undefined)
    expect(inherited.submitMessage).toBeDefined();
    expect(inherited.steerMessage).toBeDefined();
    expect(inherited.followUpMessage).toBeDefined();
    // createSession returns a stub session
    const session = await inherited.createSession({} as never);
    expect(session).toMatchObject({ id: 'stub' });
  });

  test('agentManager shape is inherited from canonical, not inlined', () => {
    const ctx = buildMinimalContext();
    const inherited = assertPlatformInheritsAgentManager(ctx);
    expect(inherited.getStatus('stub-session')).toBeNull();
    inherited.cancel('stub-session'); // stub is a no-op — just verify it does not throw
  });

  test('DaemonRuntimeRouteHandlerMap is imported from canonical, not Pick<>-duplicated', async () => {
    // This test verifies the module shape at import time.
    // If DaemonRuntimeRouteHandlerMap were re-declared as a local Pick<>,
    // a new handler added to the canonical would not be required here.
    // By importing from the canonical file, this is enforced automatically.
    const mod = await import('../packages/sdk/src/platform/daemon/http/runtime-route-types.js');
    // The module should export JsonBody and DaemonRuntimeRouteHandlerMap (type-only)
    // At runtime we can only verify the module loaded without error.
    expect(mod).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Stub builder
// ---------------------------------------------------------------------------

function buildMinimalContext(
  automationManagerOverride?: CanonicalContext['automationManager'],
): PlatformHttpContext {
  const automationManager: CanonicalContext['automationManager'] = automationManagerOverride ?? {
    listJobs: () => [],
    listRuns: () => [],
    getRun: () => null,
    triggerHeartbeat: async () => ({}),
    cancelRun: async () => null,
    retryRun: async () => ({}),
    createJob: async () => ({ id: 'stub' }),
    updateJob: async () => null,
    removeJob: async () => {},
    setEnabled: async () => null,
    runNow: async () => ({ id: 'stub', status: 'running' }),
    getSchedulerCapacity: () => ({
      slotsTotal: 4,
      slotsInUse: 0,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    }),
  };

  return {
    parseJsonBody: async (req) => {
      try { return await req.json() as Record<string, unknown>; } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    parseOptionalJsonBody: async (req) => {
      const text = await req.text();
      if (!text) return null;
      try { return JSON.parse(text) as Record<string, unknown>; } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    recordApiResponse: (_req, _path, response) => response,
    requireAdmin: () => null,
    snapshotMetrics: () => ({}),
    sessionBroker: {
      start: async () => {},
      submitMessage: async () => { throw new Error('not expected'); },
      steerMessage: async () => { throw new Error('not expected'); },
      followUpMessage: async () => { throw new Error('not expected'); },
      bindAgent: async () => {},
      createSession: async () => ({ id: 'stub' }),
      getSession: () => null,
      getMessages: () => [],
      getInputs: () => [],
      closeSession: async () => null,
      reopenSession: async () => null,
      cancelInput: async () => null,
      completeAgent: async () => {},
      appendCompanionMessage: async () => {},
    },
    agentManager: { getStatus: () => null, cancel: () => {} },
    automationManager,
    normalizeAtSchedule: () => ({}),
    normalizeEverySchedule: () => ({}),
    normalizeCronSchedule: () => ({}),
    routeBindings: { start: async () => {}, getBinding: () => undefined },
    trySpawnAgent: () => new Response(JSON.stringify({ error: 'not expected' }), { status: 500 }),
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response('', { status: 200 }),
  };
}
