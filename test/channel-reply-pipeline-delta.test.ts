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
    /**
     * Owner-audience by default: these tests are about pacing and delta, and
     * they use prose statuses a reader can act on. Tool-activity progress is
     * `operator` and is dropped before any of this machinery runs — that rule
     * has its own tests, above and in
     * channel-internal-diagnostics-never-delivered.test.ts.
     */
    async progress(agentId: string, text: string, audience: 'owner' | 'operator' = 'owner') {
      sequence += 1;
      emitAgentProgress(bus, {
        sessionId: 'test-session',
        traceId: `progress-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, progress: text, audience });
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
    // The duration line no longer rides along at all — the answer is the whole
    // notification.
    expect(body).not.toContain('Agent completed in');
    expect(body.trim()).toBe('The build is green and the tag is pushed.');
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
    // The leg still arrives; it no longer quotes the chain id. This harness
    // never emits the opening event that carries the task, so the workstream
    // has no name to be known by — and it says so in words rather than falling
    // back to the identifier. See channel-workstream-labels.test.ts.
    expect(h.published[1]?.text).toBe('The workstream is done');
    expect(h.published[1]?.text).not.toContain('chain-9');
    expect(h.pipeline.has('agent-chain')).toBe(false);
  });
});

describe('the final body is a delta, not a replay', () => {
  test('a final with no explicit text does not repeat lines progress already sent', async () => {
    const h = harness('telegram');
    h.track('agent-tg');
    // Past the floor below which no progress notification is warranted.
    h.advance(45_000);
    await h.progress('agent-tg', 'reading the diff');
    h.advance(30_000);
    await h.progress('agent-tg', 'running the gates');
    expect(h.bodies()).toEqual(['reading the diff', 'running the gates']);

    h.advance(30_000);
    await h.pipeline.deliverFinal('agent-tg', '');

    // The defect this pins: the final body was `[...state.events, statusEvent]`
    // — every line the two progress updates had just delivered, plus
    // "Completed". Nothing here is new, so under the owner's ruling nothing is
    // sent: the two progress notifications stand and no third arrives.
    expect(h.published).toHaveLength(2);
    expect(occurrences(h.bodies(), 'reading the diff')).toBe(1);
    expect(occurrences(h.bodies(), 'running the gates')).toBe(1);
    // The run is closed out even though nobody was notified.
    expect(h.pipeline.has('agent-tg')).toBe(false);
  });

  test('progress lines and the answer each appear exactly once across notifications', async () => {
    const h = harness('telegram');
    h.track('agent-tg2');
    h.advance(45_000);
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
    // Owner ruling: how long the run took is operator telemetry and must not
    // reach a channel user at all. It used to be appended under every answer,
    // which is also where the duplicate completion line came from.
    expect(final.text).not.toContain('Agent completed in');
    expect(final.text.trim()).toBe('Done: the flag now defaults to on.');
  });

  test('a final delivered with nothing new at all sends nothing and closes the run', async () => {
    const h = harness('telegram');
    h.track('agent-empty');
    h.advance(45_000);
    await h.progress('agent-empty', 'only line');
    h.advance(30_000);
    await h.pipeline.deliverFinal('agent-empty', '');
    h.advance(30_000);

    // This used to send a synthesised "Completed". Owner ruling: a bare
    // acknowledgement is not a message. Silence is the honest outcome, and the
    // run still ends — the pipeline is not left waiting on this agent.
    expect(h.bodies()).toEqual(['only line']);
    expect(h.pipeline.has('agent-empty')).toBe(false);
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

describe('the report reaches nobody in its prose form either', () => {
  // What the owner actually received for "Hey, are you there?" — the JSON form
  // was already stripped, so the agent filed the same report as prose and it
  // shipped verbatim.
  test('a filled-in report template is reduced to the answer it carries', async () => {
    const h = harness('ntfy');
    h.track('agent-prose');
    await h.complete('agent-prose', [
      '## Summary',
      "Yes, I'm here. The daemon is running and the ntfy route is bound.",
      '',
      '## Changes',
      'None.',
      '',
      '## Decisions',
      '- No action taken: the message was a status check, not a work request.',
      '',
      '## Issues',
      'None.',
      '',
      '## Uncertainties',
      'None.',
    ].join('\n'));

    await waitFor(() => h.published.length > 0);
    expect(h.bodies()).toEqual(["Yes, I'm here. The daemon is running and the ntfy route is bound."]);
  });

  test('the inline label form is stripped too', async () => {
    const h = harness('ntfy');
    h.track('agent-inline');
    await h.complete('agent-inline', [
      'Summary: The release is tagged and CI is green on every job.',
      'Changes: None.',
      'Decisions: None.',
      'Issues: None.',
      'Uncertainties: None.',
    ].join('\n'));

    await waitFor(() => h.published.length > 0);
    expect(h.bodies()).toEqual(['The release is tagged and CI is green on every job.']);
  });

  test('the bulleted label form is stripped too', async () => {
    const h = harness('telegram');
    h.track('agent-bullets');
    await h.complete('agent-bullets', [
      '- Summary: Two files changed; the flag defaults to on.',
      '- Changes: src/flags.ts, src/config.ts',
      '- Issues: none',
    ].join('\n'));

    await waitFor(() => h.published.length > 0);
    expect(h.bodies()).toEqual(['Two files changed; the flag defaults to on.']);
  });

  test('prose written before the report survives it', async () => {
    const h = harness('telegram');
    h.track('agent-preamble');
    await h.complete('agent-preamble', [
      'The parser was reading the header twice. Fixed.',
      '',
      '## Summary',
      'Removed the duplicate header read in src/parse.ts.',
      '',
      '## Changes',
      'src/parse.ts',
    ].join('\n'));

    await waitFor(() => h.published.length > 0);
    const body = h.bodies().join('\n');
    expect(body).toContain('The parser was reading the header twice. Fixed.');
    expect(body).toContain('Removed the duplicate header read in src/parse.ts.');
    expect(body).not.toContain('## Changes');
    expect(body).not.toContain('Summary');
  });

  test('a report whose summary says nothing sends nothing at all', async () => {
    const h = harness('ntfy');
    h.track('agent-hollow');
    await h.complete('agent-hollow', [
      'Summary: None.',
      'Changes: None.',
      'Decisions: None.',
      'Issues: None.',
    ].join('\n'));

    // An empty reply is honest; a reply made of paperwork is not.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(h.published).toHaveLength(0);
    expect(h.pipeline.has('agent-hollow')).toBe(false);
  });

  test('ordinary prose that merely mentions a section word is left alone', async () => {
    const h = harness('telegram');
    h.track('agent-prose-safe');
    const answer = 'Summary: the API is down. I checked the health endpoint twice and it timed out both times.';
    await h.complete('agent-prose-safe', answer);

    await waitFor(() => h.published.length > 0);
    // One heading is a sentence opener, not a form. Nothing is removed.
    expect(h.bodies()).toEqual([answer]);
  });

  test('a heading-shaped sentence without a colon is not a section boundary', async () => {
    const h = harness('telegram');
    h.track('agent-prose-safe2');
    const answer = [
      'Summary: I rewrote the changelog entry.',
      'Changes to the release process are still pending your call.',
    ].join('\n');
    await h.complete('agent-prose-safe2', answer);

    await waitFor(() => h.published.length > 0);
    expect(h.bodies()).toEqual([answer]);
  });
});

describe('progress notifications carry a status line, never the answer', () => {
  // The defect: surface-delivery passed `record.progress` into deliverProgress,
  // and buildRenderedText discarded explicitText on the progress phase, so the
  // status reached no notification body on ANY surface.
  test.each(['ntfy', 'telegram', 'slack'])('the status line reaches the body on %s', async (surface) => {
    const h = harness(surface);
    h.track('agent-status');
    // Long enough that a person would wonder whether the run died. Below that
    // floor a progress notification is not warranted at all.
    h.advance(45_000);
    await h.pipeline.deliverProgress('agent-status', 'Turn 3 · Network error, retrying in 5s…', true, 'owner');

    await waitFor(() => h.published.length > 0);
    expect(h.published[0]!.phase).toBe('progress');
    // The reason the reply is late is information. "Turn 3" is a fact about the
    // machine that changes on every tick and that nobody can act on.
    expect(h.published[0]!.text).toContain('Network error, retrying in 5s…');
    expect(h.published[0]!.text).not.toContain('Turn 3');
  });

  // The owner received `registry — email send`, `exec — standard` and
  // `find` as Telegram messages. Those are `record.progress` — the running tool
  // and a scrap of its arguments — and no surface may carry them, whatever the
  // pacing says. See channels/render-audience.ts.
  test.each(['ntfy', 'telegram', 'slack'])('a tool-activity status is dropped on %s however old the run', async (surface) => {
    const h = harness(surface);
    h.track('agent-tool-status');
    h.advance(45_000);
    expect(await h.pipeline.deliverProgress('agent-tool-status', 'Turn 3 · registry — email send', true)).toBeNull();
    expect(await h.pipeline.deliverProgress('agent-tool-status', 'Turn 4 · Read(src/parse.ts)', true)).toBeNull();
    expect(h.published).toHaveLength(0);
  });

  test('a status line is one bounded line, not a growing transcript', async () => {
    const h = harness('ntfy');
    h.track('agent-bounded');
    h.advance(45_000);
    // Even a caller that wrongly hands over multi-line accumulating content
    // cannot produce a transcript: it collapses to one bounded line.
    const blob = `line one\nline two\nline three\n${'x'.repeat(500)}`;
    await h.pipeline.deliverProgress('agent-bounded', blob, true, 'owner');

    await waitFor(() => h.published.length > 0);
    const body = h.published[0]!.text;
    expect(body.split('\n')).toHaveLength(1);
    expect(body.length).toBeLessThanOrEqual(160);
  });

  test('the same status is never published twice', async () => {
    const h = harness('ntfy');
    h.track('agent-repeat');
    h.advance(45_000);
    await h.pipeline.deliverProgress('agent-repeat', 'Turn 1 · Rate limited, retrying in 60s…', true, 'owner');
    const after = h.published.length;
    expect(after).toBe(1);
    await h.pipeline.deliverProgress('agent-repeat', 'Turn 2 · Rate limited, retrying in 60s…', true, 'owner');
    // Same work, a later turn. With the turn counter gone the two render
    // identically, which is what the duplicate check is for.
    expect(h.published.length).toBe(after);
  });

  test('nothing to say publishes nothing', async () => {
    const h = harness('ntfy');
    h.track('agent-silent');
    h.advance(45_000);
    expect(await h.pipeline.deliverProgress('agent-silent', '', true, 'owner')).toBeNull();
    expect(await h.pipeline.deliverProgress('agent-silent', '   \n  ', true, 'owner')).toBeNull();
    expect(h.published).toHaveLength(0);
  });

  test('a turn counter and a placeholder are never published, however long the run', async () => {
    const h = harness('ntfy');
    h.track('agent-placeholder');
    h.advance(10 * 60_000);
    // The single most-delivered notification body on the owner's phone.
    expect(await h.pipeline.deliverProgress('agent-placeholder', 'Turn 1 · Thinking…', true, 'owner')).toBeNull();
    expect(await h.pipeline.deliverProgress('agent-placeholder', 'Turn 12 · Thinking...', true, 'owner')).toBeNull();
    expect(await h.pipeline.deliverProgress('agent-placeholder', 'Working…', true, 'owner')).toBeNull();
    expect(await h.pipeline.deliverProgress('agent-placeholder', 'Starting', true, 'owner')).toBeNull();
    expect(h.published).toHaveLength(0);
  });

  test('no progress notification interrupts anyone in the first seconds of a run', async () => {
    const h = harness('ntfy');
    h.track('agent-quick');
    // A real, informative status — withheld purely because the run is young.
    expect(await h.pipeline.deliverProgress('agent-quick', 'Turn 1 · Network error, retrying in 5s…', true, 'owner')).toBeNull();
    h.advance(29_000);
    expect(await h.pipeline.deliverProgress('agent-quick', 'Turn 2 · Network error, retrying in 9s…', true, 'owner')).toBeNull();
    expect(h.published).toHaveLength(0);
    h.advance(2_000);
    await h.pipeline.deliverProgress('agent-quick', 'Turn 3 · Network error, retrying in 9s…', true, 'owner');
    expect(h.bodies()).toEqual(['Network error, retrying in 9s…']);
  });

  test('a short conversational exchange produces exactly one notification: the answer', async () => {
    const h = harness('ntfy');
    h.track('agent-hello');
    // What a real run does in its first seconds, in order.
    await h.progress('agent-hello', 'Turn 1 · Thinking…');
    h.advance(1_200);
    await h.progress('agent-hello', 'Turn 2 · Thinking…');
    h.advance(1_500);
    await h.complete('agent-hello', "Yes — I'm here and the daemon is running.");

    await waitFor(() => h.published.length > 0);
    expect(h.bodies()).toEqual(["Yes — I'm here and the daemon is running."]);
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
