/**
 * The owner's actual symptom: every Telegram exchange stored TWICE.
 *
 * A throwing surface delivery escaped `deliverFinal` before `untrack(agentId)`,
 * so the agent stayed tracked; the pending-reply poller then treated the already
 * completed agent as unhandled, called `completeAgent` a second time, and
 * appended the same assistant answer to the shared session again.
 *
 * These tests assert the STORE, not just the calls — the duplicate rows in
 * sessions.json are the thing the owner saw — plus the ledger and log behaviour
 * that makes a dropped reply visible instead of silent.
 *
 * Surface choice is deliberate: telegram/slack, never ntfy. The ntfy render
 * rules and the delta watermark are being changed concurrently, and nothing here
 * should pin them.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPluginRegistry } from '../packages/sdk/src/platform/channels/plugin-registry.js';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.js';
import {
  DaemonSurfaceDeliveryHelper,
  type SurfaceDeliveryLedgerEntry,
} from '../packages/sdk/src/platform/daemon/surface-delivery.js';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.js';
import type { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.js';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.js';
import type { PendingSurfaceReply } from '../packages/sdk/src/platform/daemon/types.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

type LogCall = { readonly level: 'error' | 'warn'; readonly message: string; readonly data: Record<string, unknown> };

/** Capture logger.error/logger.warn for the duration of `run`, then restore. */
async function captureLogs(run: () => Promise<void>): Promise<LogCall[]> {
  const calls: LogCall[] = [];
  const originalError = logger.error.bind(logger);
  const originalWarn = logger.warn.bind(logger);
  logger.error = (message: string, data?: Record<string, unknown>): void => {
    calls.push({ level: 'error', message, data: data ?? {} });
  };
  logger.warn = (message: string, data?: Record<string, unknown>): void => {
    calls.push({ level: 'warn', message, data: data ?? {} });
  };
  try {
    await run();
  } finally {
    logger.error = originalError;
    logger.warn = originalWarn;
  }
  return calls;
}

function telegramBinding(overrides: Partial<AutomationRouteBinding> = {}): AutomationRouteBinding {
  const now = Date.now();
  return {
    id: 'route-telegram-1',
    kind: 'conversation',
    surfaceKind: 'telegram',
    surfaceId: 'telegram',
    externalId: 'chat-9001',
    channelId: 'chat-9001',
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  } as AutomationRouteBinding;
}

function routeBindingsStub(bindings: readonly AutomationRouteBinding[]): RouteBindingManager {
  return {
    start: async () => {},
    stop: async () => {},
    list: () => [...bindings],
    find: () => null,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    getBinding: (id: string) => bindings.find((b) => b.id === id) ?? null,
    captureReplyTarget: async () => {},
  } as unknown as RouteBindingManager;
}

interface Harness {
  readonly pipeline: ChannelReplyPipeline;
  readonly helper: DaemonSurfaceDeliveryHelper;
  readonly broker: SharedSessionBroker;
  readonly ledger: SurfaceDeliveryLedgerEntry[];
  readonly delivered: string[];
  readonly pendingSurfaceReplies: Map<string, PendingSurfaceReply>;
  readonly storePath: string;
  readonly agentStatus: { current: { id: string; status: string; fullOutput?: string; error?: string } | null };
}

/**
 * A real broker over a real on-disk store, a real reply pipeline, and a channel
 * plugin whose delivery can be made to throw. Only the agent manager and the
 * route bindings are stubs.
 */
function makeHarness(options: { readonly deliverReplyThrows: boolean }): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gv-surface-reply-'));
  const storePath = join(dir, 'sessions.json');
  const binding = telegramBinding();
  const routeBindings = routeBindingsStub([binding]);
  const delivered: string[] = [];
  const channelPlugins = new ChannelPluginRegistry();
  channelPlugins.register({
    id: 'telegram-test',
    surface: 'telegram',
    displayName: 'telegram',
    capabilities: ['egress'],
    deliverReply: async (_pending, message) => {
      if (options.deliverReplyThrows) {
        throw new Error('telegram 429: too many requests');
      }
      delivered.push(message);
    },
    deliverProgress: async () => {},
  });

  const ledger: SurfaceDeliveryLedgerEntry[] = [];
  const pendingSurfaceReplies = new Map<string, PendingSurfaceReply>();
  const agentStatus: Harness['agentStatus'] = { current: null };

  const broker = new SharedSessionBroker({
    storePath,
    routeBindings,
    agentStatusProvider: { getStatus: () => agentStatus.current as never },
    messageSender: { send: () => false },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);

  const pipeline = new ChannelReplyPipeline({ channelPlugins, routeBindings });
  const helper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies,
    channelReplyPipeline: pipeline,
    configManager: { get: () => undefined } as never,
    serviceRegistry: { resolveSecret: async () => null } as never,
    agentManager: { getStatus: () => agentStatus.current } as never,
    sessionBroker: broker,
    routeBindings,
    channelPlugins,
    authToken: () => null,
    surfaceDeliveryEnabled: () => true,
    recordDeliveryAttempt: (entry) => ledger.push(entry),
  } as never);

  pipeline.setUndeliveredReporter((reply) => helper.recordUndeliveredReply(reply));
  pipeline.setDeliveredReporter((reply) => helper.recordDeliveredReply(reply));

  return { pipeline, helper, broker, ledger, delivered, pendingSurfaceReplies, storePath, agentStatus };
}

/** Assistant/system rows stored for `agentId`, read back off disk. */
function storedAgentMessages(storePath: string, agentId: string): Array<Record<string, unknown>> {
  const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as {
    messages?: Record<string, Array<Record<string, unknown>>>;
  };
  const buckets = Object.values(raw.messages ?? {});
  return buckets
    .flat()
    .filter((message) => message.agentId === agentId && (message.role === 'assistant' || message.role === 'system'));
}

describe('a throwing surface delivery is not allowed to duplicate the stored answer', () => {
  test('deliverFinal untracks the agent even when the surface send throws', async () => {
    const harness = makeHarness({ deliverReplyThrows: true });
    try {
      harness.pipeline.trackPending({
        agentId: 'agent-1',
        surfaceKind: 'telegram',
        task: 'what is the status',
        createdAt: Date.now(),
        sessionId: 'session-1',
        routeId: 'route-telegram-1',
      });
      expect(harness.pipeline.has('agent-1')).toBe(true);

      const logs = await captureLogs(async () => {
        // The send fails, and the failure must not escape as a rejection either:
        // an escaping throw is exactly what skipped the untrack below.
        const result = await harness.pipeline.deliverFinal('agent-1', 'the answer');
        expect(result).toBeNull();
      });

      expect(harness.pipeline.has('agent-1')).toBe(false);
      const errors = logs.filter((call) => call.level === 'error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.data.surface).toBe('telegram');
      expect(errors[0]?.data.agentId).toBe('agent-1');
      expect(errors[0]?.data.sessionId).toBe('session-1');
      expect(errors[0]?.data.bindingId).toBe('route-telegram-1');
      expect(String(errors[0]?.data.reason)).toContain('429');
    } finally {
      harness.pipeline.dispose();
    }
  });

  test('the poller stores exactly ONE assistant message when the delivery throws', async () => {
    const harness = makeHarness({ deliverReplyThrows: true });
    try {
      const session = await harness.broker.createSession({ id: 'session-dup' });
      expect(session.id).toBe('session-dup');

      harness.helper.queueSurfaceReplyFromBinding(telegramBinding(), {
        agentId: 'agent-dup',
        task: 'what is the status',
        sessionId: 'session-dup',
      });
      harness.agentStatus.current = { id: 'agent-dup', status: 'completed', fullOutput: 'the one and only answer' };

      await captureLogs(async () => {
        // Poll twice. The second pass is the re-completion that produced the
        // duplicate row: before the fix the agent was still tracked, so this
        // pass called completeAgent again and appended the same answer.
        await harness.helper.pollPendingSurfaceReplies(() => {});
        await harness.helper.pollPendingSurfaceReplies(() => {});
      });

      const stored = storedAgentMessages(harness.storePath, 'agent-dup');
      expect(stored.length).toBe(1);
      expect(String(stored[0]?.body)).toContain('the one and only answer');
      // And the pending entry is gone, so a third pass cannot resurrect it.
      expect(harness.pendingSurfaceReplies.has('agent-dup')).toBe(false);
    } finally {
      harness.pipeline.dispose();
    }
  });

  test('the poller does not re-complete an agent whose delivery already threw', async () => {
    const harness = makeHarness({ deliverReplyThrows: true });
    try {
      await harness.broker.createSession({ id: 'session-once' });
      const completions: string[] = [];
      const realCompleteAgent = harness.broker.completeAgent.bind(harness.broker);
      harness.broker.completeAgent = (async (sessionId, agentId, body, metadata) => {
        completions.push(agentId);
        return realCompleteAgent(sessionId, agentId, body, metadata);
      }) as typeof harness.broker.completeAgent;

      harness.helper.queueSurfaceReplyFromBinding(telegramBinding(), {
        agentId: 'agent-once',
        task: 'status',
        sessionId: 'session-once',
      });
      harness.agentStatus.current = { id: 'agent-once', status: 'completed', fullOutput: 'done' };

      await captureLogs(async () => {
        await harness.helper.pollPendingSurfaceReplies(() => {});
        await harness.helper.pollPendingSurfaceReplies(() => {});
        await harness.helper.pollPendingSurfaceReplies(() => {});
      });

      expect(completions).toEqual(['agent-once']);
    } finally {
      harness.pipeline.dispose();
    }
  });

  test('a delivery that succeeds also stores exactly one assistant message', async () => {
    const harness = makeHarness({ deliverReplyThrows: false });
    try {
      await harness.broker.createSession({ id: 'session-ok' });
      harness.helper.queueSurfaceReplyFromBinding(telegramBinding(), {
        agentId: 'agent-ok',
        task: 'status',
        sessionId: 'session-ok',
      });
      harness.agentStatus.current = { id: 'agent-ok', status: 'completed', fullOutput: 'delivered answer' };

      await harness.helper.pollPendingSurfaceReplies(() => {});
      await harness.helper.pollPendingSurfaceReplies(() => {});

      expect(storedAgentMessages(harness.storePath, 'agent-ok').length).toBe(1);
      expect(harness.delivered.length).toBe(1);
    } finally {
      harness.pipeline.dispose();
    }
  });
});

describe('queueSurfaceReplyFromBinding is idempotent by agent id', () => {
  test('a second call sends nothing extra and does not reset the buffer', async () => {
    const harness = makeHarness({ deliverReplyThrows: false });
    try {
      const binding = telegramBinding();
      expect(harness.helper.queueSurfaceReplyFromBinding(binding, {
        agentId: 'agent-idem',
        task: 'first',
        sessionId: 'session-idem',
      })).toBe(true);
      const first = harness.pendingSurfaceReplies.get('agent-idem');

      // The broker announces the pairing centrally AND the adapter that spawned
      // the agent asks for it. Re-tracking would reset the pipeline's event
      // buffer and republish everything already sent.
      expect(harness.helper.queueSurfaceReplyFromBinding(binding, {
        agentId: 'agent-idem',
        task: 'second',
        sessionId: 'session-idem',
      })).toBe(true);

      expect(harness.pendingSurfaceReplies.size).toBe(1);
      expect(harness.pendingSurfaceReplies.get('agent-idem')).toBe(first!);
      expect(harness.pendingSurfaceReplies.get('agent-idem')?.task).toBe('first');
      // One queued ledger entry, not two.
      expect(harness.ledger.filter((entry) => entry.phase === 'queued').length).toBe(1);
      // And the pipeline still holds the ORIGINAL pending record.
      expect(harness.pipeline.getPending('agent-idem')?.task).toBe('first');

      await harness.pipeline.deliverFinal('agent-idem', 'answer');
      expect(harness.delivered.length).toBe(1);
    } finally {
      harness.pipeline.dispose();
    }
  });
});

describe('surface replies land in the deliveries ledger', () => {
  test('a delivered reply is queued then succeeded', async () => {
    const harness = makeHarness({ deliverReplyThrows: false });
    try {
      harness.helper.queueSurfaceReplyFromBinding(telegramBinding(), {
        agentId: 'agent-led-ok',
        task: 'status',
        sessionId: 'session-led-ok',
      });
      await harness.pipeline.deliverFinal('agent-led-ok', 'the answer');

      const mine = harness.ledger.filter((entry) => entry.agentId === 'agent-led-ok');
      expect(mine.map((entry) => entry.phase)).toEqual(['queued', 'succeeded']);
      for (const entry of mine) {
        expect(entry.deliveryId).toBe('surface-reply:agent-led-ok');
        expect(entry.surfaceKind).toBe('telegram');
        expect(entry.routeId).toBe('route-telegram-1');
        expect(entry.targetId).toBe('chat-9001');
      }
    } finally {
      harness.pipeline.dispose();
    }
  });

  test('an undelivered reply is queued then failed, carrying the reason', async () => {
    const harness = makeHarness({ deliverReplyThrows: true });
    try {
      harness.helper.queueSurfaceReplyFromBinding(telegramBinding(), {
        agentId: 'agent-led-bad',
        task: 'status',
        sessionId: 'session-led-bad',
      });
      await captureLogs(async () => {
        await harness.pipeline.deliverFinal('agent-led-bad', 'the answer');
      });

      const mine = harness.ledger.filter((entry) => entry.agentId === 'agent-led-bad');
      expect(mine.map((entry) => entry.phase)).toEqual(['queued', 'failed']);
      expect(String(mine[1]?.error)).toContain('429');
      expect(mine[1]?.sessionId).toBe('session-led-bad');
      expect(mine[1]?.surfaceKind).toBe('telegram');
    } finally {
      harness.pipeline.dispose();
    }
  });
});

describe('a channel message that cannot resolve a binding is never silent', () => {
  test('ensureSurfaceReply logs at ERROR with surface, session, binding and reason, and writes a failed ledger entry', async () => {
    const harness = makeHarness({ deliverReplyThrows: false });
    try {
      let accepted = true;
      const logs = await captureLogs(async () => {
        accepted = harness.helper.ensureSurfaceReply({
          sessionId: 'session-unbound',
          agentId: 'agent-unbound',
          routeId: 'route-that-does-not-exist',
          surfaceKind: 'telegram',
          task: 'answer me',
          reason: 'continued-live',
        });
      });

      expect(accepted).toBe(false);
      const errors = logs.filter((call) => call.level === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0]?.data.surface).toBe('telegram');
      expect(errors[0]?.data.sessionId).toBe('session-unbound');
      expect(errors[0]?.data.agentId).toBe('agent-unbound');
      expect(errors[0]?.data.bindingId).toBe('route-that-does-not-exist');
      expect(errors[0]?.data.reason).toBe('no-route-binding');
      expect(errors[0]?.data.pairedBy).toBe('continued-live');

      const mine = harness.ledger.filter((entry) => entry.agentId === 'agent-unbound');
      expect(mine.length).toBe(1);
      expect(mine[0]?.phase).toBe('failed');
      expect(String(mine[0]?.error)).toContain('no-route-binding');
      expect(mine[0]?.surfaceKind).toBe('telegram');
    } finally {
      harness.pipeline.dispose();
    }
  });

  test('a resolvable binding announced by the broker does create the reply', async () => {
    const harness = makeHarness({ deliverReplyThrows: false });
    try {
      const accepted = harness.helper.ensureSurfaceReply({
        sessionId: 'session-bound',
        agentId: 'agent-bound',
        routeId: 'route-telegram-1',
        surfaceKind: 'telegram',
        task: 'answer me',
        reason: 'continued-live',
      });
      expect(accepted).toBe(true);
      expect(harness.pendingSurfaceReplies.has('agent-bound')).toBe(true);
      expect(harness.ledger.some((entry) => entry.agentId === 'agent-bound' && entry.phase === 'queued')).toBe(true);
    } finally {
      harness.pipeline.dispose();
    }
  });
});
