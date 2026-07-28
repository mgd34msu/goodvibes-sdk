/**
 * payments-notice-injection.test.ts
 *
 * The approval and veto notices are read on a phone, under a ten-minute clock,
 * and answered with a word that authorises a charge. Every merchant-derived
 * string in them is chosen by whoever controls the checkout page.
 *
 * These are attack tests, not formatting tests. Each asserts that a hostile
 * string arrives INERT — no clickable link, no mention, no fake affordance —
 * rather than asserting that some particular escaping was applied.
 *
 * The class comes from the inbound-mail notice (SDK `140cbcb4`), where
 * `[Approved](https://evil.example)@ourdomain.com` rendered as a real link
 * because the field's provenance was partly verified and that was mistaken for
 * the field being safe.
 */
import { describe, test, expect } from 'bun:test';
import {
  sanitizeNoticeField,
  sanitizeOwnerNoticeField,
  breakMentionForms,
  isPlainHostname,
} from '../packages/sdk/src/platform/security/notice-text.js';
import {
  renderApprovalMessage,
  renderVetoMessage,
  renderCancellationReport,
  type PurchaseFacts,
} from '../packages/sdk/src/platform/payments/message.js';
import { assertCartMatchesRequest, detectRecurringCharge } from '../packages/sdk/src/platform/payments/cart.js';
import { BudgetLedger, type BudgetLimits } from '../packages/sdk/src/platform/payments/budget.js';
import {
  parseCurrencyCode,
  unsafeOwnerSuppliedTextForTests,
  type CurrencyCode,
} from '../packages/sdk/src/platform/payments/types.js';

const USD = parseCurrencyCode('USD') as CurrencyCode;

/** The payload a hostile merchant would choose: a link, a mention, a fake verdict. */
const ATTACK = '[Approved](https://evil.example) @everyone `code` <http://x|y> ~~s~~ *b* |spoiler|';

const limits: BudgetLimits = {
  dailyItemMinorUnits: 100_000,
  dailyOverageMinorUnits: 20_000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 },
  overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
};

function facts(overrides: Partial<PurchaseFacts> = {}): PurchaseFacts {
  return {
    merchantDomain: 'shop.example',
    item: unsafeOwnerSuppliedTextForTests('a burr coffee grinder'),
    itemMinorUnits: 12_000,
    taxMinorUnits: 990,
    feesMinorUnits: 0,
    shippingMinorUnits: 500,
    totalMinorUnits: 13_490,
    currency: USD,
    cardLast4: '4242',
    shippingTier: 'normal',
    stepDown: null,
    poolsAfter: new BudgetLedger().snapshot(limits, Date.parse('2026-07-27T12:00:00Z'), 'UTC'),
    ...overrides,
  };
}

/** No markup pair, no mention form, no HTML entity survived. */
function expectInert(rendered: string): void {
  expect(rendered).not.toMatch(/\[[^\]]*\]\([^)]*\)/); // markdown link
  expect(rendered).not.toMatch(/<[^>]*\|[^>]*>/);      // slack link
  expect(rendered).not.toMatch(/@(?![​])\w/);      // unbroken mention
  expect(rendered).not.toContain('`');
  expect(rendered).not.toContain('*');
  expect(rendered).not.toContain('~');
  expect(rendered).not.toContain('|');
}

describe('the sanitizer makes attacker text inert', () => {
  test('a markdown link cannot survive', () => {
    const out = sanitizeNoticeField('[Approved](https://evil.example)');
    expect(out).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    expect(out).not.toContain('[');
    expect(out).not.toContain('(');
  });

  test('a mention is broken but still readable', () => {
    const out = sanitizeNoticeField('@everyone');
    expect(out).not.toMatch(/@(?![​])\w/);
    // Legible to a human: the zero-width space is invisible.
    expect(out.replace(/​/g, '')).toBe('@everyone');
  });

  test('an ordinary address stays readable through mention-breaking', () => {
    expect(breakMentionForms('user@example.com').replace(/​/g, '')).toBe('user@example.com');
  });

  test('control characters and line separators cannot forge a line', () => {
    const out = sanitizeNoticeField('total: 12.00 Approved by owner');
    expect(out).not.toContain(' ');
    expect(out).not.toContain('\n');
  });

  test('owner text keeps underscore but loses everything that can link', () => {
    const out = sanitizeOwnerNoticeField('my_grinder [x](y) `z`');
    expect(out).toContain('_');
    expect(out).not.toContain('[');
    expect(out).not.toContain('`');
  });

  test('the length cap cannot be used to push the real total off the message', () => {
    const out = sanitizeNoticeField('A'.repeat(5_000), 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

describe('the notices themselves arrive inert', () => {
  test('an item title carrying an attack renders inert in the approval', () => {
    const rendered = renderApprovalMessage(
      facts({ item: unsafeOwnerSuppliedTextForTests(ATTACK) }),
      60,
    );
    expectInert(rendered);
    // The real total is still there and still ours.
    expect(rendered).toContain('USD 134.90');
  });

  test('the same attack is inert in the veto and the cancellation report', () => {
    const hostile = facts({ item: unsafeOwnerSuppliedTextForTests(ATTACK) });
    expectInert(renderVetoMessage(hostile, 10));
    expectInert(renderCancellationReport(hostile));
  });

  test('a merchant that is not a plain hostname is not rendered at all', () => {
    // A page can call itself anything; the identity shown is a computed eTLD+1.
    // If a caller ever supplies something else, it is refused, not printed.
    const rendered = renderApprovalMessage(
      facts({ merchantDomain: '[Apple](https://evil.example)' }),
      60,
    );
    expect(rendered).not.toContain('evil.example');
    expect(rendered).toContain('merchant identity unavailable');
  });

  test('a real registrable domain still renders normally', () => {
    expect(renderApprovalMessage(facts(), 60)).toContain('shop.example');
    expect(isPlainHostname('shop.example')).toBe(true);
    expect(isPlainHostname('[x](y)')).toBe(false);
  });

  test('the amount shown is ours, never merchant text', () => {
    // formatMinorUnits refuses a non-integer rather than rendering something
    // plausible, so a merchant string can never become the number he reads.
    const rendered = renderVetoMessage(facts(), 10);
    expect(rendered).toContain('USD 120.00');
    expect(rendered).toContain('USD 134.90');
  });
});

describe('refusal reasons carry merchant text and must be inert too', () => {
  test('an unexpected cart line label cannot inject', () => {
    const check = assertCartMatchesRequest(
      [
        { label: 'Burr coffee grinder', quantity: 1, unitMinorUnits: 12_000 },
        { label: ATTACK, quantity: 1, unitMinorUnits: 800 },
      ],
      [{ label: 'burr coffee grinder', quantity: 1 }],
    );
    expect(check.ok).toBe(false);
    expectInert(check.reason ?? '');
  });

  test('recurring-charge evidence lifted off the page cannot inject', () => {
    // The payload has to land INSIDE a capturing pattern to be a real case.
    // The trial-then-charge detector spans arbitrary text between "then" and
    // "per month", so the merchant controls what gets quoted back.
    const summary = 'Free trial, then [A](http://e.co) per month';
    const check = detectRecurringCharge(summary);
    expect(check.recurring).toBe(true);
    expect(check.matched.some((hit) => hit.includes('e.co'))).toBe(true);
    // …and the reason built from it is still inert.
    expectInert(check.reason ?? '');
    expect(check.reason ?? '').not.toMatch(/\[[^\]]*\]\([^)]*\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Proving the tests are really gated — the mail round's discipline
// ───────────────────────────────────────────────────────────────────────────

describe('each case is genuinely gated by its trigger', () => {
  /** The sanitizer, reimplemented with ONE character dropped from the set. */
  function sanitizeMinus(raw: string, dropped: string): string {
    const triggers = '`*_~|<>[]&()'.split('').filter((c) => c !== dropped);
    const escaped = triggers.map((c) => `\\${c}`).join('');
    const noControl = raw.replace(new RegExp('[\\u0000-\\u001F\\u007F\\u2028\\u2029]', 'g'), ' ');
    const noMarkup = noControl.replace(new RegExp(`[${escaped}]`, 'g'), ' ');
    return breakMentionForms(noMarkup).replace(/ {2,}/g, ' ').trim();
  }

  test('dropping "(" lets a markdown link survive — so "(" is what gates it', () => {
    // Without this, "[" removal alone would look sufficient and the parenthesis
    // case would be passing for a reason nobody chose.
    const weakened = sanitizeMinus('[Approved](https://evil.example)', '(');
    expect(weakened).toContain('(https://evil.example');
    // The real sanitizer does not.
    expect(sanitizeNoticeField('[Approved](https://evil.example)')).not.toContain('(');
  });

  test('dropping "[" still leaves the pair broken — the sets overlap on purpose', () => {
    const weakened = sanitizeMinus('[Approved](https://evil.example)', '[');
    expect(weakened).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
  });

  test('dropping "<" lets a Slack link survive', () => {
    expect(sanitizeMinus('<http://evil.example|Approved>', '<')).toContain('<http://evil.example');
    expect(sanitizeNoticeField('<http://evil.example|Approved>')).not.toContain('<');
  });

  test('dropping "`" lets a code span survive', () => {
    expect(sanitizeMinus('`rm -rf`', '`')).toContain('`');
    expect(sanitizeNoticeField('`rm -rf`')).not.toContain('`');
  });

  test('without mention-breaking, @everyone would form a real mention', () => {
    const withoutBreaking = '@everyone'.replace(/[`*_~|<>[\]&()]/g, ' ').trim();
    expect(withoutBreaking).toMatch(/@(?![​])\w/);
    expect(sanitizeNoticeField('@everyone')).not.toMatch(/@(?![​])\w/);
  });
});
