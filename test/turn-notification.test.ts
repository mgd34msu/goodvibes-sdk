/**
 * Notifications name the work (owner ruling 2026-09-29): every channel names
 * the turn and says how it ended; behavior.notificationsMetadataOnly (default
 * off) reduces every channel to metadata.
 */
import { describe, expect, test } from 'bun:test';
import {
  TurnActivityTally,
  buildApprovalNotification,
  buildBudgetNotification,
  buildTurnNotification,
  buildTurnNotificationLine,
  describeToolTarget,
  formatElapsed,
  formatWebhookText,
  readNotificationsMetadataOnly,
  resolveTurnName,
  trimAtWordBoundary,
  type TurnNotificationFacts,
} from '../packages/sdk/src/platform/runtime/operations.js';

const LONG_ASK = 'Refactor the authentication middleware so expired sessions redirect to the login page instead of throwing a 500 error';

const on = { metadataOnly: true } as const;
const off = { metadataOnly: false } as const;

function facts(outcome: TurnNotificationFacts['outcome'], extra: Partial<TurnNotificationFacts> = {}): TurnNotificationFacts {
  return { outcome, elapsedMs: 83_000, name: resolveTurnName({ turnText: LONG_ASK }), sessionId: 'abcdef1234567890', ...extra };
}

/** True when `trimmed` ends on a word of `source` (plus the ellipsis). */
function endsOnWordBoundary(trimmed: string, source: string): boolean {
  if (!trimmed.endsWith('…')) return source.startsWith(trimmed);
  const head = trimmed.slice(0, -1);
  return source.startsWith(head) && (source[head.length] === ' ' || /[\s,.;:]/.test(source[head.length] ?? ''));
}

describe('the privacy setting reader', () => {
  test('an unset value reads as off, true/"true" read as on', () => {
    expect(readNotificationsMetadataOnly(() => undefined)).toBe(false);
    expect(readNotificationsMetadataOnly(() => true)).toBe(true);
    expect(readNotificationsMetadataOnly(() => 'true')).toBe(true);
    expect(readNotificationsMetadataOnly(() => false)).toBe(false);
  });
});

describe('naming the turn', () => {
  test('trims at a word boundary and marks the cut', () => {
    const trimmed = trimAtWordBoundary(LONG_ASK, 40);
    expect(trimmed.length).toBeLessThanOrEqual(40);
    expect(trimmed.endsWith('…')).toBe(true);
    expect(endsOnWordBoundary(trimmed, LONG_ASK)).toBe(true);
    expect(trimmed).toBe('Refactor the authentication middleware…');
  });

  test('takes the first non-empty line and collapses whitespace', () => {
    expect(trimAtWordBoundary('\n\n  fix   the tests  \nthen push', 60)).toBe('fix the tests');
  });

  test('a dangling connector word is not left before the ellipsis', () => {
    expect(trimAtWordBoundary('fix the login and the logout pages', 22)).toBe('fix the login…');
    expect(trimAtWordBoundary('Refactor the authentication middleware so expired sessions redirect', 43)).toBe('Refactor the authentication middleware…');
  });

  test('a single word longer than the budget is cut mid-word', () => {
    expect(trimAtWordBoundary('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  test('a user-set title wins; otherwise the turn message; otherwise the derived title', () => {
    expect(resolveTurnName({ title: 'Login work', titleSource: 'user', turnText: 'run the tests' })).toBe('Login work');
    expect(resolveTurnName({ title: 'first message of the session', titleSource: 'system', turnText: 'run the tests' })).toBe('run the tests');
    expect(resolveTurnName({ title: 'first message of the session', titleSource: 'system', turnText: '' })).toBe('first message of the session');
    expect(resolveTurnName({})).toBeNull();
  });
});

describe('desktop text for completed, failed and cancelled turns', () => {
  test('completed: title is the turn name, body says done with the counts', () => {
    const text = buildTurnNotification(facts('completed', { filesChanged: 2, toolCalls: 5, agentsStarted: 1, reviewScore: 9.5 }), off);
    expect(text.title).toBe('Refactor the authentication middleware so expired sessions…');
    expect(text.title.length).toBeLessThanOrEqual(60);
    expect(endsOnWordBoundary(text.title, LONG_ASK)).toBe(true);
    expect(text.body).toBe('Done in 1m 23s, 2 files changed, 5 tool calls, 1 agent started, review 9.5/10');
  });

  test('failed: body carries the reason', () => {
    const text = buildTurnNotification(facts('failed', { reason: 'Provider returned HTTP 500 (upstream timeout)' }), off);
    expect(text.title).toBe('Refactor the authentication middleware so expired sessions…');
    expect(text.body).toBe('Failed after 1m 23s: Provider returned HTTP 500 (upstream timeout)');
  });

  test('cancelled: body says cancelled, the bare "cancelled" reason is not repeated', () => {
    const text = buildTurnNotification(facts('cancelled', { reason: 'cancelled' }), off);
    expect(text.body).toBe('Cancelled after 1m 23s');
  });

  test('with no name the title falls back to the outcome', () => {
    expect(buildTurnNotification(facts('completed', { name: null }), off).title).toBe('GoodVibes: turn done');
  });

  test('metadata only: no name, no reason, session prefix instead', () => {
    for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
      const text = buildTurnNotification(facts(outcome, { reason: 'secret stack trace', filesChanged: 3 }), on);
      expect(text.title).toBe(`GoodVibes: turn ${outcome === 'completed' ? 'done' : outcome}`);
      expect(text.title).not.toContain('Refactor');
      expect(text.body).not.toContain('Refactor');
      expect(text.body).not.toContain('secret');
      expect(text.body).toContain('3 files changed');
      expect(text.body).toContain('session abcdef12');
    }
  });

  test('elapsed reads in plain units', () => {
    expect(formatElapsed(4_000)).toBe('4s');
    expect(formatElapsed(120_000)).toBe('2m');
    expect(formatElapsed(3_723_000)).toBe('1h 2m');
  });
});

describe('one-line (OSC 9) and webhook text', () => {
  test('the line fits the budget, keeps the outcome whole and trims the name at a word', () => {
    for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
      const line = buildTurnNotificationLine(facts(outcome, { reason: 'The provider refused the request' }), off, 90);
      expect(line.length).toBeLessThanOrEqual(90);
      const [name, body] = line.split(': ', 2) as [string, string];
      expect(endsOnWordBoundary(name, LONG_ASK)).toBe(true);
      expect(body.startsWith(outcome === 'completed' ? 'Done' : outcome === 'failed' ? 'Failed' : 'Cancelled')).toBe(true);
    }
  });

  test('metadata-only line carries no name', () => {
    const line = buildTurnNotificationLine(facts('failed', { reason: 'boom' }), on);
    expect(line).toBe('GoodVibes: turn failed: Failed after 1m 23s, session abcdef12');
  });

  test('webhook text is title line then outcome line', () => {
    const webhook = formatWebhookText(buildTurnNotification(facts('completed', { filesChanged: 1 }), off));
    expect(webhook).toBe('Refactor the authentication middleware so expired sessions…\nDone in 1m 23s, 1 file changed');
  });
});

describe('approval and budget notices', () => {
  test('approval names the command and the turn; metadata only keeps tool + category', () => {
    const target = describeToolTarget({ commands: [{ cmd: 'bun test src/auth' }] });
    expect(target).toBe('bun test src/auth');
    const named = buildApprovalNotification({ tool: 'exec', category: 'execute', target, turnName: 'Fix the login redirect' }, off);
    expect(named).toEqual({ title: 'Approval needed: Fix the login redirect', body: 'exec is waiting for approval: bun test src/auth' });
    const meta = buildApprovalNotification({ tool: 'exec', category: 'execute', target, turnName: 'Fix the login redirect' }, on);
    expect(meta).toEqual({ title: 'GoodVibes: approval needed', body: 'exec (execute) is waiting for approval' });
  });

  test('describeToolTarget reads write/edit paths and the analysis target', () => {
    expect(describeToolTarget({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] })).toBe('a.ts (+1 more)');
    expect(describeToolTarget({ edits: [{ path: 'a.ts' }, { path: 'a.ts' }] })).toBe('a.ts');
    expect(describeToolTarget({}, 'https://example.com')).toBe('https://example.com');
    expect(describeToolTarget({})).toBeNull();
  });

  test('budget names the budget and the turn; metadata only keeps the numbers', () => {
    const named = buildBudgetNotification({ sessionCostUsd: 1.234, budgetUsd: 1, sessionId: 'abcdef1234', turnName: 'Fix the login redirect' }, off);
    expect(named).toEqual({ title: 'Budget passed: Fix the login redirect', body: 'Session cost $1.23 passed the $1.00 session budget during this turn' });
    const meta = buildBudgetNotification({ sessionCostUsd: 1.234, budgetUsd: 1, sessionId: 'abcdef1234', turnName: 'Fix the login redirect' }, on);
    expect(meta).toEqual({ title: 'GoodVibes: budget passed', body: 'Session cost $1.23 passed the $1.00 budget, session abcdef12' });
  });
});

describe('TurnActivityTally', () => {
  test('counts tool calls, distinct changed files, agents and the latest review score', () => {
    const tally = new TurnActivityTally();
    tally.noteToolReceived('c1', 'write', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    tally.noteToolReceived('c2', 'edit', { edits: [{ path: 'a.ts' }] });
    tally.noteToolReceived('c3', 'edit', { edits: [{ path: 'c.ts' }] });
    tally.noteToolReceived('c4', 'write', { files: [{ path: 'd.ts' }], dry_run: true });
    tally.noteToolSucceeded('c1');
    tally.noteToolSucceeded('c2');
    tally.noteToolFailed('c3');
    tally.noteToolSucceeded('c4');
    tally.noteToolSucceeded('c5');
    tally.noteAgentStarted();
    tally.noteReviewScore(8);
    tally.noteReviewScore(9.2);
    expect(tally.snapshot()).toEqual({ toolCalls: 5, filesChanged: 2, agentsStarted: 1, reviewScore: 9.2 });
    tally.reset();
    expect(tally.snapshot()).toEqual({ toolCalls: 0, filesChanged: 0, agentsStarted: 0, reviewScore: null });
  });
});
