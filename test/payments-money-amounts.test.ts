/**
 * payments-money-amounts.test.ts — the payment limits hold the number the owner
 * would say out loud, and an existing file is carried across to that form.
 *
 * The defect this pins: the four budget keys used to be named for, and stored
 * as, the count of the currency's smallest division. `100` in the file meant one
 * dollar; a hundred-dollar ceiling had to be written `10000`. Every entry point
 * was one absent zero away from a hundredfold error on a spending limit, in the
 * direction that spends more.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { CONFIG_SCHEMA } from '../packages/sdk/src/platform/config/schema.ts';
import {
  MAX_MONEY_AMOUNT,
  parseMoneyAmount,
} from '../packages/sdk/src/platform/config/money-value.ts';
import {
  PAYMENTS_BUDGET_RENAMES,
  migratePaymentsBudgetAmounts,
} from '../packages/sdk/src/platform/config/migrations.ts';
import { readBudgetLimits } from '../packages/sdk/src/platform/payments/payments-config.ts';

const AMOUNT_KEYS = [
  'payments.budget.dailyItem',
  'payments.budget.dailyOverage',
  'payments.budget.perPurchaseCeiling',
  'payments.budget.overageToleranceDailyAllowance',
] as const;

function makeManager(): { manager: ConfigManager; daemonTierPath: string } {
  const home = makeProjectTempDir('gv-money-home');
  const configDir = join(home, '.goodvibes', 'tui');
  const daemonTierPath = join(home, '.goodvibes', 'daemon', 'settings.json');
  mkdirSync(configDir, { recursive: true });
  const manager = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });
  return { manager, daemonTierPath };
}

function budgetReader(values: Record<string, unknown>): { get(key: string): unknown } {
  return { get: (key: string): unknown => values[key] };
}

// ─── The grammar ───────────────────────────────────────────────────────────

describe('what an amount setting accepts', () => {
  test('a whole number is the number', () => {
    expect(parseMoneyAmount(100)).toEqual({ ok: true, value: 100 });
    expect(parseMoneyAmount('100')).toEqual({ ok: true, value: 100 });
    expect(parseMoneyAmount(0)).toEqual({ ok: true, value: 0 });
  });

  test('a decimal is kept exactly as written — nothing is padded to two places', () => {
    expect(parseMoneyAmount('19.99')).toEqual({ ok: true, value: 19.99 });
    expect(parseMoneyAmount('100.5')).toEqual({ ok: true, value: 100.5 });
    expect(parseMoneyAmount(0.29)).toEqual({ ok: true, value: 0.29 });
  });

  test('a leading currency symbol is tolerated and dropped', () => {
    expect(parseMoneyAmount('$100')).toEqual({ ok: true, value: 100 });
    expect(parseMoneyAmount('£19.99')).toEqual({ ok: true, value: 19.99 });
    expect(parseMoneyAmount('€ 250.50')).toEqual({ ok: true, value: 250.5 });
  });

  test('thousands grouping is tolerated, because people write numbers that way', () => {
    expect(parseMoneyAmount('1,250')).toEqual({ ok: true, value: 1250 });
    expect(parseMoneyAmount('$12,500.75')).toEqual({ ok: true, value: 12500.75 });
  });

  test('genuine garbage is refused, and the refusal shows a plain example', () => {
    for (const bad of ['lots', '', 'abc', '1.2.3', '-5', -5, Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
      const result = parseMoneyAmount(bad);
      expect(result.ok).toBe(false);
    }
    const refusal = parseMoneyAmount('lots');
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.reason).toContain('100');
      expect(refusal.reason).toContain('19.99');
    }
  });

  test('more decimal places than an amount can carry is refused', () => {
    expect(parseMoneyAmount('100.555').ok).toBe(false);
    expect(parseMoneyAmount(100.555).ok).toBe(false);
  });

  test('a figure past the ceiling on the ceiling is refused', () => {
    expect(parseMoneyAmount(MAX_MONEY_AMOUNT).ok).toBe(true);
    expect(parseMoneyAmount(MAX_MONEY_AMOUNT + 1).ok).toBe(false);
  });

  test('no refusal, hint, or description anywhere names a unit', () => {
    const refusal = parseMoneyAmount('nope');
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.reason.toLowerCase()).not.toContain('cent');

    for (const key of AMOUNT_KEYS) {
      const setting = CONFIG_SCHEMA.find((entry) => entry.key === key);
      expect(setting).toBeDefined();
      expect(setting!.description.toLowerCase()).not.toContain('cent');
      expect(setting!.description.toLowerCase()).not.toContain('minor unit');
      expect((setting!.validationHint ?? '').toLowerCase()).not.toContain('cent');
    }
  });
});

// ─── The schema ────────────────────────────────────────────────────────────

describe('the schema is what a consumer keys off', () => {
  test('every amount key is marked as money, and no key is named for a unit', () => {
    for (const key of AMOUNT_KEYS) {
      const setting = CONFIG_SCHEMA.find((entry) => entry.key === key);
      expect(setting?.unit).toBe('money');
    }
    expect(CONFIG_SCHEMA.filter((entry) => entry.key.endsWith('Cents'))).toEqual([]);
  });

  test('the two budget switches keep their names', () => {
    for (const key of ['payments.budget.perPurchaseCeilingEnabled', 'payments.budget.overageToleranceEnabled']) {
      expect(CONFIG_SCHEMA.find((entry) => entry.key === key)?.type).toBe('boolean');
    }
  });
});

// ─── Setting one ───────────────────────────────────────────────────────────

describe('setting an amount', () => {
  test('a plain number is stored as given — a whole number stays whole', () => {
    const { manager, daemonTierPath } = makeManager();
    manager.set('payments.budget.perPurchaseCeiling', 100);

    expect(manager.get('payments.budget.perPurchaseCeiling')).toBe(100);
    const stored = JSON.parse(readFileSync(daemonTierPath, 'utf-8')) as {
      payments: { budget: { perPurchaseCeiling: number } };
    };
    expect(stored.payments.budget.perPurchaseCeiling).toBe(100);
    expect(readFileSync(daemonTierPath, 'utf-8')).toContain('"perPurchaseCeiling": 100');
  });

  test('a decimal is stored as the decimal that was typed', () => {
    const { manager, daemonTierPath } = makeManager();
    manager.set('payments.budget.dailyItem', 19.99);

    expect(manager.get('payments.budget.dailyItem')).toBe(19.99);
    expect(readFileSync(daemonTierPath, 'utf-8')).toContain('"dailyItem": 19.99');
  });

  test('a currency symbol on the way in reaches the same stored number', () => {
    const { manager } = makeManager();
    manager.set('payments.budget.dailyOverage', '$40' as unknown as number);
    expect(manager.get('payments.budget.dailyOverage')).toBe(40);
  });

  test('garbage is refused loudly, naming a plain example and no unit', () => {
    const { manager } = makeManager();
    let message = '';
    try {
      manager.set('payments.budget.dailyItem', 'lots' as unknown as number);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('payments.budget.dailyItem');
    expect(message).toContain('100');
    expect(message).toContain('19.99');
    expect(message.toLowerCase()).not.toContain('cent');
  });

  test('too many decimal places is refused rather than silently rounded', () => {
    const { manager } = makeManager();
    expect(() => manager.set('payments.budget.dailyItem', 100.555)).toThrow();
  });
});

// ─── The migration ─────────────────────────────────────────────────────────

describe('an existing file is carried across', () => {
  test('the rename map covers exactly the four amount keys', () => {
    expect(PAYMENTS_BUDGET_RENAMES.map(([from]) => from)).toEqual([
      'dailyItemCents',
      'dailyOverageCents',
      'perPurchaseCeilingCents',
      'overageToleranceDailyAllowanceCents',
    ]);
  });

  test('the stored count becomes the amount, in its simplest exact form', () => {
    const result = migratePaymentsBudgetAmounts({
      payments: {
        budget: {
          dailyItemCents: 10_000,
          dailyOverageCents: 1999,
          perPurchaseCeilingCents: 29,
          overageToleranceDailyAllowanceCents: 0,
        },
      },
    });

    expect(result.migrated).toBe(true);
    const budget = (result.config.payments as { budget: Record<string, unknown> }).budget;
    expect(budget.dailyItem).toBe(100);
    expect(budget.dailyOverage).toBe(19.99);
    expect(budget.perPurchaseCeiling).toBe(0.29);
    expect(budget.overageToleranceDailyAllowance).toBe(0);
    for (const [from] of PAYMENTS_BUDGET_RENAMES) expect(from in budget).toBe(false);
  });

  test('the migration is idempotent — a file already migrated is untouched', () => {
    const already = { payments: { budget: { dailyItem: 100 } } };
    const result = migratePaymentsBudgetAmounts(already);
    expect(result.migrated).toBe(false);
    expect(result.config).toBe(already);
  });

  test('a value already under the new name wins; the old key is still removed', () => {
    const result = migratePaymentsBudgetAmounts({
      payments: { budget: { dailyItem: 250, dailyItemCents: 10_000 } },
    });
    const budget = (result.config.payments as { budget: Record<string, unknown> }).budget;
    expect(budget.dailyItem).toBe(250);
    expect('dailyItemCents' in budget).toBe(false);
  });

  test('the owner\'s live daemon file: perPurchaseCeilingCents 10000 reads back as perPurchaseCeiling 100, with a receipt', () => {
    const home = makeProjectTempDir('gv-money-migrate');
    const configDir = join(home, '.goodvibes', 'tui');
    const daemonTierPath = join(home, '.goodvibes', 'daemon', 'settings.json');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(
      daemonTierPath,
      JSON.stringify({ payments: { budget: { perPurchaseCeilingCents: 10_000, dailyItemCents: 2500 } } }, null, 2),
      'utf-8',
    );

    const manager = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });

    // The resolved config reads the amount, not the old count.
    expect(manager.get('payments.budget.perPurchaseCeiling')).toBe(100);
    expect(manager.get('payments.budget.dailyItem')).toBe(25);

    // And the FILE itself now reads that way — this is what he opens.
    const onDisk = readFileSync(daemonTierPath, 'utf-8');
    expect(onDisk).toContain('"perPurchaseCeiling": 100');
    expect(onDisk).toContain('"dailyItem": 25');
    expect(onDisk).not.toContain('Cents');

    // The migration announced itself, naming every key and both values.
    const receipts = readFileSync(
      join(manager.getControlPlaneConfigDir(), 'control-plane', 'feature-announcements.json'),
      'utf-8',
    );
    expect(receipts).toContain('payments.budget.perPurchaseCeilingCents 10000 is now payments.budget.perPurchaseCeiling 100');
    expect(receipts).toContain('payments.budget.dailyItemCents 2500 is now payments.budget.dailyItem 25');
    // The receipt shows him what to type now, with no unit vocabulary.
    expect(receipts).toContain('19.99');
  });

  test('a file being migrated is not also reported as carrying settings nobody knows', () => {
    const home = makeProjectTempDir('gv-money-honesty');
    const configDir = join(home, '.goodvibes', 'tui');
    const daemonTierPath = join(home, '.goodvibes', 'daemon', 'settings.json');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(
      daemonTierPath,
      JSON.stringify({ payments: { budget: { dailyItemCents: 10_000 } } }, null, 2),
      'utf-8',
    );

    const manager = new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath });

    const notices = manager.getIngestionQuarantine();
    expect(notices.filter((notice) => notice.key.includes('Cents'))).toEqual([]);
  });
});

// ─── What enforcement reads ────────────────────────────────────────────────

describe('enforcement reads the new form', () => {
  test('an amount becomes an exact whole count of the currency\'s smallest division', () => {
    const limits = readBudgetLimits(
      budgetReader({
        'payments.budget.dailyItem': 100,
        'payments.budget.dailyOverage': 19.99,
        'payments.budget.perPurchaseCeiling': 0.29,
        'payments.budget.overageToleranceDailyAllowance': 2.5,
      }),
      'USD',
    );

    expect(limits.dailyItemMinorUnits).toBe(10_000);
    expect(limits.dailyOverageMinorUnits).toBe(1999);
    expect(limits.perPurchaseCeiling.minorUnits).toBe(29);
    expect(limits.overageTolerance.dailyAllowanceMinorUnits).toBe(250);
  });

  test('a limit set through the manager is the limit enforcement sees', () => {
    const { manager } = makeManager();
    manager.set('payments.budget.perPurchaseCeiling', 100);

    const limits = readBudgetLimits(
      { get: (key: string): unknown => manager.get(key as Parameters<typeof manager.get>[0]) },
      'USD',
    );
    // A hundred, enforced as a hundred — not as one dollar, which is what the
    // old keys produced when he typed what he meant.
    expect(limits.perPurchaseCeiling.minorUnits).toBe(10_000);
  });

  test('an unreadable setting falls back to nothing-allowed rather than being coerced', () => {
    const limits = readBudgetLimits(
      budgetReader({ 'payments.budget.dailyItem': 'lots', 'payments.budget.dailyOverage': -5 }),
      'USD',
    );
    expect(limits.dailyItemMinorUnits).toBe(0);
    expect(limits.dailyOverageMinorUnits).toBe(0);
  });
});
