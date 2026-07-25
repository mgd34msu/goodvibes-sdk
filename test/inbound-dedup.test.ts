/**
 * Duplicate inbound delivery — the double-agent-spawn defect.
 *
 * One ntfy message produced two agent runs ("Agent completed in 20365ms" and
 * "in 28942ms"). The same message reaches handleNtfySurfacePayload from two
 * independent routes — the long-lived JSON subscription and the HTTP webhook —
 * and the subscription's own seen-id cache is scoped to a single subscribe
 * call, so it cannot see the other copy. Each delivery ran the full pipeline.
 *
 * The claim store is module-scoped precisely so both routes share it.
 */
import { describe, expect, test } from 'bun:test';
import { InboundMessageDedup, inboundDedupKey } from '../packages/sdk/src/platform/adapters/inbound-dedup.ts';

describe('InboundMessageDedup', () => {
  test('the first delivery is claimed and the second is not', () => {
    const dedup = new InboundMessageDedup();
    const key = inboundDedupKey('ntfy', 'goodvibes-agent', 'msg-1');
    expect(dedup.claim(key)).toBe(true);
    expect(dedup.claim(key)).toBe(false);
  });

  test('two independent routes delivering one message spawn once', () => {
    const dedup = new InboundMessageDedup();
    const key = inboundDedupKey('ntfy', 'goodvibes-agent', 'msg-1');
    const fromSubscription = dedup.claim(key);
    const fromWebhook = dedup.claim(key);
    expect([fromSubscription, fromWebhook].filter(Boolean)).toHaveLength(1);
  });

  test('different messages are each claimed', () => {
    const dedup = new InboundMessageDedup();
    expect(dedup.claim(inboundDedupKey('ntfy', 'topic', 'a'))).toBe(true);
    expect(dedup.claim(inboundDedupKey('ntfy', 'topic', 'b'))).toBe(true);
  });

  test('the same id on a different topic is a different message', () => {
    const dedup = new InboundMessageDedup();
    expect(dedup.claim(inboundDedupKey('ntfy', 'topic-a', 'x'))).toBe(true);
    expect(dedup.claim(inboundDedupKey('ntfy', 'topic-b', 'x'))).toBe(true);
  });

  test('a message with no id is always processed rather than collapsed onto one key', () => {
    const dedup = new InboundMessageDedup();
    expect(inboundDedupKey('ntfy', 'topic', undefined)).toBe('');
    expect(inboundDedupKey('ntfy', 'topic', '   ')).toBe('');
    expect(dedup.claim('')).toBe(true);
    expect(dedup.claim('')).toBe(true);
  });

  test('a claim expires so the cache cannot pin a message forever', () => {
    let now = 1_000;
    const dedup = new InboundMessageDedup(60_000, 100, () => now);
    expect(dedup.claim('k')).toBe(true);
    expect(dedup.claim('k')).toBe(false);
    now += 60_001;
    expect(dedup.claim('k')).toBe(true);
  });

  test('the cache is bounded', () => {
    const dedup = new InboundMessageDedup(60_000, 10);
    for (let index = 0; index < 100; index += 1) dedup.claim(`k${index}`);
    expect(dedup.size).toBeLessThanOrEqual(10);
  });

  test('has() reports without claiming', () => {
    const dedup = new InboundMessageDedup();
    expect(dedup.has('k')).toBe(false);
    dedup.claim('k');
    expect(dedup.has('k')).toBe(true);
  });
});
