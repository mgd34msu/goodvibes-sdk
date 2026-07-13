/**
 * Owner allowlist gate for chat channels: the allowlist self-seeds from the
 * first identified sender (whoever pairs/configures the channel proves it by
 * messaging first — no separate add-yourself step exists), unknown senders are
 * ignored with one log line and no session, and a paired owner can approve,
 * deny, or steer a pending permission ask by replying in the channel — routed
 * through the same ApprovalBroker the TUI and webui use.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPolicyManager } from '../packages/sdk/src/platform/channels/policy-manager.js';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import { DaemonSurfaceActionHelper } from '../packages/sdk/src/platform/daemon/surface-actions.js';
import { parseApprovalReplyVerb } from '../packages/sdk/src/platform/daemon/approval-reply.js';
import { handleSlackSurfacePayload } from '../packages/sdk/src/platform/adapters/slack/index.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';
import type { SurfaceAdapterContext } from '../packages/sdk/src/platform/adapters/index.js';

const scratchDirs: string[] = [];

function makePolicyManager(): ChannelPolicyManager {
  const dir = mkdtempSync(join(tmpdir(), 'gv-channel-owner-gate-'));
  scratchDirs.push(dir);
  return new ChannelPolicyManager({ storePath: join(dir, 'policies.json') });
}

function makeAskRequest(callId: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'run_command',
    args: { command: 'deploy' },
    category: 'execute',
    analysis: { classification: 'execute', riskLevel: 'medium', summary: 'run a command', reasons: [] },
  };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('owner allowlist self-seeding', () => {
  test('the first identified sender seeds the surface owner allowlist', async () => {
    const policy = makePolicyManager();
    const first = await policy.evaluateIngress({
      surface: 'slack',
      userId: 'U-OWNER',
      conversationKind: 'direct',
      text: 'hello',
    });
    expect(first.allowed).toBe(true);
    expect(first.reason).toBe('owner-allowlist-seeded');
    expect(first.policy.allowlistUserIds).toEqual(['U-OWNER']);
    expect(policy.getPolicy('slack').allowlistUserIds).toEqual(['U-OWNER']);
  });

  test('after seeding, an unknown sender is denied and the owner stays allowed', async () => {
    const policy = makePolicyManager();
    await policy.evaluateIngress({ surface: 'telegram', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });

    const stranger = await policy.evaluateIngress({
      surface: 'telegram',
      userId: 'U-STRANGER',
      conversationKind: 'direct',
      text: 'let me in',
    });
    expect(stranger.allowed).toBe(false);
    expect(stranger.reason).toBe('user-not-allowlisted');

    const owner = await policy.evaluateIngress({
      surface: 'telegram',
      userId: 'U-OWNER',
      conversationKind: 'direct',
      text: 'status',
    });
    expect(owner.allowed).toBe(true);
    expect(owner.reason).toBe('allowed');
  });

  test('a message with no sender identity does not seed anything', async () => {
    const policy = makePolicyManager();
    const decision = await policy.evaluateIngress({
      surface: 'webhook',
      conversationKind: 'direct',
      text: 'machine payload',
    });
    expect(decision.allowed).toBe(true);
    expect(policy.getPolicy('webhook').allowlistUserIds).toEqual([]);
  });

  test('an unknown sender denial emits one log line', async () => {
    const policy = makePolicyManager();
    await policy.evaluateIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });

    const infoLines: Array<{ message: string; data: unknown }> = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = ((message: string, data?: unknown) => {
      infoLines.push({ message, data });
    }) as typeof logger.info;
    try {
      await policy.evaluateIngress({ surface: 'slack', userId: 'U-STRANGER', conversationKind: 'direct', text: 'hey' });
    } finally {
      logger.info = originalInfo;
    }
    const ignored = infoLines.filter((line) => line.message.includes('unknown sender ignored'));
    expect(ignored.length).toBe(1);
  });
});

describe('unknown sender at the adapter level (slack)', () => {
  test('produces no route binding, no session submit, and a policy-blocked response', async () => {
    const policy = makePolicyManager();
    await policy.evaluateIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });

    const submitted: unknown[] = [];
    const bindings: unknown[] = [];
    const context = {
      authorizeSurfaceIngress: (input: Parameters<ChannelPolicyManager['evaluateIngress']>[0]) =>
        policy.evaluateIngress(input),
      routeBindings: {
        upsertBinding: async (input: unknown) => {
          bindings.push(input);
          return { id: 'route-test', surfaceId: 'slack' };
        },
      },
      sessionBroker: {
        submitMessage: async (input: unknown) => {
          submitted.push(input);
          return { sessionId: 'session-test', accepted: true };
        },
      },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      trySpawnAgent: () => new Response('no'),
    } as unknown as SurfaceAdapterContext;

    const response = await handleSlackSurfacePayload({
      command: '/goodvibes',
      text: 'do something',
      user_id: 'U-STRANGER',
      user_name: 'stranger',
      channel_id: 'C1',
      channel_name: 'general',
      team_id: 'T1',
      response_url: '',
    }, context);

    expect(response.status).toBe(403);
    expect(bindings.length).toBe(0);
    expect(submitted.length).toBe(0);
  });
});

describe('owner channel reply resolves a pending permission ask', () => {
  function makeHelper(options: {
    readonly policy: ChannelPolicyManager;
    readonly broker: ApprovalBroker;
    readonly bindingSurface?: string | undefined;
  }): DaemonSurfaceActionHelper {
    return new DaemonSurfaceActionHelper({
      channelPolicy: options.policy,
      approvalBroker: options.broker,
      routeBindings: {
        getBinding: () => (options.bindingSurface ? { surfaceKind: options.bindingSurface } : undefined),
      },
    } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  }

  test('replying approve resolves the pending ask through the shared broker', async () => {
    const policy = makePolicyManager();
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    await policy.evaluateIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });
    const helper = makeHelper({ policy, broker, bindingSurface: 'slack' });

    const decisionPromise = broker.requestApproval({
      request: makeAskRequest('call-approve-1'),
      routeId: 'route-1',
    });
    await Bun.sleep(5);

    const ingress = await helper.authorizeSurfaceIngress({
      surface: 'slack',
      userId: 'U-OWNER',
      conversationKind: 'direct',
      text: 'approve',
    });
    expect(ingress.allowed).toBe(false);
    expect(ingress.reason).toBe('approval-reply-consumed');

    const decision = await decisionPromise;
    expect(decision.approved).toBe(true);
    const record = broker.listApprovals(10)[0]!;
    expect(record.status).toBe('approved');
    expect(record.resolvedBy).toBe('U-OWNER');
  });

  test('replying deny with guidance steers the ask: denied with the note recorded', async () => {
    const policy = makePolicyManager();
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    await policy.evaluateIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });
    const helper = makeHelper({ policy, broker, bindingSurface: 'slack' });

    const decisionPromise = broker.requestApproval({
      request: makeAskRequest('call-deny-1'),
      routeId: 'route-1',
    });
    await Bun.sleep(5);

    const ingress = await helper.authorizeSurfaceIngress({
      surface: 'slack',
      userId: 'U-OWNER',
      conversationKind: 'direct',
      text: 'deny: use the staging database instead',
    });
    expect(ingress.allowed).toBe(false);
    expect(ingress.reason).toBe('approval-reply-consumed');

    const decision = await decisionPromise;
    expect(decision.approved).toBe(false);
    // The guidance is MODEL-VISIBLE: it rides the structured declined decision
    // delivered to the waiting tool call as `reason` — not only the audit note —
    // so the model adapts ("use the staging database instead") instead of
    // seeing a bare deny.
    expect(decision.reason).toBe('use the staging database instead');
    const record = broker.listApprovals(10)[0]!;
    expect(record.status).toBe('denied');
    expect(record.decision?.reason).toBe('use the staging database instead');
    expect(record.audit.some((entry) => entry.note === 'use the staging database instead')).toBe(true);
  });

  test('an approve reply with trailing text delivers that steer to the running turn as the decision reason', async () => {
    const policy = makePolicyManager();
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    await policy.evaluateIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });
    const helper = makeHelper({ policy, broker, bindingSurface: 'slack' });

    const decisionPromise = broker.requestApproval({
      request: makeAskRequest('call-approve-steer-1'),
      routeId: 'route-1',
    });
    await Bun.sleep(5);

    const ingress = await helper.authorizeSurfaceIngress({
      surface: 'slack',
      userId: 'U-OWNER',
      conversationKind: 'direct',
      text: 'approve, but only touch the migrations directory',
    });
    expect(ingress.allowed).toBe(false);
    expect(ingress.reason).toBe('approval-reply-consumed');

    const decision = await decisionPromise;
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('but only touch the migrations directory');
    const record = broker.listApprovals(10)[0]!;
    expect(record.decision?.reason).toBe('but only touch the migrations directory');
  });

  test('an unknown sender reply never touches the pending ask', async () => {
    const policy = makePolicyManager();
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    await policy.evaluateIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });
    const helper = makeHelper({ policy, broker, bindingSurface: 'slack' });

    void broker.requestApproval({ request: makeAskRequest('call-guard-1'), routeId: 'route-1' });
    await Bun.sleep(5);

    const ingress = await helper.authorizeSurfaceIngress({
      surface: 'slack',
      userId: 'U-STRANGER',
      conversationKind: 'direct',
      text: 'approve',
    });
    expect(ingress.allowed).toBe(false);
    expect(ingress.reason).toBe('user-not-allowlisted');
    expect(broker.listApprovals(10)[0]!.status).toBe('pending');
  });

  test('non-verb owner text flows through as a normal message even with a pending ask', async () => {
    const policy = makePolicyManager();
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    await policy.evaluateIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct', text: 'hi' });
    const helper = makeHelper({ policy, broker, bindingSurface: 'slack' });

    void broker.requestApproval({ request: makeAskRequest('call-flow-1'), routeId: 'route-1' });
    await Bun.sleep(5);

    const ingress = await helper.authorizeSurfaceIngress({
      surface: 'slack',
      userId: 'U-OWNER',
      conversationKind: 'direct',
      text: 'how is the run going?',
    });
    expect(ingress.allowed).toBe(true);
    expect(broker.listApprovals(10)[0]!.status).toBe('pending');
  });
});

describe('approval reply verb parsing', () => {
  test('recognizes explicit verbs with optional steering notes and nothing else', () => {
    expect(parseApprovalReplyVerb('approve')).toEqual({ approved: true });
    expect(parseApprovalReplyVerb('yes')).toEqual({ approved: true });
    expect(parseApprovalReplyVerb('Deny')).toEqual({ approved: false });
    expect(parseApprovalReplyVerb('no, wait for me')).toEqual({ approved: false, note: 'wait for me' });
    expect(parseApprovalReplyVerb('approve: but only the first file')).toEqual({
      approved: true,
      note: 'but only the first file',
    });
    expect(parseApprovalReplyVerb('please approve this')).toBeNull();
    expect(parseApprovalReplyVerb('yesterday was fine')).toBeNull();
    expect(parseApprovalReplyVerb('')).toBeNull();
    expect(parseApprovalReplyVerb(undefined)).toBeNull();
  });
});
