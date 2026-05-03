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
      expect(delivered[0]).toContain('Agent completed in 5ms');
      expect(delivered[0]).not.toContain('child done');
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
        createdAt: Date.now(),
        routeId: 'route-1',
      });

      emitAgentCompleted(runtimeBus, {
        sessionId: 'agent-manager',
        traceId: 'test:complete-root',
        source: 'test',
      }, {
        agentId: 'agent-root',
        durationMs: 5,
        output: 'raw root output that should not be sent to ntfy',
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply'));
      expect(delivered[0]?.message).toContain('Agent completed in 5ms');
      expect(delivered[0]?.message).not.toContain('raw root output');
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

      await waitFor(() => delivered.some((entry) => entry.kind === 'progress' && entry.message.includes('WRFC review needs fixes')));

      emitWorkflowChainPassed(runtimeBus, {
        sessionId: 'wrfc',
        traceId: 'test:passed',
        source: 'test',
      }, {
        chainId: 'chain-1',
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply' && entry.message.includes('WRFC chain chain-1 passed')));
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
        createdAt: Date.now(),
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

      await waitFor(() => delivered.some((message) => message.includes('WRFC chain chain-2 started')));
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
          fullOutput: 'raw completed output that should not be sent',
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

      expect(delivered[0]?.message).toContain('finished initial work');
      expect(delivered[0]?.message).not.toContain('raw completed output');
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

      await waitFor(() => delivered.some((entry) => entry.kind === 'progress' && entry.message.includes('WRFC review passed')));
      expect(pipeline.has('agent-root')).toBe(true);

      emitWorkflowChainPassed(runtimeBus, {
        sessionId: 'wrfc',
        traceId: 'test:passed-after-poll',
        source: 'test',
      }, {
        chainId: 'chain-1',
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply' && entry.message.includes('WRFC chain chain-1 passed')));
      expect(pipeline.has('agent-root')).toBe(false);
    } finally {
      pipeline.dispose();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
