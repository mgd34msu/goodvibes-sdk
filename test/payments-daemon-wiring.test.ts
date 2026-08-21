/**
 * payments-daemon-wiring.test.ts, the two links between "the flow exists" and
 * "the flow runs".
 *
 * Both were the same shape of gap as the one that made `runCheckout`
 * unreachable: a complete, tested component with nothing constructing it.
 *
 *  1. `PaymentsServiceConfig` had the right fields and nothing built it from
 *     the real config manager, so a budget the owner typed did nothing.
 *  2. `MerchantJudgePort` had a criterion and a contract and nothing called a
 *     model, so "determine if it is reputable" always resolved to "I could not
 *     form a judgement".
 */
import { describe, expect, test } from 'bun:test';

import {
  readBudgetLimits,
  readCvvHandling,
  readMerchantPolicy,
  readNotifyChannels,
  readPaymentsServiceConfig,
  type PaymentsConfigReader,
} from '../packages/sdk/src/platform/payments/payments-config.js';
import { createModelMerchantJudge } from '../packages/sdk/src/platform/payments/merchant-judge-model.js';
import { MERCHANT_RECOURSE_CRITERION } from '../packages/sdk/src/platform/payments/merchant-recourse.js';

/** A config manager standing on a plain map, so a test can set one key. */
function config(values: Record<string, unknown>): PaymentsConfigReader {
  return { get: (key: string) => values[key] };
}

describe('the service configuration is read from live config', () => {
  test('an empty config yields a daemon that refuses rather than one with invented limits', () => {
    const resolved = readPaymentsServiceConfig(config({}));
    // Zero item budget is a terminal refusal in decidePurchase. A daemon nobody
    // has configured must not inherit a spending limit from a default.
    expect(resolved.limits.dailyItemMinorUnits).toBe(0);
    expect(String(resolved.budgetCurrency)).toBe('USD');
    expect(resolved.timezone).toBe('UTC');
    expect(resolved.preferredTier).toBe('normal');
  });

  test('every field comes from its key', () => {
    const resolved = readPaymentsServiceConfig(config({
      'payments.currency': 'GBP',
      'daemon.timezone': 'America/Detroit',
      'payments.shipping.preferredTier': 'fastest',
      'payments.budget.dailyItem': 250,
      'payments.budget.dailyOverage': 40,
      'payments.windows.approvalMinutes': 45,
      'payments.windows.vetoMinutes': 15,
    }));

    expect(String(resolved.budgetCurrency)).toBe('GBP');
    expect(resolved.timezone).toBe('America/Detroit');
    expect(resolved.preferredTier).toBe('fastest');
    expect(resolved.limits.dailyItemMinorUnits).toBe(25_000);
    expect(resolved.limits.dailyOverageMinorUnits).toBe(4_000);
    expect(resolved.approvalMinutes).toBe(45);
    expect(resolved.vetoMinutes).toBe(15);
  });

  test('the timezone key is the one the owner profile writes', () => {
    // owner-profile/consumers.ts maps location.timezone onto daemon.timezone.
    // Reading the KEY rather than the profile keeps one consumer and means a
    // machine with no profile still has a definite day boundary.
    expect(readPaymentsServiceConfig(config({ 'daemon.timezone': 'Europe/Berlin' })).timezone)
      .toBe('Europe/Berlin');
  });

  test('a mid-session change is visible on the next read, because nothing is cached', () => {
    const values: Record<string, unknown> = { 'payments.budget.dailyItem': 100 };
    const reader = config(values);
    expect(readPaymentsServiceConfig(reader).limits.dailyItemMinorUnits).toBe(10_000);
    // He raises it in the settings UI while a session is open.
    values['payments.budget.dailyItem'] = 900;
    expect(readPaymentsServiceConfig(reader).limits.dailyItemMinorUnits).toBe(90_000);
  });

  test('the amount is an amount of the configured currency, whatever its smallest division is', () => {
    // 500 with USD is 500 dollars -> 50000 hundredths.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 500 }), 'USD').dailyItemMinorUnits)
      .toBe(50_000);
    // JPY has no smaller division: 500 is 500 yen -> 500.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 500 }), 'JPY').dailyItemMinorUnits)
      .toBe(500);
    // BHD has three: 500 is 500 dinar -> 500000 fils.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 500 }), 'BHD').dailyItemMinorUnits)
      .toBe(500_000);
  });

  test('a decimal amount lands on an exact whole count, with no floating-point dust', () => {
    // 19.99 * 100 is 1998.9999999999998 as a bare multiply; the reader rounds
    // once so the limit is exactly 1999.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 19.99 }), 'USD').dailyItemMinorUnits)
      .toBe(1999);
    expect(readBudgetLimits(config({ 'payments.budget.perPurchaseCeiling': 0.29 }), 'USD').perPurchaseCeiling.minorUnits)
      .toBe(29);
  });

  test('an amount hand-written into the file as text reads the same as one set through a surface', () => {
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': '$250.50' }), 'USD').dailyItemMinorUnits)
      .toBe(25_050);
  });

  test('the safe defaults ship: ceiling ON, tolerance OFF with nothing allowed', () => {
    const limits = readBudgetLimits(config({}), 'USD');
    expect(limits.perPurchaseCeiling.enabled).toBe(true);
    expect(limits.overageTolerance.enabled).toBe(false);
    expect(limits.overageTolerance.dailyAllowanceMinorUnits).toBe(0);
  });

  test('a malformed setting falls back rather than being coerced', () => {
    const limits = readBudgetLimits(config({
      'payments.budget.dailyItem': -500,
      'payments.budget.dailyOverage': 'lots',
    }), 'USD');
    // Neither becomes a spending limit. Rounding or coercing someone's budget
    // is how a limit stops meaning what the person who typed it believes.
    expect(limits.dailyItemMinorUnits).toBe(0);
    expect(limits.dailyOverageMinorUnits).toBe(0);
  });

  test('cvvHandling and notify channels are read', () => {
    expect(readCvvHandling(config({}))).toBe('stored');
    expect(readCvvHandling(config({ 'payments.cvvHandling': 'prompt' }))).toBe('prompt');
    expect(readNotifyChannels(config({ 'payments.notifyChannels': 'telegram, tui' })))
      .toEqual(['telegram', 'tui']);
  });

  test('the owner\'s merchant overrides are read from his keys', () => {
    const policy = readMerchantPolicy(config({
      'payments.majorRetailersAdditional': 'microcenter.com, redbubble.com',
      'payments.majorRetailersExcluded': 'jeffsgadgets.biz',
    }));
    expect(JSON.stringify(policy)).toContain('microcenter.com');
    expect(JSON.stringify(policy)).toContain('jeffsgadgets.biz');
  });
});

// ═══ The judge ═════════════════════════════════════════════════════════════

/** A model that records what it was asked and answers with whatever is given. */
function fakeModel(answer: string | null | (() => never)) {
  const calls: { task: string; prompt: string; systemPrompt: string | undefined }[] = [];
  return {
    calls,
    model: {
      async chat(
        task: 'intent_classify',
        prompt: string,
        options: { readonly maxTokens?: number; readonly systemPrompt?: string },
      ): Promise<string | null> {
        calls.push({ task, prompt, systemPrompt: options.systemPrompt });
        if (typeof answer === 'function') {
          answer();
          // `answer` is declared `() => never`, so reaching this line means the
          // fixture was handed a function that returns. Saying so beats what
          // the unnarrowed `return answer` did, which was hand the function
          // itself back as if it were the model's reply.
          throw new Error('fakeModel: the answer function returned instead of throwing');
        }
        return answer;
      },
    },
  };
}

describe('the merchant judgement is made by a model', () => {
  test('the prompt carries the criterion and the domain, and nothing else', async () => {
    const fake = fakeModel('{"qualifies": true, "confident": true, "recourse": "returns process"}');
    const judge = createModelMerchantJudge(fake.model);
    await judge.judge({ registrableDomain: 'bestbuy.com' });

    expect(fake.calls.length).toBe(1);
    const call = fake.calls[0];
    expect(call?.systemPrompt).toContain(MERCHANT_RECOURSE_CRITERION);
    // The ONLY variable content. A page title, seller name or review count in
    // here would be the merchant writing its own reference.
    expect(call?.prompt).toBe('Domain: bestbuy.com');
  });

  test('a qualifying verdict is returned as given', async () => {
    const fake = fakeModel('{"qualifies": true, "confident": true, "recourse": "established electronics retailer"}');
    const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: 'bestbuy.com' });
    expect(verdict.qualifies).toBe(true);
    expect(verdict.confident).toBe(true);
    expect(verdict.recourse).toContain('established');
  });

  test('an answer wrapped in a code fence is still read', async () => {
    const fake = fakeModel('```json\n{"qualifies": false, "confident": true, "recourse": "none found"}\n```');
    const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: 'jeffsgadgets.biz' });
    expect(verdict.qualifies).toBe(false);
    expect(verdict.recourse).toBe('none found');
  });

  test('an unsure model is not a yes', async () => {
    const fake = fakeModel('{"qualifies": true, "confident": false, "recourse": "maybe"}');
    const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: 'unknown.example' });
    // classifyMerchant treats unconfident as not-major, so this resolves to an
    // approval where silence denies.
    expect(verdict.confident).toBe(false);
  });

  test('a missing confidence field reads as NOT confident', async () => {
    const fake = fakeModel('{"qualifies": true, "recourse": "big shop"}');
    const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: 'x.example' });
    expect(verdict.confident).toBe(false);
  });

  for (const [label, answer] of [
    ['prose instead of JSON', 'Yes, that is a well known retailer with good returns.'],
    ['a non-boolean verdict', '{"qualifies": "true", "confident": true, "recourse": "x"}'],
    ['a missing verdict', '{"confident": true, "recourse": "x"}'],
    ['empty', ''],
    ['broken JSON', '{"qualifies": true, '],
  ] as const) {
    test(`${label} resolves to not-major rather than being salvaged`, async () => {
      const fake = fakeModel(answer);
      const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: 'x.example' });
      expect(verdict.qualifies).toBe(false);
      expect(verdict.confident).toBe(false);
    });
  }

  test('a model that is unavailable resolves to not-major, never to yes', async () => {
    const fake = fakeModel(() => {
      throw new Error('Helper model routing is disabled.');
    });
    const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: 'bestbuy.com' });
    // A model outage must never make spending MORE automatic.
    expect(verdict.qualifies).toBe(false);
    expect(verdict.confident).toBe(false);
    expect(verdict.recourse).toContain('asking first');
  });

  test('a helper that returns null (no route configured) resolves to not-major', async () => {
    const fake = fakeModel(null);
    const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: 'bestbuy.com' });
    expect(verdict.qualifies).toBe(false);
  });

  test('an empty domain is not sent to a model at all', async () => {
    const fake = fakeModel('{"qualifies": true, "confident": true, "recourse": "x"}');
    const verdict = await createModelMerchantJudge(fake.model).judge({ registrableDomain: '   ' });
    expect(fake.calls.length).toBe(0);
    expect(verdict.qualifies).toBe(false);
  });
});
