/**
 * A workstream's progress lines are the owner's, and they carry no chain id.
 *
 * The round that put an audience on render events kept this family owner-facing
 * on purpose: someone who asked for a long-running workstream is owed its legs.
 * What it left behind was the text itself — every line led with
 * `WRFC chain 7f3a91c02b4e`, a name for the machinery and a register id, and
 * outward-facing text carries neither.
 *
 * These tests hold three things at once, because getting one without the others
 * is a different defect:
 *
 *   1. no rendered line contains the chain id (or a prefix of it);
 *   2. the lines still ARRIVE — this is not a suppression fix;
 *   3. two workstreams running at once are still told apart, in words.
 */
import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.js';
import { WebhookNotifier } from '../packages/sdk/src/platform/integrations/webhooks.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';

/**
 * The envelope type `emit` accepts for the `workflows` domain specifically.
 *
 * `Parameters<typeof bus.emit>[1]` was wrong here: `emit` is generic over the
 * domain, so reading its parameters without supplying one instantiates the
 * type variable at its constraint and yields the union envelope across every
 * domain — which the `workflows` overload does not accept. The instantiation
 * expression pins the domain, so this alias stays correct as the event map
 * grows instead of silently widening again.
 */
type WorkflowsEnvelope = Parameters<typeof RuntimeEventBus.prototype.emit<'workflows'>>[1];
import { eventLine, normalizeChannelRenderEventFromRuntime } from '../packages/sdk/src/platform/channels/reply-render.js';
import { DEFAULT_POLICY } from '../packages/sdk/src/platform/channels/reply-policy.js';
import {
  describeWorkstreamState,
  finishWorkstreamLabel,
  rememberWorkstreamLabel,
  resetWorkstreamLabelsForTests,
  workstreamLabel,
  workstreamLabelInline,
} from '../packages/sdk/src/platform/channels/workstream-labels.js';
import type { WrfcState as EventsWrfcState } from '../packages/sdk/src/events/workflows.js';
import type { WrfcState as AgentsWrfcState } from '../packages/sdk/src/platform/agents/wrfc-types.js';
import type { ChannelSurface } from '../packages/sdk/src/platform/channels/types.js';
import { settleEvents, waitFor } from './_helpers/test-timeout.js';

/**
 * A chain id shaped like the real thing. Long enough that a 12-character slice
 * of it is still distinctive, so a test can catch the truncated form the old
 * lines used as well as the whole id.
 */
const CHAIN_ID = '7f3a91c02b4e5d6a8b9c0d1e2f3a4b5c';
const CHAIN_ID_SHORT = CHAIN_ID.slice(0, 12);
const OTHER_CHAIN_ID = 'c5b4a3f2e1d0c9b8a7d6e5f4c3b2a190';

const ALL_SURFACES = Object.keys(DEFAULT_POLICY) as ChannelSurface[];

const TASK = 'rewrite the retry backoff so it stops hammering the mail host';

/**
 * Every workflow event the renderer turns into an owner-facing line.
 *
 * Each envelope gets its own trace id and timestamp because the pipeline's
 * delta watermark keys on the render event id, which is built from both — reuse
 * them and the second event of a chain looks like one already delivered.
 */
function workflowEnvelopes(chainId: string, task: string) {
  const base = { ts: 1, traceId: `trace-${chainId}`, source: 'test' };
  return [
    { ...base, type: 'WORKFLOW_CHAIN_CREATED', payload: { type: 'WORKFLOW_CHAIN_CREATED', chainId, task } },
    { ...base, type: 'WORKFLOW_CONSTRAINTS_ENUMERATED', payload: { type: 'WORKFLOW_CONSTRAINTS_ENUMERATED', chainId, constraints: [{ id: 'c1', text: 'keep the retry budget', source: 'prompt' }] } },
    { ...base, type: 'WORKFLOW_STATE_CHANGED', payload: { type: 'WORKFLOW_STATE_CHANGED', chainId, from: 'engineering', to: 'awaiting_gates' } },
    { ...base, type: 'WORKFLOW_REVIEW_COMPLETED', payload: { type: 'WORKFLOW_REVIEW_COMPLETED', chainId, score: 8, passed: true, constraintsSatisfied: 3, constraintsTotal: 4 } },
    { ...base, type: 'WORKFLOW_FIX_ATTEMPTED', payload: { type: 'WORKFLOW_FIX_ATTEMPTED', chainId, attempt: 2, maxAttempts: 3 } },
    { ...base, type: 'WORKFLOW_GATE_RESULT', payload: { type: 'WORKFLOW_GATE_RESULT', chainId, gate: 'typecheck', passed: false } },
    { ...base, type: 'WORKFLOW_AUTO_COMMITTED', payload: { type: 'WORKFLOW_AUTO_COMMITTED', chainId, commitHash: 'abc1234' } },
    { ...base, type: 'WORKFLOW_SCORE_REGRESSION', payload: { type: 'WORKFLOW_SCORE_REGRESSION', chainId, reason: 'the fix undid a passing constraint' } },
    { ...base, type: 'WORKFLOW_CASCADE_ABORTED', payload: { type: 'WORKFLOW_CASCADE_ABORTED', chainId, reason: 'three attempts scored no better' } },
    { ...base, type: 'WORKFLOW_CHAIN_PASSED', payload: { type: 'WORKFLOW_CHAIN_PASSED', chainId } },
    { ...base, type: 'WORKFLOW_CHAIN_FAILED', payload: { type: 'WORKFLOW_CHAIN_FAILED', chainId, reason: 'the gates never went green' } },
  ].map((envelope, index) => ({
    ...envelope,
    ts: base.ts + index,
    traceId: `${base.traceId}-${index}`,
  })) as unknown as Parameters<typeof normalizeChannelRenderEventFromRuntime>[0][];
}

/** Render one chain's whole lifecycle to the lines a person would receive. */
function renderLifecycle(chainId: string, task: string): string[] {
  return workflowEnvelopes(chainId, task)
    .flatMap((envelope) => normalizeChannelRenderEventFromRuntime(envelope))
    .map((event) => eventLine(event, 'public'))
    .filter((line): line is string => Boolean(line));
}

beforeEach(() => {
  resetWorkstreamLabelsForTests();
});

describe('the id never reaches a rendered line', () => {
  test('no line in a whole workstream lifecycle contains the chain id', () => {
    const lines = renderLifecycle(CHAIN_ID, TASK);
    const body = lines.join('\n');
    expect(body).not.toContain(CHAIN_ID);
    expect(body).not.toContain(CHAIN_ID_SHORT);
    // The name for the machinery goes with it — outward-facing text carries
    // neither an id nor an internal codename.
    expect(body).not.toContain('WRFC');
  });

  test('a chain whose opening line was never seen still renders no id', () => {
    // The daemon restarted, or the reply pipeline attached mid-workstream: the
    // label was never learned. It says so in words rather than falling back to
    // the identifier.
    const lines = workflowEnvelopes(CHAIN_ID, TASK)
      .filter((envelope) => envelope.payload.type !== 'WORKFLOW_CHAIN_CREATED')
      .flatMap((envelope) => normalizeChannelRenderEventFromRuntime(envelope))
      .map((event) => eventLine(event, 'public'))
      .filter((line): line is string => Boolean(line));
    const body = lines.join('\n');
    expect(body).not.toContain(CHAIN_ID);
    expect(body).not.toContain(CHAIN_ID_SHORT);
    expect(body).toContain('the workstream');
  });

  test('the raw state name never reaches the reader either', () => {
    rememberWorkstreamLabel(CHAIN_ID, TASK);
    const [line] = renderLifecycle(CHAIN_ID, TASK).filter((text) => text.includes('is now'));
    expect(line).toContain('waiting for its checks');
    expect(line).not.toContain('awaiting_gates');
  });
});

describe('the lines still arrive — this is not a suppression fix', () => {
  test('every stage of the workstream still produces a line', () => {
    const lines = renderLifecycle(CHAIN_ID, TASK);
    const body = lines.join('\n');
    // One line per event in the family, none of them dropped.
    expect(lines.length).toBe(workflowEnvelopes(CHAIN_ID, TASK).length);
    expect(body).toContain('Started work on:');
    expect(body).toContain('requirement');
    expect(body).toContain('is now waiting for its checks');
    expect(body).toContain('Review of');
    expect(body).toContain('scored 8 out of 10');
    expect(body).toContain('3 of 4 requirements met');
    expect(body).toContain('attempt 2 of 3');
    expect(body).toContain('typecheck check');
    expect(body).toContain('abc1234');
    expect(body).toContain('scored worse');
    expect(body).toContain('Stopped retrying');
    expect(body).toContain('is done');
    expect(body).toContain('could not be finished');
  });

  test('the task itself still reaches the reader on the opening line', () => {
    const [opening] = renderLifecycle(CHAIN_ID, TASK);
    expect(opening).toContain('rewrite the retry backoff');
  });
});

describe('two workstreams at once are told apart, in words', () => {
  test('identical tasks produce different lines', () => {
    rememberWorkstreamLabel(CHAIN_ID, TASK);
    rememberWorkstreamLabel(OTHER_CHAIN_ID, TASK);
    const first = workstreamLabel(CHAIN_ID);
    const second = workstreamLabel(OTHER_CHAIN_ID);
    expect(first).not.toBe(second);
    expect(first).toContain('the first one');
    expect(second).toContain('the second one');
    // In words, not by an identifier.
    expect(`${first}${second}`).not.toContain(CHAIN_ID_SHORT);
    expect(`${first}${second}`).not.toContain(OTHER_CHAIN_ID.slice(0, 12));
  });

  test('the second opening line says which one it is', () => {
    // Only the opening events — running two whole lifecycles would retire the
    // first workstream before the second one started, which is not the case
    // under test.
    const openingLine = (chainId: string): string | null => {
      const [created] = workflowEnvelopes(chainId, TASK);
      const [event] = normalizeChannelRenderEventFromRuntime(created!);
      return eventLine(event!, 'public');
    };
    expect(openingLine(CHAIN_ID)).toBe(`Started work on: ${TASK}`);
    expect(openingLine(OTHER_CHAIN_ID)).toBe(`Started work on: ${TASK} (the second one)`);
  });

  test('a lone workstream is not qualified — there is nothing to distinguish it from', () => {
    rememberWorkstreamLabel(CHAIN_ID, TASK);
    const label = workstreamLabel(CHAIN_ID);
    expect(label.startsWith('"')).toBe(true);
    expect(label.endsWith('"')).toBe(true);
    expect(label).not.toContain(' one)');
  });

  test('tasks that only differ past the label length still get told apart', () => {
    const long = 'rewrite the retry backoff in the mail transport so that it ';
    rememberWorkstreamLabel(CHAIN_ID, `${long}stops hammering the host`);
    rememberWorkstreamLabel(OTHER_CHAIN_ID, `${long}gives up after five tries`);
    expect(workstreamLabelInline(CHAIN_ID)).not.toBe(workstreamLabelInline(OTHER_CHAIN_ID));
  });

  test('a place, once given, is kept after the other workstream finishes', () => {
    rememberWorkstreamLabel(CHAIN_ID, TASK);
    rememberWorkstreamLabel(OTHER_CHAIN_ID, TASK);
    const before = workstreamLabel(OTHER_CHAIN_ID);
    // The first one finishes. The survivor's name does not change under the
    // reader mid-run.
    normalizeChannelRenderEventFromRuntime(workflowEnvelopes(CHAIN_ID, TASK).at(-2)!);
    expect(workstreamLabel(OTHER_CHAIN_ID)).toBe(before);
  });

  test('a workstream started after its namesake finished stands alone again', () => {
    // The same ask, run twice, one after the other. There is nothing live to
    // tell the second run apart from, so it is not qualified — and it does not
    // reuse the place the first run wore.
    rememberWorkstreamLabel(CHAIN_ID, TASK);
    finishWorkstreamLabel(CHAIN_ID);
    rememberWorkstreamLabel(OTHER_CHAIN_ID, TASK);
    expect(workstreamLabel(OTHER_CHAIN_ID)).not.toContain(' one)');
  });

  test('a third workstream does not reuse a place the reader already saw', () => {
    rememberWorkstreamLabel('chain-a', TASK);
    rememberWorkstreamLabel('chain-b', TASK);
    finishWorkstreamLabel('chain-a');
    rememberWorkstreamLabel('chain-c', TASK);
    expect(workstreamLabel('chain-b')).toContain('the second one');
    expect(workstreamLabel('chain-c')).toContain('the third one');
  });
});

describe('what the label module promises', () => {
  test('a terminal event leaves the name readable for every other subscriber', () => {
    rememberWorkstreamLabel(CHAIN_ID, TASK);
    expect(workstreamLabelInline(CHAIN_ID)).toContain('rewrite the retry backoff');
    // WORKFLOW_CHAIN_PASSED — the second-to-last envelope in the family.
    normalizeChannelRenderEventFromRuntime(workflowEnvelopes(CHAIN_ID, TASK).at(-2)!);

    // Still readable, deliberately. Three subscribers build a line from this
    // one event — the channel renderer, the conversation follow-up and the
    // webhook notifier — and dropping the name on the first of them would make
    // the other two say "the workstream" purely because of subscription order.
    // Reaping is by the map's bound, where nothing is racing.
    expect(workstreamLabelInline(CHAIN_ID)).toContain('rewrite the retry backoff');
  });

  test('a finished workstream is evicted before a live one', () => {
    rememberWorkstreamLabel('finished-chain', 'the one that ended');
    finishWorkstreamLabel('finished-chain');
    rememberWorkstreamLabel('live-chain', 'the one still running');
    // Push exactly one entry past the 64 ceiling, so precisely one eviction
    // happens and the test says which entry it took.
    for (let index = 0; index < 63; index += 1) {
      rememberWorkstreamLabel(`filler-${index}`, `filler task ${index}`);
    }
    expect(workstreamLabelInline('finished-chain')).toBe('the workstream');
    expect(workstreamLabelInline('live-chain')).toContain('the one still running');
  });

  test('a process that never sees a terminal event cannot grow the map unbounded', () => {
    for (let index = 0; index < 500; index += 1) {
      rememberWorkstreamLabel(`chain-${index}`, `task number ${index}`);
    }
    // The oldest are evicted; an evicted workstream reads as "the workstream"
    // rather than inventing an id to fill the gap.
    expect(workstreamLabelInline('chain-0')).toBe('the workstream');
    expect(workstreamLabelInline('chain-499')).toContain('task number 499');
  });

  test('an empty task leaves no label rather than an empty pair of quotes', () => {
    rememberWorkstreamLabel(CHAIN_ID, '   ');
    expect(workstreamLabel(CHAIN_ID)).toBe('The workstream');
  });

  test('every workstream state has plain words', () => {
    const states: readonly EventsWrfcState[] = [
      'pending', 'engineering', 'integrating', 'reviewing', 'fixing',
      'awaiting_gates', 'gating', 'passed', 'failed', 'committing',
    ];
    for (const state of states) {
      const words = describeWorkstreamState(state);
      expect(words).not.toContain('_');
      expect(words.length).toBeGreaterThan(0);
    }
  });

  test('the two WrfcState declarations are the same union — a rename in one is a build error here', () => {
    // The SDK declares this union twice (events/workflows.ts and
    // platform/agents/wrfc-types.ts). Mutual assignability is the assertion:
    // add a state to one and this stops compiling.
    const fromAgents: EventsWrfcState = 'awaiting_gates' as AgentsWrfcState;
    const fromEvents: AgentsWrfcState = 'awaiting_gates' as EventsWrfcState;
    expect(fromAgents).toBe('awaiting_gates');
    expect(fromEvents).toBe('awaiting_gates');
  });
});

describe('the other places a workstream line reaches a person', () => {
  test('a webhook body names the workstream, not the chain', async () => {
    // A webhook body is read by whatever the operator pointed it at — a Slack
    // channel, a phone. Outward-facing text, same rule.
    const sent: string[] = [];
    const bus = new RuntimeEventBus();
    const notifier = new WebhookNotifier(['https://example.com/webhook']);
    const sendSpy = spyOn(notifier, 'send').mockImplementation(async (text: string) => {
      sent.push(text);
      // WebhookNotifierSendResult also declares `attempted`; omitting it made
      // this mock a different shape from the method it replaces.
      return { attempted: 1, delivered: 1, failed: 0, results: [] };
    });
    try {
      notifier.attachToRuntimeBus(bus);
      rememberWorkstreamLabel(CHAIN_ID, TASK);
      bus.emit('workflows', workflowEnvelopes(CHAIN_ID, TASK).at(-2)! as WorkflowsEnvelope);
      bus.emit('workflows', workflowEnvelopes(OTHER_CHAIN_ID, TASK).at(-1)! as WorkflowsEnvelope);
      await waitFor(() => sent.length >= 2);
      const body = sent.join('\n');
      expect(body).not.toContain(CHAIN_ID);
      expect(body).not.toContain(CHAIN_ID_SHORT);
      expect(body).not.toContain('WRFC');
      // Still says what happened, to both outcomes.
      expect(body).toContain('passed all its checks');
      expect(body).toContain('could not be finished');
    } finally {
      sendSpy.mockRestore();
      notifier.detach();
    }
  });
});

/** The end-to-end path: bus -> pipeline -> the body a surface publishes. */
function harness(surfaceKind: string) {
  const published: string[] = [];
  let now = 2_000_000;
  const bus = new RuntimeEventBus();
  const pipeline = new ChannelReplyPipeline({
    channelPlugins: {
      getRenderPolicy: async () => null,
      render: async (_surface: string, request: { phase: string; text: string }) => {
        published.push(request.text);
        return { delivered: true, metadata: {} };
      },
    },
    routeBindings: { captureReplyTarget: async () => {} },
    runtimeBus: bus,
    now: () => now,
  } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);

  return {
    published,
    advance(ms: number) { now += ms; },
    track(agentId: string, task: string) {
      pipeline.trackPending({
        agentId,
        surfaceKind,
        task,
        createdAt: now,
        routeId: 'route-1',
      } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);
    },
    async emit(envelope: unknown) {
      bus.emit('workflows', envelope as WorkflowsEnvelope);
      await settleEvents();
    },
  };
}

describe('end to end, on every surface', () => {
  for (const surface of ALL_SURFACES) {
    test(`${surface} receives the workstream's progress with no chain id in it`, async () => {
      resetWorkstreamLabelsForTests();
      const h = harness(surface);
      h.track(`agent-${surface}`, TASK);
      h.advance(40_000);
      const [created, , stateChanged] = workflowEnvelopes(CHAIN_ID, TASK);
      await h.emit(created);
      h.advance(40_000);
      await h.emit(stateChanged);
      await waitFor(() => h.published.length > 0);

      const body = h.published.join('\n');
      expect(body).not.toContain(CHAIN_ID);
      expect(body).not.toContain(CHAIN_ID_SHORT);
      expect(body).not.toContain('WRFC');
      // Still delivered — the owner's workstream still reports its legs.
      expect(body).toContain('rewrite the retry backoff');
    });
  }

  test('two concurrent workstreams reach the surface distinguishable', async () => {
    resetWorkstreamLabelsForTests();
    const h = harness('telegram');
    h.track('agent-one', TASK);
    h.track('agent-two', TASK);
    h.advance(40_000);
    const [createdOne, , stateOne] = workflowEnvelopes(CHAIN_ID, TASK);
    const [createdTwo, , stateTwo] = workflowEnvelopes(OTHER_CHAIN_ID, TASK);
    await h.emit(createdOne);
    await h.emit(createdTwo);
    h.advance(40_000);
    await h.emit(stateOne);
    h.advance(40_000);
    await h.emit(stateTwo);
    await waitFor(() => h.published.join('\n').includes('(the first one)')
      && h.published.join('\n').includes('(the second one)'));

    const body = h.published.join('\n');
    expect(body).not.toContain(CHAIN_ID_SHORT);
    expect(body).not.toContain(OTHER_CHAIN_ID.slice(0, 12));
    expect(body).toContain('(the first one)');
    expect(body).toContain('(the second one)');
  });
});
