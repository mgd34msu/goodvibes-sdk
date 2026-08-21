import { describe, expect, test } from 'bun:test';

import {
  CardMaterialRedactor,
  REDACTED_MARKER,
} from '../packages/sdk/src/platform/payments/card-redaction.js';

/**
 * card-redaction-separators.test.ts, converted from a reviewer's reproduction
 * probe (leak-probe.test.ts's PROBE describe block) that armed a redactor with
 * a plain digit PAN and then redacted the same number reformatted with a run
 * of separators the matcher did not recognise: a dot mask, an en dash mask, a
 * newline mask and an underscore mask all came back with the PAN still
 * readable, because `digitRuns` only bridged a plain space, a non-breaking
 * space and a hyphen between digit groups.
 *
 * `4539578763621486` is a Luhn-valid but entirely fictitious PAN. No real card
 * material appears in this repository.
 */

const PAN = '4539578763621486';

function armedGuard(): CardMaterialRedactor {
  const guard = new CardMaterialRedactor();
  guard.arm('s', 'p', [{ kind: 'number', value: PAN }]);
  return guard;
}

describe('CardMaterialRedactor redacts every mask an input can plausibly reformat a PAN into', () => {
  const reformattings: readonly { readonly label: string; readonly text: string }[] = [
    { label: 'unformatted', text: PAN },
    { label: 'space-grouped', text: '4539 5787 6362 1486' },
    { label: 'hyphen-grouped', text: '4539-5787-6362-1486' },
    // The regression this file exists for: none of the four below leaked
    // before the fix, only because they used a separator the matcher had
    // never heard of, not because anything about the number changed.
    { label: 'dot-grouped', text: '4539.5787.6362.1486' },
    { label: 'en-dash-grouped', text: '4539–5787–6362–1486' },
    { label: 'newline-grouped', text: '4539\n5787\n6362\n1486' },
    { label: 'underscore-grouped', text: '4539_5787_6362_1486' },
    { label: 'non-breaking-space-grouped', text: '4539 5787 6362 1486' },
    { label: 'thin-space-grouped', text: '4539 5787 6362 1486' },
  ];

  for (const { label, text } of reformattings) {
    test(`redacts a ${label} spelling of the armed PAN`, () => {
      const guard = armedGuard();
      const out = guard.redact('s', 'p', `Card ${text} on file`);
      expect(out).not.toContain(PAN.slice(0, 4) + PAN.slice(4));
      expect(out).not.toContain('4539');
      expect(out).toContain(REDACTED_MARKER);
    });
  }

  test('a page that mixes separators within one mask still gets redacted', () => {
    const guard = armedGuard();
    const out = guard.redact('s', 'p', 'Card 4539-5787.6362_1486 on file');
    expect(out).not.toContain('4539');
    expect(out).toContain(REDACTED_MARKER);
  });

  test('does not bridge two unrelated short numbers separated by ordinary prose', () => {
    const guard = armedGuard();
    const out = guard.redact('s', 'p', 'Order 4539 shipped. Invoice 5787 attached.');
    // Neither fragment alone contains the full 16-digit PAN, and the words
    // between them are not in the separator set, so nothing here should be
    // treated as a reformatted spelling of the card.
    expect(out).toBe('Order 4539 shipped. Invoice 5787 attached.');
  });

  test('an unarmed guard redacts nothing, of any spelling', () => {
    const guard = new CardMaterialRedactor();
    const text = 'Card 4539.5787.6362.1486 on file';
    expect(guard.redact('s', 'p', text)).toBe(text);
  });
});
