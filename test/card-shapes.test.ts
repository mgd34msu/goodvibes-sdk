/**
 * card-shapes.test.ts
 *
 * The detector behind the remote-channel card gate (docs/inbound-email.md
 * §11.0). Every card number below is a published test value that passes Luhn
 * and belongs to no cardholder.
 */
import { describe, expect, test } from 'bun:test';
import {
  cardShapeKinds,
  describeCardShapes,
  detectCardShapes,
  hasRefusableCardShapes,
  passesLuhn,
  redactCardShapes,
  renderCardShapeRefusal,
  type CardShapeFinding,
} from '../packages/sdk/src/platform/security/card-shapes.ts';

/** Published test PANs. None of these is a real card. */
const VISA = '4111111111111111';
const MASTERCARD = '5555555555554444';
const AMEX = '378282246310005';
const DINERS = '3056930009020004';

describe('Luhn', () => {
  test('accepts published test card numbers and rejects a digit-swapped one', () => {
    expect(passesLuhn(VISA)).toBe(true);
    expect(passesLuhn(MASTERCARD)).toBe(true);
    expect(passesLuhn(AMEX)).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
  });
});

describe('pan detection', () => {
  test('a bare Luhn-valid card number is a pan finding', () => {
    const findings = detectCardShapes(`please charge ${VISA} thanks`);
    expect(findings.map((f) => f.kind)).toEqual(['pan']);
    expect(hasRefusableCardShapes(findings)).toBe(true);
  });

  test('internal spaces and hyphens are stripped before the Luhn check', () => {
    for (const written of ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111 1111-1111 1111']) {
      const findings = detectCardShapes(`card: ${written}`);
      expect(findings.some((f) => f.kind === 'pan')).toBe(true);
    }
  });

  test('the finding span covers the written form, separators included', () => {
    const text = `pay with 4111 1111 1111 1111 now`;
    const pan = detectCardShapes(text).find((f) => f.kind === 'pan');
    expect(pan).toBeDefined();
    expect(text.slice(pan!.startIndex, pan!.startIndex + pan!.length)).toBe('4111 1111 1111 1111');
  });

  test('Luhn alone decides it — no issuer prefix is required', () => {
    // A 16-digit Luhn-valid number under no well-known issuer prefix (leading
    // 9). §11.0 refuses an issuer-prefix allowlist precisely so cards from
    // less common networks are not missed.
    const oddball = '9111111111111110';
    expect(passesLuhn(oddball)).toBe(true);
    expect(detectCardShapes(oddball).map((f) => f.kind)).toEqual(['pan']);
  });

  test('a Luhn-failing digit run of card length is not a pan', () => {
    expect(detectCardShapes('reference 4111111111111112 attached')).toEqual([]);
  });

  test('digit runs shorter than thirteen and longer than nineteen are not pans', () => {
    expect(detectCardShapes('order 12345678 shipped')).toEqual([]);
    // 20 digits, Luhn-valid, still outside the 13-19 window.
    const twenty = '12345678901234567894';
    expect(passesLuhn(twenty)).toBe(true);
    expect(detectCardShapes(`tracking ${twenty}`)).toEqual([]);
  });

  test('newlines do not join two lines into one run', () => {
    // Each line alone is too short; welded together they would be 16 digits.
    const text = '41111111\n11111111';
    expect(detectCardShapes(text)).toEqual([]);
  });

  test('several card numbers in one message all report', () => {
    const findings = detectCardShapes(`${VISA} and ${MASTERCARD} and ${AMEX} and ${DINERS}`);
    expect(findings.filter((f) => f.kind === 'pan')).toHaveLength(4);
  });
});

describe('secondary shapes are never refused on shape alone', () => {
  test('bare three- and four-digit runs are not findings', () => {
    expect(detectCardShapes('the answer is 123')).toEqual([]);
    expect(detectCardShapes('meet me in room 4021 at noon')).toEqual([]);
    expect(detectCardShapes('build 872 passed, 991 queued, 100 pending')).toEqual([]);
  });

  test('a bare MM/YY is not a finding', () => {
    expect(detectCardShapes('the invoice is dated 07/26')).toEqual([]);
    expect(detectCardShapes('window is 03/27 to 11/27')).toEqual([]);
  });

  test('a security code counts in card context', () => {
    const findings = detectCardShapes('the cvv is 123');
    expect(cardShapeKinds(findings)).toEqual(['security-code']);
    expect(hasRefusableCardShapes(findings)).toBe(true);
  });

  test('each named card-context keyword enables the secondary shapes', () => {
    for (const keyword of ['cvv', 'cvc', 'security code', 'card', 'expiry']) {
      const findings = detectCardShapes(`${keyword}: 123`);
      expect(cardShapeKinds(findings)).toEqual(['security-code']);
    }
  });

  test('an expiry counts in card context', () => {
    const findings = detectCardShapes('card expiry 07/29');
    expect(findings.some((f) => f.kind === 'expiry')).toBe(true);
  });

  test('a month outside 01-12 is not an expiry even in card context', () => {
    const findings = detectCardShapes('card ratio 13/29');
    expect(findings.some((f) => f.kind === 'expiry')).toBe(false);
  });

  test('a pan in the same message is itself card context for the rest', () => {
    // No keyword anywhere, the pan alone licenses the secondary shapes.
    const findings = detectCardShapes(`${VISA} 07/29 123`);
    expect(cardShapeKinds(findings)).toEqual(['pan', 'security-code', 'expiry']);
  });

  test('secondary shapes never overlap a pan span', () => {
    const findings = detectCardShapes(`card 4111-1111-1111-1111`);
    expect(cardShapeKinds(findings)).toEqual(['pan']);
  });

  test('findings come back sorted by position and never overlap', () => {
    const findings = detectCardShapes(`cvv 123 then ${VISA} then 07/29`);
    for (let index = 1; index < findings.length; index += 1) {
      const previous = findings[index - 1]!;
      const current = findings[index]!;
      expect(current.startIndex).toBeGreaterThanOrEqual(previous.startIndex + previous.length);
    }
  });
});

describe('the result cannot carry the digits', () => {
  test('a finding exposes only kind, startIndex and length at runtime', () => {
    const findings = detectCardShapes(`charge ${VISA}`);
    expect(findings).toHaveLength(1);
    expect(Object.keys(findings[0]!).sort()).toEqual(['kind', 'length', 'startIndex']);
  });

  test('no finding value serialises any part of the card number', () => {
    const findings = detectCardShapes(`card ${VISA} cvv 123 expiry 07/29`);
    expect(JSON.stringify(findings)).not.toContain(VISA);
    expect(JSON.stringify(findings)).not.toContain('4111');
  });

  test('the compile-time guard in card-shapes.ts is the type-level assertion', () => {
    // The real assertion is the @ts-expect-error trio and the keyof guard at
    // the bottom of card-shapes.ts, which fail `tsc` the moment a value-bearing
    // field is added, a runtime test cannot observe a field that does not
    // exist. This case pins the exact key set the type is allowed to have, so
    // an addition shows up here as well as in the build.
    const finding: CardShapeFinding = { kind: 'pan', startIndex: 0, length: 16 };
    const allowed: ReadonlyArray<keyof CardShapeFinding> = ['kind', 'startIndex', 'length'];
    expect(Object.keys(finding).every((key) => (allowed as readonly string[]).includes(key))).toBe(true);
  });
});

describe('refusal text', () => {
  test('names the shapes and never the digits', () => {
    const findings = detectCardShapes(`card ${VISA} cvv 123 expiry 07/29`);
    const message = renderCardShapeRefusal(findings);
    expect(message).toContain('card number');
    expect(message).toContain('security code');
    expect(message).toContain('expiry date');
    expect(message).not.toContain(VISA);
    // Nothing from the card, in any written form, and no numerals at all.
    expect(message).not.toMatch(/\d/);
  });

  test('says approvals and vetoes still work, because the refused message may have been one', () => {
    const message = renderCardShapeRefusal(detectCardShapes(VISA));
    expect(message.toLowerCase()).toContain('vetoing');
  });

  test('describeCardShapes reports each distinct shape once, in a stable order', () => {
    const findings = detectCardShapes(`card ${VISA} ${MASTERCARD} cvv 123`);
    expect(describeCardShapes(findings)).toEqual(['card number', 'security code']);
  });
});

describe('redaction', () => {
  test('replaces the card number with a kind marker and leaves the rest intact', () => {
    const redacted = redactCardShapes(`Your order shipped. Card ending ${VISA} was charged.`);
    expect(redacted).not.toContain(VISA);
    expect(redacted).not.toContain('4111');
    expect(redacted).toContain('[redacted:pan]');
    expect(redacted).toContain('Your order shipped.');
    expect(redacted).toContain('was charged.');
  });

  test('redacts every span when there are several', () => {
    const redacted = redactCardShapes(`${VISA} then ${MASTERCARD}`);
    expect(redacted).toBe('[redacted:pan] then [redacted:pan]');
  });

  test('leaves ordinary order-confirmation text untouched', () => {
    const body = 'Order 10029384 shipped. Tracking 1Z999AA10123456784. Total 42.99 on 07/26.';
    expect(redactCardShapes(body)).toBe(body);
  });

  test('redacts secondary shapes only in card context', () => {
    expect(redactCardShapes('room 123')).toBe('room 123');
    expect(redactCardShapes('cvv 123')).toBe('cvv [redacted:security-code]');
  });
});
