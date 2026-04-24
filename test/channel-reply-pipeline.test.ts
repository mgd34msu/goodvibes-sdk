import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../packages/sdk/src/_internal/platform/channels/plugin-registry.js';
import { ChannelReplyPipeline } from '../packages/sdk/src/_internal/platform/channels/reply-pipeline.js';
import { RuntimeEventBus } from '../packages/sdk/src/_internal/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentSpawning } from '../packages/sdk/src/_internal/platform/runtime/emitters/agents.js';

describe('ChannelReplyPipeline', () => {
  test('routes child-agent final output to the parent surface reply target', async () => {
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
      expect(delivered[0]).toContain('child done');
      expect(pipeline.has('agent-child')).toBe(false);
      expect(pipeline.has('agent-parent')).toBe(true);
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
