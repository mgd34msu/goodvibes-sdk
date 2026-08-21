/**
 * surface-card-gate.test.ts
 *
 * The remote-channel card gate (docs/inbound-email.md §11.0), asserted at the
 * one shared hook every remote adapter passes through:
 * `SurfaceActions.authorizeSurfaceIngress`.
 *
 * The card number used throughout is `4111111111111111`, the published Visa
 * test value. It passes Luhn and belongs to no cardholder.
 *
 * What these cases are actually defending. `parseApprovalReplyVerb` treats
 * `no, <anything>` as a veto whose trailing text becomes the resolution
 * `note` AND the `reason` handed to the waiting tool call; `evaluateIngress`
 * writes `input.text.slice(0, 200)` into the channel policy audit trail and
 * schedules that trail to disk. So a veto typed with a card number in it had
 * two independent paths onto disk before this gate existed, and the gate only
 * closes them by running BEFORE both.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { DaemonSurfaceActionHelper } from '../packages/sdk/src/platform/daemon/surface-actions.ts';
import { handleNtfySurfacePayload } from '../packages/sdk/src/platform/adapters/ntfy/index.ts';
import { WorkProposalStore } from '../packages/sdk/src/platform/agents/work-proposal-store.ts';
import { logger } from '../packages/sdk/src/platform/utils/logger.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

const CARD = '4111111111111111';
const CARD_SPACED = '4111 1111 1111 1111';
const AGENT_TOPIC = 'goodvibes-agent';
const OWNER_ID = 'owner-1';

/**
 * Every fragment of the card that must not turn up anywhere. Four-digit
 * groupings are included because a "helpfully" truncated log line
 * (`…ending 1111`) is still a leak of the digits this gate exists to keep off
 * every durable surface.
 */
const CARD_FRAGMENTS = [CARD, CARD_SPACED, '411111', '4111'];

/** Captured logger calls: every message and payload the platform handed the logger. */
let loggedText: string[] = [];
let restoreLogger: (() => void) | null = null;

/**
 * Capture at the logger METHOD rather than at its file. The logger buffers and
 * flushes asynchronously and redacts on the way out; patching the methods
 * asserts the stricter property, that nothing card-shaped is ever PASSED to it
 * in the first place, so no redactor has to be right for the guarantee to hold.
 */
function captureLogger(): void {
  const original = {
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
    debug: logger.debug.bind(logger),
  };
  const record = (message: string, data?: Record<string, unknown>): void => {
    loggedText.push(message + (data ? ` ${JSON.stringify(data)}` : ''));
  };
  logger.info = record;
  logger.warn = record;
  logger.error = record;
  logger.debug = record;
  restoreLogger = () => {
    logger.info = original.info;
    logger.warn = original.warn;
    logger.error = original.error;
    logger.debug = original.debug;
  };
}

beforeEach(() => {
  loggedText = [];
  captureLogger();
});

afterEach(() => {
  restoreLogger?.();
  restoreLogger = null;
});

interface HarnessOptions {
  /** Seed a pending approval so approval-reply resolution has something to consume. */
  readonly pendingApproval?: boolean;
  /** Seed a pending work proposal so proposal-reply resolution has something to consume. */
  readonly pendingProposal?: boolean;
}

function buildHarness(options: HarnessOptions = {}) {
  /** Ordered record of which downstream stage ran, for the ordering assertions. */
  const stages: string[] = [];

  /** Every persistence tier a refused message must not reach, each captured separately. */
  const configStore = new Map<string, unknown>([
    ['surfaces.ntfy.enabled', true],
    ['surfaces.ntfy.agentTopic', AGENT_TOPIC],
    ['surfaces.ntfy.token', 'test-token'],
  ]);
  const secretsStore = new Map<string, string>([['ntfy/primary', 'test-secret']]);
  /** The channel-policy audit trail: what evaluateIngress persists, reproduced faithfully. */
  const policyAudit: Array<Record<string, unknown>> = [];
  /** Resolutions written through the approval broker, notes and steering reasons included. */
  const approvalResolutions: Array<Record<string, unknown>> = [];
  /** The transcript: agent tasks spawned, and message bodies submitted to a session. */
  const spawnTasks: string[] = [];
  const submittedBodies: string[] = [];
  /** Everything put on the channel. */
  const notices: Array<{ routeId: string | undefined; text: string }> = [];

  const proposals = disposables.add(new WorkProposalStore());
  if (options.pendingProposal) {
    const proposal = proposals.create({
      surfaceKind: 'ntfy',
      task: 'refactor the parser',
      summary: 'refactor the parser',
      ttlMs: 10 * 60_000,
      routeId: 'route-1',
      channelId: AGENT_TOPIC,
      userId: OWNER_ID,
    });
    // Only a DELIVERED proposal is answerable, listPending excludes the rest,
    // so without this the "nothing consumed it" assertion would be vacuous.
    proposals.markDelivered(proposal.id);
  }

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
  const policyRecord = { surface: 'ntfy', enabled: true, allowlistUserIds: [OWNER_ID], groupPolicies: [] };

  let agentSeq = 0;
  const context = {
    serviceRegistry: { resolveSecret: async (service: string, key: string) => secretsStore.get(`${service}/${key}`) ?? null },
    secretsManager: {
      get: (key: string) => secretsStore.get(key),
      set: (key: string, value: string) => { secretsStore.set(key, value); },
      getGlobalHome: () => undefined,
    },
    configManager: {
      get: (key: string) => configStore.get(key),
      set: (key: string, value: unknown) => { configStore.set(key, value); },
      getCategory: () => undefined,
    },
    routeBindings: {
      upsertBinding: async () => binding,
      getBinding: (id: string) => (id === binding.id ? binding : undefined),
      resolve: () => binding,
    },
    sessionBroker: {
      submitMessage: async (input: { body: string }) => {
        submittedBodies.push(input.body);
        return { mode: 'spawn', session, task: `Respond to this message: ${input.body}`, routeBinding: binding };
      },
      findPreferredSession: async () => null,
      listSessions: () => [],
      bindAgent: async () => undefined,
      getSession: (id: string) => (id === session.id ? session : undefined),
    },
    channelPolicy: {
      // Faithful to the real evaluateIngress in two respects that matter here:
      // it records the message text into a durable audit trail, and it is the
      // stage the gate must precede.
      evaluateIngress: async (input: { text?: string; surface: string; userId?: string }) => {
        stages.push('evaluateIngress');
        policyAudit.push({
          surface: input.surface,
          userId: input.userId,
          ...(input.text ? { text: input.text.slice(0, 200) } : {}),
        });
        return { allowed: true, reason: 'allowed', policy: policyRecord };
      },
      getPolicy: () => policyRecord,
    },
    controlPlaneGateway: { publishEvent: () => undefined },
    runtimeBus: { emit: () => undefined, on: () => () => undefined },
    companionChatManager: null,
    automationManager: { getRun: () => null },
    agentManager: { getStatus: () => null },
    trySpawnAgent: (input: { task: string }) => {
      agentSeq += 1;
      spawnTasks.push(input.task);
      return { id: `agent-${agentSeq}`, task: input.task, status: 'running', tools: [] };
    },
    queueSurfaceReplyFromBinding: () => undefined,
    queueWebhookReply: () => undefined,
    surfaceDeliveryEnabled: () => true,
    signWebhookPayload: () => '',
    handleApprovalAction: async () => new Response(null),
    approvalBroker: options.pendingApproval
      ? {
          listApprovals: () => {
            stages.push('listApprovals');
            return [{ id: 'approval-1', status: 'pending', routeId: 'route-1' }];
          },
          resolveApproval: async (id: string, resolution: Record<string, unknown>) => {
            stages.push('resolveApproval');
            approvalResolutions.push({ id, ...resolution });
          },
        }
      : undefined,
    workProposals: proposals,
    deliverSurfaceNotice: async (b: { id: string } | undefined, text: string) => {
      stages.push('deliverSurfaceNotice');
      notices.push({ routeId: b?.id, text });
      return { delivered: true };
    },
  };

  const helper = new DaemonSurfaceActionHelper(
    context as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0],
  );

  let messageSeq = 0;
  return {
    helper,
    stages,
    notices,
    proposals,
    /** Each durable tier, captured separately so a test can assert against it by name. */
    tiers: {
      config: () => JSON.stringify([...configStore.entries()]),
      secrets: () => JSON.stringify([...secretsStore.entries()]),
      policyAudit: () => JSON.stringify(policyAudit),
      approvalStore: () => JSON.stringify(approvalResolutions),
      workProposals: () => JSON.stringify(proposals.listPending()),
      transcript: () => JSON.stringify({ spawnTasks, submittedBodies }),
      notices: () => JSON.stringify(notices),
      logs: () => JSON.stringify(loggedText),
    },
    /** Call the shared hook exactly as every adapter does. */
    async ingress(text: string) {
      return helper.authorizeSurfaceIngress({
        surface: 'ntfy',
        userId: OWNER_ID,
        channelId: AGENT_TOPIC,
        threadId: AGENT_TOPIC,
        conversationKind: 'direct',
        text,
      } as unknown as Parameters<DaemonSurfaceActionHelper['authorizeSurfaceIngress']>[0]);
    },
    /** Drive the REAL ntfy adapter through the REAL adapter-context factory. */
    async send(message: string) {
      messageSeq += 1;
      return handleNtfySurfacePayload(
        { topic: AGENT_TOPIC, message, id: `ntfy-${messageSeq}-${Math.random()}` },
        helper.buildSurfaceAdapterContext(),
      );
    },
  };
}

function expectTierClean(label: string, contents: string): void {
  for (const fragment of CARD_FRAGMENTS) {
    if (contents.includes(fragment)) {
      throw new Error(`${label} contains the card fragment ${JSON.stringify(fragment)}: ${contents.slice(0, 400)}`);
    }
  }
}

describe('a card number on a remote channel is refused', () => {
  test('the decision is not-allowed and its reason names the shape, not the digits', async () => {
    const harness = buildHarness();
    const decision = await harness.ingress(`here is my card ${CARD}`);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('card-shapes-refused');
    expect(decision.reason).toContain('pan');
    expectTierClean('the decision reason', decision.reason);
  });

  test.each([
    ['solid', `${CARD}`],
    ['spaced', `pay with ${CARD_SPACED}`],
    ['hyphenated', 'use 4111-1111-1111-1111 please'],
    ['with the expiry right after it', `${CARD} 07/29`],
    ['with a cvv', `card ${CARD} cvv 123`],
  ])('a card written %s is refused', async (_label, text) => {
    const harness = buildHarness();
    const decision = await harness.ingress(text);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('card-shapes-refused');
  });

  test('the refused digits reach no durable tier — each asserted by name', async () => {
    const harness = buildHarness({ pendingApproval: true, pendingProposal: true });
    await harness.ingress(`no, charge my card ${CARD} cvv 123 expiry 07/29 instead`);

    expectTierClean('config', harness.tiers.config());
    expectTierClean('secrets', harness.tiers.secrets());
    expectTierClean('the channel policy audit trail', harness.tiers.policyAudit());
    // The approval store is the nearest thing this repo has to a payments
    // store: the payments capability itself lives in goodvibes-agent, which
    // §11.0 verified has no inbound channel path at all. This is the store a
    // veto's steering note would have been written into.
    expectTierClean('the approval store', harness.tiers.approvalStore());
    expectTierClean('the work proposal store', harness.tiers.workProposals());
    expectTierClean('the transcript', harness.tiers.transcript());
    expectTierClean('the logs', harness.tiers.logs());
    expectTierClean('the delivered notices', harness.tiers.notices());
  });

  test('the logs record the refusal but never the message', async () => {
    const harness = buildHarness();
    await harness.ingress(`my card is ${CARD}`);

    // Something WAS logged, an assertion over an empty log proves nothing.
    expect(loggedText.join('\n')).toContain('card-shaped');
    expectTierClean('the logs', harness.tiers.logs());
  });

  test('the refusal reply is delivered and contains none of the digits', async () => {
    const harness = buildHarness();
    await harness.ingress(`my card is ${CARD}`);

    expect(harness.notices).toHaveLength(1);
    const reply = harness.notices[0]!.text;
    expect(reply).toContain('card number');
    expectTierClean('the refusal reply', reply);
    // No numerals at all, so "did any part of the card survive" is answerable
    // by looking at the message.
    expect(reply).not.toMatch(/\d/);
  });

  test('the refusal goes back on the channel the message arrived on', async () => {
    const harness = buildHarness();
    await harness.ingress(`card ${CARD}`);
    expect(harness.notices[0]!.routeId).toBe('route-1');
  });
});

describe('the gate runs before everything that could store the message', () => {
  test('policy evaluation never sees a card-shaped message', async () => {
    const harness = buildHarness();
    await harness.ingress(`card ${CARD}`);

    expect(harness.stages).not.toContain('evaluateIngress');
    expect(harness.tiers.policyAudit()).toBe('[]');
  });

  test('proposal-reply and approval-reply resolution never see it either', async () => {
    const harness = buildHarness({ pendingApproval: true, pendingProposal: true });
    await harness.ingress(`no, my card is ${CARD}`);

    expect(harness.stages).not.toContain('listApprovals');
    expect(harness.stages).not.toContain('resolveApproval');
    // The pending proposal is untouched: nothing consumed it.
    expect(harness.proposals.listPending()).toHaveLength(1);
  });

  test('the only stage that runs is delivering the refusal', async () => {
    const harness = buildHarness({ pendingApproval: true, pendingProposal: true });
    await harness.ingress(`card ${CARD}`);
    expect(harness.stages).toEqual(['deliverSurfaceNotice']);
  });

  test('an ordinary message still reaches every downstream stage', async () => {
    // The control that gives the three assertions above their meaning: without
    // it, a gate that refused everything would pass them all.
    const harness = buildHarness({ pendingApproval: true });
    const decision = await harness.ingress('what is the status?');

    expect(decision.allowed).toBe(true);
    expect(harness.stages[0]).toBe('evaluateIngress');
    // Approval-reply resolution is reached by verbs only, so a status question
    // is the wrong probe for it, the 'no' case below covers that stage.
  });
});

describe('a veto carrying a card is refused, and he is told', () => {
  test('the veto is not silently swallowed', async () => {
    const harness = buildHarness({ pendingApproval: true });
    const decision = await harness.ingress(`no, that is not the card, use ${CARD}`);

    // Refused...
    expect(decision.allowed).toBe(false);
    // ...and the refusal reached him, on the same channel. Silence here is the
    // one silence that costs money: an unheard objection inside a veto window
    // elapses into a completed purchase.
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]!.text.toLowerCase()).toContain('vetoing');
  });

  test('the veto text never reaches the approval store as a steering note', async () => {
    // Without the gate, parseApprovalReplyVerb reads `no, <text>` as a deny
    // whose trailing text becomes both the audit note and the `reason` handed
    // to the waiting tool call. That is the path this closes.
    const harness = buildHarness({ pendingApproval: true });
    await harness.ingress(`no, that is not the card, use ${CARD}`);
    expect(harness.tiers.approvalStore()).toBe('[]');
    expectTierClean('the approval store', harness.tiers.approvalStore());
  });

  test('an approve or veto WITHOUT digits still resolves — the authority is untouched', async () => {
    // §11.0's distinction, asserted rather than trusted: remote surfaces keep
    // authority to say yes or no about a purchase. Only the instrument has no
    // path in.
    const harness = buildHarness({ pendingApproval: true });
    const decision = await harness.ingress('no');

    expect(decision.reason).toBe('approval-reply-consumed');
    expect(harness.stages).toContain('resolveApproval');
  });
});

describe('shapes that are far too common are not refused', () => {
  test.each([
    ['a three digit number', 'the answer is 123'],
    ['a four digit number', 'meet me in room 4021'],
    ['several short numbers', 'build 872 passed, 991 queued, 100 pending'],
    ['a bare MM/YY', 'the invoice is dated 07/26'],
    ['a date range', 'window is 03/27 to 11/27'],
    ['an order number', 'Order 10029384 shipped, tracking 1Z999AA10123456784'],
    ['two phone numbers', 'call 555 123 4567 or 555 987 6543'],
    ['a plain veto', 'no'],
    ['a plain approval', 'yes go ahead'],
  ])('%s is allowed through', async (_label, text) => {
    const harness = buildHarness();
    const decision = await harness.ingress(text);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).not.toContain('card-shapes-refused');
  });
});

describe('through a real adapter, not just the hook', () => {
  test('the ntfy adapter refuses a card and spawns nothing', async () => {
    const harness = buildHarness();
    await harness.send(`please charge ${CARD}`);

    expectTierClean('the transcript', harness.tiers.transcript());
    expectTierClean('the channel policy audit trail', harness.tiers.policyAudit());
    expect(harness.notices).toHaveLength(1);
  });

  test('the per-message origin cell is cleared, so a refused message is not readable downstream', async () => {
    // buildSurfaceAdapterContext parks the raw message in a closure cell for
    // the gated spawn path to classify. On a card refusal that cell is dropped,
    // so the guarantee does not rest on every adapter honouring the decision.
    const harness = buildHarness();
    const context = harness.helper.buildSurfaceAdapterContext();

    const refused = await context.authorizeSurfaceIngress({
      surface: 'ntfy',
      userId: OWNER_ID,
      channelId: AGENT_TOPIC,
      text: `charge ${CARD}`,
    } as unknown as Parameters<typeof context.authorizeSurfaceIngress>[0]);
    expect(refused.allowed).toBe(false);

    // Reaching the spawn path anyway must not surface the refused text.
    const spawned = context.trySpawnAgent(
      { mode: 'spawn', task: 'unrelated follow-up' },
      'surface-card-gate.test',
      'session-1',
    );
    expect(spawned).toBeDefined();
    expectTierClean('the transcript', harness.tiers.transcript());
  });
});

describe('every remote adapter call site is covered by the shared hook', () => {
  const ADAPTERS_DIR = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'adapters');

  /**
   * `github` is NOT a remote messaging channel and is deliberately not gated:
   * it is an HMAC-verified webhook from GitHub carrying issue and pull-request
   * text, with no `ChannelPolicyDecision` shape and no owner-facing reply
   * channel to refuse on. It is listed here so that its bypass is a recorded
   * decision rather than an oversight, and so that any NEW adapter which skips
   * the hook fails this test instead of shipping open.
   */
  const DOCUMENTED_NON_CHANNEL_ADAPTERS = new Set(['github']);

  function adapterDirs(): string[] {
    return readdirSync(ADAPTERS_DIR)
      .filter((entry) => statSync(join(ADAPTERS_DIR, entry)).isDirectory())
      .sort();
  }

  test('there are exactly nineteen call sites, and they all go through authorizeSurfaceIngress', () => {
    let total = 0;
    const perAdapter: Record<string, number> = {};
    for (const dir of adapterDirs()) {
      const source = readFileSync(join(ADAPTERS_DIR, dir, 'index.ts'), 'utf8');
      const count = source.match(/context\.authorizeSurfaceIngress\(/g)?.length ?? 0;
      perAdapter[dir] = count;
      total += count;
    }

    // §11.0's count, pinned. A new adapter raises it; this test is where that
    // is noticed, and where someone confirms the new one is gated.
    expect(total).toBe(19);
    expect(perAdapter).toEqual({
      bluebubbles: 1,
      discord: 3,
      github: 0,
      'google-chat': 1,
      homeassistant: 1,
      imessage: 1,
      matrix: 1,
      mattermost: 1,
      msteams: 1,
      ntfy: 1,
      signal: 1,
      slack: 3,
      telegram: 1,
      telephony: 1,
      webhook: 1,
      whatsapp: 1,
    });
  });

  /**
   * Every `trySpawnAgent` call site that is NOT preceded by an
   * `authorizeSurfaceIngress` call in an enclosing scope.
   *
   * Per CALL SITE, using the compiler's own tree. The predecessor of this
   * check was per FILE, "the file contains both strings somewhere", which
   * says nothing about a file that has one gated spawn and one ungated one.
   * An entirely ungated `context.trySpawnAgent({...})` appended to
   * `adapters/slack/index.ts` passed it, because slack's three legitimate
   * gates were still in the file.
   *
   * "Precedes" is judged by source position within an enclosing function, so a
   * handler that gates at the top and spawns inside a nested callback is
   * correctly seen as gated, and a spawn in a function that never gates is
   * not.
   */
  function ungatedSpawnSites(fileName: string, source: string): string[] {
    const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

    const callsNamed = (name: string): ts.CallExpression[] => {
      const found: ts.CallExpression[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const called = ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : (ts.isIdentifier(callee) ? callee.text : '');
          if (called === name) found.push(node);
        }
        ts.forEachChild(node, walk);
      };
      walk(tree);
      return found;
    };

    /**
     * Local functions in this file that reach the hook, directly or through
     * another local function.
     *
     * ntfy is why this exists rather than being over-engineering: its handler
     * gates by calling `authorizeNtfyPayload(...)`, a helper in the same file
     * that calls `context.authorizeSurfaceIngress` itself. A rule that only
     * recognised the literal call would report ntfy's one legitimate spawn as
     * ungated, a false alarm, which is how a structural gate gets muted.
     */
    const gatingFunctionNames = ((): ReadonlySet<string> => {
      const bodies = new Map<string, ts.Node>();
      const collect = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name) bodies.set(node.name.text, node);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          bodies.set(node.name.text, node.initializer);
        }
        ts.forEachChild(node, collect);
      };
      collect(tree);

      const calledNamesWithin = (scope: ts.Node): Set<string> => {
        const names = new Set<string>();
        const walk = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee)) names.add(callee.text);
            else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
          }
          ts.forEachChild(node, walk);
        };
        ts.forEachChild(scope, walk);
        return names;
      };

      const gating = new Set<string>();
      for (const [name, body] of bodies) {
        if (calledNamesWithin(body).has('authorizeSurfaceIngress')) gating.add(name);
      }
      // Fixed point, so a two-hop helper chain resolves too.
      for (let changed = true; changed;) {
        changed = false;
        for (const [name, body] of bodies) {
          if (gating.has(name)) continue;
          for (const called of calledNamesWithin(body)) {
            if (!gating.has(called)) continue;
            gating.add(name);
            changed = true;
            break;
          }
        }
      }
      return gating;
    })();

    const spawns = callsNamed('trySpawnAgent');
    const gates = [
      ...callsNamed('authorizeSurfaceIngress'),
      ...[...gatingFunctionNames].flatMap((name) => callsNamed(name)),
    ];

    // FUNCTION scopes only, deliberately not the source file. Counting the
    // file as a scope is exactly the per-file rule wearing an AST costume: a
    // gate in one handler would "cover" a spawn in a different handler further
    // down, which is the defect this replaces.
    const enclosingScopes = (node: ts.Node): ts.Node[] => {
      const scopes: ts.Node[] = [];
      for (let current = node.parent; current !== undefined; current = current.parent) {
        if (ts.isFunctionLike(current)) scopes.push(current);
      }
      return scopes;
    };

    const ungated: string[] = [];
    for (const spawn of spawns) {
      const scopes = enclosingScopes(spawn);
      const covered = gates.some((gate) => gate.end <= spawn.getStart(tree)
        && scopes.some((scope) => gate.getStart(tree) >= scope.getStart(tree) && gate.end <= scope.end));
      if (!covered) {
        const { line } = tree.getLineAndCharacterOfPosition(spawn.getStart(tree));
        ungated.push(`${fileName}:${String(line + 1)}`);
      }
    }
    return ungated;
  }

  test('the call-site check catches an ungated spawn that a per-file check waves through', () => {
    // The counter-example the old check passed. One gated handler and one
    // ungated one in the SAME file: both strings are present, so "contains
    // both somewhere" says clean, and the second spawn is wide open.
    const mixed = [
      "export async function gated(context: C): Promise<void> {",
      "  const decision = await context.authorizeSurfaceIngress({ surface: 'x' });",
      "  if (!decision.allowed) return;",
      "  context.trySpawnAgent({ mode: 'spawn' });",
      "}",
      "export function ungated(context: C): void {",
      "  context.trySpawnAgent({ mode: 'spawn' });",
      "}",
    ].join('\n');

    // The per-file rule this replaced.
    expect(/context\.trySpawnAgent\(/.test(mixed) && /context\.authorizeSurfaceIngress\(/.test(mixed)).toBe(true);
    // The per-call-site rule.
    expect(ungatedSpawnSites('mixed.ts', mixed)).toEqual(['mixed.ts:7']);
  });

  test('the call-site check accepts a gate in an enclosing scope, not only the same block', () => {
    const nested = [
      "export async function handler(context: C): Promise<void> {",
      "  const decision = await context.authorizeSurfaceIngress({ surface: 'x' });",
      "  if (!decision.allowed) return;",
      "  await Promise.all(items.map((item) => {",
      "    return context.trySpawnAgent({ mode: 'spawn', task: item });",
      "  }));",
      "}",
    ].join('\n');
    expect(ungatedSpawnSites('nested.ts', nested)).toEqual([]);
  });

  test('no adapter reaches a spawn without passing the hook first', () => {
    const bypassing: string[] = [];
    let spawnSitesSeen = 0;
    for (const dir of adapterDirs()) {
      if (DOCUMENTED_NON_CHANNEL_ADAPTERS.has(dir)) continue;
      const file = join(ADAPTERS_DIR, dir, 'index.ts');
      const source = readFileSync(file, 'utf8');
      spawnSitesSeen += (source.match(/trySpawnAgent\(/g) ?? []).length;
      bypassing.push(...ungatedSpawnSites(`${dir}/index.ts`, source));
    }
    expect(bypassing).toEqual([]);
    // There ARE spawn sites to check. Without this the assertion above would
    // hold just as well against a rename that made every call site invisible
    // to the walk.
    expect(spawnSitesSeen).toBeGreaterThan(0);
  });

  test('the card gate is installed on the shared hook, not per adapter', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'daemon', 'surface-actions.ts'),
      'utf8',
    );
    expect(source).toContain('refuseCardShapedIngress');

    // Nothing under adapters/ carries its own copy, a per-adapter fix is what
    // leaves the other seventeen open.
    for (const dir of adapterDirs()) {
      const adapterSource = readFileSync(join(ADAPTERS_DIR, dir, 'index.ts'), 'utf8');
      expect(adapterSource).not.toContain('detectCardShapes');
      expect(adapterSource).not.toContain('refuseCardShapedIngress');
    }
  });
});
