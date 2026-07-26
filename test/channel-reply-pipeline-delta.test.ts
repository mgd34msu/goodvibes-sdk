/**
 * Channel reply defects observed live against a real daemon.
 *
 * 1. ntfy structurally discarded the agent's answer: `assistant_text` was
 *    excluded from the final body, so the owner's phone received
 *    "Agent completed in Nms" and never the reply.
 * 2. The final body ignored the delivery watermark and replayed every buffered
 *    event, making it a strict superset of the progress updates before it —
 *    one trivial message arrived as three notifications, each repeating the
 *    previous one plus a little more.
 * 3. An agent's internal completion-report JSON reached the channel verbatim:
 *    `{"version":1,"archetype":"engineer",...}` on a lock screen.
 */
import { describe, expect, test } from 'bun:test';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentProgress } from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import { emitWorkflowChainPassed } from '../packages/sdk/src/platform/runtime/emitters/workflows.js';
import { waitFor } from './_helpers/test-timeout.js';

interface Published {
  readonly phase: string;
  readonly text: string;
}

function harness(surfaceKind: string) {
  const published: Published[] = [];
  let now = 2_000_000;
  const bus = new RuntimeEventBus();
  const channelPlugins = {
    getRenderPolicy: async () => null,
    render: async (_surface: string, request: { phase: string; text: string }) => {
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
    advance(ms: number) { now += ms; },
    track(agentId: string, extra: Record<string, unknown> = {}) {
      pipeline.trackPending({
        agentId,
        surfaceKind,
        task: 'phone task',
        createdAt: now,
        routeId: 'route-1',
        ...extra,
      } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);
    },
    async progress(agentId: string, text: string) {
      sequence += 1;
      emitAgentProgress(bus, {
        sessionId: 'test-session',
        traceId: `progress-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, progress: text });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
    async complete(agentId: string, output: string, durationMs = 5) {
      sequence += 1;
      emitAgentCompleted(bus, {
        sessionId: 'test-session',
        traceId: `complete-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, durationMs, output });
    },
    async chainPassed(chainId: string) {
      sequence += 1;
      emitWorkflowChainPassed(bus, {
        sessionId: 'wrfc',
        traceId: `chain-${sequence}`,
        source: 'test',
      }, { chainId });
    },
  };
}

/** How many published bodies contain `needle`. */
function occurrences(bodies: readonly string[], needle: string): number {
  return bodies.filter((body) => body.includes(needle)).length;
}

describe('ntfy delivers the answer, not just the duration', () => {
  test('a run whose only content is one assistant_text final event delivers that text', async () => {
    const h = harness('ntfy');
    h.track('agent-ntfy');
    await h.complete('agent-ntfy', 'The build is green and the tag is pushed.');

    await waitFor(() => h.published.length > 0);
    const body = h.bodies().join('\n');
    expect(body).toContain('The build is green and the tag is pushed.');
    // The duration line may ride along; the answer may not be replaced by it.
    expect(h.published[0]?.phase).toBe('final');
  });

  test('an ntfy workflow chain still delivers every leg', async () => {
    const h = harness('ntfy');
    h.track('agent-chain', { workflowChainId: 'chain-9' });
    await h.complete('agent-chain', 'first leg answer');
    await waitFor(() => h.published.length === 1);
    expect(h.published[0]?.text).toContain('first leg answer');
    // keepTracking: the chain is still live after the root agent completes.
    expect(h.pipeline.has('agent-chain')).toBe(true);

    h.advance(30_000);
    await h.chainPassed('chain-9');
    await waitFor(() => h.published.length === 2);
    expect(h.published[1]?.text).toContain('chain-9 passed');
    expect(h.pipeline.has('agent-chain')).toBe(false);
  });
});

describe('the final body is a delta, not a replay', () => {
  test('a final with no explicit text does not repeat lines progress already sent', async () => {
    const h = harness('telegram');
    h.track('agent-tg');
    await h.progress('agent-tg', 'reading the diff');
    h.advance(30_000);
    await h.progress('agent-tg', 'running the gates');
    expect(h.bodies()).toEqual(['reading the diff', 'running the gates']);

    h.advance(30_000);
    await h.pipeline.deliverFinal('agent-tg', '');

    expect(h.published).toHaveLength(3);
    const final = h.published[2]!;
    expect(final.phase).toBe('final');
    // The defect: the final body was `[...state.events, statusEvent]` — every
    // line the two progress updates had just delivered, plus "Completed".
    expect(final.text).not.toContain('reading the diff');
    expect(final.text).not.toContain('running the gates');
    // A completion with nothing new still says something.
    expect(final.text.trim().length).toBeGreaterThan(0);
    expect(occurrences(h.bodies(), 'reading the diff')).toBe(1);
    expect(occurrences(h.bodies(), 'running the gates')).toBe(1);
  });

  test('progress lines and the answer each appear exactly once across notifications', async () => {
    const h = harness('telegram');
    h.track('agent-tg2');
    await h.progress('agent-tg2', 'reading the diff');
    h.advance(30_000);
    await h.complete('agent-tg2', 'The answer is 42.');

    await waitFor(() => h.published.length === 2);
    const bodies = h.bodies();
    expect(occurrences(bodies, 'reading the diff')).toBe(1);
    expect(occurrences(bodies, 'The answer is 42.')).toBe(1);
    expect(h.published[1]?.text).not.toContain('reading the diff');
  });

  test('a run with no progress ticks still delivers a complete final message', async () => {
    const h = harness('telegram');
    h.track('agent-quiet');
    await h.complete('agent-quiet', 'Done: the flag now defaults to on.');

    await waitFor(() => h.published.length === 1);
    const final = h.published[0]!;
    expect(final.phase).toBe('final');
    expect(final.text).toContain('Done: the flag now defaults to on.');
    expect(final.text).toContain('Agent completed in 5ms');
  });

  test('a final delivered with nothing new at all still sends a terminal message', async () => {
    const h = harness('telegram');
    h.track('agent-empty');
    await h.progress('agent-empty', 'only line');
    h.advance(30_000);
    await h.pipeline.deliverFinal('agent-empty', '');
    h.advance(30_000);

    expect(h.published).toHaveLength(2);
    expect(h.published[1]?.text.trim().length).toBeGreaterThan(0);
  });
});

describe('internal completion-report JSON never reaches the channel body', () => {
  const report = JSON.stringify({
    version: 1,
    archetype: 'engineer',
    wrfcId: null,
    summary: 'Fixed the ntfy final body and the delivery watermark.',
    gatheredContext: ['reply-pipeline.ts'],
    plannedActions: ['include assistant_text'],
    appliedChanges: ['reply-pipeline.ts'],
    filesCreated: [],
    filesModified: ['reply-pipeline.ts'],
    filesDeleted: [],
    decisions: [{ what: 'delta', why: 'no supersets' }],
    issues: [],
    uncertainties: [],
  });

  test('a bare report payload is rendered as its human summary', async () => {
    const h = harness('ntfy');
    h.track('agent-report');
    await h.complete('agent-report', report);

    await waitFor(() => h.published.length > 0);
    const body = h.bodies().join('\n');
    expect(body).toContain('Fixed the ntfy final body and the delivery watermark.');
    expect(body).not.toContain('"archetype"');
    expect(body).not.toContain('"version"');
    expect(body).not.toContain('gatheredContext');
  });

  test('prose written around a report survives; only the report span is replaced', async () => {
    const h = harness('telegram');
    h.track('agent-report2');
    await h.complete('agent-report2', `Here is what I changed.\n\n\`\`\`json\n${report}\n\`\`\`\n\nAsk if you want detail.`);

    await waitFor(() => h.published.length > 0);
    const body = h.bodies().join('\n');
    expect(body).toContain('Here is what I changed.');
    expect(body).toContain('Ask if you want detail.');
    expect(body).toContain('Fixed the ntfy final body and the delivery watermark.');
    expect(body).not.toContain('"appliedChanges"');
  });

  test('an answer that legitimately is JSON is left alone', async () => {
    const h = harness('telegram');
    h.track('agent-json');
    const answer = JSON.stringify({ topic: 'goodvibes', archetype: 'engineer', count: 3 });
    await h.complete('agent-json', answer);

    await waitFor(() => h.published.length > 0);
    expect(h.bodies().join('\n')).toContain('"topic":"goodvibes"');
  });
});

describe('progress notifications carry a status line, never the answer', () => {
  // The defect: surface-delivery passed `record.progress` into deliverProgress,
  // and buildRenderedText discarded explicitText on the progress phase, so the
  // status reached no notification body on ANY surface.
  test.each(['ntfy', 'telegram', 'slack'])('the status line reaches the body on %s', async (surface) => {
    const h = harness(surface);
    h.track('agent-status');
    await h.pipeline.deliverProgress('agent-status', 'Turn 3 · Read(src/parse.ts)', true);

    await waitFor(() => h.published.length > 0);
    expect(h.published[0]!.phase).toBe('progress');
    expect(h.published[0]!.text).toContain('Turn 3 · Read(src/parse.ts)');
  });

  test('a status line is one bounded line, not a growing transcript', async () => {
    const h = harness('ntfy');
    h.track('agent-bounded');
    // Even a caller that wrongly hands over multi-line accumulating content
    // cannot produce a transcript: it collapses to one bounded line.
    const blob = `line one\nline two\nline three\n${'x'.repeat(500)}`;
    await h.pipeline.deliverProgress('agent-bounded', blob, true);

    await waitFor(() => h.published.length > 0);
    const body = h.published[0]!.text;
    expect(body.split('\n')).toHaveLength(1);
    expect(body.length).toBeLessThanOrEqual(160);
  });

  test('the same status is never published twice', async () => {
    const h = harness('ntfy');
    h.track('agent-repeat');
    await h.pipeline.deliverProgress('agent-repeat', 'Turn 1 · Thinking…', true);
    const after = h.published.length;
    await h.pipeline.deliverProgress('agent-repeat', 'Turn 1 · Thinking…', true);
    expect(h.published.length).toBe(after);
  });

  test('nothing to say publishes nothing', async () => {
    const h = harness('ntfy');
    h.track('agent-silent');
    expect(await h.pipeline.deliverProgress('agent-silent', '', true)).toBeNull();
    expect(await h.pipeline.deliverProgress('agent-silent', '   \n  ', true)).toBeNull();
    expect(h.published).toHaveLength(0);
  });

  test('a progress body never carries a fragment of the answer', async () => {
    const h = harness('telegram');
    h.track('agent-frag');
    // An assistant_text event buffered mid-run must not reach a progress body.
    await h.complete('agent-frag', 'FINAL ANSWER TEXT');
    await waitFor(() => h.published.length > 0);
    const progressBodies = h.published.filter((p) => p.phase === 'progress').map((p) => p.text);
    expect(progressBodies.some((b) => b.includes('FINAL ANSWER TEXT'))).toBe(false);
  });
});
