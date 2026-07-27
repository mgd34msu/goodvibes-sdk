/**
 * telegram-conflict-policy.test.ts
 *
 * Every branch of the 409 decision, provable with no socket and no clock.
 *
 * The live failure this pins: inbound Telegram went permanently dead because a
 * 409 was terminal down a branch it should never have been on. Telegram uses
 * 409 for a registered webhook AND for another process polling the same token,
 * and they were told apart by matching the description against "terminated by
 * other getUpdates" — with webhook as the fallback for everything else. Any
 * description that did not match that exact phrase was read as a webhook
 * conflict, and the webhook branch gave up after three tries.
 *
 * The two properties asserted throughout:
 *   1. `getWebhookInfo` decides, not the description string.
 *   2. Nothing is ever terminal — there is no give-up action to return.
 */

import { describe, expect, test } from 'bun:test';
import {
  CONFLICT_ESCALATION_ATTEMPTS,
  classifyTelegramConflict,
  type TelegramConflictAction,
} from '../packages/sdk/src/platform/channels/telegram/conflict-policy.ts';

const WEBHOOK_DESCRIPTION = "Conflict: can't use getUpdates method while webhook is active";
const OTHER_CONSUMER_DESCRIPTION = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
const BEYOND = CONFLICT_ESCALATION_ATTEMPTS + 1;

function classify(overrides: Partial<Parameters<typeof classifyTelegramConflict>[0]> = {}): TelegramConflictAction {
  return classifyTelegramConflict({
    description: OTHER_CONSUMER_DESCRIPTION,
    webhookUrl: null,
    clustered: false,
    attempt: 1,
    ...overrides,
  });
}

describe('getWebhookInfo is the authority, not the description', () => {
  test('a registered webhook is a webhook conflict, whatever the description said', () => {
    const action = classify({ webhookUrl: 'https://example.com/hook', description: OTHER_CONSUMER_DESCRIPTION });
    expect(action.kind).toBe('clear-webhook');
  });

  test('no registered webhook plus a webhook-blaming description: cleared first, then ruled out', () => {
    // First attempts clear the (possibly stale) webhook — deleteWebhook is
    // idempotent, so trying costs nothing.
    const early = classify({ webhookUrl: null, description: WEBHOOK_DESCRIPTION, attempt: 1 });
    expect(early.kind).toBe('clear-webhook');
    expect(early.escalate).toBe(false);

    // Once clearing has demonstrably not helped, the description is overruled
    // by the evidence. THIS is the live repro: the old code called it
    // unrecoverable here and stopped polling for good.
    const late = classify({ webhookUrl: null, description: WEBHOOK_DESCRIPTION, attempt: BEYOND });
    expect(late.kind).toBe('competing-consumer');
    if (late.kind !== 'competing-consumer') throw new Error('unreachable');
    expect(late.ruledOutWebhook).toBe(true);
    expect(late.reason).toContain('no webhook registered');
    expect(late.reason).toContain('another process is already long-polling');
  });

  test('an empty-string webhook url counts as no webhook', () => {
    const action = classify({ webhookUrl: '   ', description: OTHER_CONSUMER_DESCRIPTION });
    expect(action.kind).toBe('competing-consumer');
  });

  test('a 409 with no usable description at all is a competing consumer, the recoverable reading', () => {
    // The old fallback sent this to the webhook branch, which gave up. An
    // unreadable description must never be the reason a surface dies.
    const action = classify({ description: 'HTTP 409', webhookUrl: null });
    expect(action.kind).toBe('competing-consumer');
    if (action.kind !== 'competing-consumer') throw new Error('unreachable');
    expect(action.ruledOutWebhook).toBe(false);
  });

  test('an empty description does not throw or match a webhook', () => {
    const action = classify({ description: '', webhookUrl: null });
    expect(action.kind).toBe('competing-consumer');
    expect(action.reason).toContain('no description');
  });
});

describe('nothing is ever terminal', () => {
  const everyShape: readonly (Parameters<typeof classifyTelegramConflict>[0])[] = [
    { description: WEBHOOK_DESCRIPTION, webhookUrl: 'https://example.com/hook', clustered: false, attempt: 1 },
    { description: WEBHOOK_DESCRIPTION, webhookUrl: 'https://example.com/hook', clustered: true, attempt: 99 },
    { description: WEBHOOK_DESCRIPTION, webhookUrl: null, clustered: false, attempt: 99 },
    { description: OTHER_CONSUMER_DESCRIPTION, webhookUrl: null, clustered: false, attempt: 99 },
    { description: OTHER_CONSUMER_DESCRIPTION, webhookUrl: null, clustered: true, attempt: 99 },
    { description: 'HTTP 409', webhookUrl: null, clustered: false, attempt: 1_000 },
  ];

  test.each(everyShape)('%o still yields an action to take, never a stop', (input) => {
    const action = classifyTelegramConflict(input);
    expect(['clear-webhook', 'competing-consumer']).toContain(action.kind);
  });
});

describe('what a person is told', () => {
  test('a proven stuck webhook names the fix and promises recovery', () => {
    const action = classify({ webhookUrl: 'https://stuck.example.com/hook', attempt: BEYOND });
    expect(action.kind).toBe('clear-webhook');
    expect(action.escalate).toBe(true);
    expect(action.reason).toContain('surfaces.telegram.mode=webhook');
    expect(action.reason).toContain('https://stuck.example.com/hook');
    // The half that was missing: it comes back on its own.
    expect(action.reason).toContain('will resume by itself');
  });

  test('clustering ON says it is deferring to the election', () => {
    const action = classify({ clustered: true });
    expect(action.reason).toContain('leader election');
  });

  test('clustering OFF says why it retries instead of standing down', () => {
    const action = classify({ clustered: false });
    // The precise reason the live failure was permanent: the designed response
    // was "stand down", and with clustering off there was nothing to stand
    // down to.
    expect(action.reason).toContain('Clustering is off');
    expect(action.reason).toContain('backing off and retrying');
    expect(action.reason).toContain('transient');
  });

  test('escalation is a volume control, not a give-up count', () => {
    const quiet = classify({ attempt: CONFLICT_ESCALATION_ATTEMPTS });
    const loud = classify({ attempt: BEYOND });
    expect(quiet.escalate).toBe(false);
    expect(loud.escalate).toBe(true);
    // Same action either way — only the loudness changed.
    expect(quiet.kind).toBe(loud.kind);
  });
});
