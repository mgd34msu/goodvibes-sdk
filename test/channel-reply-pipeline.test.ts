import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../packages/sdk/src/platform/channels/plugin-registry.js';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.js';
import { DaemonSurfaceDeliveryHelper } from '../packages/sdk/src/platform/daemon/surface-delivery.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentSpawning } from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import {
  emitWorkflowChainCreated,
  emitWorkflowChainPassed,
  emitWorkflowReviewCompleted,
} from '../packages/sdk/src/platform/runtime/emitters/workflows.js';
import { waitFor } from './_helpers/test-timeout.js';

describe('ChannelReplyPipeline', () => {
  test('routes child-agent completion status to the parent ntfy reply target', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: string[] = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverReply: async (_pending, message) => {
        delivered.push(message);
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
    });

    try {
      pipeline.trackPending({
        agentId: 'agent-parent',
        surfaceKind: 'ntfy',
        task: 'parent task',
        createdAt: Date.now(),
        routeId: 'route-1',
      });

      emitAgentSpawning(runtimeBus, {
        sessionId: 'agent-manager',
        traceId: 'test:spawn-child',
        source: 'test',
      }, {
        agentId: 'agent-child',
        parentAgentId: 'agent-parent',
        task: 'child task',
      });
      emitAgentCompleted(runtimeBus, {
        sessionId: 'agent-manager',
        traceId: 'test:complete-child',
        source: 'test',
      }, {
        agentId: 'agent-child',
        durationMs: 5,
        output: 'child done',
      });

      await waitFor(() => delivered.length === 1);
      // The answer is the point of the notification, on ntfy as anywhere else,
      // and it is the WHOLE notification. How long the run took is operator
      // telemetry that no channel user receives.
      expect(delivered[0]).toContain('child done');
      expect(delivered[0]).not.toContain('Agent completed in');
      expect(pipeline.has('agent-child')).toBe(false);
      expect(pipeline.has('agent-parent')).toBe(true);
    } finally {
      pipeline.dispose();
    }
  });

  test('keeps ntfy WRFC replies active for workflow progress after the root agent completes', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: Array<{ kind: 'reply' | 'progress'; message: string }> = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverReply: async (_pending, message) => {
        delivered.push({ kind: 'reply', message });
      },
      deliverProgress: async (_pending, message) => {
        delivered.push({ kind: 'progress', message });
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
    });

    try {
      pipeline.trackPending({
        agentId: 'agent-root',
        surfaceKind: 'ntfy',
        task: 'phone task',
        agentTask: 'expanded WRFC task',
        workflowChainId: 'chain-1',
        // A minute in: old enough that the chain's later legs may notify.
        createdAt: Date.now() - 60_000,
        routeId: 'route-1',
      });

      emitAgentCompleted(runtimeBus, {
        sessionId: 'agent-manager',
        traceId: 'test:complete-root',
        source: 'test',
      }, {
        agentId: 'agent-root',
        durationMs: 5,
        output: 'root output the owner asked for',
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply'));
      expect(delivered[0]?.message).toContain('root output the owner asked for');
      expect(delivered[0]?.message).not.toContain('Agent completed in');
      expect(pipeline.has('agent-root')).toBe(true);

      emitWorkflowReviewCompleted(runtimeBus, {
        sessionId: 'wrfc',
        traceId: 'test:review',
        source: 'test',
      }, {
        chainId: 'chain-1',
        score: 6,
        passed: false,
      });

      // Plain words, and no chain id: the line names the outcome, not the machinery.
      await waitFor(() => delivered.some((entry) => entry.kind === 'progress' && entry.message.includes('found things to fix')));

      emitWorkflowChainPassed(runtimeBus, {
        sessionId: 'wrfc',
        traceId: 'test:passed',
        source: 'test',
      }, {
        chainId: 'chain-1',
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply' && entry.message.includes('is done')));
      // The id this run correlated on never reaches the reader.
      expect(delivered.every((entry) => !entry.message.includes('chain-1'))).toBe(true);
      expect(pipeline.has('agent-root')).toBe(false);
    } finally {
      pipeline.dispose();
    }
  });

  test('associates WRFC workflow replies by agent task when the chain-created event is observed after tracking', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: string[] = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverProgress: async (_pending, message) => {
        delivered.push(message);
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
    });

    try {
      pipeline.trackPending({
        agentId: 'agent-root',
        surfaceKind: 'ntfy',
        task: 'phone task',
        agentTask: 'expanded WRFC task',
        // A minute in. Progress notifications are withheld below the
        // MIN_PROGRESS_NOTIFICATION_AGE_MS floor, and a WRFC chain opening on a
        // run this old is exactly the case the floor is meant to let through.
        createdAt: Date.now() - 60_000,
        routeId: 'route-1',
      });

      emitWorkflowChainCreated(runtimeBus, {
        sessionId: 'wrfc',
        traceId: 'test:created',
        source: 'test',
      }, {
        chainId: 'chain-2',
        task: 'expanded WRFC task',
      });

      await waitFor(() => delivered.some((message) => message.includes('Started work on: expanded WRFC task')));
      expect(delivered.every((message) => !message.includes('chain-2'))).toBe(true);
      expect(pipeline.getPending('agent-root')?.workflowChainId).toBe('chain-2');
    } finally {
      pipeline.dispose();
    }
  });

  test('daemon ntfy polling keeps WRFC reply tracking alive after the root agent completes', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: Array<{ kind: 'reply' | 'progress'; message: string }> = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverReply: async (_pending, message) => {
        delivered.push({ kind: 'reply', message });
      },
      deliverProgress: async (_pending, message) => {
        delivered.push({ kind: 'progress', message });
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
      // The helper stamps `createdAt` itself, so the clock is what moves: the
      // chain's review lands a minute into the run, past the floor below which
      // no progress notification is warranted.
      now: () => Date.now() + 60_000,
    });
    const pendingSurfaceReplies = new Map();
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies,
      channelReplyPipeline: pipeline,
      configManager: { get: () => '' },
      serviceRegistry: { resolveSecret: async () => null },
      agentManager: {
        getStatus: () => ({
          id: 'agent-root',
          status: 'completed',
          task: 'expanded WRFC task',
          fullOutput: 'The duplicate header read is gone and the parser tests pass.',
          tools: [],
          startedAt: Date.now(),
          wrfcId: 'chain-1',
        }),
      },
      sessionBroker: { completeAgent: async () => null },
      routeBindings: {},
      channelPlugins,
      authToken: () => null,
      surfaceDeliveryEnabled: () => true,
    } as unknown as ConstructorParameters<typeof DaemonSurfaceDeliveryHelper>[0]);

    try {
      helper.queueSurfaceReplyFromBinding({
        id: 'route-1',
        surfaceKind: 'ntfy',
        surfaceId: 'ntfy',
        externalId: 'goodvibes-agent',
        channelId: 'goodvibes-agent',
        metadata: {},
      } as never, {
        agentId: 'agent-root',
        task: 'phone task',
        agentTask: 'expanded WRFC task',
        workflowChainId: 'chain-1',
        sessionId: 'session-1',
      });

      await helper.pollPendingSurfaceReplies(() => {});

      // ntfy renders what every other surface renders: the agent's answer.
      // This used to assert the opposite, that the output was withheld and a
      // canned "Agent <id> finished initial work" line went out in its place,
      // which is how the owner's primary surface came to deliver everything
      // except the reply. Tracking still stays alive for the chain's later legs.
      expect(delivered[0]?.message).toContain('The duplicate header read is gone');
      expect(delivered[0]?.message).not.toContain('finished initial work');
      expect(pipeline.has('agent-root')).toBe(true);

      emitWorkflowReviewCompleted(runtimeBus, {
        sessionId: 'wrfc',
        traceId: 'test:review-after-poll',
        source: 'test',
      }, {
        chainId: 'chain-1',
        score: 9,
        passed: true,
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'progress' && entry.message.includes('Review of') && entry.message.includes('passed')));
      expect(pipeline.has('agent-root')).toBe(true);

      emitWorkflowChainPassed(runtimeBus, {
        sessionId: 'wrfc',
        traceId: 'test:passed-after-poll',
        source: 'test',
      }, {
        chainId: 'chain-1',
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply' && entry.message.includes('is done')));
      expect(delivered.every((entry) => !entry.message.includes('chain-1'))).toBe(true);
      expect(pipeline.has('agent-root')).toBe(false);
    } finally {
      pipeline.dispose();
    }
  });
});
