/**
 * The conversation-first gate at the shared spawn boundary, end to end.
 *
 * Drives the REAL ntfy surface adapter through the REAL surface-adapter
 * context factory, which is where the gate is installed. This is the
 * regression test for the reported incident: the single word "Testing" sent to
 * the ntfy agent topic must produce a conversational reply and no workstream.
 *
 * Covers:
 * - a trivial message: replies, spawns with WRFC disabled, starts no chain
 * - a work request: proposes and spawns nothing
 * - agreement over the originating channel: starts the work, once
 * - pre-authorized work (schedules/triggers/on-exit, and the raw spawn path):
 *   bypasses the gate entirely
 * - mode 'off': previous behavior restored
 */
import { describe, expect, test } from 'bun:test';
import { DaemonSurfaceActionHelper } from '../packages/sdk/src/platform/daemon/surface-actions.ts';
import { handleNtfySurfacePayload } from '../packages/sdk/src/platform/adapters/ntfy/index.ts';
import { WorkProposalStore } from '../packages/sdk/src/platform/agents/work-proposal-store.ts';
import { ntfyInboundDedup } from '../packages/sdk/src/platform/adapters/inbound-dedup.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

const AGENT_TOPIC = 'goodvibes-agent';

interface SpawnCall {
  readonly task: string;
  readonly wrfcDisabled: boolean;
  readonly replyStyle?: string | undefined;
  readonly logLabel?: string | undefined;
}

type NoticeOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

function buildHarness(
  configOverrides: Record<string, unknown> = {},
  clock?: { now: number },
  noticeOutcome: NoticeOutcome = { delivered: true },
) {
  const spawns: SpawnCall[] = [];
  const notices: Array<{ routeId: string | undefined; text: string }> = [];
  const queuedReplies: Array<{ agentId: string }> = [];
  // The store starts a sweep interval as soon as a proposal is pending, and it
  // only self-clears once the last one resolves, a test that leaves one open
  // otherwise leaves the sweep running for the rest of the shared process.
  const proposals = disposables.add(
    clock ? new WorkProposalStore({ now: () => clock.now }) : new WorkProposalStore(),
  );

  const config: Record<string, unknown> = {
    'surfaces.ntfy.enabled': true,
    'surfaces.ntfy.token': 'test-token',
    'surfaces.ntfy.agentTopic': AGENT_TOPIC,
    'surfaces.ntfy.chatTopic': 'goodvibes-chat',
    'surfaces.ntfy.remoteTopic': 'goodvibes-remote',
    ...configOverrides,
  };

  const binding = {
    id: 'route-1',
    surfaceKind: 'ntfy',
    surfaceId: 'ntfy',
    externalId: AGENT_TOPIC,
    channelId: AGENT_TOPIC,
    threadId: AGENT_TOPIC,
    metadata: {},
  };

  const session = { id: 'session-1', routeIds: ['route-1'], status: 'active', metadata: {} };

  let agentSeq = 0;
  const context = {
    serviceRegistry: { resolveSecret: async () => null },
    secretsManager: { get: () => undefined, getGlobalHome: () => undefined },
    configManager: {
      get: (key: string) => config[key],
      getCategory: () => undefined,
    },
    routeBindings: {
      upsertBinding: async () => binding,
      getBinding: (id: string) => (id === binding.id ? binding : undefined),
      resolve: () => binding,
    },
    sessionBroker: {
      submitMessage: async (input: { body: string }) => ({
        mode: 'spawn',
        session,
        task: `Respond to this message: ${input.body}`,
        routeBinding: binding,
      }),
      findPreferredSession: async () => null,
      listSessions: () => [],
      bindAgent: async () => undefined,
      getSession: (id: string) => (id === session.id ? session : undefined),
    },
    channelPolicy: {
      evaluateIngress: async () => ({ allowed: true, reason: 'ok', policy: { allowlistUserIds: [] } }),
    },
    controlPlaneGateway: {},
    runtimeBus: { emit: () => undefined },
    companionChatManager: null,
    automationManager: { getRun: () => null },
    agentManager: { getStatus: () => null },
    trySpawnAgent: (input: { task: string; dangerously_disable_wrfc?: boolean; replyStyle?: string }, logLabel?: string) => {
      agentSeq += 1;
      spawns.push({
        task: input.task,
        wrfcDisabled: input.dangerously_disable_wrfc === true,
        replyStyle: input.replyStyle,
        logLabel,
      });
      return { id: `agent-${agentSeq}`, task: input.task, status: 'running', tools: [] };
    },
    queueSurfaceReplyFromBinding: (_binding: unknown, input: { agentId: string }) => {
      queuedReplies.push({ agentId: input.agentId });
    },
    queueWebhookReply: () => undefined,
    surfaceDeliveryEnabled: () => true,
    signWebhookPayload: () => '',
    handleApprovalAction: async () => new Response(null),
    workProposals: proposals,
    deliverSurfaceNotice: async (b: { id: string } | undefined, text: string) => {
      notices.push({ routeId: b?.id, text });
      return noticeOutcome;
    },
  };

  const helper = new DaemonSurfaceActionHelper(
    context as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0],
  );

  let messageSeq = 0;
  return {
    proposals,
    spawns,
    notices,
    queuedReplies,
    rawSpawn: context.trySpawnAgent,
    /** Send one inbound ntfy message on the agent topic. */
    async send(message: string) {
      messageSeq += 1;
      // A fresh adapter context per message, exactly as the daemon builds it.
      return handleNtfySurfacePayload(
        { topic: AGENT_TOPIC, message, id: `ntfy-${messageSeq}-${Math.random()}` },
        helper.buildSurfaceAdapterContext(),
      );
    },
    /** Deliver an exact payload, so a duplicate id can be replayed. */
    async deliver(payload: Record<string, unknown>) {
      return handleNtfySurfacePayload(payload, helper.buildSurfaceAdapterContext());
    },
  };
}

describe('conversation gate at the surface spawn boundary', () => {
  test('the reported incident: "Testing" gets a reply and starts no workstream', async () => {
    const harness = buildHarness();
    const response = await harness.send('Testing');
    const body = await response.json() as Record<string, unknown>;

    // A reply happens...
    expect(harness.spawns).toHaveLength(1);
    expect(body.outcome).not.toBe('work-proposed');
    // ...but it is a conversation, not a write-review-fix-confirm chain.
    expect(harness.spawns[0]!.wrfcDisabled).toBe(true);
    // ...and exactly one agent, not two.
    expect(harness.spawns).toHaveLength(1);
    expect(harness.proposals.listPending()).toHaveLength(0);
  });

  test.each(['hey', 'what is the status?', 'thanks!', 'testing 1 2 3'])(
    'trivial message %p replies conversationally with no chain',
    async (message) => {
      const harness = buildHarness();
      await harness.send(message);
      expect(harness.spawns).toHaveLength(1);
      expect(harness.spawns[0]!.wrfcDisabled).toBe(true);
      expect(harness.proposals.listPending()).toHaveLength(0);
    },
  );

  test.each(['Hey, are you there?', 'hey', 'what is the status?', 'thanks!'])(
    'conversation %p spawns asking for a reply, not a completion report',
    async (message) => {
      const harness = buildHarness();
      await harness.send(message);
      // The gate had already decided this was conversation and then spawned an
      // agent still under orders to file a Summary/Changes/Decisions report,
      // which is what the owner received on his phone. What the message IS and
      // what the reply should LOOK like are one decision.
      expect(harness.spawns[0]!.replyStyle).toBe('conversational');
    },
  );

  test('an agreed workstream still reports as work', async () => {
    const harness = buildHarness();
    await harness.send('fix the parser in src/parse.ts');
    expect(harness.spawns).toHaveLength(0);
    await harness.send('yes');
    expect(harness.spawns).toHaveLength(1);
    // Real work keeps the completion report, the WRFC controller parses it.
    expect(harness.spawns[0]!.replyStyle).toBeUndefined();
  });

  test('a work request produces a proposal rather than a spawn', async () => {
    const harness = buildHarness();
    const response = await harness.send('fix the login bug');
    const body = await response.json() as Record<string, unknown>;

    expect(harness.spawns).toHaveLength(0);
    expect(body.outcome).toBe('work-proposed');
    expect(typeof body.proposalId).toBe('string');
    expect(harness.proposals.listPending()).toHaveLength(1);
  });

  // Observed live: the notice was refused by one of four silent guards, so the
  // owner saw nothing while the system held a pending, answerable proposal.
  // The next thing they typed could then be matched against it.
  test('a proposal whose notice was refused is not answerable', async () => {
    const harness = buildHarness({}, undefined, { delivered: false, reason: 'surface-delivery-disabled' });
    const response = await harness.send('fix the login bug');
    expect((await response.json() as Record<string, unknown>).outcome).toBe('work-proposed');

    expect(harness.proposals.listPending()).toHaveLength(0);
    expect(harness.proposals.disclose().reaped.undelivered).toBe(1);

    // ...and a later "yes" therefore starts nothing.
    await harness.send('yes');
    expect(harness.spawns.filter((spawn) => !spawn.wrfcDisabled)).toHaveLength(0);
  });

  test('a work request is answerable only after its notice is confirmed', async () => {
    const harness = buildHarness();
    await harness.send('fix the login bug');
    const pending = harness.proposals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.delivered).toBe(true);
  });

  test('the proposal goes out on the channel the message arrived on', async () => {
    const harness = buildHarness();
    await harness.send('refactor the session broker');
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]!.routeId).toBe('route-1');
    expect(harness.notices[0]!.text).toContain('refactor the session broker');
    expect(harness.notices[0]!.text.toLowerCase()).toContain('yes');
  });

  test('agreement over the originating channel starts the work, exactly once', async () => {
    const harness = buildHarness();
    await harness.send('fix the login bug');
    expect(harness.spawns).toHaveLength(0);

    await harness.send('yes');

    const workSpawns = harness.spawns.filter((call) => !call.wrfcDisabled);
    expect(workSpawns).toHaveLength(1);
    expect(workSpawns[0]!.task).toContain('fix the login bug');
    expect(harness.proposals.listPending()).toHaveLength(0);

    // A second "yes" must not start it again.
    await harness.send('yes');
    expect(harness.spawns.filter((call) => !call.wrfcDisabled)).toHaveLength(1);
  });

  test('refusing over the channel starts nothing', async () => {
    const harness = buildHarness();
    await harness.send('deploy the worker');
    await harness.send('no, not now');

    expect(harness.spawns.filter((call) => !call.wrfcDisabled)).toHaveLength(0);
    expect(harness.proposals.listPending()).toHaveLength(0);
    expect(harness.notices.some((notice) => notice.text.startsWith('Skipped:'))).toBe(true);
  });

  test('an expired proposal is not answerable — a late "yes" starts nothing', async () => {
    const clock = { now: 1_000_000 };
    const harness = buildHarness({ 'conversationGate.proposalTtlMs': 60_000 }, clock);
    await harness.send('fix the login bug');
    expect(harness.proposals.listPending()).toHaveLength(1);

    // The owner answers after the proposal window closed.
    clock.now += 60_001;

    await harness.send('yes');
    expect(harness.spawns.filter((call) => !call.wrfcDisabled)).toHaveLength(0);
    expect(harness.proposals.listPending()).toHaveLength(0);
  });

  test('pre-authorized work bypasses the gate — the raw spawn path is never gated', () => {
    const harness = buildHarness();
    // Schedules, triggers, on-exit chains, and the retry control command all
    // spawn through the raw path, not the surface adapter context.
    harness.rawSpawn({ task: 'scheduled nightly audit' }, 'AutomationManager');
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.wrfcDisabled).toBe(false);
    expect(harness.proposals.listPending()).toHaveLength(0);
  });

  test('mode off restores the previous behavior', async () => {
    const harness = buildHarness({ 'conversationGate.mode': 'off' });
    await harness.send('fix the login bug');
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.wrfcDisabled).toBe(false);
    expect(harness.proposals.listPending()).toHaveLength(0);
  });

  test('confirm-all mode proposes even for a trivial message', async () => {
    const harness = buildHarness({ 'conversationGate.mode': 'confirm-all' });
    await harness.send('hey');
    expect(harness.spawns).toHaveLength(0);
    expect(harness.proposals.listPending()).toHaveLength(1);
  });

  test('one message delivered on two routes runs the pipeline once, not twice', async () => {
    const harness = buildHarness();
    ntfyInboundDedup.clear();
    // The same ntfy message id, delivered by the JSON subscription and again
    // by the HTTP webhook route, the shape that produced two agent runs.
    const payload = { topic: AGENT_TOPIC, message: 'Testing', id: 'ntfy-duplicate-1' };

    const first = await harness.deliver({ ...payload });
    const second = await harness.deliver({ ...payload });

    const firstBody = await first.json() as Record<string, unknown>;
    const secondBody = await second.json() as Record<string, unknown>;
    expect(firstBody.reason).not.toBe('duplicate-delivery');
    expect(secondBody.reason).toBe('duplicate-delivery');
    // Exactly one agent for one message.
    expect(harness.spawns).toHaveLength(1);
  });
});
