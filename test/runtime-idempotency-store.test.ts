import { describe, expect, test } from 'bun:test';
import { GoodVibesSdkError } from '../packages/errors/src/index.js';
import { IdempotencyStore } from '../packages/sdk/src/platform/runtime/idempotency/index.js';

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('IdempotencyStore finalization', () => {
  test('markComplete surfaces a missing record', () => {
    const store = new IdempotencyStore();
    const err = captureThrown(() => store.markComplete('missing-key'));

    expect(err).toBeInstanceOf(GoodVibesSdkError);
    expect((err as GoodVibesSdkError).code).toBe('IDEMPOTENCY_RECORD_NOT_FOUND');
    expect((err as GoodVibesSdkError).operation).toBe('markComplete');
  });

  test('markFailed surfaces a missing record', () => {
    const store = new IdempotencyStore();
    const err = captureThrown(() => store.markFailed('missing-key'));

    expect(err).toBeInstanceOf(GoodVibesSdkError);
    expect((err as GoodVibesSdkError).code).toBe('IDEMPOTENCY_RECORD_NOT_FOUND');
    expect((err as GoodVibesSdkError).operation).toBe('markFailed');
  });

  test('normal finalization keeps completed records queryable', () => {
    const store = new IdempotencyStore();
    const key = store.generateKey({ sessionId: 's', turnId: 't', callId: 'c' });

    expect(store.checkAndRecord(key).status).toBe('new');
    store.markComplete(key, { ok: true });

    const record = store.getRecord(key);
    expect(record?.status).toBe('completed');
    expect(record?.result).toEqual({ ok: true });
  });
});
