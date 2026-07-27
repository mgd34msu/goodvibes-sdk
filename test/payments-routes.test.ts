/**
 * payments-routes.test.ts
 *
 * The daemon serving `payments.*`. The property that matters most here is the
 * one the whole storage design rests on: card material goes IN and can never
 * come back out — not in a response, not in an error, not through a service
 * that hands back more than it should.
 */
import { describe, test, expect } from 'bun:test';
import {
  createPaymentsBudgetStatusHandler,
  createPaymentsCardsCreateHandler,
  createPaymentsCardsListHandler,
  type PaymentCardView,
  type PaymentsGatewayService,
} from '../packages/sdk/src/platform/control-plane/routes/payments.js';

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

describe('card material cannot come back out', () => {
  test('creating a card returns metadata and never what was submitted', async () => {
    const service: PaymentsGatewayService = {
      budgetStatus: async () => { throw new Error('unused'); },
      listCards: async () => ({ cards: [card], defaultCardId: 'card-1' }),
      createCard: async () => card,
      deleteCard: async () => ({ deleted: true, secretsCleared: 4 }),
      listPurchases: async () => ({ purchases: [], total: 0 }),
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
    };
    const result = await createPaymentsBudgetStatusHandler(service)(invocation({})) as Record<string, unknown>;
    expect(result['dayKey']).toBe('2026-07-27');
    expect(result['timezone']).toBe('America/New_York');
    // A node that is not the payments leader says so, because it refuses every
    // purchase and a surface should show why rather than a silent zero.
    expect(result['isPaymentsLeader']).toBe(false);
  });
});
