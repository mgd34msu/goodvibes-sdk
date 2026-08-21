/**
 * PERMANENT REGRESSION GUARDS, do not weaken.
 *
 * Verification-email correlation gates on which address a message arrived at.
 * If that value can come from the `To:` header, an attacker who guesses an
 * open expectation's address forges the header, matches it, and has the agent
 * follow their link. These tests exist so that hole cannot reopen quietly.
 *
 * If a change makes one of these fail, the change is wrong, not the test.
 */

import { describe, expect, test } from 'bun:test';
import {
  bestDeliveryEvidence,
  deliveredRecipientFromAliasMailbox,
  deliveredRecipientFromDeliveryHeaders,
  deliveryEvidenceFromMessage,
  describeDeliveryEvidence,
  NO_ALIAS_MAILBOXES,
  normalizeDeliveryAddress,
} from '../packages/sdk/src/platform/google/delivery-evidence.ts';
import {
  VerificationExpectationBook,
  type CandidateEmail,
} from '../packages/sdk/src/platform/google/verification-expectations.ts';

const T0 = new Date('2026-07-26T12:00:00.000Z');
const ALIAS = 'owner+gv-github-com-k3n9x2p4@example.com';

function bookExpecting(address: string): VerificationExpectationBook {
  const book = new VerificationExpectationBook();
  book.openExpectation({
    id: 'exp-1',
    serviceDomain: 'github.com',
    recipientAddress: address,
    purpose: 'Create a GitHub account for the owner',
    now: T0,
  });
  return book;
}

function candidate(overrides: Partial<CandidateEmail>): CandidateEmail {
  return {
    messageId: 'msg-1',
    from: 'noreply@github.com',
    deliveredTo: null,
    toHeaderClaim: '',
    subject: 'Verify your email address',
    body: 'Confirm your address: https://github.com/verify?token=abc123',
    ...overrides,
  };
}

describe('constructing delivery evidence', () => {
  test('an alias mailbox the fetch ran against is accepted as evidence', () => {
    const evidence = deliveredRecipientFromAliasMailbox(ALIAS);
    expect(evidence?.address).toBe(ALIAS);
    expect(evidence?.source).toBe('alias-mailbox');
  });

  test('the top-most delivery header is the evidence', () => {
    const evidence = deliveredRecipientFromDeliveryHeaders([ALIAS, 'someone-else@example.com']);
    expect(evidence?.address).toBe(ALIAS);
  });

  test('a forged delivery header below the genuine one is ignored, not searched for a match', () => {
    // A sender can embed their own Delivered-To lines in the message they
    // submit; those land BELOW the one the receiving server prepends. Scanning
    // the whole list for a match would hand the attacker back the forgery.
    const evidence = deliveredRecipientFromDeliveryHeaders([
      'real-delivery@example.com',
      ALIAS, // forged by the sender, positioned to look like a match
    ]);
    expect(evidence?.address).toBe('real-delivery@example.com');
    expect(evidence?.address).not.toBe(ALIAS);
  });

  test('addresses are normalized, so case and angle brackets cannot dodge a comparison', () => {
    expect(normalizeDeliveryAddress('  <Owner+GV-GitHub@Example.COM>  ')).toBe('owner+gv-github@example.com');
  });

  test('an empty or malformed value yields no evidence rather than a bogus one', () => {
    expect(deliveredRecipientFromDeliveryHeaders([])).toBeNull();
    expect(deliveredRecipientFromDeliveryHeaders(['not-an-address'])).toBeNull();
    expect(deliveredRecipientFromAliasMailbox('')).toBeNull();
  });

  test('an alias mailbox outranks a delivery header, because a mailbox cannot be talked into existing', () => {
    const best = bestDeliveryEvidence([
      deliveredRecipientFromDeliveryHeaders(['header@example.com']),
      deliveredRecipientFromAliasMailbox(ALIAS),
    ]);
    expect(best?.source).toBe('alias-mailbox');
    expect(best?.address).toBe(ALIAS);
  });
});

describe('correlation gates on delivery evidence, never on the To: header', () => {
  test('THE ATTACK: a forged To: naming the alias is refused when delivery evidence disagrees', () => {
    // The attacker knows (or guesses) the alias an open signup is waiting on
    // and sends a message whose To: header names it. The message was really
    // delivered somewhere else entirely.
    const book = bookExpecting(ALIAS);
    const result = book.matchCandidate(
      candidate({
        toHeaderClaim: ALIAS, // forged to match
        deliveredTo: deliveredRecipientFromAliasMailbox('attacker-drop@example.com'),
        body: 'Confirm here: https://github.com/verify?token=attacker-controlled',
      }),
      new Date(T0.getTime() + 60_000),
    );

    expect(result.kind).toBe('recipient-mismatch');
    expect(result.kind).not.toBe('matched');
  });

  test('THE ATTACK, no-evidence variant: a forged To: with no delivery evidence at all is refused', () => {
    const book = bookExpecting(ALIAS);
    const result = book.matchCandidate(
      candidate({ toHeaderClaim: ALIAS, deliveredTo: null }),
      new Date(T0.getTime() + 60_000),
    );

    expect(result.kind).toBe('no-delivery-evidence');
    if (result.kind !== 'no-delivery-evidence') throw new Error('expected no-delivery-evidence');
    // The refusal must explain WHY, or the next person re-adds the header path.
    expect(result.reason).toContain('sender sets that field themselves');
  });

  test('the refusal names both the claim and the real destination, so a forgery is legible', () => {
    const book = bookExpecting(ALIAS);
    const result = book.matchCandidate(
      candidate({
        toHeaderClaim: ALIAS,
        deliveredTo: deliveredRecipientFromAliasMailbox('attacker-drop@example.com'),
      }),
      new Date(T0.getTime() + 60_000),
    );
    if (result.kind !== 'recipient-mismatch') throw new Error('expected recipient-mismatch');
    expect(result.reason).toContain('attacker-drop@example.com');
    expect(result.reason).toContain(ALIAS);
  });

  test('genuine delivery to the expected alias still matches, so the guard does not cry wolf', () => {
    const book = bookExpecting(ALIAS);
    const result = book.matchCandidate(
      candidate({
        toHeaderClaim: ALIAS,
        deliveredTo: deliveredRecipientFromAliasMailbox(ALIAS),
      }),
      new Date(T0.getTime() + 60_000),
    );
    expect(result.kind).toBe('matched');
  });

  test('a match works even when the To: header is absent entirely — evidence is what counts', () => {
    const book = bookExpecting(ALIAS);
    const result = book.matchCandidate(
      candidate({ toHeaderClaim: '', deliveredTo: deliveredRecipientFromAliasMailbox(ALIAS) }),
      new Date(T0.getTime() + 60_000),
    );
    expect(result.kind).toBe('matched');
  });

  test('a forged delivery header below the genuine one does not produce a match', () => {
    const book = bookExpecting(ALIAS);
    const result = book.matchCandidate(
      candidate({
        toHeaderClaim: ALIAS,
        deliveredTo: deliveredRecipientFromDeliveryHeaders(['real-drop@example.com', ALIAS]),
      }),
      new Date(T0.getTime() + 60_000),
    );
    expect(result.kind).toBe('recipient-mismatch');
  });

  test('describeDeliveryEvidence never claims evidence it does not have', () => {
    expect(describeDeliveryEvidence(null)).toContain('no delivery evidence');
  });
});

describe('bridging a fetched message into evidence', () => {
  test('a per-signup alias mailbox is evidence, and outranks the delivery header', () => {
    const evidence = deliveryEvidenceFromMessage(
      { mailbox: ALIAS, deliveredTo: ['header@example.com'] },
      new Set([ALIAS]),
    );
    expect(evidence?.source).toBe('alias-mailbox');
    expect(evidence?.address).toBe(ALIAS);
  });

  test('INBOX is NOT evidence, because everything lands there', () => {
    // Treating the shared mailbox as proof would make every message look like
    // it satisfied every open expectation.
    const evidence = deliveryEvidenceFromMessage({ mailbox: 'INBOX', deliveredTo: [] }, new Set([ALIAS]));
    expect(evidence).toBeNull();
  });

  test('a mailbox that was never minted for a signup is not evidence', () => {
    const evidence = deliveryEvidenceFromMessage(
      { mailbox: 'attacker-guess@example.com', deliveredTo: [] },
      new Set([ALIAS]),
    );
    expect(evidence).toBeNull();
  });

  test('with no alias mailbox it falls back to the top-most delivery header', () => {
    const evidence = deliveryEvidenceFromMessage({ mailbox: 'INBOX', deliveredTo: [ALIAS, 'forged@example.com'] }, new Set());
    expect(evidence?.source).toBe('delivered-to-header');
    expect(evidence?.address).toBe(ALIAS);
  });

  test('a message with neither yields no evidence rather than a guess', () => {
    expect(deliveryEvidenceFromMessage({}, new Set())).toBeNull();
  });

  test('NO_ALIAS_MAILBOXES states a transport has no per-signup mailboxes', () => {
    // The Gmail case: mail is filed under labels, so even a mailbox name that
    // looks like the alias proves nothing about which signup it belongs to.
    const evidence = deliveryEvidenceFromMessage(
      { mailbox: ALIAS, deliveredTo: ['header@example.com'] },
      NO_ALIAS_MAILBOXES,
    );
    expect(evidence?.source).toBe('delivered-to-header');
    expect(evidence?.address).toBe('header@example.com');
    expect(NO_ALIAS_MAILBOXES.size).toBe(0);
  });
});
