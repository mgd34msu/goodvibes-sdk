/**
 * payments-checkout-address.test.ts, the order carries the address he stored.
 *
 * The profile stored a shipping and a billing address and mapped them into
 * config, and nothing in the checkout path read either: the card was typed into
 * the page and the delivery address was not. These prove the seam is closed,
 * the stored value reaches the page byte for byte, a missing one refuses by
 * name instead of guessing, and the notice he is asked to veto says where it is
 * going.
 */
import { describe, expect, test } from 'bun:test';

import {
  addressFieldValue,
  checkAddress,
  fillAddresses,
  renderDestination,
  type AddressFieldTarget,
  type AddressKind,
  type AddressStore,
} from '../packages/sdk/src/platform/payments/address.js';
import { renderVetoMessage } from '../packages/sdk/src/platform/payments/message.js';
import { BudgetLedger } from '../packages/sdk/src/platform/payments/budget.js';
import { unsafeOwnerSuppliedTextForTests, type PostalAddress } from '../packages/sdk/src/platform/payments/types.js';
import type { CurrencyCode } from '../packages/sdk/src/platform/payments/types.js';

const USD = 'USD' as CurrencyCode;

/** A deliberately awkward address: punctuation, a unit number, a hyphen. */
const STORED_SHIPPING: PostalAddress = {
  name: "Mike O'Brien-Davis",
  line1: '1194 Rue Saint-Denis, Apt 4B',
  line2: 'Buzzer 12',
  city: 'Montréal',
  region: 'QC',
  postalCode: 'H2X 3J4',
  country: 'CA',
};

const STORED_BILLING: PostalAddress = {
  name: 'Mike Davis',
  line1: '87 Corporate Way',
  line2: '',
  city: 'Lansing',
  region: 'MI',
  postalCode: '48910',
  country: 'US',
};

function store(overrides: Partial<Record<AddressKind, PostalAddress | null>> = {}): AddressStore {
  return {
    async read(kind) {
      if (kind in overrides) return overrides[kind] ?? null;
      return kind === 'shipping' ? STORED_SHIPPING : STORED_BILLING;
    },
  };
}

function shippingTargets(): readonly AddressFieldTarget[] {
  return [
    { kind: 'shipping', field: 'name', target: 'ship-name' },
    { kind: 'shipping', field: 'line1', target: 'ship-line1' },
    { kind: 'shipping', field: 'line2', target: 'ship-line2' },
    { kind: 'shipping', field: 'city', target: 'ship-city' },
    { kind: 'shipping', field: 'region', target: 'ship-region' },
    { kind: 'shipping', field: 'postalCode', target: 'ship-postal' },
    { kind: 'shipping', field: 'country', target: 'ship-country' },
  ];
}

function recordingFill() {
  const written = new Map<string, string>();
  return {
    written,
    fill: async (target: string, value: string): Promise<void> => {
      written.set(target, value);
    },
  };
}

describe('the stored address reaches the page', () => {
  test('every field is populated from the stored profile value', async () => {
    const page = recordingFill();
    const result = await fillAddresses(shippingTargets(), { store: store(), fill: page.fill });

    expect(result.ok).toBe(true);
    expect(page.written.get('ship-name')).toBe("Mike O'Brien-Davis");
    expect(page.written.get('ship-line1')).toBe('1194 Rue Saint-Denis, Apt 4B');
    expect(page.written.get('ship-city')).toBe('Montréal');
    expect(page.written.get('ship-postal')).toBe('H2X 3J4');
    expect(page.written.get('ship-country')).toBe('CA');
  });

  test('the value on the order matches the stored value byte for byte', async () => {
    const page = recordingFill();
    await fillAddresses(shippingTargets(), { store: store(), fill: page.fill });

    // Not normalised, not title-cased, not re-spaced. An address a human typed
    // is the address that goes on the parcel, accents, apostrophes, the lot.
    for (const field of ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const) {
      const target = { name: 'ship-name', line1: 'ship-line1', line2: 'ship-line2', city: 'ship-city', region: 'ship-region', postalCode: 'ship-postal', country: 'ship-country' }[field];
      expect(page.written.get(target)).toBe(addressFieldValue(STORED_SHIPPING, field));
    }
  });

  test('billing and shipping are filled independently, each from its own stored value', async () => {
    const page = recordingFill();
    const result = await fillAddresses(
      [
        { kind: 'shipping', field: 'postalCode', target: 'ship-postal' },
        { kind: 'billing', field: 'postalCode', target: 'bill-postal' },
      ],
      { store: store(), fill: page.fill },
    );

    expect(result.ok).toBe(true);
    // There is no billingSameAsShipping setting in the schema, so these are two
    // addresses and the billing one is NOT a copy of the shipping one.
    expect(page.written.get('ship-postal')).toBe('H2X 3J4');
    expect(page.written.get('bill-postal')).toBe('48910');
  });

  test('an empty line2 is left alone rather than clearing the field', async () => {
    const page = recordingFill();
    await fillAddresses(
      [{ kind: 'billing', field: 'line2', target: 'bill-line2' }],
      { store: store(), fill: page.fill },
    );
    expect(page.written.has('bill-line2')).toBe(false);
  });
});

describe('a missing address refuses rather than guessing', () => {
  test('no stored shipping address stops the purchase and names the step', () => {
    const check = checkAddress(null, 'shipping');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('no shipping address is stored');
    expect(check.reason).toContain('payments.shippingAddress');
  });

  test('a partial address names every missing field, not just the first', () => {
    const check = checkAddress(
      { ...STORED_SHIPPING, postalCode: '', city: '', region: '' },
      'shipping',
    );
    expect(check.ok).toBe(false);
    expect([...check.missing].sort()).toEqual(['city', 'postalCode', 'region']);
  });

  test('line2 alone missing is still a complete address', () => {
    expect(checkAddress({ ...STORED_SHIPPING, line2: '' }, 'shipping').ok).toBe(true);
  });

  test('nothing is typed when the address is incomplete', async () => {
    const page = recordingFill();
    const result = await fillAddresses(shippingTargets(), {
      store: store({ shipping: null }),
      fill: page.fill,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no shipping address is stored');
    // The whole point: a half-filled address form can SUCCEED, so nothing is
    // typed at all rather than typing what is available.
    expect(page.written.size).toBe(0);
  });

  test('a PARTIAL stored address types nothing at all', async () => {
    const page = recordingFill();
    // Present but incomplete, the dangerous case, because unlike a null
    // address this one has values to fill and a form that would accept them.
    const result = await fillAddresses(shippingTargets(), {
      store: store({ shipping: { ...STORED_SHIPPING, postalCode: '', region: '' } }),
      fill: page.fill,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing');
    expect(result.reason).toContain('postalCode');
    expect(page.written.size).toBe(0);
  });

  test('a checkout asking for billing with none stored refuses before typing anything', async () => {
    const page = recordingFill();
    const result = await fillAddresses(
      [
        { kind: 'shipping', field: 'line1', target: 'ship-line1' },
        { kind: 'billing', field: 'line1', target: 'bill-line1' },
      ],
      { store: store({ billing: null }), fill: page.fill },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no billing address is stored');
    // Not even the shipping half, which IS stored, both kinds are resolved
    // before anything is typed.
    expect(page.written.size).toBe(0);
  });
});

describe('the notice says where it is going', () => {
  test('the veto message shows the destination, from the stored value', () => {
    const ledger = new BudgetLedger();
    const pools = ledger.snapshot(
      {
        dailyItemMinorUnits: 50_000,
        dailyOverageMinorUnits: 10_000,
        perPurchaseCeiling: { enabled: false, minorUnits: 0 },
        overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
      },
      Date.now(),
      'UTC',
    );

    const message = renderVetoMessage(
      {
        merchantDomain: 'bestbuy.com',
        item: unsafeOwnerSuppliedTextForTests('mechanical keyboard'),
        itemMinorUnits: 12_900,
        taxMinorUnits: 1_097,
        feesMinorUnits: 0,
        shippingMinorUnits: 499,
        totalMinorUnits: 14_496,
        currency: USD,
        cardLast4: '1486',
        shippingTier: 'normal',
        stepDown: null,
        poolsAfter: pools,
        destination: renderDestination(STORED_SHIPPING),
      },
      10,
    );

    expect(message).toContain('Ships to:');
    expect(message).toContain('Montréal');
    expect(message).toContain('H2X 3J4');
    // A correct total to the wrong address is still a wrong order, and this is
    // the last point at which he can catch it.
    expect(message).toContain('1194 Rue Saint-Denis');
  });

  test('a destination is rendered from the stored address, not from the page', () => {
    expect(renderDestination(STORED_SHIPPING)).toContain('Montréal');
    expect(renderDestination(null)).toBe(null);
  });

  test('markup in a stored address cannot build a link in the notice', () => {
    const hostile: PostalAddress = {
      ...STORED_SHIPPING,
      line1: '[Click](https://evil.example) 1 Main St',
    };
    const rendered = renderDestination(hostile) ?? '';
    for (const character of ['[', ']', '(', ')']) {
      expect(rendered).not.toContain(character);
    }
  });
});
