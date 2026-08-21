/**
 * A hand-edited expectation file must not mint a grant the live API refuses.
 *
 * §9.2 states that as a guarantee. It was false in two independent ways, and
 * the two composed into one permanent wildcard grant from one edit of a 0644
 * file:
 *
 *   - The window was validated as a DELTA only. Neither timestamp was compared
 *     to the present and the `now` parameter was accepted and ignored, so a
 *     record dated `openedAt: 2999-01-01` with a thirty-minute window had a
 *     perfectly valid delta, validated, survived the sweep (which reaps only
 *     records already EXPIRED, this one expires in 2999) and hydrated into an
 *     expectation that never ages out. `openExpectation` computes
 *     `expiresAt = now + clampWindow(...)`, so a live grant cannot outlive the
 *     hour; the load path was strictly weaker than the API it mirrors.
 *
 *   - `serviceDomain` was validated by `normalizeDomain` alone, trim,
 *     lowercase, strip trailing dot and port, and no hostname validation at
 *     all. `"com"` survived intact, on the load path AND through the live
 *     verb, and `hostMatchesServiceDomain` accepts any host ending in
 *     `.${serviceDomain}`. An expectation scoped to `"com"` authorises a link
 *     at every `.com` host in existence.
 *
 * The last test here executes the full chain the reviewer executed, and
 * asserts it no longer completes.
 */

import { describe, expect, test } from 'bun:test';
import {
  MAX_PURPOSE_CHARS,
  MAX_VERIFICATION_WINDOW_MS,
  MIN_VERIFICATION_WINDOW_MS,
  VerificationExpectationBook,
  isRegistrableServiceDomain,
  validatePersistedExpectation,
} from '../packages/sdk/src/platform/google/verification-expectations.ts';
import { deliveredRecipientFromAliasMailbox } from '../packages/sdk/src/platform/google/delivery-evidence.ts';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const NOW_MS = NOW.getTime();

function planted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'planted-1',
    kind: 'signup',
    authority: 'evidence-only',
    serviceDomain: 'github.com',
    recipientAddress: 'owner+alias@example.com',
    purpose: 'confirm the account',
    openedAt: new Date(NOW_MS - 5 * 60_000).toISOString(),
    expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('a future-dated record cannot mint a permanent grant', () => {
  test('a record opened in the year 2999 is discarded', () => {
    // The planted record from the review, verbatim in shape: a valid
    // thirty-minute delta, entirely in the future.
    expect(validatePersistedExpectation(planted({
      openedAt: '2999-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:30:00.000Z',
    }), NOW)).toBeNull();
  });

  test('a record opened one second from now is discarded', () => {
    // The boundary, not just the absurd case: a grant that has not been
    // issued yet is not a grant.
    expect(validatePersistedExpectation(planted({
      openedAt: new Date(NOW_MS + 1_000).toISOString(),
      expiresAt: new Date(NOW_MS + 2 * 60_000).toISOString(),
    }), NOW)).toBeNull();
  });

  test('a record opened in the past with a huge window is still discarded', () => {
    // The other way to reach a far-future expiry: keep openedAt honest and
    // declare a delta of centuries. The ceiling catches it.
    expect(validatePersistedExpectation(planted({
      openedAt: new Date(NOW_MS - 60_000).toISOString(),
      expiresAt: '2999-01-01T00:00:00.000Z',
    }), NOW)).toBeNull();
  });

  test('an ordinary live record still validates', () => {
    expect(validatePersistedExpectation(planted(), NOW)).not.toBeNull();
  });

  test('an already-expired record still validates as CONTENT, so the sweep can call it expired', () => {
    // Deliberately not refused here. Refusing it at this layer would take the
    // `expired` classification away from sweep(), which would then report a
    // merely-spent record as malformed, telling the owner his store is
    // corrupt when a signup simply timed out.
    expect(validatePersistedExpectation(planted({
      openedAt: new Date(NOW_MS - 20 * 60_000).toISOString(),
      expiresAt: new Date(NOW_MS - 5 * 60_000).toISOString(),
    }), NOW)).not.toBeNull();
  });
});

describe('a zero or sub-minimum window cannot validate', () => {
  test.each([0, -1_000, MIN_VERIFICATION_WINDOW_MS - 1])('a %d ms window is refused', (delta) => {
    expect(validatePersistedExpectation(planted({
      openedAt: new Date(NOW_MS - 60_000).toISOString(),
      expiresAt: new Date(NOW_MS - 60_000 + delta).toISOString(),
    }), NOW)).toBeNull();
  });

  test('exactly the minimum window is accepted', () => {
    expect(validatePersistedExpectation(planted({
      openedAt: new Date(NOW_MS - 60_000).toISOString(),
      expiresAt: new Date(NOW_MS - 60_000 + MIN_VERIFICATION_WINDOW_MS).toISOString(),
    }), NOW)).not.toBeNull();
  });

  test('exactly the maximum window is accepted', () => {
    expect(validatePersistedExpectation(planted({
      openedAt: new Date(NOW_MS - 60_000).toISOString(),
      expiresAt: new Date(NOW_MS - 60_000 + MAX_VERIFICATION_WINDOW_MS).toISOString(),
    }), NOW)).not.toBeNull();
  });
});

describe('a bare TLD is not a service domain, on either path', () => {
  test.each(['com', 'co.uk', 'localhost', '', '.', 'github'])(
    '%p is refused as a service domain',
    (domain) => {
      expect(isRegistrableServiceDomain(domain)).toBe(false);
    },
  );

  test.each(['github.com', 'accounts.github.com', 'example.co.uk'])(
    '%p is accepted',
    (domain) => {
      expect(isRegistrableServiceDomain(domain)).toBe(true);
    },
  );

  test('the LOAD path discards a record scoped to a bare TLD', () => {
    expect(validatePersistedExpectation(planted({ serviceDomain: 'com' }), NOW)).toBeNull();
  });

  test('the LIVE verb refuses to open one', () => {
    // This half needed no file edit at all, it was reachable through
    // email.expectation.open.
    const book = new VerificationExpectationBook();
    expect(() => book.openExpectation({
      serviceDomain: 'com',
      recipientAddress: 'owner+alias@example.com',
      purpose: 'confirm the account',
      now: NOW,
    })).toThrow('registrable service domain');
  });

  test('the live verb still opens a real domain', () => {
    const book = new VerificationExpectationBook();
    expect(book.openExpectation({
      serviceDomain: 'github.com',
      recipientAddress: 'owner+alias@example.com',
      purpose: 'confirm the account',
      now: NOW,
    }).serviceDomain).toBe('github.com');
  });
});

describe('fields are bounded, not merely counted', () => {
  test('an oversized purpose is refused on load', () => {
    // MAX_OPEN_EXPECTATIONS bounds the COUNT. Nothing bounded the SIZE, so a
    // one-megabyte purpose validated and thirty-two of them made a
    // thirty-two-megabyte file that was entirely well-formed.
    expect(validatePersistedExpectation(planted({
      purpose: 'x'.repeat(MAX_PURPOSE_CHARS + 1),
    }), NOW)).toBeNull();
    expect(validatePersistedExpectation(planted({
      purpose: 'x'.repeat(1_000_000),
    }), NOW)).toBeNull();
  });

  test('an oversized purpose is refused by the live verb', () => {
    const book = new VerificationExpectationBook();
    expect(() => book.openExpectation({
      serviceDomain: 'github.com',
      recipientAddress: 'owner+alias@example.com',
      purpose: 'x'.repeat(MAX_PURPOSE_CHARS + 1),
      now: NOW,
    })).toThrow('at most');
  });

  test('an oversized service domain and recipient are refused on load', () => {
    expect(validatePersistedExpectation(planted({
      serviceDomain: `${'a'.repeat(300)}.com`,
    }), NOW)).toBeNull();
    expect(validatePersistedExpectation(planted({
      recipientAddress: `${'a'.repeat(400)}@example.com`,
    }), NOW)).toBeNull();
  });

  test('a purpose at exactly the bound is accepted', () => {
    expect(validatePersistedExpectation(planted({
      purpose: 'x'.repeat(MAX_PURPOSE_CHARS),
    }), NOW)).not.toBeNull();
  });
});

describe('the full planted-record chain no longer completes', () => {
  test('plant, hydrate, deliver unsolicited mail — and nothing matches', () => {
    // The exact chain the review executed: a record with serviceDomain "com"
    // and an expiry in 2999, hydrated from disk, then unsolicited mail from a
    // sender the owner never signed up with.
    const book = new VerificationExpectationBook();
    const record = planted({
      serviceDomain: 'com',
      openedAt: '2999-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:30:00.000Z',
    });

    // Refused twice over, the date and the domain each stop it alone.
    expect(validatePersistedExpectation(record, NOW)).toBeNull();
    expect(book.hydrateExpectation(record, NOW)).toBeNull();
    expect(book.list(NOW)).toHaveLength(0);

    const unsolicited = {
      messageId: '<phish@phisher.example>',
      from: 'billing@phisher.example',
      deliveredTo: deliveredRecipientFromAliasMailbox('owner+alias@example.com'),
      toHeaderClaim: 'owner@example.com',
      subject: 'Your invoice',
      body: 'Pay at https://evil.example.com/pay',
    };

    // No expectation exists, so there is nothing for the mail to satisfy.
    expect(book.matchCandidate(unsolicited, NOW).kind).toBe('no-expectation');
  });

  test('and the same record cannot be re-created through the live verb either', () => {
    // Closing only the file path would have left the verb minting the same
    // wildcard grant with a fresh expiry every hour.
    const book = new VerificationExpectationBook();
    expect(() => book.openExpectation({
      serviceDomain: 'com',
      recipientAddress: 'owner+alias@example.com',
      purpose: 'confirm the account',
      now: NOW,
    })).toThrow();
  });
});
