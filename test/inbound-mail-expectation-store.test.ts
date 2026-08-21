/**
 * inbound-mail-expectation-store.test.ts
 *
 * Proves the override docs/inbound-email.md §9.2 makes to
 * `VerificationExpectationBook`'s in-memory-only design: expectations now
 * persist across a restart, but ONLY with their original absolute expiry, and
 * ONLY when the persisted record passes the exact validation the live
 * `openExpectation` API enforces.
 *
 * The security property under test, stated as such in §9.2: **a file on disk
 * must not be able to mint an expectation the live API would have refused.**
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_OPEN_EXPECTATIONS,
  MAX_VERIFICATION_WINDOW_MS,
  VerificationExpectationBook,
  validatePersistedExpectation,
  type VerificationExpectation,
} from '../packages/sdk/src/platform/google/verification-expectations.ts';
import {
  PersistedExpectationStore,
  type ExpectationSweepReport,
} from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';

const T0 = new Date('2026-07-27T12:00:00.000Z');
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-expectations-'));
  storePath = join(dir, 'inbound-mail-expectations.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(expectations: readonly unknown[]): void {
  writeFileSync(storePath, `${JSON.stringify({ version: 1, expectations }, null, 2)}\n`, 'utf-8');
}

function validExpectation(overrides: Partial<VerificationExpectation> = {}): VerificationExpectation {
  return {
    id: 'exp-1',
    kind: 'signup',
    serviceDomain: 'github.com',
    recipientAddress: 'owner+gv-github-com@example.com',
    purpose: 'account signup',
    openedAt: T0.toISOString(),
    expiresAt: at(15 * 60 * 1000).toISOString(),
    authority: 'evidence-only',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The security property: a file cannot mint what the live API would refuse
// ---------------------------------------------------------------------------
describe('validatePersistedExpectation refuses anything openExpectation would have refused', () => {
  test('a window longer than MAX_VERIFICATION_WINDOW_MS is refused', () => {
    const overLong = validExpectation({
      openedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + MAX_VERIFICATION_WINDOW_MS + 60_000).toISOString(),
    });
    expect(validatePersistedExpectation(overLong, T0)).toBeNull();
  });

  test('an authority field that is not exactly "evidence-only" is refused', () => {
    const wrongAuthority = { ...validExpectation(), authority: 'command' };
    expect(validatePersistedExpectation(wrongAuthority, T0)).toBeNull();
  });

  test('an empty or unparseable service domain is refused', () => {
    expect(validatePersistedExpectation({ ...validExpectation(), serviceDomain: '' }, T0)).toBeNull();
    expect(validatePersistedExpectation({ ...validExpectation(), serviceDomain: 42 }, T0)).toBeNull();
  });

  test('a recipient address with no "@" is refused', () => {
    expect(validatePersistedExpectation({ ...validExpectation(), recipientAddress: 'not-an-address' }, T0)).toBeNull();
  });

  test('an empty purpose is refused', () => {
    expect(validatePersistedExpectation({ ...validExpectation(), purpose: '   ' }, T0)).toBeNull();
  });

  test('an unparseable kind is refused (no third kind exists)', () => {
    expect(validatePersistedExpectation({ ...validExpectation(), kind: 'password-reset' }, T0)).toBeNull();
  });

  test('a torn record (missing fields entirely) is refused', () => {
    expect(validatePersistedExpectation({ id: 'exp-1' }, T0)).toBeNull();
    expect(validatePersistedExpectation(null, T0)).toBeNull();
    expect(validatePersistedExpectation('a string', T0)).toBeNull();
  });

  test('a well-formed record passes', () => {
    const valid = validatePersistedExpectation(validExpectation(), T0);
    expect(valid).not.toBeNull();
    expect(valid?.serviceDomain).toBe('github.com');
  });
});

// ---------------------------------------------------------------------------
// Original absolute expiry, never a fresh window
// ---------------------------------------------------------------------------
describe('expectations reload with their ORIGINAL expiry, never a fresh window', () => {
  test('the remaining window after restoring at T0+5min is 10min, not a fresh 15min', () => {
    const book = new VerificationExpectationBook();
    const opened = book.openExpectation({
      serviceDomain: 'github.com',
      recipientAddress: 'owner+gv-github-com@example.com',
      purpose: 'account signup',
      windowMs: 15 * 60 * 1000,
      now: T0,
    });
    expect(opened.expiresAt).toBe(at(15 * 60 * 1000).toISOString());

    // "Restart": a fresh book, hydrated from the persisted record 5 minutes later.
    const restartedBook = new VerificationExpectationBook();
    const restartTime = at(5 * 60 * 1000);
    const hydrated = restartedBook.hydrateExpectation(opened, restartTime);
    expect(hydrated).not.toBeNull();
    // The ORIGINAL absolute expiresAt, byte-for-byte, not recomputed from restartTime.
    expect(hydrated?.expiresAt).toBe(opened.expiresAt);
    expect(hydrated?.openedAt).toBe(opened.openedAt);

    const remainingMs = Date.parse(hydrated!.expiresAt) - restartTime.getTime();
    expect(remainingMs).toBe(10 * 60 * 1000); // 10 minutes left, not a fresh 15.

    const fetched = restartedBook.get(opened.id, restartTime);
    expect(fetched?.expiresAt).toBe(opened.expiresAt);
  });

  test('hydrateExpectation refuses to mint a fresh window even when passed a plain object', () => {
    const book = new VerificationExpectationBook();
    const raw = validExpectation();
    const hydrated = book.hydrateExpectation(raw, T0);
    expect(hydrated?.expiresAt).toBe(raw.expiresAt);
    expect(hydrated?.openedAt).toBe(raw.openedAt);
  });
});

// ---------------------------------------------------------------------------
// Already-expired expectations reaped at load, before any match
// ---------------------------------------------------------------------------
describe('already-expired expectations are reaped at load, before they can match anything', () => {
  test('hydrateExpectation refuses an expired record outright', () => {
    const book = new VerificationExpectationBook();
    // Structurally valid (positive window within the ceiling) but its window
    // has already elapsed by T0, the expiry check, not content validation,
    // is what must refuse this.
    const expired = validExpectation({ openedAt: at(-20 * 60 * 1000).toISOString(), expiresAt: at(-5 * 60 * 1000).toISOString() });
    expect(validatePersistedExpectation(expired, T0)).not.toBeNull(); // content is fine
    expect(book.hydrateExpectation(expired, T0)).toBeNull(); // but it is already expired
    expect(book.list(T0)).toHaveLength(0);
  });

  test('PersistedExpectationStore.sweep() reaps an expired record with reason "expired" and it is absent from survivors', async () => {
    // A structurally VALID expectation (positive window, well within
    // MAX_VERIFICATION_WINDOW_MS) whose window has simply elapsed by "now",
    // distinct from a malformed record, which is refused by content
    // validation before expiry is ever considered.
    seed([validExpectation({ id: 'expired-1', openedAt: at(-20 * 60 * 1000).toISOString(), expiresAt: at(-5 * 60 * 1000).toISOString() })]);
    const store = new PersistedExpectationStore(storePath, { now: () => T0 });
    const report: ExpectationSweepReport = await store.runRecoverySweep();
    expect(report.removed).toEqual([expect.objectContaining({ id: 'expired-1', reason: 'expired' })]);
    expect(report.survivors).toHaveLength(0);
  });

  test('an on-disk expectation the live API would refuse is discarded by the store sweep, not repaired', async () => {
    seed([
      validExpectation({ id: 'bad-authority', authority: 'command' as never }),
      validExpectation({ id: 'over-long', openedAt: T0.toISOString(), expiresAt: new Date(T0.getTime() + MAX_VERIFICATION_WINDOW_MS + 1).toISOString() }),
      validExpectation({ id: 'bad-domain', serviceDomain: '' }),
      validExpectation({ id: 'ok' }),
    ]);
    const store = new PersistedExpectationStore(storePath, { now: () => T0 });
    const report = await store.runRecoverySweep();
    expect(report.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.survivors.map((s) => s.id)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// MAX_OPEN_EXPECTATIONS enforced on load, not only on open
// ---------------------------------------------------------------------------
describe('MAX_OPEN_EXPECTATIONS is enforced on load', () => {
  test('a file hand-edited to hold more than the cap is trimmed to the cap on sweep', async () => {
    const seeds = Array.from({ length: MAX_OPEN_EXPECTATIONS + 1 }, (_, i) =>
      validExpectation({
        id: `exp-${String(i)}`,
        recipientAddress: `owner+gv-svc-${String(i)}@example.com`,
        openedAt: at(i * 1000).toISOString(),
        expiresAt: at(i * 1000 + 15 * 60 * 1000).toISOString(),
      }));
    seed(seeds);
    const store = new PersistedExpectationStore(storePath, { now: () => at(MAX_OPEN_EXPECTATIONS * 1000) });
    const report = await store.runRecoverySweep();
    expect(report.removed.filter((r) => r.reason === 'over-cap')).toHaveLength(1);
    expect(report.retained).toBe(MAX_OPEN_EXPECTATIONS);
    // The OLDEST-opened expectation is the one dropped.
    expect(report.removed.some((r) => r.id === 'exp-0')).toBe(true);
  });

  test('hydrateExpectation refuses past the cap when the book is already full', () => {
    const book = new VerificationExpectationBook();
    for (let i = 0; i < MAX_OPEN_EXPECTATIONS; i += 1) {
      const exp = validExpectation({ id: `exp-${String(i)}`, recipientAddress: `owner+gv-svc-${String(i)}@example.com` });
      expect(book.hydrateExpectation(exp, T0)).not.toBeNull();
    }
    const overflow = validExpectation({ id: 'overflow', recipientAddress: 'owner+gv-overflow@example.com' });
    expect(book.hydrateExpectation(overflow, T0)).toBeNull();
    expect(book.list(T0)).toHaveLength(MAX_OPEN_EXPECTATIONS);
  });
});

// ---------------------------------------------------------------------------
// The persisted store is a mirror, not a second decision-maker
// ---------------------------------------------------------------------------
describe('replaceAll mirrors the live book without widening it', () => {
  test('replaceAll persists exactly the valid, unexpired subset of what it was handed', async () => {
    const store = new PersistedExpectationStore(storePath, { now: () => T0 });
    await store.replaceAll([
      validExpectation({ id: 'good' }),
      { ...validExpectation({ id: 'expired' }), expiresAt: at(-1).toISOString() },
      { id: 'garbage' } as unknown as VerificationExpectation,
    ]);
    const live = await store.list();
    expect(live.map((e) => e.id)).toEqual(['good']);
  });
});

describe('hydrateExpectation refuses when email has command authority', () => {
  test('a probe reporting command authority refuses hydration even for an otherwise-valid record', () => {
    const book = new VerificationExpectationBook({ surfaceHasCommandAuthority: () => true });
    expect(book.hydrateExpectation(validExpectation(), T0)).toBeNull();
  });
});
