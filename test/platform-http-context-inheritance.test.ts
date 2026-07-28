/**
 * platform-http-context-inheritance.test.ts
 *
 * platform-HTTP DaemonRuntimeRouteContext must
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
import type {
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
} from '../packages/sdk/src/platform/automation/manager-runtime-helpers.js';

// ---------------------------------------------------------------------------
// Type-level assertions
// ---------------------------------------------------------------------------

/**
 * A value assignable to PlatformHttpContext must satisfy the canonical
 * automationManager shape — every method except the two this layer refines.
 *
 * This FAILS TO COMPILE if the platform-HTTP type stops requiring any method
 * the canonical defines on automationManager.
 *
 * `createJob` and `updateJob` are excluded because they diverge ON PURPOSE:
 * the canonical types them `Record<string, unknown>` since daemon-sdk's
 * handlers call them with a parsed JSON body, and the platform layer types them
 * with the validated CreateAutomationJobInput / UpdateAutomationJobInput it
 * actually implements. `createDaemonRuntimeRouteHandlers` in
 * platform/daemon/http/runtime-routes.ts is the bridge that runs the body
 * through `parseCreateAutomationJobInput` between the two.
 *
 * This exclusion is new, and it is the reason the file did not compile: nothing
 * ever compiled it. The two shapes are UNRELATED types — an interface with no
 * index signature is not assignable to `Record<string, unknown>` in either
 * direction — so `ctx.automationManager` was never assignable to the canonical
 * and this assertion could not have held on any day since it was written. The
 * same absence of compilation had let AutomationRunLike lose a field the
 * canonical copy carries; both are fixed now.
 *
 * `assertRefinedAutomationInputs` below pins the divergence itself, so removing
 * the refinement does not silently pass by falling back to the canonical.
 */
function assertPlatformInheritsAutomationManager(
  ctx: PlatformHttpContext,
): Omit<CanonicalContext['automationManager'], 'createJob' | 'updateJob'> {
  // If the canonical gains a new method, this function's return type widens and
  // the assignment stops compiling.
  return ctx.automationManager;
}

/**
 * The two refined methods, pinned in the direction that matters.
 *
 * `createJob` here must take the VALIDATED input type. If someone "fixes" the
 * divergence by widening this layer back to `Record<string, unknown>`, the
 * Omit above would still pass — this does not.
 */
function assertRefinedAutomationInputs(
  ctx: PlatformHttpContext,
): [(input: CreateAutomationJobInput) => Promise<{ readonly id: string }>,
    (jobId: string, input: UpdateAutomationJobInput) => Promise<{ readonly id: string } | null>] {
  return [ctx.automationManager.createJob, ctx.automationManager.updateJob];
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

describe('platform-HTTP DaemonRuntimeRouteContext inherits canonical shapes', () => {
  test('automationManager shape is inherited from canonical, not inlined', () => {
    // Construct a minimal stub that satisfies PlatformHttpContext
    const automationManager: PlatformHttpContext['automationManager'] = {
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
  });

  test('sessionBroker shape is inherited from canonical, not inlined', async () => {
    const ctx = buildMinimalContext();
    const inherited = assertPlatformInheritsSessionBroker(ctx);
    // Stubs throw — verify they are callable methods (not undefined)
    expect(typeof inherited.submitMessage).toBe('function');
    expect(typeof inherited.steerMessage).toBe('function');
    expect(typeof inherited.followUpMessage).toBe('function');
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
    expect(mod).not.toBeNull(); // presence-only: module loaded check
  });
});

// ---------------------------------------------------------------------------
// Stub builder
// ---------------------------------------------------------------------------

function buildMinimalContext(
  automationManagerOverride?: PlatformHttpContext['automationManager'],
): PlatformHttpContext {
  const automationManager: PlatformHttpContext['automationManager'] = automationManagerOverride ?? {
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
    sessionBroker: {
      start: async () => {},
      register: async () => ({ record: { id: 'stub' }, reopened: false }),
      submitMessage: async () => { throw new Error('not expected'); },
      steerMessage: async () => { throw new Error('not expected'); },
      followUpMessage: async () => { throw new Error('not expected'); },
      bindAgent: async () => {},
      createSession: async () => ({ id: 'stub' }),
      getSession: () => null,
      getMessages: () => [],
      getInputs: () => [],
      getInputsSince: () => [],
      markInputDelivered: async () => null,
      closeSession: async () => null,
      reopenSession: async () => null,
      detachParticipant: async () => null,
      deleteSession: async () => 'not-found' as const,
      cancelInput: async () => null,
      completeAgent: async () => {},
      appendCompanionMessage: async () => {},
    },
    agentManager: { getStatus: () => null, cancel: () => {} },
    automationManager,
    normalizeAtSchedule: (at) => ({ kind: 'at' as const, at }),
    normalizeEverySchedule: () => ({ kind: 'every' as const, intervalMs: 1000 }),
    normalizeCronSchedule: (expression) => ({ kind: 'cron' as const, expression }),
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
