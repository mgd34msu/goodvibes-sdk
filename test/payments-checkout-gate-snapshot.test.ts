/**
 * Pins the synchronous prefix of `PaymentsGatewayServiceImpl.beginCheckout`.
 *
 * The daemon primes a per-call gate-inputs cell (its `CheckoutGateInputsCell`)
 * immediately before invoking `beginCheckout` and clears it immediately after
 * the call returns its promise. That is only sound because `beginCheckout`
 * reads `deps.gates()` (and `deps.config()`, `deps.driverFor()`) synchronously,
 * before its first `await`. If an `await` ever lands ahead of the `gates()`
 * read, the daemon-side cell would already be cleared (or repopulated for a
 * different call) by the time the snapshot is taken, and gate inputs would
 * silently bind to the wrong purchase. The daemon side records this contract
 * in its decisions journal; this test is the SDK side of the pin.
 */
import { describe, expect, test } from 'bun:test';
import { PaymentsGatewayServiceImpl } from '../packages/sdk/src/platform/payments/payments-gateway-service.js';
import { BudgetLedger } from '../packages/sdk/src/platform/payments/budget.js';
import { CheckoutRegistry, MemoryCheckoutJournal, type CheckoutPhase, type InFlightCheckout } from '../packages/sdk/src/platform/payments/checkout-registry.js';
import { UntrustedContentLedger } from '../packages/sdk/src/platform/security/untrusted-content.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerPaymentsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/payments.js';
import { unsafeOwnerSuppliedTextForTests } from '../packages/sdk/src/platform/payments/types.js';
import type { CurrencyCode } from '../packages/sdk/src/platform/payments/types.js';

function buildService(
  order: string[],
  options: {
    readonly journal?: MemoryCheckoutJournal;
    readonly notices?: { kind: string; message: string }[];
    readonly ledger?: BudgetLedger;
    /** undefined = the port has no lookup; true/false = lookup result. */
    readonly purchasesHas?: boolean | undefined;
    readonly armingPageCleanup?: ((record: { purchaseId: string }) => Promise<boolean>) | undefined;
    readonly isPaymentsLeader?: boolean | undefined;
    readonly recoveryIoTimeoutMs?: number | undefined;
    readonly deliverNever?: boolean | undefined;
  } = {},
) {
  return new PaymentsGatewayServiceImpl({
    cards: {
      async metadata(id: string) {
        return {
          id, label: 'Test', brand: 'visa', last4: '0000', kind: 'virtual',
          expiryMonth: 1, expiryYear: 2030, issuerCapMinorUnits: null,
          addedAt: new Date().toISOString(),
        };
      },
      async read() {
        throw new Error('card material must not be read in this test');
      },
    },
    addresses: {
      async read() {
        throw new Error('address must not be read in this test');
      },
    },
    ledger: options.ledger ?? new BudgetLedger(),
    purchases: {
      async record() { /* not reached: gates refuse first */ },
      ...(options.purchasesHas === undefined
        ? {}
        : { has: async () => options.purchasesHas === true }),
    },
    notifier: {
      deliver(input: { kind: string; message: string }) {
        if (options.deliverNever === true) return new Promise(() => { /* never settles */ });
        options.notices?.push({ kind: input.kind, message: input.message });
        return Promise.resolve([{ channel: 'telegram', delivered: true, backfillable: true }]);
      },
      async awaitAnswer() { return null; },
    } as never,
    untrusted: new UntrustedContentLedger(),
    journal: options.journal ?? new MemoryCheckoutJournal(),
    merchantJudge: {
      async judge() {
        return { qualifies: false, confident: true, recourse: 'not reached' };
      },
    },
    driverFor: () => {
      order.push('driverFor');
      return {} as never;
    },
    ...(options.armingPageCleanup === undefined ? {} : { armingPageCleanup: options.armingPageCleanup }),
    ...(options.recoveryIoTimeoutMs === undefined ? {} : { recoveryIoTimeoutMs: options.recoveryIoTimeoutMs }),
    gates: () => {
      order.push('gates');
      // Disabled on purpose: the flow refuses at gate zero, so the call
      // settles quickly without windows, pages, or card material. The
      // snapshot read happens regardless of the values it carries.
      return {
        enabled: false,
        hasUsableCard: false,
        hasShippingAddress: false,
        isOwnerDirectRequest: true,
        isPaymentsLeader: options.isPaymentsLeader ?? true,
      };
    },
    config: () => {
      order.push('config');
      return {
        limits: {
          dailyItemMinorUnits: 1_000,
          dailyOverageMinorUnits: 0,
          perPurchaseCeiling: { enabled: false, minorUnits: 0 },
          overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
        },
        budgetCurrency: 'USD' as CurrencyCode,
        timezone: 'UTC',
        preferredTier: 'normal',
        approvalMinutes: 60,
        vetoMinutes: 10,
      };
    },
  });
}

describe('beginCheckout synchronous prefix', () => {
  test('reads gates(), config(), and driverFor() before its first await', async () => {
    const order: string[] = [];
    const service = buildService(order);

    // Deliberately NOT awaited yet: everything asserted next must have
    // happened synchronously, during the beginCheckout call itself.
    const pending = service.beginCheckout({
      sessionId: 's-1',
      pageId: 'p-1',
      merchantDomain: 'www.example-merchant.test',
      checkoutUrl: 'https://www.example-merchant.test/checkout',
      item: 'a thing the owner asked for',
      cardId: 'card-1',
      requestedLines: [{ label: 'a thing the owner asked for', quantity: 1 }],
      reading: {
        lines: [{ label: 'a thing the owner asked for', quantity: '1', unitPrice: '$1.00' }],
        tax: null,
        fees: [],
        shippingOptions: [],
        statedTotal: null,
        currency: 'USD',
        summaryText: 'a thing the owner asked for x1 $1.00',
      } as never,
      controls: {
        cardFields: [],
        placeOrderTarget: 'button#place-order',
      },
    });

    // The whole point: the gate snapshot was taken synchronously, inside the
    // call, before any microtask ran. The daemon's gate-inputs cell is only
    // valid for exactly that long.
    expect(order).toContain('gates');
    expect(order.filter((entry) => entry === 'gates')).toHaveLength(1);
    expect(order).toContain('config');
    expect(order).toContain('driverFor');
    // config is the first read, gates is taken at the runCheckout call site.
    expect(order.indexOf('config')).toBeLessThan(order.indexOf('gates'));

    const result = await pending;
    // Gate zero refuses (payments disabled), which proves the snapshot both
    // happened and was honored, with no card or address reads on the way.
    expect(result.outcome.startsWith('refused')).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.purchaseId === null || typeof result.purchaseId === 'string').toBe(true);
  });
});

// ─── Boot recovery of interrupted checkouts ─────────────────────────────────

function inFlight(phase: CheckoutPhase, overrides: Partial<InFlightCheckout> = {}): InFlightCheckout {
  return {
    purchaseId: `pur-${phase}`,
    sessionId: 's-1',
    pageId: `p-${phase}`,
    merchantDomain: 'www.example-merchant.test',
    cardId: 'card-1',
    item: unsafeOwnerSuppliedTextForTests('a thing the owner asked for'),
    currency: 'USD' as CurrencyCode,
    phase,
    startedAtMs: Date.now() - 60_000,
    updatedAtMs: Date.now() - 30_000,
    draw: null,
    reservationId: null,
    shippingTierRequested: 'normal',
    shippingTierUsed: null,
    stepDown: null,
    totalMinorUnits: null,
    ...overrides,
  };
}

describe('recoverInterruptedCheckouts', () => {
  test('an interrupted window settles by refusal, with no claim about what the owner saw', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('awaiting-window', { reservationId: 'res-1' }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });

    const { settlements: recovered } = await service.recoverInterruptedCheckouts();

    expect(recovered).toHaveLength(1);
    const [entry] = recovered;
    expect(entry!.verdict).toBe('not-submitted');
    expect(entry!.action).toBe('released');
    // Honest and narrow: delivery could not be verified, so it settles as
    // refused. No assertion that the notice "never reached" anyone, and no
    // citation of the delivery-keyed rules recovery cannot apply.
    expect(entry!.message).toContain('could not verify that the window notice ever reached you');
    expect(entry!.message).toContain('settles as refused');
    expect(entry!.message).not.toContain('undeliverable rule');
    expect(entry!.windowRecovery).toBeUndefined();
    expect(await journal.list()).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('notice');
  });

  test('the released sentence follows the actual release result', async () => {
    // Across a real restart the in-memory hold is gone; the message must not
    // claim a release that did not happen.
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('deciding', { reservationId: 'res-dead' }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.reservationReleased).toBe(false);
    expect(entry!.message).toContain('did not survive the restart');
    expect(entry!.message).not.toContain('has been released');
  });

  test('a possibly-submitted checkout keeps its hold and notifies once across two boots', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('submit-pending', { reservationId: 'res-2' }));
    const noticesBootOne: { kind: string; message: string }[] = [];
    const bootOne = buildService([], { journal, notices: noticesBootOne });

    const { settlements: first } = await bootOne.recoverInterruptedCheckouts();
    expect(first[0]!.action).toBe('held');
    expect(first[0]!.reservationReleased).toBe(false);
    expect(await journal.list()).toHaveLength(1);
    expect(noticesBootOne).toHaveLength(1);
    // The message promises nothing that does not exist: no settle verb, and
    // it covers both the crash and the pending-verification case.
    expect(noticesBootOne[0]!.message).toContain('stopped at the point of submitting');
    expect(noticesBootOne[0]!.message).toContain('order history');
    expect(noticesBootOne[0]!.message).not.toContain('tell me which it was');
    // The delivered notice was stamped through the journal.
    expect((await journal.list())[0]!.recoveryNotifiedAtMs).toBeDefined();

    // Second boot over the same journal: same verdict, no second notice.
    const noticesBootTwo: { kind: string; message: string }[] = [];
    const bootTwo = buildService([], { journal, notices: noticesBootTwo });
    const { settlements: second } = await bootTwo.recoverInterruptedCheckouts();
    expect(second[0]!.action).toBe('held');
    expect(noticesBootTwo).toHaveLength(0);
  });

  test('a submitted record is closed only when its purchase record verifies', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('submitted'));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices, purchasesHas: true });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.action).toBe('closed');
    expect(entry!.message).toContain('purchase record is on the ledger');
    expect(await journal.list()).toHaveLength(0);

    const { settlements: again } = await service.recoverInterruptedCheckouts();
    expect(again).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  test("a submitted record with no purchase record is KEPT and reported honestly (the reviewer's probe)", async () => {
    // The bad-ordering crash: journal says submitted, ledger has nothing.
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('submitted'));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices, purchasesHas: false });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.action).toBe('held');
    expect(entry!.message).toContain('no purchase record exists');
    expect(entry!.message).not.toContain('is recorded');
    // The evidence is NOT destroyed.
    expect(await journal.list()).toHaveLength(1);
  });

  test('a composition without a purchases lookup keeps the record and says it cannot verify', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('submitted'));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.action).toBe('held');
    expect(entry!.message).toContain('cannot verify the purchase record');
    expect(await journal.list()).toHaveLength(1);
  });

  test("a record live in this process is skipped by the sweep (the reviewer's probe)", async () => {
    const journal = new MemoryCheckoutJournal();
    const registry = new CheckoutRegistry(journal);
    const live = inFlight('deciding', { purchaseId: 'pur-live', pageId: 'p-live' });
    await registry.open(live);
    await journal.put(inFlight('deciding', { purchaseId: 'pur-dead', pageId: 'p-dead' }));

    const interrupted = await registry.interrupted();
    expect(interrupted.map((entry) => entry.record.purchaseId)).toEqual(['pur-dead']);
  });

  test('one throwing record does not abandon the rest of the sweep', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('submitted', { purchaseId: 'pur-throws' }));
    await journal.put(inFlight('deciding', { purchaseId: 'pur-fine', pageId: 'p-fine' }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });
    // Sabotage only the first record's settlement path.
    const impl = service as unknown as { deps: { purchases: { has?: (id: string) => Promise<boolean> } } };
    impl.deps.purchases.has = async (id: string) => {
      if (id === 'pur-throws') throw new Error('ledger unavailable');
      return true;
    };

    const { settlements: results } = await service.recoverInterruptedCheckouts();
    expect(results).toHaveLength(2);
    const failed = results.find((entry) => entry.purchaseId === 'pur-throws');
    const fine = results.find((entry) => entry.purchaseId === 'pur-fine');
    expect(failed!.action).toBe('failed');
    expect(failed!.message).toContain('ledger unavailable');
    expect(fine!.action).toBe('released');
  });
});

// ─── Registration wiring ────────────────────────────────────────────────────

describe('registerPaymentsGatewayMethods wiring', () => {
  const VERB = 'payments.checkout.begin';

  function stubVerbs() {
    return {
      async budgetStatus() { return {} as never; },
      async listCards() { return { cards: [], defaultCardId: '' } as never; },
      async createCard() { return {} as never; },
      async deleteCard() { return {} as never; },
      async listPurchases() { return { purchases: [], total: 0 } as never; },
      async beginCheckout() { return {} as never; },
      async fillCardIntoCheckout() { return {} as never; },
    };
  }

  test('no verb serves until a slow sweep completes; a begin mid-sweep finds no handler', async () => {
    let releaseSweep!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSweep = resolve; });
    const service = {
      ...stubVerbs(),
      recoverInterruptedCheckouts: async () => { await gate; return []; },
    };
    const catalog = new GatewayMethodCatalog();
    const registration = registerPaymentsGatewayMethods(catalog, service as never);

    // Mid-sweep: the descriptor exists but carries no handler, so an arriving
    // begin is refused as not-invokable rather than racing the sweep.
    expect(catalog.get(VERB)).toBeDefined();
    expect(catalog.hasHandler(VERB)).toBe(false);

    releaseSweep();
    await registration;
    expect(catalog.hasHandler(VERB)).toBe(true);
  });

  test('onRecoveryFailure catches a rejected sweep, and the verbs still attach', async () => {
    const failures: unknown[] = [];
    const service = {
      ...stubVerbs(),
      recoverInterruptedCheckouts: async () => { throw new Error('sweep rejected'); },
    };
    const catalog = new GatewayMethodCatalog();
    await registerPaymentsGatewayMethods(catalog, service as never, {
      onRecoveryFailure: (error) => failures.push(error),
    });
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe('sweep rejected');
    expect(catalog.hasHandler(VERB)).toBe(true);
  });

  test('onRecoveryFailure catches a SYNCHRONOUS throw, and the verbs still attach', async () => {
    const failures: unknown[] = [];
    const service = {
      ...stubVerbs(),
      recoverInterruptedCheckouts: () => { throw new Error('sync throw'); },
    };
    const catalog = new GatewayMethodCatalog();
    await registerPaymentsGatewayMethods(catalog, service as never, {
      onRecoveryFailure: (error) => failures.push(error),
    });
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe('sync throw');
    expect(catalog.hasHandler(VERB)).toBe(true);
  });

  test('a legacy double without the recovery method registers unchanged', async () => {
    const failures: unknown[] = [];
    const settled: unknown[] = [];
    const catalog = new GatewayMethodCatalog();
    await registerPaymentsGatewayMethods(catalog, stubVerbs() as never, {
      onRecoveryFailure: (error) => failures.push(error),
      onRecoverySettled: (results) => settled.push(results),
    });
    expect(catalog.hasHandler(VERB)).toBe(true);
    expect(failures).toHaveLength(0);
    expect(settled).toHaveLength(0);
  });

  test('settlements reach onRecoverySettled for the audit record', async () => {
    const settled: unknown[][] = [];
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('deciding', { purchaseId: 'pur-audit' }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });
    const catalog = new GatewayMethodCatalog();
    await registerPaymentsGatewayMethods(catalog, service as never, {
      onRecoverySettled: (sweep) => {
        settled.push([...(sweep as { settlements: readonly unknown[] }).settlements]);
      },
    });
    expect(settled).toHaveLength(1);
    expect((settled[0]![0] as { purchaseId: string }).purchaseId).toBe('pur-audit');
  });

  test('a non-leader boot skips the sweep and reports the skip; a leader boot sweeps', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('deciding', { purchaseId: 'pur-led' }));
    const notices: { kind: string; message: string }[] = [];

    const follower = buildService([], { journal, notices, isPaymentsLeader: false });
    const followerSweep = await follower.recoverInterruptedCheckouts();
    expect(followerSweep.swept).toBe(false);
    expect(followerSweep.skipped).toBe('not-leader');
    expect(followerSweep.settlements).toHaveLength(0);
    // Nothing was settled, released, or messaged by the follower.
    expect(await journal.list()).toHaveLength(1);
    expect(notices).toHaveLength(0);

    const leader = buildService([], { journal, notices, isPaymentsLeader: true });
    const leaderSweep = await leader.recoverInterruptedCheckouts();
    expect(leaderSweep.swept).toBe(true);
    expect(leaderSweep.settlements).toHaveLength(1);
    expect(await journal.list()).toHaveLength(0);
  });

  test('a never-settling notifier cannot hang the sweep or verb attachment', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('deciding', { purchaseId: 'pur-slow' }));
    const service = buildService([], { journal, deliverNever: true, recoveryIoTimeoutMs: 50 });
    const catalog = new GatewayMethodCatalog();

    const started = Date.now();
    await registerPaymentsGatewayMethods(catalog, service as never);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(catalog.hasHandler('payments.checkout.begin')).toBe(true);

    // The settlement itself succeeded (record closed); only the notice
    // failed, and honestly so, which the audit envelope records.
    expect(await journal.list()).toHaveLength(0);
  });

  test('a timed-out notice is reported as failed in the audit envelope', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('deciding', { purchaseId: 'pur-timeout' }));
    const service = buildService([], { journal, deliverNever: true, recoveryIoTimeoutMs: 50 });

    const { settlements } = await service.recoverInterruptedCheckouts();
    expect(settlements[0]!.action).toBe('released');
    expect(settlements[0]!.notice).toBe('failed');
    expect(settlements[0]!.notified).toBe(false);
  });

  test('the possibly-submitted crash-between-record-and-flush case closes on the next boot', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('submit-pending', { purchaseId: 'pur-landed' }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices, purchasesHas: true });

    const { settlements } = await service.recoverInterruptedCheckouts();
    expect(settlements[0]!.action).toBe('closed');
    expect(settlements[0]!.message).toContain('the order completed and is recorded');
    expect(await journal.list()).toHaveLength(0);
  });

  test('a deciding record that never took a hold says nothing about a hold', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('deciding', { reservationId: null }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });

    const { settlements } = await service.recoverInterruptedCheckouts();
    expect(settlements[0]!.message).toContain('Nothing was charged.');
    expect(settlements[0]!.message).not.toContain('hold');
    expect(settlements[0]!.message).not.toContain('released');
  });

  test('later boots report already-notified distinctly from delivery-failed', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('submit-pending', { recoveryNotifiedAtMs: 1 }));
    const service = buildService([], { journal, notices: [] });

    const { settlements } = await service.recoverInterruptedCheckouts();
    expect(settlements[0]!.notice).toBe('already-notified');
    expect(settlements[0]!.notified).toBe(false);
  });
});

describe('recovery with persisted window deliveries and the arming cleanup hook', () => {
  test('a delivered, expired window settles by the expiry-stands rule across a restart', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('awaiting-window', {
      reservationId: 'res-w1',
      windowKind: 'veto',
      windowDeadlineMs: Date.now() - 60_000,
      windowDeliveries: [{ channel: 'telegram', delivered: true, backfillable: true }],
    }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.action).toBe('released');
    expect(entry!.windowRecovery?.outcome).toBe('expiry-stands');
    expect(entry!.windowRecovery?.backfillChannels).toEqual(['telegram']);
    expect(entry!.message).toContain('veto window');
    expect(entry!.message).toContain('reached you before the restart');
    expect(entry!.message).toContain('nothing was charged');
    expect(entry!.message).toContain('telegram');
    expect(await journal.list()).toHaveLength(0);
  });

  test('a delivered window on an un-backfillable channel reports the reopen rule honestly', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('awaiting-window', {
      windowKind: 'approval',
      windowDeadlineMs: Date.now() - 60_000,
      windowDeliveries: [{ channel: 'tui', delivered: true, backfillable: false }],
    }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.windowRecovery?.outcome).toBe('reopen');
    expect(entry!.windowRecovery?.reopenChannels).toEqual(['tui']);
    expect(entry!.message).toContain('approval window');
    expect(entry!.message).toContain('cannot re-read tui');
    expect(entry!.message).toContain('nothing was charged');
  });

  test('a persisted report where nothing was delivered still refuses conservatively', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('awaiting-window', {
      windowKind: 'veto',
      windowDeadlineMs: Date.now() - 60_000,
      windowDeliveries: [{ channel: 'telegram', delivered: false, backfillable: true }],
    }));
    const service = buildService([], { journal, notices: [] });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.windowRecovery?.outcome).toBe('undeliverable-rule');
    expect(entry!.message).toContain('never reached you on any channel');
    expect(entry!.message).toContain('refused rather than charged');
  });

  test('an arming-phase record clears the page through the composition hook when one exists', async () => {
    const cleaned: string[] = [];
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('arming-payment', { purchaseId: 'pur-arm' }));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], {
      journal,
      notices,
      armingPageCleanup: async (record) => { cleaned.push(record.purchaseId); return true; },
    });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(cleaned).toEqual(['pur-arm']);
    expect(entry!.armingPageCleanup).toBe('done');
    expect(entry!.message).toContain('were cleared from the page');
  });

  test('without the hook, recovery refuses to claim a cleanup it cannot perform', async () => {
    const journal = new MemoryCheckoutJournal();
    await journal.put(inFlight('arming-payment'));
    const notices: { kind: string; message: string }[] = [];
    const service = buildService([], { journal, notices });

    const [entry] = (await service.recoverInterruptedCheckouts()).settlements;
    expect(entry!.armingPageCleanup).toBe('unavailable');
    expect(entry!.message).toContain('cannot reach that page from here');
    expect(entry!.message).not.toContain('were cleared');
  });
});
