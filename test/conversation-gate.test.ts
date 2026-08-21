/**
 * Conversation-first spawn gate.
 *
 * The incident this covers: the single word "Testing" sent to the ntfy agent
 * topic started a full write-review-fix-confirm chain, spawned a second agent,
 * and produced 23 notifications, when a conversational reply was what was
 * wanted. Verifies the decision half of the fix:
 * - a trivial message classifies as conversation (no work, no chain)
 * - a work request classifies as work, which is what triggers a proposal
 * - agreement and refusal parse from natural phrasing, not a magic token
 * - configuration is bounded, and 'off' restores the previous behavior
 * - the TUI is exempt at the surface level
 */
import { describe, expect, test } from 'bun:test';
import {
  CONVERSATION_GATE_DEFAULTS,
  CONVERSATION_GATE_DEFAULT_SURFACES,
  classifyInboundIntent,
  isGatedSurface,
  parseWorkProposalReply,
  readConversationGateConfig,
  renderWorkProposalMessage,
  summarizeWorkRequest,
  type ConversationGateConfig,
} from '../packages/sdk/src/platform/agents/conversation-gate.ts';

function reader(scalars: Record<string, unknown>, category?: unknown) {
  return {
    get: (key: string) => scalars[key],
    getCategory: () => category,
  };
}

describe('classifyInboundIntent', () => {
  test('the reported message — a bare "Testing" — is conversation, not work', () => {
    const intent = classifyInboundIntent('Testing');
    expect(intent.kind).toBe('conversation');
  });

  test.each([
    'hey',
    'hello there',
    'thanks!',
    'what is the current status?',
    'how does the reply pipeline work?',
    'why did that fail',
    'nice, that looks right',
    'are you around',
    'testing 1 2 3',
    'just checking in',
  ])('conversation: %p', (text) => {
    expect(classifyInboundIntent(text).kind).toBe('conversation');
  });

  test.each([
    'fix the login bug',
    'please add a retry to the uploader',
    'can you refactor the session broker',
    'go ahead and rename that helper',
    'implement the delta rendering',
    "let's upgrade the ntfy client",
    'hey, could you please review the diff',
    'update src/platform/daemon/facade.ts to use the new helper',
    'we need to migrate the store',
  ])('work request: %p', (text) => {
    expect(classifyInboundIntent(text).kind).toBe('work');
  });

  test('a work verb in a later clause still counts', () => {
    const intent = classifyInboundIntent('thanks! now fix the failing gate');
    expect(intent.kind).toBe('work');
  });

  test('a question ABOUT a work verb is not a work request', () => {
    expect(classifyInboundIntent('how do I review a chain?').kind).toBe('conversation');
    expect(classifyInboundIntent('what does deploy do here').kind).toBe('conversation');
  });

  test('a code reference plus a work verb is work even without an imperative', () => {
    const intent = classifyInboundIntent('the `reply-pipeline.ts` progress path needs a fix');
    expect(intent.kind).toBe('work');
  });

  test('an empty message is conversation', () => {
    expect(classifyInboundIntent('').kind).toBe('conversation');
    expect(classifyInboundIntent(undefined).kind).toBe('conversation');
  });

  test('a work intent carries a one-line summary', () => {
    const intent = classifyInboundIntent('fix the login bug');
    expect(intent.kind).toBe('work');
    if (intent.kind !== 'work') throw new Error('unreachable');
    expect(intent.summary).toBe('fix the login bug');
  });
});

describe('summarizeWorkRequest', () => {
  test('collapses whitespace and stays one short line', () => {
    const summary = summarizeWorkRequest(`fix   the\n\nlogin bug`);
    expect(summary).toBe('fix the login bug');
    expect(summary).not.toContain('\n');
  });

  test('truncates long requests', () => {
    const summary = summarizeWorkRequest('x'.repeat(400));
    expect(summary.length).toBeLessThanOrEqual(90);
  });
});

describe('parseWorkProposalReply', () => {
  test.each(['yes', 'Yes please', 'yeah', 'yep', 'y', 'ok', 'sure', 'go ahead', 'do it', 'ship it', 'sounds good', 'proceed'])(
    'affirmative: %p',
    (text) => {
      expect(parseWorkProposalReply(text)?.decision).toBe('affirmative');
    },
  );

  test.each(['no', 'nope', 'nah', "don't", 'not now', 'cancel', 'skip', 'never mind', 'hold off', 'no thanks'])(
    'negative: %p',
    (text) => {
      expect(parseWorkProposalReply(text)?.decision).toBe('negative');
    },
  );

  test('unrelated conversation is not an answer', () => {
    expect(parseWorkProposalReply('what is the status')).toBeNull();
    expect(parseWorkProposalReply('deploy the thing')).toBeNull();
    expect(parseWorkProposalReply('')).toBeNull();
  });

  test('trailing text becomes steering guidance', () => {
    const reply = parseWorkProposalReply('yes but only touch the ntfy adapter');
    expect(reply?.decision).toBe('affirmative');
    expect(reply?.note).toBe('but only touch the ntfy adapter');
  });

  test('a long paragraph starting with "no" is conversation, not an answer', () => {
    const paragraph = `no ${'context '.repeat(40)}`;
    expect(parseWorkProposalReply(paragraph)).toBeNull();
  });

  // The severe one, observed live: a brand-new request opening with an
  // ordinary polite word was read as "yes" to an unrelated pending proposal,
  // which was accepted and launched a chain on the OLD task with the new
  // sentence demoted to "Additional direction from the owner". The owner had
  // never even seen the proposal. A reply must be ONLY an answer.
  test.each([
    'Please refactor the parser in src/parse.ts',
    'please add a test for the login flow',
    'pls fix the changelog',
    'go look at the deploy logs',
    'go ahead and rename the config key',
    'start the daemon on port 9000',
    'begin the migration in packages/sdk',
    'proceed with rewriting the release script',
    'sure, can you fix the login bug',
    'ok now deploy the web app',
    'yes update packages/sdk/src/index.ts',
    'yeah, write the migration guide',
    'k, ship the release notes',
  ])('a request that merely opens like an answer is not an answer: %p', (text) => {
    expect(parseWorkProposalReply(text)).toBeNull();
  });

  // The same rule on the refusal side: these are verbs taking an object.
  test.each([
    'stop the daemon',
    'cancel the release and ship the hotfix',
    'skip the slow tests in test/integration',
    "don't forget to bump the changelog",
    'later today, migrate the store',
  ])('a request that merely opens like a refusal is not an answer: %p', (text) => {
    expect(parseWorkProposalReply(text)).toBeNull();
  });

  // The words above are still answers when they are the WHOLE answer, the
  // owner types these from a phone and must not be forced to a magic token.
  test.each([
    'please', 'pls', 'go', 'start', 'begin', 'proceed',
    'go ahead', 'go for it', 'start it', 'ok go', 'please go ahead',
    'ok then', 'sure thing', 'yeah go for it', 'approved', 'confirmed',
  ])('a bare answer still reads as agreement: %p', (text) => {
    expect(parseWorkProposalReply(text)?.decision).toBe('affirmative');
  });

  test.each(['stop', 'cancel', 'skip', 'abort', 'later', "don't", 'do not', 'drop it', 'forget it'])(
    'a bare refusal still reads as refusal: %p',
    (text) => {
      expect(parseWorkProposalReply(text)?.decision).toBe('negative');
    },
  );

  test('a short qualifier still rides along, a second instruction does not', () => {
    expect(parseWorkProposalReply('yes but only touch the ntfy adapter')?.note)
      .toBe('but only touch the ntfy adapter');
    // Same opener, but the trailer is its own job, the whole message is a
    // request and must flow through rather than steer somebody else's task.
    expect(parseWorkProposalReply('yes and also rewrite the telegram adapter')).toBeNull();
  });
});

describe('readConversationGateConfig', () => {
  test('defaults to propose mode — conversation first is the shipped behavior', () => {
    const config = readConversationGateConfig(reader({}));
    expect(config.mode).toBe('propose');
    expect(config).toEqual(CONVERSATION_GATE_DEFAULTS);
  });

  test('reads a configured mode', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.mode': 'off' })).mode).toBe('off');
    expect(readConversationGateConfig(reader({ 'conversationGate.mode': 'confirm-all' })).mode).toBe('confirm-all');
  });

  test('rejects a bogus mode rather than disabling the gate', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.mode': 'nonsense' })).mode).toBe('propose');
  });

  test('clamps the TTL so a proposal can never be unanswerable or immortal', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.proposalTtlMs': 1 })).proposalTtlMs).toBe(60_000);
    expect(readConversationGateConfig(reader({ 'conversationGate.proposalTtlMs': 1e12 })).proposalTtlMs).toBe(24 * 60 * 60_000);
    expect(readConversationGateConfig(reader({ 'conversationGate.proposalTtlMs': Number.NaN })).proposalTtlMs)
      .toBe(CONVERSATION_GATE_DEFAULTS.proposalTtlMs);
  });

  test('clamps the pending cap', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.maxPendingProposals': 0 })).maxPendingProposals).toBe(1);
    expect(readConversationGateConfig(reader({ 'conversationGate.maxPendingProposals': 9_999 })).maxPendingProposals).toBe(200);
  });

  test('reads gatedSurfaces from the category, and ignores junk entries', () => {
    const config = readConversationGateConfig(reader({}, { gatedSurfaces: ['ntfy', '', 42, 'telegram'] }));
    expect(config.gatedSurfaces).toEqual(['ntfy', 'telegram']);
  });

  test('a throwing config reader falls back to defaults rather than crashing ingress', () => {
    const hostile = {
      get: () => { throw new Error('no such key'); },
      getCategory: () => { throw new Error('no such category'); },
    };
    expect(readConversationGateConfig(hostile)).toEqual(CONVERSATION_GATE_DEFAULTS);
  });
});

describe('isGatedSurface', () => {
  const config: ConversationGateConfig = CONVERSATION_GATE_DEFAULTS;

  test('channel surfaces are gated', () => {
    for (const surface of ['ntfy', 'telegram', 'slack', 'discord', 'homeassistant']) {
      expect(isGatedSurface(config, surface)).toBe(true);
    }
  });

  test('goodvibes-tui is exempt — the operator typed it in front of the terminal', () => {
    expect(isGatedSurface(config, 'tui')).toBe(false);
    expect(isGatedSurface(config, 'local')).toBe(false);
  });

  test('generic webhooks are not gated — a registered webhook is pre-authorized automation', () => {
    expect(isGatedSurface(config, 'webhook')).toBe(false);
  });

  test('an unknown/undeclared surface is gated, so a new adapter cannot silently opt out', () => {
    expect(isGatedSurface(config, undefined)).toBe(true);
  });

  test('email is gated, so a mail adapter written the ordinary way cannot spawn work', () => {
    // The fail-closed rule only covers a surface the gate cannot identify:
    // `undefined` returns true above. 'email' is a known, non-TUI string, so
    // it skips that branch entirely and falls through to
    // `gatedSurfaces.includes(...)`, which was false. An adapter passing
    // `surface: 'email'` would therefore have let any message that reads as a
    // work request spawn an agent immediately, skipping propose-and-wait.
    //
    // Nothing in the inbound-mail design reaches this gate: the watcher is
    // handed a context with no spawn capability in it at all. This covers the
    // person who wires email the ordinary way later, without reading that.
    expect(isGatedSurface(config, 'email')).toBe(true);
    expect(CONVERSATION_GATE_DEFAULT_SURFACES).toContain('email');
  });

  test('mode off disables the gate entirely', () => {
    expect(isGatedSurface({ ...config, mode: 'off' }, 'ntfy')).toBe(false);
  });
});

describe('renderWorkProposalMessage', () => {
  test('is short enough to read on a lock screen and says how to answer', () => {
    const message = renderWorkProposalMessage({ summary: 'fix the login bug', expiresInMs: 30 * 60_000 });
    const lines = message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('fix the login bug');
    expect(message).toContain('yes');
    expect(message).toContain('30m');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });
});
