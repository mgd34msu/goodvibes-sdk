/**
 * payments-routes.test.ts
 *
 * The daemon serving `payments.*`. The property that matters most here is the
 * one the whole storage design rests on: card material goes IN and can never
 * come back out, not in a response, not in an error, not through a service
 * that hands back more than it should.
 */
import { describe, test, expect } from 'bun:test';
import {
  createPaymentsBudgetStatusHandler,
  createPaymentsCardsCreateHandler,
  createPaymentsCardsListHandler,
  createPaymentsPurchasesListHandler,
  type PaymentCardView,
  type PaymentsGatewayService,
} from '../packages/sdk/src/platform/control-plane/routes/payments.js';
import { GatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.js';

const FIXTURE_NUMBER = '4242424242424242';
const FIXTURE_CVV = 'CVV-SENTINEL-4b21';

const card: PaymentCardView = {
  id: 'card-1', label: 'shopping', brand: 'visa', last4: '4242', kind: 'virtual',
  expiryMonth: 12, expiryYear: 2034, issuerCapMinorUnits: 50_000,
  addedAt: '2026-07-27T00:00:00.000Z', materialComplete: true,
};

function invocation(body: Record<string, unknown>): Parameters<ReturnType<typeof createPaymentsCardsCreateHandler>>[0] {
  return { body, context: {} } as Parameters<ReturnType<typeof createPaymentsCardsCreateHandler>>[0];
}

/** A REST GET invocation: params under `query`, nothing in `body`. */
function queryInvocation(query: Record<string, unknown>): Parameters<ReturnType<typeof createPaymentsPurchasesListHandler>>[0] {
  return { query, body: undefined, context: {} } as Parameters<ReturnType<typeof createPaymentsPurchasesListHandler>>[0];
}

/** A service whose createCard fails the test if it is ever reached. */
function serviceThatMustNotStore(): PaymentsGatewayService {
  return {
    budgetStatus: async () => { throw new Error('unused'); },
    listCards: async () => ({ cards: [], defaultCardId: '' }),
    createCard: async () => { throw new Error('service.createCard must not run when field validation fails'); },
    deleteCard: async () => ({ deleted: false, secretsCleared: 0 }),
    listPurchases: async () => ({ purchases: [], total: 0 }),
    beginCheckout: async () => { throw new Error('unused'); },
    fillCardIntoCheckout: async () => { throw new Error('unused'); },
  };
}

describe('card material cannot come back out', () => {
  test('creating a card returns metadata and never what was submitted', async () => {
    const service: PaymentsGatewayService = {
      budgetStatus: async () => { throw new Error('unused'); },
      listCards: async () => ({ cards: [card], defaultCardId: 'card-1' }),
      createCard: async () => card,
      deleteCard: async () => ({ deleted: true, secretsCleared: 4 }),
      listPurchases: async () => ({ purchases: [], total: 0 }),
      beginCheckout: async () => { throw new Error('unused'); },
      fillCardIntoCheckout: async () => { throw new Error('unused'); },
    };
    const result = await createPaymentsCardsCreateHandler(service)(invocation({
      label: 'shopping', kind: 'virtual', number: FIXTURE_NUMBER,
      expiryMonth: 12, expiryYear: 2034, cvv: FIXTURE_CVV, cardholderName: 'A Person',
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FIXTURE_NUMBER);
    expect(serialized).not.toContain(FIXTURE_CVV);
    expect(serialized).toContain('4242');
  });

  test('a service that leaks extra fields still cannot get them past the handler', async () => {
    // The allowlist is the point: a service bug becomes a MISSING field rather
    // than a leaked card.
    const leaky = { ...card, cvv: FIXTURE_CVV, number: FIXTURE_NUMBER } as PaymentCardView;
    const service: PaymentsGatewayService = {
      budgetStatus: async () => { throw new Error('unused'); },
      listCards: async () => ({ cards: [leaky], defaultCardId: 'card-1' }),
      createCard: async () => leaky,
      deleteCard: async () => ({ deleted: true, secretsCleared: 0 }),
      listPurchases: async () => ({ purchases: [], total: 0 }),
      beginCheckout: async () => { throw new Error('unused'); },
      fillCardIntoCheckout: async () => { throw new Error('unused'); },
    };
    const listed = JSON.stringify(await createPaymentsCardsListHandler(service)(invocation({})));
    expect(listed).not.toContain(FIXTURE_CVV);
    expect(listed).not.toContain(FIXTURE_NUMBER);

    const created = JSON.stringify(await createPaymentsCardsCreateHandler(service)(invocation({
      label: 'x', kind: 'virtual', number: FIXTURE_NUMBER,
      expiryMonth: 1, expiryYear: 2030, cvv: FIXTURE_CVV, cardholderName: 'A Person',
    })));
    expect(created).not.toContain(FIXTURE_CVV);
    expect(created).not.toContain(FIXTURE_NUMBER);
  });

  test('a storage failure reports the stage without echoing the card', async () => {
    const service: PaymentsGatewayService = {
      budgetStatus: async () => { throw new Error('unused'); },
      listCards: async () => ({ cards: [], defaultCardId: '' }),
      // A service whose error message carelessly contains the card.
      createCard: async () => { throw new Error(`could not write ${FIXTURE_NUMBER} / ${FIXTURE_CVV}`); },
      deleteCard: async () => ({ deleted: false, secretsCleared: 0 }),
      listPurchases: async () => ({ purchases: [], total: 0 }),
      beginCheckout: async () => { throw new Error('unused'); },
      fillCardIntoCheckout: async () => { throw new Error('unused'); },
    };
    let message = '';
    try {
      await createPaymentsCardsCreateHandler(service)(invocation({
        label: 'x', kind: 'virtual', number: FIXTURE_NUMBER,
        expiryMonth: 1, expiryYear: 2030, cvv: FIXTURE_CVV, cardholderName: 'A Person',
      }));
    } catch (error) {
      message = error instanceof Error ? `${error.message}${JSON.stringify(error)}` : String(error);
    }
    expect(message).not.toContain(FIXTURE_NUMBER);
    expect(message).not.toContain(FIXTURE_CVV);
    expect(message).toContain('Nothing was saved');
  });
});

describe('budget status reports the day it was computed for', () => {
  test('the pools, the day key and the leader flag all come through', async () => {
    const service: PaymentsGatewayService = {
      budgetStatus: async () => ({
        enabled: true,
        currency: 'USD',
        reservationCount: 1,
        isPaymentsLeader: false,
        pools: {
          dayKey: '2026-07-27' as never,
          timezone: 'America/New_York',
          item: { limit: 10_000, spent: 2_000, reserved: 1_000, remaining: 7_000 },
          overage: { limit: 2_000, spent: 0, reserved: 0, remaining: 2_000 },
          tolerance: { limit: 0, spent: 0, reserved: 0, remaining: 0 },
        },
      }),
      listCards: async () => ({ cards: [], defaultCardId: '' }),
      createCard: async () => card,
      deleteCard: async () => ({ deleted: true, secretsCleared: 0 }),
      listPurchases: async () => ({ purchases: [], total: 0 }),
      beginCheckout: async () => { throw new Error('unused'); },
      fillCardIntoCheckout: async () => { throw new Error('unused'); },
    };
    const result = await createPaymentsBudgetStatusHandler(service)(invocation({})) as Record<string, unknown>;
    expect(result['dayKey']).toBe('2026-07-27');
    expect(result['timezone']).toBe('America/New_York');
    // A node that is not the payments leader says so, because it refuses every
    // purchase and a surface should show why rather than a silent zero.
    expect(result['isPaymentsLeader']).toBe(false);
  });
});

describe('purchases.list `limit` tolerates the query string a GET actually sends', () => {
  function listCapturing(): { service: PaymentsGatewayService; seen: Array<{ limit: number; dayKey: string | undefined }> } {
    const seen: Array<{ limit: number; dayKey: string | undefined }> = [];
    const service: PaymentsGatewayService = {
      budgetStatus: async () => { throw new Error('unused'); },
      listCards: async () => ({ cards: [], defaultCardId: '' }),
      createCard: async () => { throw new Error('unused'); },
      deleteCard: async () => ({ deleted: false, secretsCleared: 0 }),
      listPurchases: async (input) => { seen.push(input); return { purchases: [], total: 0 }; },
      beginCheckout: async () => { throw new Error('unused'); },
      fillCardIntoCheckout: async () => { throw new Error('unused'); },
    };
    return { service, seen };
  }

  test('a numeric-string limit is honored, not silently replaced by the default', async () => {
    // GET query strings always arrive as strings ("?limit=1" -> "1"). Before the
    // fix, only `typeof rawLimit === 'number'` was accepted, so this fell back
    // to 100 for every real REST caller.
    const { service, seen } = listCapturing();
    await createPaymentsPurchasesListHandler(service)(queryInvocation({ limit: '1' }));
    expect(seen[0]?.limit).toBe(1);
  });

  test('a junk string falls back to the default exactly like a wrong-typed value does today', async () => {
    const { service, seen } = listCapturing();
    await createPaymentsPurchasesListHandler(service)(queryInvocation({ limit: 'not-a-number' }));
    expect(seen[0]?.limit).toBe(100);
    // A wrong-typed value falls back the same way today; this fix must not change that.
    await createPaymentsPurchasesListHandler(service)(queryInvocation({ limit: true as unknown as string }));
    expect(seen[1]?.limit).toBe(100);
  });
});

describe('cards.create validation failures surface as field-named 400s, not the storage 500', () => {
  test('a missing field 400s with its own name and never reaches the storage call', async () => {
    const service = serviceThatMustNotStore();
    let caught: unknown;
    try {
      await createPaymentsCardsCreateHandler(service)(invocation({
        label: 'shopping', kind: 'virtual',
        // number omitted, obviously-invalid on purpose: no card fixture needed at all.
        expiryMonth: 12, expiryYear: 2034, cvv: 'not-a-real-cvv', cardholderName: 'A Person',
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayVerbError);
    const refusal = caught as GatewayVerbError;
    expect(refusal.status).toBe(400);
    expect(refusal.field).toBe('number');
    expect(refusal.message).not.toContain('Storing the card failed');
  });

  test('a malformed field type 400s with its own name too, before storage runs', async () => {
    const service = serviceThatMustNotStore();
    let caught: unknown;
    try {
      await createPaymentsCardsCreateHandler(service)(invocation({
        label: 'shopping', kind: 'virtual', number: 'obviously-fake-card',
        expiryMonth: 'twelve', expiryYear: 2034, cvv: 'not-a-real-cvv', cardholderName: 'A Person',
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayVerbError);
    const refusal = caught as GatewayVerbError;
    expect(refusal.status).toBe(400);
    expect(refusal.field).toBe('expiryMonth');
    expect(refusal.message).not.toContain('Storing the card failed');
  });

  test('a genuine storage failure still 500s once every field validated (unchanged behavior)', async () => {
    const service: PaymentsGatewayService = {
      budgetStatus: async () => { throw new Error('unused'); },
      listCards: async () => ({ cards: [], defaultCardId: '' }),
      createCard: async () => { throw new Error('disk full'); },
      deleteCard: async () => ({ deleted: false, secretsCleared: 0 }),
      listPurchases: async () => ({ purchases: [], total: 0 }),
      beginCheckout: async () => { throw new Error('unused'); },
      fillCardIntoCheckout: async () => { throw new Error('unused'); },
    };
    let caught: unknown;
    try {
      await createPaymentsCardsCreateHandler(service)(invocation({
        label: 'shopping', kind: 'virtual', number: 'obviously-fake-card',
        expiryMonth: 12, expiryYear: 2034, cvv: 'not-a-real-cvv', cardholderName: 'A Person',
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayVerbError);
    const refusal = caught as GatewayVerbError;
    expect(refusal.status).toBe(500);
    expect(refusal.message).toContain('Storing the card failed. Nothing was saved.');
  });
});
