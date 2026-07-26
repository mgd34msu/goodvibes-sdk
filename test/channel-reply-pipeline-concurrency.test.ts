/**
 * The notification watermark race, observed live against a real daemon.
 *
 * One trivial message produced FOUR notifications, three of them strict
 * supersets of an earlier one:
 *
 *   [2] 'Turn 1 · exec — ls'
 *   [3] 'Turn 1 · exec — echo $((5 + 3))\nTurn 1 · Thinking…'
 *   [4] 'Turn 1 · exec — ls\nTurn 1 · exec — echo $((5 + 3))'
 *
 * The single-call delta was already correct. What was wrong was the
 * interleaving: `deliverProgress` selected the undelivered events, awaited the
 * network dispatch, and only marked them delivered AFTER it returned. Two
 * callers reach this concurrently by design — `handleEnvelope` on every bus
 * event, and the daemon's pending-reply poller (daemon/surface-delivery.ts)
 * on its own tick — so both read the same unmarked watermark and each selected
 * everything the other was already sending. `deliverFinal` had the same shape.
 *
 * A fast dispatch hides this completely: the window is the duration of one
 * HTTP request. These tests inject a slow one, which makes the ladder
 * deterministic — this file fails on the unfixed pipeline and passes on the
 * fixed one.
 */
import { describe, expect, test } from 'bun:test';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentProgress } from '../packages/sdk/src/platform/runtime/emitters/agents.js';

const DISPATCH_MS = 60;

interface Published {
  readonly phase: string;
  readonly text: string;
}

function harness(surfaceKind: string, dispatchMs = DISPATCH_MS) {
  const published: Published[] = [];
  let inFlight = 0;
  let maxConcurrentDispatches = 0;
  let now = 3_000_000;
  const bus = new RuntimeEventBus();
  const channelPlugins = {
    getRenderPolicy: async () => null,
    render: async (_surface: string, request: { phase: string; text: string }) => {
      inFlight += 1;
      if (inFlight > maxConcurrentDispatches) maxConcurrentDispatches = inFlight;
      await new Promise((resolve) => { setTimeout(resolve, dispatchMs); });
      inFlight -= 1;
      published.push({ phase: request.phase, text: request.text });
      return { delivered: true, metadata: {} };
    },
  };
  const pipeline = new ChannelReplyPipeline({
    channelPlugins,
    routeBindings: { captureReplyTarget: async () => {} },
    runtimeBus: bus,
    now: () => now,
  } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);

  let sequence = 0;
  return {
    pipeline,
    published,
    bodies: () => published.map((entry) => entry.text),
    maxConcurrentDispatches: () => maxConcurrentDispatches,
    advance(ms: number) { now += ms; },
    track(agentId: string) {
      pipeline.trackPending({
        agentId,
        surfaceKind,
        task: 'phone task',
        createdAt: now,
        routeId: 'route-1',
      } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);
    },
    /** A bus event, delivered the way the daemon delivers it: not awaited. */
    emitProgress(agentId: string, text: string) {
      sequence += 1;
      emitAgentProgress(bus, {
        sessionId: 'race-session',
        traceId: `progress-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, progress: text });
    },
    emitCompleted(agentId: string, output: string) {
      sequence += 1;
      emitAgentCompleted(bus, {
        sessionId: 'race-session',
        traceId: `complete-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, durationMs: 5, output });
    },
    /** Wait until every queued dispatch has drained. */
    async settle(): Promise<void> {
      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, DISPATCH_MS); });
        if (inFlight === 0) {
          const before = published.length;
          await new Promise((resolve) => { setTimeout(resolve, DISPATCH_MS); });
          if (published.length === before && inFlight === 0) return;
        }
      }
      throw new Error('dispatches never drained');
    },
  };
}

function lines(body: string): string[] {
  return body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Pairs where a later body repeats everything an earlier one already said. */
function supersetPairs(bodies: readonly string[]): string[] {
  const found: string[] = [];
  for (let earlier = 0; earlier < bodies.length; earlier += 1) {
    for (let later = earlier + 1; later < bodies.length; later += 1) {
      const earlierLines = lines(bodies[earlier]!);
      const laterLines = new Set(lines(bodies[later]!));
      if (earlierLines.length === 0) continue;
      if (earlierLines.every((line) => laterLines.has(line))) {
        found.push(`[${earlier}] ${JSON.stringify(bodies[earlier])} ⊆ [${later}] ${JSON.stringify(bodies[later])}`);
      }
    }
  }
  return found;
}

/** Lines published in more than one notification. */
function duplicatedLines(bodies: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    for (const line of new Set(lines(body))) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([line]) => line);
}

describe('concurrent progress deliveries with a slow dispatch', () => {
  test('bus events arriving during an in-flight publish produce no supersets', async () => {
    const h = harness('ntfy');
    h.track('agent-race');

    // Exactly the live shape: two tool events land while the first publish is
    // still on the wire, and the poller's forced status tick lands with them.
    h.emitProgress('agent-race', 'Turn 1 · exec — ls');
    h.advance(30_000);
    h.emitProgress('agent-race', 'Turn 1 · exec — echo $((5 + 3))');
    h.advance(30_000);
    const polled = h.pipeline.deliverProgress('agent-race', 'Turn 1 · Thinking…', true);

    await polled;
    await h.settle();

    const bodies = h.bodies();
    expect(supersetPairs(bodies)).toEqual([]);
    expect(duplicatedLines(bodies)).toEqual([]);
    // Every event still reaches the reader exactly once.
    expect(bodies.join('\n')).toContain('exec — ls');
    expect(bodies.join('\n')).toContain('exec — echo $((5 + 3))');
  });

  test('the critical section never runs two dispatches for one agent at once', async () => {
    const h = harness('ntfy');
    h.track('agent-serial');
    for (let i = 0; i < 6; i += 1) {
      h.emitProgress('agent-serial', `Turn 1 · step ${i}`);
      h.advance(30_000);
    }
    void h.pipeline.deliverProgress('agent-serial', 'Turn 1 · Thinking…', true);
    await h.settle();

    expect(h.maxConcurrentDispatches()).toBe(1);
    expect(supersetPairs(h.bodies())).toEqual([]);
    expect(duplicatedLines(h.bodies())).toEqual([]);
  });

  test('a final racing an in-flight progress does not replay what progress sent', async () => {
    const h = harness('ntfy');
    h.track('agent-final-race');

    h.emitProgress('agent-final-race', 'Turn 1 · exec — ls');
    h.advance(30_000);
    // The completion lands while the progress publish is still on the wire —
    // deliverFinal had the same select/await/mark shape as deliverProgress.
    h.emitCompleted('agent-final-race', 'The answer is 42.');
    await h.settle();

    const bodies = h.bodies();
    expect(supersetPairs(bodies)).toEqual([]);
    expect(duplicatedLines(bodies)).toEqual([]);
    expect(bodies.join('\n')).toContain('The answer is 42.');
  });

  test('two agents are not serialized against each other', async () => {
    const h = harness('ntfy');
    h.track('agent-a');
    h.track('agent-b');
    // Both runs are old enough to warrant a progress notification at all.
    h.advance(45_000);
    const started = Date.now();
    await Promise.all([
      h.pipeline.deliverProgress('agent-a', 'Turn 1 · exec — build a', true),
      h.pipeline.deliverProgress('agent-b', 'Turn 1 · exec — build b', true),
    ]);
    // Serialized, this would take two dispatch windows. Per-agent scope means
    // one slow surface cannot stall another agent's updates.
    expect(Date.now() - started).toBeLessThan(DISPATCH_MS * 2);
    expect(h.published).toHaveLength(2);
  });
});
