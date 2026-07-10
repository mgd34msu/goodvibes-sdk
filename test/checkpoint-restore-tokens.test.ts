/**
 * checkpoint-restore-tokens.test.ts
 *
 * Unit coverage for RestoreTokenStore — the in-memory, single-use, TTL-bound
 * confirmation-token store behind the checkpoints.restore confirmation gate.
 * Uses an injected clock so expiry is deterministic (no real waiting).
 */
import { describe, expect, test } from 'bun:test';
import {
  RestoreTokenStore,
  RESTORE_TOKEN_TTL_MS,
} from '../packages/sdk/src/platform/control-plane/routes/checkpoint-restore-tokens.ts';

describe('RestoreTokenStore', () => {
  test('a freshly issued token authorizes exactly its own checkpoint id', () => {
    const store = new RestoreTokenStore();
    const { token } = store.issue('wcp_abc');
    expect(store.consume(token, 'wcp_abc')).toBe(true);
  });

  test('a token is single-use — a second consume of the same token fails', () => {
    const store = new RestoreTokenStore();
    const { token } = store.issue('wcp_abc');
    expect(store.consume(token, 'wcp_abc')).toBe(true);
    expect(store.consume(token, 'wcp_abc')).toBe(false);
  });

  test('a token minted for one checkpoint does not authorize a different checkpoint (and is then spent)', () => {
    const store = new RestoreTokenStore();
    const { token } = store.issue('wcp_abc');
    // Wrong id fails...
    expect(store.consume(token, 'wcp_other')).toBe(false);
    // ...and the mismatched attempt still burns the token (no retry with the right id).
    expect(store.consume(token, 'wcp_abc')).toBe(false);
  });

  test('a token past its TTL is rejected', () => {
    let clock = 1_000;
    const store = new RestoreTokenStore(() => clock, RESTORE_TOKEN_TTL_MS);
    const { token, expiresAt } = store.issue('wcp_abc');
    expect(expiresAt).toBe(1_000 + RESTORE_TOKEN_TTL_MS);
    // One ms past expiry.
    clock = expiresAt + 1;
    expect(store.consume(token, 'wcp_abc')).toBe(false);
  });

  test('a token exactly at its expiry boundary is already expired (expiresAt is exclusive)', () => {
    let clock = 0;
    const store = new RestoreTokenStore(() => clock, 100);
    const { token, expiresAt } = store.issue('wcp_abc');
    clock = expiresAt; // == now
    expect(store.consume(token, 'wcp_abc')).toBe(false);
  });

  test('an unknown token is rejected', () => {
    const store = new RestoreTokenStore();
    expect(store.consume('never-issued', 'wcp_abc')).toBe(false);
  });

  test('distinct issues produce distinct tokens', () => {
    const store = new RestoreTokenStore();
    const a = store.issue('wcp_abc').token;
    const b = store.issue('wcp_abc').token;
    expect(a).not.toBe(b);
  });
});
